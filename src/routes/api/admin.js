/**
 * Tashkheesa Command — Admin API  (/api/v1/admin/*)
 *
 * Superadmin-only, READ-ONLY namespace for the Command mobile app.
 * v1 performs NO writes to production business data. The ONE write here is
 * auth-infra: rotating the superadmin's own users.refresh_token on login/
 * refresh (mirrors the patient auth pattern, enables server-side revocation).
 *
 * Mounting (see src/routes/api_v1.js): this router is mounted at `/admin`
 * BEFORE the global requireJWT + requireRole('patient') gate, so:
 *   - POST /admin/auth/login     → public (issues superadmin tokens)
 *   - POST /admin/auth/refresh   → public (rotates against stored token)
 *   - everything else            → requireJWT + requireRole('superadmin')
 *
 * Factory signature mirrors the patient sub-routers: (db, helpers, deploy).
 *   db      - the pg Pool (for pool.* connection metrics)
 *   helpers - { safeGet, safeAll, safeRun }
 *   deploy  - { gitSha, startedAt, startedAtIso, version, mode } from server.js
 *
 * See docs/COMMAND_APP_PHASE0_AUDIT.md for the audit + decisions this implements.
 */

'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const {
  requireJWT,
  requireRole,
  generateAdminTokens,
  verifyRefreshToken,
} = require('../../middleware/requireJWT');
const { buildHealthPayload, WORKER_SPECS } = require('../../services/admin_health');
const { randomUUID } = require('crypto');
// Shared pure helpers for the /cases endpoints (status/tier normalization,
// tier-support, capacity, acceptance window). Extracted to a single source of
// truth so the candidates picker, single-assign write, queue/detail readers,
// and the bulk-auto-assign write all agree. See ./_assign_helpers.js.
const {
  STATUS_RAW,
  TIER_RAW,
  normalizeStatus,
  normalizeTier,
  doctorSupportsTier,
  capFor,
  acceptByIso,
} = require('./_assign_helpers');
const { bulkAutoAssign } = require('../../services/admin_bulk_assign');
const { issueRefund } = require('../../services/admin_refund');

// Single-account lock (decision 1): the app authenticates ONLY the Shifa
// superadmin. Email allowlist is defense-in-depth on top of the role gate.
const SUPERADMIN_EMAIL = String(process.env.SUPERADMIN_EMAIL || 'ziad.wahsh@shifaegypt.com')
  .trim()
  .toLowerCase();

function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function isAllowedAdminEmail(email) {
  return normEmail(email) === SUPERADMIN_EMAIL;
}

// Never leak password_hash / refresh_token / PII the app doesn't need.
function sanitizeAdmin(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

// ─── /pulse helpers (pure) ─────────────────────────────────────
// The prototype invented patient age/sex; real rows carry users.date_of_birth
// (TEXT, usually ISO) + users.gender ("male"/"female"). Derive best-effort —
// either may be null. Western numerals throughout.
function deriveAgeSex(dob, gender) {
  let age = null;
  if (dob) {
    const t = Date.parse(String(dob));
    if (!Number.isNaN(t)) {
      const yrs = Math.floor((Date.now() - t) / (365.25 * 24 * 3600 * 1000));
      if (yrs >= 0 && yrs < 130) age = yrs;
    }
  }
  const g = String(gender || '').trim().toLowerCase();
  const sex = g === 'male' || g === 'm' ? 'M' : g === 'female' || g === 'f' ? 'F' : null;
  if (age != null && sex) return `${age}${sex}`;
  if (age != null) return String(age);
  if (sex) return sex;
  return null;
}

function cap(s) {
  const str = String(s || '');
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

// order_events.label is free-text (no event-type enum), so "kind" is a
// best-effort classification used only for the activity dot colour.
function classifyActivity(label) {
  const l = String(label || '').toLowerCase();
  if (/refund/.test(l)) return 'refund';
  if (/assign/.test(l)) return 'assignment';
  if (/approv|reject/.test(l)) return 'approval';
  if (/overrid/.test(l)) return 'override';
  if (/paid|payment/.test(l)) return 'payment';
  if (/submit|report/.test(l)) return 'submit';
  if (/upload|file/.test(l)) return 'files';
  if (/draft|created/.test(l)) return 'draft';
  return 'event';
}

// snake_case machine labels → human; sentence labels pass through unchanged.
function humanizeLabel(label) {
  const s = String(label || '').trim();
  if (!s) return '—';
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(s)) {
    return s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
  return s;
}

// reference_id is NULL in prod → fall back to the raw order id.
function refDetail(referenceId, orderId) {
  const ref = referenceId || (orderId ? String(orderId).slice(0, 8) : null);
  return ref ? `Case ${ref}` : null;
}

function toIso(v) {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// status/tier normalization (STATUS_RAW, TIER_RAW, normalizeStatus,
// normalizeTier) now live in ./_assign_helpers.js — imported at the top.

// order_files in prod often carries only the R2 storage key (filename/label
// NULL) — derive a display name from the key's last path segment.
function basenameFromKey(key) {
  if (!key) return null;
  const seg = String(key).split('?')[0].split('/').filter(Boolean).pop();
  try {
    return seg ? decodeURIComponent(seg) : null;
  } catch (_) {
    return seg || null;
  }
}
// Coarse file kind from mime then filename extension (no file_type column).
function fileKind(mime, name) {
  const m = String(mime || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (m.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|dcm|dicom)$/.test(n)) return 'image';
  if (m === 'application/pdf' || /\.pdf$/.test(n)) return 'pdf';
  return 'file';
}

// /assign helpers (doctorSupportsTier, capFor, acceptByIso) now live in
// ./_assign_helpers.js — imported at the top.

module.exports = function (db, helpers, deploy, deps) {
  const { safeGet, safeAll, safeRun } = helpers;
  const router = express.Router();

  // Post-commit notification helpers for POST /cases/:id/assign. Injectable so
  // the atomic assign write stays hermetically testable; default to the real
  // implementations at mount time. NB: ensureConversation /
  // queueMultiChannelNotification / notifyCaseAssigned each run on their OWN
  // module-level pool — they are fired strictly AFTER the assignment COMMIT,
  // never on the txn client, so a notification can never touch the atomic write.
  const assignDeps = deps || {};
  const ensureConversation = assignDeps.ensureConversation
    || require('../messaging').ensureConversation;
  const queueMultiChannelNotification = assignDeps.queueMultiChannelNotification
    || require('../../notify').queueMultiChannelNotification;
  const notifyCaseAssigned = assignDeps.notifyCaseAssigned
    || require('../../services/emailService').notifyCaseAssigned;

  // ─── POST /auth/login (public) ─────────────────────────────
  // Generic 401 INVALID_CREDENTIALS for every failure mode — no account
  // enumeration, no leak of which check failed.
  router.post('/auth/login', async (req, res) => {
    const email = normEmail(req.body && req.body.email);
    const password = req.body && req.body.password;

    if (!email || !password || typeof password !== 'string') {
      return res.fail('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
    }

    // Allowlist first — never even look up a non-superadmin identity.
    if (!isAllowedAdminEmail(email)) {
      return res.fail('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
    }

    const user = await safeGet(
      "SELECT * FROM users WHERE email = $1 AND role = 'superadmin'",
      [email]
    );
    // Defense-in-depth: the query filters role, but re-check in code in case
    // an injected/odd row comes back.
    if (!user || user.role !== 'superadmin') {
      return res.fail('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
    }

    const valid = !!user.password_hash && (await bcrypt.compare(password, user.password_hash));
    if (!valid) {
      return res.fail('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
    }

    const tokens = generateAdminTokens(user);
    // The single auth-infra write: rotate this superadmin's stored refresh token.
    await safeRun('UPDATE users SET refresh_token = $1 WHERE id = $2', [tokens.refreshToken, user.id]);

    return res.ok({
      user: sanitizeAdmin(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  // ─── POST /auth/refresh (public) ───────────────────────────
  router.post('/auth/refresh', async (req, res) => {
    const refreshToken = req.body && req.body.refreshToken;
    if (!refreshToken) {
      return res.fail('Refresh token required', 401, 'NO_REFRESH_TOKEN');
    }

    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded) {
      return res.fail('Invalid refresh token', 401, 'INVALID_REFRESH');
    }

    // Rotation + role re-check: the stored token must match AND the account
    // must still be a superadmin.
    const user = await safeGet(
      "SELECT * FROM users WHERE id = $1 AND refresh_token = $2 AND role = 'superadmin'",
      [decoded.id, refreshToken]
    );
    if (!user) {
      return res.fail('Refresh token revoked', 401, 'REFRESH_REVOKED');
    }

    const tokens = generateAdminTokens(user);
    await safeRun('UPDATE users SET refresh_token = $1 WHERE id = $2', [tokens.refreshToken, user.id]);

    return res.ok({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  // ─── Everything below is superadmin-gated ──────────────────
  router.use(requireJWT);
  router.use(requireRole('superadmin'));

  // ─── GET /health ───────────────────────────────────────────
  // Aggregates the Pulse status strip: API reachable, DB connected, the two
  // cron workers' liveness (from agent_heartbeats), and the deploy SHA/time.
  // Fully read-only.
  router.get('/health', async (req, res) => {
    const names = WORKER_SPECS.map((w) => w.key);

    let heartbeatRows = [];
    let dbConnected = true;
    try {
      heartbeatRows = await safeAll(
        'SELECT agent_name, MAX(pinged_at) AS last_run FROM agent_heartbeats' +
          ' WHERE agent_name = ANY($1::text[]) GROUP BY agent_name',
        [names]
      );
    } catch (e) {
      // If even this catalog-light read fails, the DB pill is the story.
      dbConnected = false;
    }

    const payload = buildHealthPayload({
      uptimeSec: Math.floor(process.uptime()),
      pool: db,
      heartbeatRows,
      deploy: deploy || {},
      now: Date.now(),
    });

    if (!dbConnected) {
      payload.db.connected = false;
      payload.db.pool = null;
    }

    return res.ok(payload);
  });

  // ─── GET /pulse ────────────────────────────────────────────
  // The Command dashboard's at-a-glance operational view. READ-ONLY:
  // aggregates over orders_active + users + order_events via the owner pool.
  // No writes, no Supabase SDK.
  //
  // Active set = paid/in_progress/submitted/assigned (decision A). "Pending
  // assignment" = active AND doctor_id IS NULL (there is no pending_assignment
  // status). The SLA spectrum is deliberately PARTIAL (decision B): the SLA
  // clock only starts at doctor acceptance (deadline_at = accepted_at +
  // sla_hours) and prod has no accepted cases yet, so healthy/approaching are
  // returned null — not fabricated — and fill in for real once acceptance data
  // exists. Only Breached (past deadline) and "No active timer" (active, no
  // deadline) are computed. Identity falls back to orders.id when reference_id
  // is null; the case "summary" is the real services.name (no free-text column).
  const ACTIVE_STATUSES = "('paid','in_progress','submitted','assigned')";

  router.get('/pulse', async (req, res) => {
    try {
      const [agg, backlog, breachedRows, pendingRows, activityRows] = await Promise.all([
        safeGet(
          `SELECT
              COUNT(*) FILTER (WHERE completed_at IS NULL AND status IN ${ACTIVE_STATUSES}) AS active_cases,
              COUNT(*) FILTER (WHERE completed_at IS NULL AND doctor_id IS NOT NULL AND status IN ('in_progress','assigned')) AS awaiting_review,
              COUNT(*) FILTER (WHERE completed_at IS NULL AND doctor_id IS NULL AND status IN ${ACTIVE_STATUSES}) AS pending_assignment,
              COUNT(*) FILTER (WHERE completed_at IS NULL AND status IN ${ACTIVE_STATUSES} AND deadline_at IS NOT NULL AND deadline_at::timestamptz < NOW()) AS sla_breached,
              COUNT(*) FILTER (WHERE completed_at IS NULL AND status IN ${ACTIVE_STATUSES} AND deadline_at IS NULL) AS no_sla_timer,
              ROUND(EXTRACT(EPOCH FROM (NOW() - MIN(created_at::timestamptz) FILTER (
                WHERE completed_at IS NULL AND doctor_id IS NULL AND status IN ${ACTIVE_STATUSES}
              ))) / 60) AS oldest_pending_mins
           FROM orders_active`,
          []
        ),
        safeGet(
          `SELECT COUNT(*) AS pending_approvals FROM users WHERE role = 'doctor' AND pending_approval = true`,
          []
        ),
        safeAll(
          `SELECT o.id, o.reference_id,
                  COALESCE(p.name, '—') AS patient,
                  COALESCE(sp.name, '—') AS specialty,
                  ROUND(EXTRACT(EPOCH FROM (o.deadline_at::timestamptz - NOW())) / 60) AS sla_mins
             FROM orders_active o
             LEFT JOIN users p ON p.id = o.patient_id
             LEFT JOIN specialties sp ON sp.id = o.specialty_id
            WHERE o.completed_at IS NULL AND o.status IN ${ACTIVE_STATUSES}
              AND o.deadline_at IS NOT NULL AND o.deadline_at::timestamptz < NOW()
            ORDER BY o.deadline_at::timestamptz ASC
            LIMIT 3`,
          []
        ),
        safeAll(
          `SELECT o.id, o.reference_id, o.status, o.urgency_tier,
                  COALESCE(p.name, '—') AS patient, p.gender, p.date_of_birth,
                  COALESCE(sp.name, '—') AS specialty,
                  COALESCE(sv.name, '—') AS service,
                  ROUND(EXTRACT(EPOCH FROM (o.deadline_at::timestamptz - NOW())) / 60) AS sla_mins
             FROM orders_active o
             LEFT JOIN users p ON p.id = o.patient_id
             LEFT JOIN specialties sp ON sp.id = o.specialty_id
             LEFT JOIN services sv ON sv.id = o.service_id
            WHERE o.completed_at IS NULL AND o.doctor_id IS NULL AND o.status IN ${ACTIVE_STATUSES}
            ORDER BY (o.deadline_at IS NULL), o.deadline_at::timestamptz ASC, o.created_at ASC
            LIMIT 6`,
          []
        ),
        safeAll(
          `SELECT e.id, e.label, e.at, e.actor_role,
                  u.name AS actor_name, o.reference_id, o.id AS order_id
             FROM order_events e
             LEFT JOIN users u ON u.id = e.actor_user_id
             LEFT JOIN orders o ON o.id = e.order_id
            ORDER BY e.at DESC
            LIMIT 8`,
          []
        ),
      ]);

      const a = agg || {};
      const n = (v) => Number(v) || 0;

      const payload = {
        operator: { name: (req.user && req.user.name) || null },
        generatedAt: new Date().toISOString(),
        kpis: {
          activeCases: n(a.active_cases),
          awaitingReview: n(a.awaiting_review),
          pendingAssignment: n(a.pending_assignment),
          oldestPendingMins: a.oldest_pending_mins == null ? null : n(a.oldest_pending_mins),
          slaBreached: n(a.sla_breached),
          slaApproaching: null, // deferred — SLA clock unstarted (no accepted cases yet)
          noSlaTimer: n(a.no_sla_timer),
        },
        sla: {
          healthy: null, // deferred — do not fabricate the spectrum
          approaching: null, // deferred — fills in once acceptance data exists
          breached: n(a.sla_breached),
          noTimer: n(a.no_sla_timer),
        },
        needsAction: {
          breached: (breachedRows || []).map((r) => ({
            id: r.reference_id || r.id,
            patient: r.patient,
            specialty: r.specialty,
            slaMins: r.sla_mins == null ? null : Number(r.sla_mins),
          })),
          pendingAssignmentCount: n(a.pending_assignment),
        },
        pendingAssignment: (pendingRows || []).map((r) => ({
          id: r.reference_id || r.id,
          patient: r.patient,
          ageSex: deriveAgeSex(r.date_of_birth, r.gender),
          specialty: r.specialty,
          service: r.service,
          tier: r.urgency_tier || 'standard',
          status: r.status,
          slaMins: r.sla_mins == null ? null : Number(r.sla_mins),
        })),
        doctorBacklog: { pendingApprovals: n(backlog && backlog.pending_approvals) },
        recentActivity: (activityRows || []).map((e) => ({
          id: String(e.id),
          at: toIso(e.at),
          kind: classifyActivity(e.label),
          actor: e.actor_name || (e.actor_role ? cap(e.actor_role) : 'System'),
          title: humanizeLabel(e.label),
          detail: refDetail(e.reference_id, e.order_id),
        })),
      };

      return res.ok(payload);
    } catch (err) {
      // Honest failure over fabricated zeros — the app renders its error state.
      return res.fail('Failed to compute pulse', 500, 'PULSE_ERROR');
    }
  });

  // ─── GET /cases (filterable / sortable / paginated list) ────
  // READ-ONLY triage queue over orders_active. Default scope excludes
  // expired_unpaid + draft (dead/pre-payment noise) UNLESS an explicit status
  // filter requests them. Facet counts are global over orders_active (every
  // status) so the chips show the full landscape regardless of the active
  // filter. Identity, SLA, service-as-summary handled exactly like /pulse.
  router.get('/cases', async (req, res) => {
    try {
      const q = req.query || {};
      const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 25));
      const offset = Math.max(0, parseInt(q.offset, 10) || 0);

      // Parameterized dynamic WHERE.
      const cond = [];
      const params = [];
      const ph = () => '$' + params.length;

      if (q.status) {
        params.push(STATUS_RAW[normalizeStatus(q.status)] || [String(q.status).toLowerCase()]);
        cond.push(`LOWER(o.status) = ANY(${ph()}::text[])`);
      } else {
        cond.push("LOWER(COALESCE(o.status,'')) NOT IN ('expired_unpaid','draft')");
      }
      if (q.specialty) {
        params.push(q.specialty);
        cond.push(`o.specialty_id = ${ph()}`);
      }
      if (q.tier) {
        params.push(TIER_RAW[normalizeTier(q.tier)] || [normalizeTier(q.tier)]);
        cond.push(`LOWER(COALESCE(o.urgency_tier,'standard')) = ANY(${ph()}::text[])`);
      }
      if (q.payment) {
        params.push(String(q.payment).toLowerCase());
        cond.push(`LOWER(COALESCE(o.payment_status,'unpaid')) = ${ph()}`);
      }
      if (q.assigned === 'unassigned') cond.push('o.doctor_id IS NULL');
      else if (q.assigned === 'assigned') cond.push('o.doctor_id IS NOT NULL');
      if (q.breached === '1' || q.breached === 'true') {
        cond.push("o.completed_at IS NULL AND o.deadline_at IS NOT NULL AND o.deadline_at::timestamptz < NOW()");
      }
      if (q.q) {
        params.push('%' + String(q.q).trim() + '%');
        const i = ph();
        cond.push(`(p.name ILIKE ${i} OR o.reference_id ILIKE ${i} OR o.id ILIKE ${i} OR sv.name ILIKE ${i} OR sp.name ILIKE ${i})`);
      }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const orderBy = String(q.sort) === 'created'
        ? 'ORDER BY o.created_at DESC'
        : 'ORDER BY (o.deadline_at IS NULL), o.deadline_at::timestamptz ASC, o.created_at DESC';

      const fromJoins = `
          FROM orders_active o
          LEFT JOIN users p ON p.id = o.patient_id
          LEFT JOIN users d ON d.id = o.doctor_id
          LEFT JOIN specialties sp ON sp.id = o.specialty_id
          LEFT JOIN services sv ON sv.id = o.service_id`;

      const [rows, totalRow, facets] = await Promise.all([
        safeAll(
          `SELECT o.id, o.reference_id, o.status, o.urgency_tier, o.payment_status, o.doctor_id, o.created_at,
                  o.deadline_at, o.completed_at,
                  COALESCE(p.name,'—') AS patient, p.gender, p.date_of_birth,
                  COALESCE(sp.name,'—') AS specialty, COALESCE(sv.name,'—') AS service,
                  d.name AS doctor_name,
                  ROUND(EXTRACT(EPOCH FROM (o.deadline_at::timestamptz - NOW())) / 60) AS sla_mins
             ${fromJoins} ${where} ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
          params
        ),
        safeGet(`SELECT COUNT(*) AS total ${fromJoins} ${where}`, params),
        safeAll(
          `SELECT LOWER(o.status) AS s, COUNT(*) AS n,
                  COUNT(*) FILTER (WHERE o.doctor_id IS NULL AND o.completed_at IS NULL AND LOWER(o.status) = 'paid') AS unassigned,
                  COUNT(*) FILTER (WHERE o.completed_at IS NULL AND o.deadline_at IS NOT NULL AND o.deadline_at::timestamptz < NOW()) AS breached
             FROM orders_active o GROUP BY LOWER(o.status)`,
          []
        ),
      ]);

      const byStatus = {};
      let all = 0;
      let unassigned = 0;
      let breached = 0;
      (facets || []).forEach((f) => {
        const k = normalizeStatus(f.s);
        byStatus[k] = (byStatus[k] || 0) + Number(f.n || 0);
        all += Number(f.n || 0);
        unassigned += Number(f.unassigned || 0);
        breached += Number(f.breached || 0);
      });

      const cases = (rows || []).map((r) => {
        const norm = normalizeStatus(r.status);
        return {
          id: r.id, // raw orders.id — the routing key for /cases/:id
          reference: r.reference_id || null,
          patient: r.patient,
          ageSex: deriveAgeSex(r.date_of_birth, r.gender),
          specialty: r.specialty,
          service: r.service,
          doctor: r.doctor_name || null,
          tier: normalizeTier(r.urgency_tier),
          status: norm,
          payment: String(r.payment_status || 'unpaid').toLowerCase(),
          slaMins: r.sla_mins == null ? null : Number(r.sla_mins),
          breached: !r.completed_at && r.sla_mins != null && Number(r.sla_mins) < 0,
          unassigned: !r.doctor_id && norm === 'paid',
          createdAt: toIso(r.created_at),
        };
      });

      return res.ok({ cases, total: Number((totalRow && totalRow.total) || 0), limit, offset, counts: { all, breached, unassigned, byStatus } });
    } catch (err) {
      return res.fail('Failed to load cases', 500, 'CASES_ERROR');
    }
  });

  // ─── GET /cases/:id (full detail) ──────────────────────────
  // READ-ONLY. Report = real orders columns (single-language structured
  // opinion + report_url PDF; "signed" == completed). AI = latest
  // specialty_classifications row. Files = order_files ∪ order_additional_files
  // (name/kind derived from key+mime; download via the existing /files/:id).
  // Doctor load/SLA%/rating computed from the dashboard leaderboard pattern.
  router.get('/cases/:id', async (req, res) => {
    const id = req.params.id;
    try {
      const [row, orderFiles, addlFiles, ai, events, doctor, refund] = await Promise.all([
        safeGet(
          `SELECT o.id, o.reference_id, o.status, o.urgency_tier, o.payment_status, o.paid_at, o.payment_method,
                  o.price, o.created_at, o.completed_at, o.accepted_at, o.deadline_at, o.sla_hours,
                  o.doctor_id, o.specialty_id, o.service_id,
                  o.diagnosis_text, o.impression_text, o.recommendation_text, o.clinical_question, o.report_url,
                  COALESCE(p.name,'—') AS patient_name, p.gender, p.date_of_birth,
                  d.name AS doctor_name, sp.name AS specialty, sv.name AS service, dsp.name AS doctor_specialty,
                  ROUND(EXTRACT(EPOCH FROM (o.deadline_at::timestamptz - NOW())) / 60) AS sla_mins
             FROM orders_active o
             LEFT JOIN users p ON p.id = o.patient_id
             LEFT JOIN users d ON d.id = o.doctor_id
             LEFT JOIN specialties sp ON sp.id = o.specialty_id
             LEFT JOIN services sv ON sv.id = o.service_id
             LEFT JOIN specialties dsp ON dsp.id = d.specialty_id
            WHERE o.id = $1`,
          [id]
        ),
        safeAll(`SELECT id, filename, label, mime_type, size, url, created_at FROM order_files WHERE order_id = $1 ORDER BY created_at ASC`, [id]),
        safeAll(`SELECT id, label, file_url, file_key, uploaded_at FROM order_additional_files WHERE order_id = $1 ORDER BY uploaded_at ASC`, [id]),
        safeGet(
          `SELECT c.specialty_id, c.service_id, c.confidence, c.reasoning, c.model,
                  sp.name AS ai_specialty, sv.name AS ai_service
             FROM specialty_classifications c
             LEFT JOIN specialties sp ON sp.id = c.specialty_id
             LEFT JOIN services sv ON sv.id = c.service_id
            WHERE c.case_id = $1 ORDER BY c.created_at DESC LIMIT 1`,
          [id]
        ),
        safeAll(
          `SELECT e.id, e.label, e.at, e.actor_role, u.name AS actor_name
             FROM order_events e LEFT JOIN users u ON u.id = e.actor_user_id
            WHERE e.order_id = $1 ORDER BY e.at ASC LIMIT 50`,
          [id]
        ),
        safeGet(
          `SELECT u.max_active_cases AS cap,
                  (SELECT COUNT(*) FROM orders_active o WHERE o.doctor_id = u.id AND o.completed_at IS NULL
                     AND LOWER(o.status) NOT IN ('completed','cancelled','expired_unpaid')) AS load,
                  (SELECT COUNT(*) FILTER (WHERE o.completed_at IS NOT NULL AND o.deadline_at IS NOT NULL
                            AND o.completed_at::timestamptz <= o.deadline_at::timestamptz)::float
                          / NULLIF(COUNT(*) FILTER (WHERE o.completed_at IS NOT NULL), 0)
                     FROM orders_active o WHERE o.doctor_id = u.id) AS sla_hit,
                  (SELECT AVG(rating)::numeric(3,1) FROM reviews r WHERE r.doctor_id = u.id) AS rating
             FROM users u WHERE u.id = (SELECT doctor_id FROM orders_active WHERE id = $1)`,
          [id]
        ),
        safeGet(`SELECT amount_egp, status, reason, refunded_at FROM refunds WHERE order_id = $1 ORDER BY refunded_at DESC NULLS LAST LIMIT 1`, [id]),
      ]);

      if (!row) return res.fail('Case not found', 404, 'NOT_FOUND');

      const norm = normalizeStatus(row.status);

      const files = [];
      (orderFiles || []).forEach((f) => {
        const name = f.filename || f.label || basenameFromKey(f.url) || 'File';
        files.push({ id: String(f.id), name, kind: fileKind(f.mime_type, name), sizeBytes: f.size == null ? null : Number(f.size), downloadPath: `/files/${f.id}` });
      });
      (addlFiles || []).forEach((f) => {
        const name = f.label || basenameFromKey(f.file_key || f.file_url) || 'File';
        files.push({ id: String(f.id), name, kind: fileKind(null, name), sizeBytes: null, downloadPath: `/files/${f.id}` });
      });

      const reportPresent = !!(row.diagnosis_text || row.impression_text || row.recommendation_text || row.clinical_question || row.report_url);

      const payload = {
        id: row.id,
        reference: row.reference_id || null,
        status: norm,
        patient: { name: row.patient_name, ageSex: deriveAgeSex(row.date_of_birth, row.gender), gender: row.gender || null },
        routing: { specialty: row.specialty || '—', service: row.service || '—', tier: normalizeTier(row.urgency_tier) },
        sla: {
          deadlineAt: toIso(row.deadline_at),
          slaMins: row.sla_mins == null ? null : Number(row.sla_mins),
          slaHours: row.sla_hours == null ? null : Number(row.sla_hours),
          breached: !row.completed_at && row.sla_mins != null && Number(row.sla_mins) < 0,
          hasTimer: row.deadline_at != null,
        },
        payment: {
          state: String(row.payment_status || 'unpaid').toLowerCase(),
          price: row.price == null ? null : Number(row.price),
          paidAt: toIso(row.paid_at),
          method: row.payment_method || null,
          createdAt: toIso(row.created_at),
          refund: refund ? { amount: Number(refund.amount_egp) || 0, state: refund.status || null, reason: refund.reason || null, at: toIso(refund.refunded_at) } : null,
        },
        assignment: row.doctor_id
          ? {
              doctor: {
                name: row.doctor_name || '—',
                specialty: row.doctor_specialty || '—',
                load: doctor ? Number(doctor.load) || 0 : 0,
                cap: doctor && doctor.cap != null ? Number(doctor.cap) : null,
                slaPct: doctor && doctor.sla_hit != null ? Math.round(Number(doctor.sla_hit) * 100) : null,
                rating: doctor && doctor.rating != null ? Number(doctor.rating) : null,
              },
            }
          : null,
        ai: ai
          ? {
              specialty: ai.ai_specialty || ai.specialty_id || '—',
              service: ai.ai_service || ai.service_id || '—',
              confidencePct: ai.confidence == null ? null : Math.round(Number(ai.confidence) * 100),
              reasoning: ai.reasoning || null,
              model: ai.model || null,
              matchesRouting: ai.specialty_id != null && ai.specialty_id === row.specialty_id,
            }
          : null,
        files,
        report: reportPresent
          ? {
              present: true,
              findings: row.diagnosis_text || null,
              impression: row.impression_text || null,
              recommendation: row.recommendation_text || null,
              clinicalQuestion: row.clinical_question || null,
              pdfPath: row.report_url || null,
              signed: norm === 'completed',
            }
          : { present: false, findings: null, impression: null, recommendation: null, clinicalQuestion: null, pdfPath: null, signed: false },
        timeline: (events || []).map((e) => ({
          id: String(e.id),
          at: toIso(e.at),
          kind: classifyActivity(e.label),
          actor: e.actor_name || (e.actor_role ? cap(e.actor_role) : 'System'),
          title: humanizeLabel(e.label),
          detail: null,
        })),
      };

      return res.ok(payload);
    } catch (err) {
      return res.fail('Failed to load case', 500, 'CASE_DETAIL_ERROR');
    }
  });

  // ─── GET /cases/:id/candidates (doctor picker; read-only) ──
  // Specialty-matched doctors with load/cap + eligibility flags. The operator
  // chooses informed; the assign write re-validates everything server-side.
  router.get('/cases/:id/candidates', async (req, res) => {
    try {
      const c = await safeGet(
        `SELECT o.id, o.specialty_id, o.urgency_tier, o.doctor_id, COALESCE(sp.name,'—') AS specialty
           FROM orders_active o LEFT JOIN specialties sp ON sp.id = o.specialty_id WHERE o.id = $1`,
        [req.params.id]
      );
      if (!c) return res.fail('Case not found', 404, 'NOT_FOUND');

      const docs = c.specialty_id
        ? await safeAll(
            `SELECT u.id, u.name, u.is_active, u.is_paused, u.specialty_id, COALESCE(sp.name,'—') AS specialty,
                    u.max_active_cases, u.max_active_cases_urgent, u.sla_tiers_supported,
                    (SELECT COUNT(*) FROM orders_active o WHERE o.doctor_id = u.id
                       AND LOWER(COALESCE(o.status,'')) NOT IN ('completed','cancelled','expired_unpaid','refunded')) AS load
               FROM users u LEFT JOIN specialties sp ON sp.id = u.specialty_id
              WHERE u.role = 'doctor' AND u.specialty_id = $1 ORDER BY u.name ASC`,
            [c.specialty_id]
          )
        : [];

      const candidates = (docs || [])
        .map((d) => {
          const cap = capFor(d, c.urgency_tier);
          const load = Number(d.load) || 0;
          const atCapacity = cap > 0 && load >= cap;
          const active = !!d.is_active;
          const paused = !!d.is_paused;
          return {
            id: d.id,
            name: d.name,
            specialty: d.specialty,
            specialtyMatch: true,
            active,
            paused,
            load,
            cap,
            atCapacity,
            supportsTier: doctorSupportsTier(d.sla_tiers_supported, c.urgency_tier),
            eligible: active && !paused && !atCapacity && d.id !== c.doctor_id,
          };
        })
        .sort((a, b) => (a.eligible === b.eligible ? a.load - b.load : a.eligible ? -1 : 1));

      return res.ok({ case: { id: c.id, specialty: c.specialty, specialtyId: c.specialty_id || null, tier: normalizeTier(c.urgency_tier) }, candidates });
    } catch (err) {
      return res.fail('Failed to load candidates', 500, 'CANDIDATES_ERROR');
    }
  });

  // ─── GET /doctors (read-only roster) ──────────────────────────
  // The Doctors-tab roster: every doctor with computed active load, SLA hit-rate,
  // and rating, plus a derived status and a per-specialty active-supply summary.
  // Reuses the canonical patterns verbatim: load = active-case COUNT over
  // orders_active using the /candidates exclusion list (the single canonical
  // form), sla_hit = the case-detail card's completed-within-deadline ratio,
  // rating = AVG(reviews.rating). No filters in v1 — the full roster (~14 rows)
  // is returned and the app filters client-side.
  router.get('/doctors', async (req, res) => {
    try {
      const n = (v) => Number(v) || 0;
      // sla_tiers_supported is stored as JSON (sometimes a string). Parse it the
      // same defensive way doctorSupportsTier does, but keep the array for output.
      const parseTiers = (raw) => {
        let arr = raw;
        if (typeof arr === 'string') {
          try { arr = JSON.parse(arr); } catch (_) { arr = null; }
        }
        return Array.isArray(arr) ? arr.map((s) => String(s)) : [];
      };

      const rows = await safeAll(
        `SELECT u.id, u.name, u.name_ar, u.display_name, u.email, u.phone,
                u.specialty_id, COALESCE(sp.name, '—') AS specialty,
                u.is_active, u.is_paused, u.is_available, u.pending_approval,
                u.max_active_cases, u.max_active_cases_urgent, u.sla_tiers_supported,
                u.years_of_experience, u.medical_license_number,
                u.created_at, u.approved_at, u.last_seen_at,
                (SELECT COUNT(*) FROM orders_active o WHERE o.doctor_id = u.id
                   AND LOWER(COALESCE(o.status,'')) NOT IN ('completed','cancelled','expired_unpaid','refunded')) AS load,
                (SELECT COUNT(*) FILTER (WHERE o.completed_at IS NOT NULL AND o.deadline_at IS NOT NULL
                          AND o.completed_at::timestamptz <= o.deadline_at::timestamptz)::float
                        / NULLIF(COUNT(*) FILTER (WHERE o.completed_at IS NOT NULL), 0)
                   FROM orders_active o WHERE o.doctor_id = u.id) AS sla_hit,
                (SELECT AVG(rating)::numeric(3,1) FROM reviews r WHERE r.doctor_id = u.id) AS rating,
                (SELECT COUNT(*) FROM reviews r WHERE r.doctor_id = u.id) AS rating_count
           FROM users u LEFT JOIN specialties sp ON sp.id = u.specialty_id
          WHERE u.role = 'doctor'
          ORDER BY u.name ASC`
      );

      const doctors = (rows || []).map((d) => {
        // Status precedence: a pending application outranks paused/active; an
        // explicitly paused doctor outranks the active flag.
        const status = d.pending_approval ? 'pending'
          : d.is_paused ? 'paused'
          : d.is_active ? 'active'
          : 'inactive';
        return {
          id: d.id,
          name: d.name,
          nameAr: d.name_ar || null,
          displayName: d.display_name || null,
          email: d.email || null,
          phone: d.phone || null,
          specialtyId: d.specialty_id || null,
          specialty: d.specialty,
          status,
          isAvailable: !!d.is_available,
          load: { active: n(d.load), max: n(d.max_active_cases), maxUrgent: n(d.max_active_cases_urgent) },
          slaTiersSupported: parseTiers(d.sla_tiers_supported),
          slaHitRate: d.sla_hit == null ? null : Number(d.sla_hit),
          rating: { avg: d.rating == null ? null : Number(d.rating), count: n(d.rating_count) },
          yearsOfExperience: d.years_of_experience == null ? null : n(d.years_of_experience),
          medicalLicenseNumber: d.medical_license_number || null,
          createdAt: toIso(d.created_at),
          approvedAt: toIso(d.approved_at),
          lastSeenAt: toIso(d.last_seen_at),
        };
      });

      // Roster ordering: pending applications first (they need a decision), then
      // ascending active load (most-available first) — the same load metric the
      // assignment picker sorts on.
      doctors.sort((a, b) => {
        const ap = a.status === 'pending' ? 0 : 1;
        const bp = b.status === 'pending' ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.load.active - b.load.active;
      });

      // Summary computed in JS from the fetched rows (no extra count queries).
      const byStatus = { active: 0, pending: 0, paused: 0, inactive: 0 };
      const specOrder = [];
      const specMap = new Map();
      for (const doc of doctors) {
        if (Object.prototype.hasOwnProperty.call(byStatus, doc.status)) byStatus[doc.status] += 1;
        if (doc.specialtyId) {
          let entry = specMap.get(doc.specialtyId);
          if (!entry) {
            entry = { specialtyId: doc.specialtyId, specialty: doc.specialty, activeCount: 0 };
            specMap.set(doc.specialtyId, entry);
            specOrder.push(entry);
          }
          if (doc.status === 'active') entry.activeCount += 1;
        }
      }
      const bySpecialty = specOrder.sort((a, b) => a.specialty.localeCompare(b.specialty));

      return res.ok({
        doctors,
        summary: { total: doctors.length, byStatus, bySpecialty },
      });
    } catch (err) {
      return res.fail('Failed to load doctors', 500, 'DOCTORS_ERROR');
    }
  });

  // ─── POST /cases/:id/assign (FIRST production WRITE — atomic) ──
  // One all-or-nothing transaction: SELECT … FOR UPDATE, re-validate all 10
  // rules from fresh in-txn reads (client never trusted), then 4 writes (orders
  // UPDATE + doctor_assignments INSERT + order_events + admin_audit error_logs).
  // Silent by design: NO accepted_at/deadline_at (SLA starts at acceptance),
  // NO notifications/email/conversation. Reassign = doctor swap + reassigned
  // audit columns, no earnings side-effects; reassign-to-same-doctor rejected.
  router.post('/cases/:id/assign', async (req, res) => {
    const id = req.params.id;
    const doctorId = req.body && req.body.doctorId;
    const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : null;
    if (!doctorId || typeof doctorId !== 'string') return res.fail('doctorId is required', 400, 'BAD_REQUEST');

    // Throw-to-reject: attaches an HTTP status + code carried out of the txn.
    const af = (msg, http, code) => {
      const e = new Error(msg);
      e.http = http;
      e.code = code;
      throw e;
    };

    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');

      const o = (await client.query(
        `SELECT id, doctor_id, status, payment_status, paid_at, specialty_id, urgency_tier, sla_hours
           FROM orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      )).rows[0];
      if (!o) af('Case not found', 404, 'NOT_FOUND');

      const paid = !!o.paid_at && (String(o.payment_status || '').toLowerCase() === 'paid'
        || (!o.payment_status && String(o.status || '').toLowerCase() === 'paid'));
      if (!paid) af('Payment is not confirmed for this case', 409, 'PAYMENT_NOT_CONFIRMED');

      const status = normalizeStatus(o.status);
      const isReassign = !!o.doctor_id;
      if (!isReassign && status !== 'paid') af(`Case is not assignable (status: ${status})`, 409, 'NOT_ASSIGNABLE');
      if (isReassign && !['assigned', 'in_review', 'sla_breach', 'reassigned'].includes(status)) af(`Case is not reassignable (status: ${status})`, 409, 'NOT_REASSIGNABLE');
      if (isReassign && o.doctor_id === doctorId) af('Case is already assigned to this doctor', 409, 'ALREADY_ASSIGNED_TO_DOCTOR');

      const d = (await client.query(
        `SELECT id, name, role, is_active, is_paused, specialty_id, max_active_cases, max_active_cases_urgent
           FROM users WHERE id = $1`,
        [doctorId]
      )).rows[0];
      if (!d || d.role !== 'doctor') af('Doctor not found', 404, 'DOCTOR_NOT_FOUND');
      if (!d.is_active) af('Doctor is inactive', 409, 'DOCTOR_INACTIVE');
      if (d.is_paused) af('Doctor is paused', 409, 'DOCTOR_PAUSED');
      if (d.specialty_id !== o.specialty_id) af("Doctor's specialty does not match the case", 409, 'SPECIALTY_MISMATCH');

      const cap = capFor(d, o.urgency_tier);
      const load = Number((await client.query(
        `SELECT COUNT(*) AS c FROM orders WHERE doctor_id = $1 AND deleted_at IS NULL
           AND LOWER(COALESCE(status,'')) NOT IN ('completed','cancelled','expired_unpaid','refunded')`,
        [doctorId]
      )).rows[0].c) || 0;
      if (cap > 0 && load >= cap) af(`Doctor is at capacity (${load}/${cap})`, 409, 'DOCTOR_AT_CAPACITY');

      const now = new Date().toISOString();
      const fromDoctor = o.doctor_id || null;

      if (isReassign) {
        await client.query(
          `UPDATE orders SET doctor_id = $1, reassigned_count = COALESCE(reassigned_count,0) + 1,
             reassigned_to_doctor_id = $1, reassigned_at = NOW(), reassignment_reason = $2, updated_at = NOW()
           WHERE id = $3`,
          [doctorId, reason, id]
        );
        await client.query(`UPDATE doctor_assignments SET completed_at = $1 WHERE case_id = $2 AND completed_at IS NULL`, [now, id]);
      } else {
        await client.query(
          `UPDATE orders SET doctor_id = $1, status = 'ASSIGNED', assignment_status = 'assigned', updated_at = NOW() WHERE id = $2`,
          [doctorId, id]
        );
      }

      await client.query(
        `INSERT INTO doctor_assignments (id, case_id, doctor_id, assigned_at, accept_by_at, reassigned_from_doctor_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), id, doctorId, now, acceptByIso(o.sla_hours), isReassign ? fromDoctor : null]
      );

      const label = `Case ${isReassign ? 'reassigned' : 'assigned'} to ${d.name} by superadmin`;
      await client.query(
        `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
           VALUES ($1, $2, $3, $4, NOW(), $5, 'superadmin')`,
        [randomUUID(), id, label, JSON.stringify({ doctorId, from: fromDoctor, reason }), req.user.id]
      );
      await client.query(
        `INSERT INTO error_logs (id, level, category, message, user_id, context)
           VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
        [randomUUID(), `${isReassign ? 'reassigned' : 'assigned'} case ${id} to doctor ${doctorId}`, req.user.id,
          JSON.stringify({ action: isReassign ? 'case_reassigned' : 'case_assigned', caseId: id, doctorId, from: fromDoctor, reason })]
      );

      await client.query('COMMIT');

      // ─── Post-commit notifications (best-effort) ─────────────────────────
      // The atomic assignment above is the source of truth and is already
      // committed. Everything below runs AFTER commit, on separate pools, and
      // can NEVER roll the assignment back: a conversation row, queued
      // notification rows (notification_worker.js does the real email/WhatsApp
      // send out-of-band), and the canonical inline patient email. Every path
      // is idempotent — queueNotification dedupes on (dedupe_key, channel,
      // to_user_id) and ensureConversation SELECT-guards on
      // (order_id, patient_id, doctor_id) — so a retried or partially-run block
      // never double-notifies. Channels are limited to those the worker can
      // actually deliver (verified against notification_worker TEMPLATE_TO_EMAIL
      // + whatsappTemplateMap) to avoid enqueuing undeliverable rows. Any
      // failure is logged and surfaced as a per-target flag; the assignment
      // itself still returns success.
      const nstat = { conversation: 'pending', doctor: 'pending', patient: 'pending' };
      if (isReassign) nstat.previousDoctor = 'pending';
      else nstat.patientEmail = 'pending';

      const safeQueue = async (opts) => {
        try {
          const r = await queueMultiChannelNotification(opts);
          return (r && r.ok === false) ? 'failed' : 'queued';
        } catch (e) {
          console.error('[admin/assign] notify failed:', opts && opts.template, e && e.message);
          return 'failed';
        }
      };

      try {
        const meta = await safeGet(
          `SELECT o.patient_id, o.reference_id, p.email AS patient_email, p.name AS patient_name
             FROM orders o LEFT JOIN users p ON p.id = o.patient_id WHERE o.id = $1 AND o.deleted_at IS NULL`,
          [id]
        );
        const patientId = meta && meta.patient_id ? meta.patient_id : null;
        const caseRef = (meta && meta.reference_id) || id;
        const doctorName = d.name || 'a specialist';

        // 1) Conversation (patient ↔ assigned doctor) — idempotent SELECT-guard.
        if (patientId) {
          try {
            const convoId = await ensureConversation(id, patientId, doctorId);
            nstat.conversation = convoId ? 'ok' : 'failed';
          } catch (e) {
            nstat.conversation = 'failed';
            console.error('[admin/assign] ensureConversation failed:', e && e.message);
          }
        } else {
          nstat.conversation = 'skipped_no_patient';
        }

        // 2) Incoming doctor — fully deliverable (internal + email + whatsapp).
        nstat.doctor = await safeQueue({
          orderId: id,
          toUserId: doctorId,
          channels: ['internal', 'email', 'whatsapp'],
          template: isReassign ? 'order_reassigned_doctor' : 'order_assigned_doctor',
          response: { case_id: id, caseReference: caseRef, doctorName },
          dedupe_key: `${isReassign ? 'order_reassigned' : 'order_assigned'}:${id}:${doctorId}`,
        });

        if (isReassign) {
          // 3a) Patient (reassignment): in-app + WhatsApp. No patient
          // reassignment email template exists in the system.
          if (patientId) {
            nstat.patient = await safeQueue({
              orderId: id,
              toUserId: patientId,
              channels: ['internal', 'whatsapp'],
              template: 'order_reassigned_patient',
              response: { case_id: id, caseReference: caseRef, doctorName },
              dedupe_key: `order_reassigned_patient:${id}:${doctorId}`,
            });
          } else {
            nstat.patient = 'skipped_no_patient';
          }

          // 3b) Previous doctor — informational ("reassigned to another
          // doctor"); internal + email (no WhatsApp template is mapped).
          if (fromDoctor) {
            nstat.previousDoctor = await safeQueue({
              orderId: id,
              toUserId: fromDoctor,
              channels: ['internal', 'email'],
              template: 'order_reassigned_from_doctor',
              response: { case_id: id, caseReference: caseRef },
              dedupe_key: `order_reassigned_from:${id}:${fromDoctor}`,
            });
          } else {
            nstat.previousDoctor = 'skipped';
          }
        } else if (patientId) {
          // 3) Patient (first assignment): in-app bell (internal only — the
          // email/WhatsApp channels are unmapped for this template) PLUS the
          // canonical inline assignment email (the only deliverable one).
          nstat.patient = await safeQueue({
            orderId: id,
            toUserId: patientId,
            channels: ['internal'],
            template: 'order_assigned_patient',
            response: { case_id: id, caseReference: caseRef, doctorName },
            dedupe_key: `order_assigned_patient:${id}:${doctorId}`,
          });
          if (meta && meta.patient_email) {
            try {
              const r = await notifyCaseAssigned(
                { name: meta.patient_name, email: meta.patient_email },
                caseRef, doctorName, o.sla_hours
              );
              nstat.patientEmail = (r && r.ok === false) ? 'failed' : 'sent';
            } catch (e) {
              nstat.patientEmail = 'failed';
              console.error('[admin/assign] notifyCaseAssigned failed:', e && e.message);
            }
          } else {
            nstat.patientEmail = 'skipped_no_email';
          }
        } else {
          nstat.patient = 'skipped_no_patient';
          nstat.patientEmail = 'skipped_no_patient';
        }

        // Timeline note — best-effort, on the pool (not the committed txn).
        const anyFailed = Object.keys(nstat).some((k) => nstat[k] === 'failed');
        try {
          await safeRun(
            `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
               VALUES ($1, $2, $3, $4, NOW(), $5, 'superadmin')`,
            [randomUUID(), id,
              anyFailed ? 'Assignment notifications partially failed' : 'Assignment notifications dispatched',
              JSON.stringify(nstat), req.user.id]
          );
        } catch (_) { /* the timeline note is itself best-effort */ }
      } catch (e) {
        // Defensive umbrella: nothing in the post-commit step may break the
        // already-committed assignment response.
        console.error('[admin/assign] post-commit notifications failed:', e && e.message);
      }

      return res.ok({
        id,
        status: isReassign ? status : 'assigned',
        reassigned: isReassign,
        doctor: { id: d.id, name: d.name },
        notifications: nstat,
      });
    } catch (err) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* no-op */ } }
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/assign] failed:', err && err.message);
      return res.fail('Assignment failed', 500, 'ASSIGN_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /cases/:id/sla-override (real WRITE — atomic) ──
  // Extend the report-SLA deadline by +N hours. The SLA clock starts at DOCTOR
  // ACCEPTANCE (deadline_at = accepted_at + sla_hours), so override applies ONLY
  // to cases with a live clock (accepted_at + deadline_at both non-null);
  // unaccepted / paused / terminal cases are rejected. Extend-only (N >= 1).
  // Clobber-proof: bumps sla_hours AND deadline_at by the SAME +N together, so
  // case_lifecycle.updateCase's `deadline_at = accepted_at + sla_hours` recompute
  // stays a no-op (no silent revert). The future-guard lives in the UPDATE WHERE
  // (worker-consistent: breach is `deadline_at <= NOW()`), and a future result is
  // what makes clearing breached_at + flipping sla_breach->IN_REVIEW safe. Both
  // audit rows (order_events + admin_audit/error_logs) are written on the txn
  // client — atomic with the deadline change. No notifications (internal ops).
  const SLA_OVERRIDE_MAX_HOURS = 168; // 7-day cap on a single extension; adjustable.
  router.post('/cases/:id/sla-override', async (req, res) => {
    const id = req.params.id;
    const extendHours = req.body && req.body.extendHours;
    const reason = req.body && req.body.reason ? String(req.body.reason).trim().slice(0, 500) : '';

    // Input shape (pre-txn): extend-only integer within the cap, reason required.
    if (!Number.isInteger(extendHours) || extendHours < 1 || extendHours > SLA_OVERRIDE_MAX_HOURS) {
      return res.fail(`extendHours must be an integer between 1 and ${SLA_OVERRIDE_MAX_HOURS}`, 400, 'BAD_REQUEST');
    }
    if (!reason) return res.fail('reason is required', 400, 'BAD_REQUEST');

    // Throw-to-reject: attaches an HTTP status + code carried out of the txn.
    const af = (msg, http, code) => {
      const e = new Error(msg);
      e.http = http;
      e.code = code;
      throw e;
    };

    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');

      const o = (await client.query(
        `SELECT id, status, accepted_at, deadline_at, sla_hours, sla_paused_at, breached_at
           FROM orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      )).rows[0];
      if (!o) af('Case not found', 404, 'NOT_FOUND');

      const status = normalizeStatus(o.status);
      if (['completed', 'cancelled', 'refunded', 'expired_unpaid'].includes(status)) {
        af(`Case is not overridable (status: ${status})`, 409, 'NOT_OVERRIDABLE');
      }
      // SLA clock starts at doctor acceptance — nothing to override until then.
      if (!o.accepted_at || !o.deadline_at) {
        af('SLA clock has not started (no doctor acceptance yet) — no deadline to override', 409, 'SLA_NOT_STARTED');
      }
      if (o.sla_paused_at) af('SLA is paused — resume it before overriding', 409, 'SLA_PAUSED');

      const prevDeadlineIso = toIso(o.deadline_at);

      // Atomic write. The WHERE guard enforces "resulting deadline in the future"
      // using the same comparison the breach worker uses (deadline_at vs NOW()::timestamp);
      // a 0-row result means the guard failed → DEADLINE_IN_PAST. Bumping both
      // sla_hours and deadline_at by +N keeps the acceptance invariant intact.
      const upd = await client.query(
        `UPDATE orders
            SET sla_hours = COALESCE(sla_hours, 0) + $2::int,
                deadline_at = deadline_at + make_interval(hours => $2::int),
                breached_at = NULL,
                pre_breach_notified = false,
                sla_reminder_sent = false,
                status = CASE WHEN LOWER(COALESCE(status, '')) IN ('sla_breach', 'breached') THEN 'IN_REVIEW' ELSE status END,
                updated_at = NOW()
          WHERE id = $1
            AND deadline_at + make_interval(hours => $2::int) > NOW()::timestamp
        RETURNING deadline_at, sla_hours`,
        [id, extendHours]
      );
      if (!upd.rows[0]) af('Resulting deadline would still be in the past — extend by more hours', 409, 'DEADLINE_IN_PAST');

      const newDeadlineIso = toIso(upd.rows[0].deadline_at);

      await client.query(
        `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
           VALUES ($1, $2, $3, $4, NOW(), $5, 'superadmin')`,
        [randomUUID(), id, `SLA deadline extended +${extendHours}h by superadmin`,
          JSON.stringify({ from: prevDeadlineIso, to: newDeadlineIso, extendHours, reason }), req.user.id]
      );
      await client.query(
        `INSERT INTO error_logs (id, level, category, message, user_id, context)
           VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
        [randomUUID(), `sla_override case ${id} +${extendHours}h`, req.user.id,
          JSON.stringify({ action: 'sla_override', caseId: id, extendHours, from: prevDeadlineIso, to: newDeadlineIso, reason })]
      );

      await client.query('COMMIT');

      return res.ok({
        id,
        sla: {
          deadlineAt: newDeadlineIso,
          slaHours: Number(upd.rows[0].sla_hours),
          breached: false,
          hasTimer: true,
        },
        extendedHours: extendHours,
        previousDeadlineAt: prevDeadlineIso,
      });
    } catch (err) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* no-op */ } }
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/sla-override] failed:', err && err.message);
      return res.fail('SLA override failed', 500, 'SLA_OVERRIDE_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /cases/bulk-auto-assign (production WRITE — atomic, multi-order) ──
  // Auto-assign many unassigned cases at once. Selection = least active caseload
  // within specialty (the established rule); eligibility + per-case write =
  // single-assign's first-assign branch verbatim. ONE outer txn with a SAVEPOINT
  // per case → per-case atomicity + cumulative capacity + partial success.
  // manual_queue/manual_pending/manual_claimed are excluded (skipped
  // flagged_manual_review), never auto-routed. Silent (v1): no notifications.
  // dryRun runs the identical plan then ROLLBACKs (recap source + prove-it-safe).
  // See services/admin_bulk_assign.js. requireJWT + requireRole('superadmin')
  // are inherited from the router-level gate.
  router.post('/cases/bulk-auto-assign', async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dryRun === true || body.dryRun === 'true' || body.dryRun === 1;
    let caseIds = Array.isArray(body.caseIds) ? body.caseIds : null;
    if (!caseIds || caseIds.length === 0) {
      return res.fail('caseIds (non-empty array) is required', 400, 'BAD_REQUEST');
    }
    if (!caseIds.every((x) => typeof x === 'string' && x.trim())) {
      return res.fail('caseIds must be non-empty strings', 400, 'BAD_REQUEST');
    }
    caseIds = [...new Set(caseIds.map((x) => x.trim()))];
    if (caseIds.length > 50) {
      return res.fail('Too many cases (max 50 per batch)', 400, 'TOO_MANY');
    }

    let client;
    try {
      client = await db.connect();
      const result = await bulkAutoAssign(client, { caseIds, actorId: req.user.id, dryRun });
      return res.ok(result);
    } catch (err) {
      // bulkAutoAssign already rolled the whole batch back before re-throwing.
      console.error('[admin/bulk-auto-assign] failed:', err && err.message);
      return res.fail('Bulk auto-assign failed', 500, 'BULK_ASSIGN_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /cases/:id/refund (production MONEY-PATH WRITE — atomic) ──
  // Operator-initiated refund: records a PENDING refund row (a payout
  // OBLIGATION) + both audit rows in ONE atomic txn, mirroring the validated
  // web-superadmin create. Money is returned MANUALLY via InstaPay; completion
  // (approve/mark-paid) stays on web. v1 touches the orders row not at all, no
  // earnings clawback, no notification (silent). The order is locked FOR UPDATE
  // so concurrent refund attempts on the same order serialize (no double-refund).
  // requireJWT + requireRole('superadmin') inherited from the router-level gate.
  router.post('/cases/:id/refund', async (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const amount = Number(body.amount);
    const instapayHandle = body.instapayHandle != null ? String(body.instapayHandle).trim() : '';
    const notes = body.notes != null ? String(body.notes).slice(0, 1000) : '';

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.fail('amount must be a positive number', 400, 'BAD_REQUEST');
    }
    if (instapayHandle.length < 3 || instapayHandle.length > 100) {
      return res.fail('instapayHandle is required (3–100 chars)', 400, 'BAD_REQUEST');
    }

    let client;
    try {
      client = await db.connect();
      const refund = await issueRefund(client, { orderId: id, amount, instapayHandle, notes, actorId: req.user.id });
      return res.ok({ refund });
    } catch (err) {
      // issueRefund already rolled back before re-throwing; map known rejects.
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/refund] failed:', err && err.message);
      return res.fail('Refund failed', 500, 'REFUND_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  return router;
};

// Exported for unit tests / reuse.
module.exports.isAllowedAdminEmail = isAllowedAdminEmail;
module.exports.SUPERADMIN_EMAIL = SUPERADMIN_EMAIL;
