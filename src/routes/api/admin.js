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

module.exports = function (db, helpers, deploy) {
  const { safeGet, safeAll, safeRun } = helpers;
  const router = express.Router();

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

  return router;
};

// Exported for unit tests / reuse.
module.exports.isAllowedAdminEmail = isAllowedAdminEmail;
module.exports.SUPERADMIN_EMAIL = SUPERADMIN_EMAIL;
