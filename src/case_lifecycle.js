// ---------------------------------------------------------------------------
// HARD PAYMENT GATE: block all lifecycle transitions before payment
// Returns true if transition is allowed, false if blocked (never throws).
// ---------------------------------------------------------------------------
function assertPaidGate(existingCase, nextStatus) {
  // DEAD BRANCH — orders.payment_due_at does not exist, so this is never
  // entered (see submitCase). Left in place rather than deleted because it is
  // the correct shape if a payment window is ever recorded, but READ THIS
  // FIRST if you add that column: the branch returns false, and a false here
  // SILENTLY SKIPS the transition. Adding the column without also deciding
  // what happens to a case whose window has lapsed would start stranding paid
  // work with nothing but a console.warn to show for it.
  if (existingCase.payment_due_at && !existingCase.paid_at) {
    const dueMs = new Date(existingCase.payment_due_at).getTime();
    if (Number.isFinite(dueMs) && Date.now() > dueMs) {
      console.warn(`[payment-gate] Payment window expired for case ${existingCase.id} — skipping transition`);
      return false;
    }
  }
  const current = normalizeStatus(existingCase.status);
  const desired = normalizeStatus(nextStatus);

  // Allowed statuses before payment
  const PRE_PAYMENT = [CASE_STATUS.DRAFT, CASE_STATUS.SUBMITTED];

  // If not paid yet, block everything except staying pre-payment
  if (!existingCase.paid_at && current !== CASE_STATUS.PAID) {
    if (PRE_PAYMENT.includes(desired)) return true;

    console.warn(
      `[payment-gate] Payment required before transitioning case ${existingCase.id} from ${current} to ${desired} — skipping`
    );
    return false;
  }
  return true;
}

const { randomUUID } = require('crypto');
const { queryOne, queryAll, execute, withTransaction } = require('./pg');
const emailService = require('./services/emailService');

// ---------------------------------------------------------------------------
// Phase 4: helper to fetch the human-readable case reference + patient/doctor
// contact info for outbound email notifications. Returns null on any error so
// callers can safely skip the notification rather than crash the lifecycle
// transition. Single JOIN: orders ⨝ users(patient) ⨝ users(doctor) ⨝ cases.
// ---------------------------------------------------------------------------
async function getEmailContext(caseId) {
  try {
    const row = await queryOne(
      `SELECT
         u.email AS patient_email,
         u.name  AS patient_name,
         d.email AS doctor_email,
         d.name  AS doctor_name,
         COALESCE(o.reference_id, c.reference_code) AS reference_id
       FROM orders_active o
       LEFT JOIN users u ON u.id = o.patient_id
       LEFT JOIN users d ON d.id = o.doctor_id
       LEFT JOIN cases c ON c.id = o.id
       WHERE o.id = $1`,
      [caseId]
    );
    if (!row) return null;
    return {
      patient: { email: row.patient_email, name: row.patient_name },
      doctor:  { email: row.doctor_email,  name: row.doctor_name },
      referenceId: row.reference_id || String(caseId).slice(0, 12).toUpperCase()
    };
  } catch (_) {
    return null;
  }
}

// Use the live table name used by the app (`orders`).
const CASE_TABLE = 'orders';

// ---------------------------------------------------------------------------
// Theme 8 Phase 3 (OQ-7) — SILENT_FAILURE_EVENTS registry.
//
// Single source of truth for case_events labels that mean "code ran but did
// nothing useful" — silent no-ops, dropped notifications, failed
// reassignments. The /ops/silent-failures view (Phase 5) queries on these
// labels; the Theme 8 lint test asserts every new emit site uses a label
// declared here. When you add a new silent-failure shape:
//
//   1. Add the literal here (UPPER_SNAKE_CASE, suffix _SKIPPED / _FAILED
//      / _DROPPED / _NO_OP).
//   2. Emit via `logCaseEvent(caseId, '<LABEL>', { reason, ... })` at the
//      site where the code chose to no-op instead of acting.
//   3. The Phase 5 view picks it up automatically.
//
// Forensic context: SLA_PAUSE_SKIPPED was emitted to case_events for
// MONTHS of production traffic (every doctor reject-files call) before
// migration 047 added the missing schema columns — but no UI surfaced
// it. This registry exists so the next one doesn't go undetected.
// ---------------------------------------------------------------------------
const SILENT_FAILURE_EVENTS = Object.freeze([
  'SLA_PAUSE_SKIPPED',          // case_lifecycle.pauseSla — schema columns missing
  'SLA_RESUME_SKIPPED',         // case_lifecycle.resumeSla — schema columns missing
  'CASE_REASSIGNMENT_FAILED',   // case_sla_worker — no eligible doctor after breach/timeout
  'NOTIFICATION_DROPPED',       // notify.queueNotification — invalid recipient / no channel / DB insert failed
  // AUDIT-ACCEPT-4 — workers/acceptance_watcher: the doctor_assignments mirror
  // INSERT failed after the orders row was already claimed. Used to be a bare
  // `catch {}`; the case it stranded was the definition of a silent failure.
  'ASSIGNMENT_MIRROR_FAILED',
  // AUDIT-2026-08-22 — case_lifecycle.reassignCase, no-alternate-doctor branch.
  // Both were a bare `catch (e) {}` around an UPDATE that had quietly grown to
  // six columns. CASE_UNASSIGN_FAILED is the serious one: the case is sitting at
  // REASSIGNED with a doctor still attached, which matches no sweep at all.
  'CASE_UNASSIGN_FAILED',
  'CASE_SLA_RESET_FAILED'
]);


function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// PAYMENT CONFIRMATION (single source of truth)
//
// Goal: tighten payment→SLA boundary. If the schema includes `payment_status`,
// require it to be 'paid' (case-insensitive). Otherwise fall back to `paid_at`.
// ---------------------------------------------------------------------------
async function hasColumn(tableName, columnName) {
  try {
    const row = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
      [tableName, columnName]
    );
    return !!row;
  } catch {
    return false;
  }
}

// These flags are resolved lazily at first use, then cached.
let _columnCacheReady = false;
let HAS_PAYMENT_STATUS_COLUMN = false;
let HAS_SLA_PAUSED_AT_COLUMN = false;
let HAS_SLA_REMAINING_SECONDS_COLUMN = false;
let HAS_ASSIGNED_AT_COLUMN = false;

async function ensureColumnCache() {
  if (_columnCacheReady) return;
  const [a, b, c, d] = await Promise.all([
    hasColumn(CASE_TABLE, 'payment_status'),
    hasColumn(CASE_TABLE, 'sla_paused_at'),
    hasColumn(CASE_TABLE, 'sla_remaining_seconds'),
    hasColumn(CASE_TABLE, 'assigned_at')
  ]);
  HAS_PAYMENT_STATUS_COLUMN = a;
  HAS_SLA_PAUSED_AT_COLUMN = b;
  HAS_SLA_REMAINING_SECONDS_COLUMN = c;
  HAS_ASSIGNED_AT_COLUMN = d;
  _columnCacheReady = true;
}

function isPaymentConfirmed(orderRow) {
  if (!orderRow) return false;
  if (!orderRow.paid_at) return false;

  // If we have a payment_status column, enforce it.
  if (HAS_PAYMENT_STATUS_COLUMN) {
    const ps = String(orderRow.payment_status || '').trim().toLowerCase();
    if (ps === 'paid') return true;

    // Backward-compat: allow legacy rows where status itself was set to 'paid'
    // (but only if paid_at exists).
    const st = String(orderRow.status || '').trim().toLowerCase();
    if (!ps && st === 'paid') return true;

    return false;
  }

  // No payment_status column available → paid_at is the only signal.
  return true;
}


async function hasSlaBreachAlert(caseId) {
  try {
    const row = await queryOne(`
        SELECT 1
        FROM notifications
        WHERE channel = 'whatsapp'
          AND template = 'sla_breach'
          AND response->>'case_id' = $1
        LIMIT 1
      `, [String(caseId)]);
    return Boolean(row);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Automated SLA Reminder Support (WhatsApp + Email) with Dedupe + Guardrails
// ---------------------------------------------------------------------------
async function hasNotificationByDedupeKey(dedupeKey) {
  if (!dedupeKey) return false;
  try {
    const row = await queryOne(
      `SELECT 1 FROM notifications WHERE dedupe_key = $1 LIMIT 1`,
      [dedupeKey]
    );
    return Boolean(row);
  } catch {
    return false;
  }
}

function safeUserId(value) {
  const v = String(value || '').trim();
  return v.length ? v : null;
}

function getPatientUserIdFromOrder(orderRow) {
  // Be defensive across schemas.
  return (
    safeUserId(orderRow && (orderRow.patient_user_id || orderRow.patient_id || orderRow.user_id || orderRow.to_user_id))
  );
}

function getDoctorUserIdFromOrder(orderRow) {
  return safeUserId(orderRow && orderRow.doctor_id);
}

function secondsUntilDeadline(orderRow) {
  const deadline = orderRow && orderRow.deadline_at;
  if (!deadline) return null;

  const deadlineMs = new Date(deadline).getTime();
  if (!Number.isFinite(deadlineMs)) return null;

  const nowMs = Date.now();
  return Math.floor((deadlineMs - nowMs) / 1000);
}

function isActiveForSlaReminders(canonStatus) {
  return [
    CASE_STATUS.IN_REVIEW,
    CASE_STATUS.REJECTED_FILES,
    CASE_STATUS.SLA_BREACH
  ].includes(canonStatus);
}

function deadlineFromAcceptance(orderRow) {
  const accepted = orderRow && orderRow.accepted_at;
  const hours = Number(orderRow && orderRow.sla_hours) || 0;
  if (!accepted || !hours) return null;

  const acceptedMs = new Date(accepted).getTime();
  if (!Number.isFinite(acceptedMs)) return null;

  return new Date(acceptedMs + hours * 60 * 60 * 1000).toISOString();
}

function shouldUpdateDeadline(existingDeadline, expectedDeadline, { toleranceSeconds = 120 } = {}) {
  if (!expectedDeadline) return false;
  if (!existingDeadline) return true;

  const a = new Date(existingDeadline).getTime();
  const b = new Date(expectedDeadline).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;

  return Math.abs(a - b) > toleranceSeconds * 1000;
}

async function queueSlaReminder({ caseId, level, toUserId, channel, role, secondsRemaining }) {
  const userId = safeUserId(toUserId);
  if (!userId) return { ok: false, skipped: 'missing_toUserId' };

  const dedupeKey = `sla:${level}:${channel}:${role}:${caseId}:${userId}`;
  if (await hasNotificationByDedupeKey(dedupeKey)) {
    return { ok: true, deduped: true };
  }

  // Best-effort: queueNotification returns {ok:false} on failure (do not throw).
  try {
    const { queueNotification } = require('./notify');
    return queueNotification({
      // REGRESSION FIX (F4) — `orderId` was omitted, so notifications.order_id
      // was NULL on every SLA reminder. notification_worker joins the order row
      // off that column, so the whole downstream enrichment collapsed:
      //   * email  — `caseUrl` resolved to '' and `{{#if caseUrl}}` dropped the
      //              "Open Case" button, leaving the doctor's deadline email
      //              with no call to action at all. `slaHours` was empty too.
      //   * whatsapp — the OpenClaw doctor body rendered
      //              `/portal/doctor/case/` with no id: a dead link.
      // The case id IS the order id everywhere else in this module (see
      // dispatchUnpaidCaseReminders, markCasePaid), so pass it.
      orderId: caseId,
      channel,
      toUserId: userId,
      template: `sla_reminder_${level}`,
      dedupeKey,
      dedupe_key: dedupeKey,
      response: {
        case_id: caseId,
        role,
        level,
        seconds_remaining: secondsRemaining
      }
    });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function dispatchSlaReminders(caseIdOrRow, opts = {}, client) {
  await ensureColumnCache();
  const force = Boolean(opts.force);
  const orderRow = (caseIdOrRow && typeof caseIdOrRow === 'object') ? caseIdOrRow : await getCase(caseIdOrRow, client);
  if (!orderRow) return { ok: false, skipped: 'missing_case' };

  const caseId = orderRow.id;
  const canonStatus = normalizeStatus(orderRow.status);

  // Guardrails
  if (!isPaymentConfirmed(orderRow)) return { ok: false, skipped: 'unpaid' };

  if (isTerminalStatus(canonStatus)) return { ok: true, skipped: 'terminal' };
  if (!isActiveForSlaReminders(canonStatus)) return { ok: true, skipped: 'not_active' };

  // SLA starts at acceptance (accepted_at): BACKFILL deadline_at from
  // accepted_at + sla_hours when it is missing or provably stale.
  //
  // AUDIT-SLA-10 — this used to force-rewrite deadline_at to accepted_at +
  // sla_hours whenever the stored value differed by more than 2 minutes. That
  // was harmless while nothing called runSlaReminderSweep. Wired onto a
  // 5-minute cadence it becomes destructive: it silently reverts
  //   * an admin SLA extension (routes/api/admin.js:1416-1442 writes a longer
  //     deadline_at and clears breached_at),
  //   * a pause credit (pauseSla stores sla_remaining_seconds and resumeSla
  //     writes a deadline that is deliberately NOT accepted_at + sla_hours),
  //   * the calendar anchor on an urgent case paid outside the Cairo window
  //     (markCasePaid, AUDIT-PAY-1),
  // and it does so every 5 minutes, so a human extension would not survive one
  // sweep tick. The patient's clock would silently snap back and the case would
  // breach on a deadline nobody chose.
  //
  // The rule is now: never move a deadline that someone deliberately set, and
  // never move one EARLIER. Write only when
  //   (a) there is no deadline at all — the genuine backfill case; or
  //   (b) the stored deadline is at or before accepted_at, which no valid
  //       post-acceptance SLA can be. That shape is the legacy paid-anchored
  //       value (paid_at + sla_hours written before the model moved to
  //       acceptance) and repairing it moves the deadline LATER, in the
  //       doctor's favour, never into a surprise breach.
  // A paused case is skipped outright: its stored deadline is stale on purpose
  // (see AUDIT-P0-4 in case_sla_worker.fetchSlaCandidates) and resumeSla owns
  // recomputing it.
  if ([CASE_STATUS.IN_REVIEW, CASE_STATUS.SLA_BREACH].includes(canonStatus) &&
      orderRow.sla_hours &&
      !orderRow.sla_paused_at) {
    const expected = deadlineFromAcceptance(orderRow);
    if (expected) {
      const acceptedMs = new Date(orderRow.accepted_at).getTime();
      const currentMs = orderRow.deadline_at ? new Date(orderRow.deadline_at).getTime() : null;
      const missing = !orderRow.deadline_at || !Number.isFinite(currentMs);
      const staleLegacyAnchor = !missing && Number.isFinite(acceptedMs) && currentMs <= acceptedMs;
      if ((missing || staleLegacyAnchor) && shouldUpdateDeadline(orderRow.deadline_at, expected)) {
        try {
          await updateCase(orderRow.id, { deadline_at: expected }, client);
          orderRow.deadline_at = expected;
          await logCaseEvent(orderRow.id, 'SLA_DEADLINE_BACKFILLED', {
            from: currentMs ? new Date(currentMs).toISOString() : null,
            to: expected,
            reason: missing ? 'missing_deadline' : 'deadline_at_or_before_acceptance'
          }, client);
        } catch (e) {
          return { ok: false, skipped: 'deadline_backfill_failed' };
        }
      }
    }
  }

  const secondsRemaining = secondsUntilDeadline(orderRow);
  if (secondsRemaining == null) return { ok: false, skipped: 'missing_deadline' };

  // If a case was previously marked as breached under the old model,
  // but the acceptance-based deadline is still in the future, un-breach it.
  //
  // ── REGRESSION FIX (F11) — clear `breached_at` in the same transition. ───
  //
  // This path was dormant for as long as nothing called runSlaReminderSweep.
  // Wiring the sweep onto a 5-minute cadence activated it, and it flipped
  // SLA_BREACH -> IN_REVIEW while LEAVING breached_at set. case_sla_worker's
  // fetchSlaCandidates filters `breached_at IS NULL`, so a case un-breached
  // here became permanently un-breachable: the doctor could then miss the
  // deadline by any margin and there would be no breach, no escalation, no
  // reassignment and no breach refund — for the rest of that case's life.
  //
  // The stamp is meaningless once the status it recorded has been reverted;
  // this is the same reset assignDoctor performs on a REASSIGNED -> ASSIGNED
  // hop (AUDIT-SLA-6) and admin's SLA-extension endpoint performs on extend.
  // Nulling it restores the case to a normal, sweepable IN_REVIEW row.
  if (!force && canonStatus === CASE_STATUS.SLA_BREACH && secondsRemaining > 0) {
    try {
      await transitionCase(caseId, CASE_STATUS.IN_REVIEW, { breached_at: null }, client);
      orderRow.breached_at = null;
      orderRow.status = CASE_STATUS.IN_REVIEW;
      await logCaseEvent(caseId, 'SLA_BREACH_CLEARED', {
        reason: 'deadline_in_future_under_acceptance_model',
        seconds_remaining: secondsRemaining
      }, client);
    } catch (e) {
      // best-effort
    }
  }

  // Do not send reminders after deadline unless forced (breach flow handles escalation).
  if (!force && secondsRemaining <= 0) return { ok: true, skipped: 'past_deadline' };

  // Thresholds: send once when remaining time drops below these windows.
  // Keep it simple and stable: 24h, 6h, 1h.
  const thresholds = [
    { level: '24h', seconds: 24 * 60 * 60 },
    { level: '6h', seconds: 6 * 60 * 60 },
    { level: '1h', seconds: 60 * 60 }
  ];

  const toDoctorId = getDoctorUserIdFromOrder(orderRow);
  const toPatientId = getPatientUserIdFromOrder(orderRow);

  // AUDIT-SLA-10 — fire ONLY the tightest bucket the remaining time falls into,
  // not every bucket it is under. The old loop sent every threshold whose
  // window had been crossed, so the first time a case was seen it emitted all
  // the applicable levels at once: an URGENT case (4h SLA) got told "24 hours
  // remaining" AND "6 hours remaining" in the same tick, both untrue, four
  // messages per recipient. Because nothing ever called this sweep, that burst
  // has never been observed — turning it on would have made it the normal
  // behaviour for every urgent and VIP case, and the first sweep after deploy
  // would have done it to the entire live book at once.
  //
  // Dedupe is per (level, channel, role, case, user), so escalating 24h -> 6h
  // -> 1h across later ticks still works: each tighter level is a new key and
  // sends once, while the level already sent is suppressed by
  // hasNotificationByDedupeKey.
  const dueThresholds = thresholds.filter((t) => secondsRemaining <= t.seconds);
  const activeThresholds = dueThresholds.length
    ? [dueThresholds[dueThresholds.length - 1]]
    : [];

  const sent = [];
  for (const t of activeThresholds) {
    // Doctor
    if (toDoctorId) {
      sent.push(await queueSlaReminder({
        caseId,
        level: t.level,
        toUserId: toDoctorId,
        channel: 'whatsapp',
        role: 'doctor',
        secondsRemaining
      }));
      sent.push(await queueSlaReminder({
        caseId,
        level: t.level,
        toUserId: toDoctorId,
        channel: 'email',
        role: 'doctor',
        secondsRemaining
      }));
    }

    // Patient
    if (toPatientId) {
      sent.push(await queueSlaReminder({
        caseId,
        level: t.level,
        toUserId: toPatientId,
        channel: 'whatsapp',
        role: 'patient',
        secondsRemaining
      }));
      sent.push(await queueSlaReminder({
        caseId,
        level: t.level,
        toUserId: toPatientId,
        channel: 'email',
        role: 'patient',
        secondsRemaining
      }));
    }
  }

  return { ok: true, caseId, secondsRemaining, sentCount: sent.length };
}

let _slaReminderSweepRunning = false;

async function runSlaReminderSweep({ limit = 200 } = {}) {
  // AUDIT-SLA-10 — re-entrancy guard. This sweep is exported and was, until
  // launch, called by nobody; it is now registered on a 5-minute cadence
  // (server.js runSlaEnforcementSweep). Each row costs several round trips, so
  // a backlog run can outlive its interval. server.js has its own
  // slaEnforcementRunning flag, but this must be safe when called directly
  // (pg-boss, an ops endpoint, a test) too — every other worker in this
  // codebase carries the same guard (case_sla_worker._slaSweepRunning,
  // acceptance_watcher.running).
  if (_slaReminderSweepRunning) {
    return { ok: true, processed: 0, skipped: 'already_running' };
  }
  _slaReminderSweepRunning = true;
  try {
    return await _runSlaReminderSweepInner({ limit });
  } finally {
    _slaReminderSweepRunning = false;
  }
}

async function _runSlaReminderSweepInner({ limit = 200 } = {}) {
  await ensureColumnCache();
  // Periodic sweep entrypoint (registered from server.js).
  // Only targets paid, non-terminal cases with a deadline.
  try {
    const paymentClause = HAS_PAYMENT_STATUS_COLUMN
      ? " AND (LOWER(COALESCE(payment_status,'')) = 'paid')"
      : '';

    const rows = await queryAll(
      `SELECT *
       FROM ${CASE_TABLE}
       WHERE paid_at IS NOT NULL${paymentClause}
         AND LOWER(status) NOT IN ('completed','cancelled')
         AND deleted_at IS NULL
         AND (
           deadline_at IS NOT NULL
           OR LOWER(COALESCE(status,'')) IN ('in_review','rejected_files','sla_breach','breached','delayed','overdue')
         )
       ORDER BY COALESCE(deadline_at, accepted_at, created_at) ASC
       LIMIT $1`,
      [limit]
    );

    let processed = 0;
    for (const r of rows) {
      // One bad row must not abort the sweep — dispatchSlaReminders returns
      // {ok:false} for its own guard paths but can still throw on a DB blip,
      // and rows are ordered by deadline, so an early throw would starve every
      // case behind it on every tick.
      try {
        await dispatchSlaReminders(r);
      } catch (e) {
        console.error('[sla-reminders] case ' + r.id + ' failed:', e && e.message);
      }
      processed++;
    }

    // The LIMIT is a safety valve, not a page: rows are ordered by deadline
    // ASC, so a backlog larger than `limit` means the newest cases are never
    // reached on any tick. Reminders already sent are deduped, so the practical
    // effect is a stuck head — worth an ops line rather than silence.
    if (rows.length >= limit) {
      console.warn('[sla-reminders] sweep hit its LIMIT of ' + limit +
                   ' rows — cases past the cutoff got no reminder this tick');
    }
    return { ok: true, processed };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Automated Unpaid Case Reminder Support (WhatsApp + Email) with Dedupe
// ---------------------------------------------------------------------------
function secondsSinceCreated(orderRow) {
  const createdAt = orderRow && orderRow.created_at;
  if (!createdAt) return null;
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) return null;
  return Math.floor((Date.now() - createdMs) / 1000);
}

// ── REGRESSION FIX (F12) — what "unpaid" means for the sweep. ─────────────
//
// The unpaid sweep is destructive: it sends payment chasers, expires the case
// at 24h and SOFT-DELETES it at 48h with a "your unpaid case was deleted"
// notification. Its eligibility test keyed on a `!= 'paid'` blacklist, so ANY
// payment_status that is not the literal string 'paid' read as "never paid" —
// including 'refunded' and 'captured'. A patient who paid and was then
// refunded therefore received payment reminders for a case they had already
// settled, and at 48h had it deleted out from under them with copy blaming
// them for not paying.
//
// Two independent gates now, and BOTH must say unpaid:
//
//   1. `paid_at IS NULL`. This is the primary gate because it cannot drift:
//      it is stamped exactly once, by markCasePaid, and no later state change
//      (refund, chargeback, partial refund, capture-vs-settle) rewrites it.
//      A blacklist of payment_status values has to be extended every time a
//      new value is introduced, and F12 is the second time that has been
//      missed.
//   2. The payment_status set below, kept as a backstop for any row whose
//      paid_at was never stamped by a legacy or third-party write path.
//
// Listing values that mean "money moved" is deliberately broader than 'paid':
// every one of them describes a case that must never be chased for payment.
const PAYMENT_STATUSES_MEANING_MONEY_MOVED = Object.freeze([
  'paid',
  'captured',
  'refunded',
  'partially_refunded'
]);

// The same list as a SQL literal list, so the JS guard and every SQL predicate
// in the sweep are generated from ONE array and cannot drift apart. Values are
// hardcoded lowercase identifiers above — no interpolation risk.
const UNPAID_SWEEP_STATUS_SQL_LIST = PAYMENT_STATUSES_MEANING_MONEY_MOVED
  .map((s) => `'${s}'`)
  .join(', ');

function hasMoneyMoved(orderRow) {
  if (!orderRow) return false;
  if (orderRow.paid_at) return true;
  if (HAS_PAYMENT_STATUS_COLUMN) {
    const ps = String(orderRow.payment_status || '').trim().toLowerCase();
    if (PAYMENT_STATUSES_MEANING_MONEY_MOVED.includes(ps)) return true;
  }
  return false;
}

function isUnpaidReminderEligible(orderRow) {
  if (!orderRow) return false;
  const canonStatus = normalizeStatus(orderRow.status);

  if (orderRow.completed_at) return false;
  if (isTerminalStatus(canonStatus)) return false;
  // AUDIT-P1-4: was `canonStatus === 'EXPIRED'`, a value normalizeStatus never
  // produced — the sweep writes 'expired_unpaid', which canonicalises to
  // EXPIRED_UNPAID. The guard therefore never fired and expired cases kept
  // receiving payment reminders. (EXPIRED is now an alias, so both work.)
  if (canonStatus === CASE_STATUS.EXPIRED_UNPAID) return false;

  if (hasMoneyMoved(orderRow)) return false;

  return true;
}

function getPaymentUrlFromOrder(orderRow) {
  return (orderRow && (orderRow.payment_link || orderRow.payment_url)) || null;
}

async function queuePaymentReminder({ caseId, level, toUserId, channel, paymentUrl, elapsedSeconds }) {
  const userId = safeUserId(toUserId);
  if (!userId) return { ok: false, skipped: 'missing_toUserId' };

  const dedupeKey = `payment_reminder:${level}:${channel}:${caseId}:${userId}`;
  if (await hasNotificationByDedupeKey(dedupeKey)) {
    return { ok: true, deduped: true };
  }

  try {
    const { queueNotification, buildPaymentReminderPayload } = require('./notify');
    // #66: hours_remaining = 48h hard-stop (soft-delete) minus elapsed.
    // Templates read this to show patients the actual final-release
    // window rather than inventing a number. Floored to whole hours;
    // clamped to 0 so a late sweep never produces a negative.
    const hoursRemaining = Number.isFinite(elapsedSeconds)
      ? Math.max(0, 48 - Math.floor(elapsedSeconds / 3600))
      : null;
    return queueNotification({
      channel,
      toUserId: userId,
      template: `payment_reminder_${level}`,
      dedupeKey,
      dedupe_key: dedupeKey,
      response: {
        ...buildPaymentReminderPayload({ caseId, paymentUrl }),
        elapsed_seconds: elapsedSeconds,
        hours_remaining: hoursRemaining,
        level
      }
    });
  } catch (e) {
    console.error('[unpaid-reminder] queue failed', e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}


async function dispatchUnpaidCaseReminders(caseIdOrRow, opts = {}) {
  await ensureColumnCache();
  const force = Boolean(opts.force);
  const limit = Number(opts.limit || 200);

  if (!caseIdOrRow) {
    try {
      // REGRESSION FIX (F12) — `paid_at IS NULL` is now unconditional, and the
      // payment_status test is a NOT IN over every value that means money
      // moved (see PAYMENT_STATUSES_MEANING_MONEY_MOVED). The old form was
      // `!= 'paid'` OR-else-paid_at, so with the column present a refunded
      // order passed the filter and entered the destructive sweep. Mirrors
      // isUnpaidReminderEligible exactly, so the SQL pre-filter and the JS
      // per-row check cannot disagree.
      const paymentClause = HAS_PAYMENT_STATUS_COLUMN
        ? ' AND paid_at IS NULL' +
          ` AND (payment_status IS NULL OR LOWER(TRIM(payment_status)) NOT IN (${UNPAID_SWEEP_STATUS_SQL_LIST}))`
        : ' AND paid_at IS NULL';

      // AUDIT-2026-08-22 — the exclusion list carried the bare strings
      // 'expired'/'EXPIRED' but NOT 'expired_unpaid', which is the value HARD
      // STOP #1 below actually writes. So every row this sweep expired at 24h
      // was re-selected on the very next tick and stayed selectable until the
      // 48h soft-delete. With `ORDER BY created_at ASC LIMIT 200` those rows
      // are the OLDEST, so they sit at the head of the page: once ~200 of them
      // accumulate inside a 24h window, newer unpaid cases fall off the end and
      // stop receiving payment reminders altogether.
      //
      // dbStatusValuesFor(EXPIRED_UNPAID) already contains 'expired'/'EXPIRED'
      // plus both spellings of 'expired_unpaid', so it replaces the literals
      // rather than adding to them. De-duplicated because the variant lists
      // repeat the canonical key (harmless in an IN list, noisy in a log).
      const terminalStatuses = [...new Set([
        ...dbStatusValuesFor(CASE_STATUS.COMPLETED),
        ...dbStatusValuesFor(CASE_STATUS.CANCELLED),
        ...dbStatusValuesFor(CASE_STATUS.EXPIRED_UNPAID)
      ])];
      const placeholders = terminalStatuses.map((_, i) => `$${i + 1}`).join(', ');

      const rows = await queryAll(
        `SELECT *
         FROM ${CASE_TABLE}
         WHERE created_at IS NOT NULL${paymentClause}
           AND COALESCE(status, '') NOT IN (${placeholders})
           AND deleted_at IS NULL
         ORDER BY created_at ASC
         LIMIT $${terminalStatuses.length + 1}`,
        [...terminalStatuses, limit]
      );

      let sentCount = 0;
      const skipped = [];

      for (const r of rows) {
        const res = await dispatchUnpaidCaseReminders(r, { force });
        if (res && typeof res.sentCount === 'number') {
          sentCount += res.sentCount;
        }
        if (res && res.skipped) {
          skipped.push({ caseId: r.id, reason: res.skipped });
        }
      }

      return { ok: true, sentCount, skipped };
    } catch (e) {
      console.error('[unpaid-reminder] sweep failed', e);
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  const orderRow =
    caseIdOrRow && typeof caseIdOrRow === 'object'
      ? caseIdOrRow
      : await getCase(caseIdOrRow);
  if (!orderRow) return { ok: false, sentCount: 0, skipped: 'missing_case' };

  const caseId = orderRow.id;
  if (!isUnpaidReminderEligible(orderRow)) {
    return { ok: true, sentCount: 0, skipped: 'not_eligible' };
  }

  const elapsedSeconds = secondsSinceCreated(orderRow);
  if (elapsedSeconds == null) {
    return { ok: true, sentCount: 0, skipped: 'missing_created_at' };
  }
  // HARD STOP #1: expire unpaid cases between 24h and 48h
  //
  // REGRESSION FIX (F12) — the predicate was `payment_status != 'paid'`, which
  // is true for 'refunded'. These two HARD STOP statements are the last line of
  // defence: they re-assert the unpaid condition inside the UPDATE so a stale
  // in-memory orderRow cannot expire or delete a case that has since been paid.
  // That guarantee only holds if the predicate agrees with
  // isUnpaidReminderEligible — it now does, on both gates.
  //
  // AUDIT-2026-08-22 — the status test is `LOWER(status) NOT IN (...)`. It was
  // written unfolded, and orders.status holds BOTH cases (the canonical writer
  // stores 'COMPLETED', raw SQL stores 'completed'), so an already-COMPLETED
  // row passed the guard and could be stamped expired_unpaid. LOWER(), not
  // LOWER(COALESCE(...)): a NULL status must keep behaving exactly as before
  // (predicate NULL -> no update), which the COALESCE form would change.
  if (!force && elapsedSeconds >= 24 * 60 * 60 && elapsedSeconds < 48 * 60 * 60) {
    await execute(`
      UPDATE ${CASE_TABLE}
      SET status = 'expired_unpaid'
      WHERE id = $1
        AND paid_at IS NULL
        AND (payment_status IS NULL OR LOWER(TRIM(payment_status)) NOT IN (${UNPAID_SWEEP_STATUS_SQL_LIST}))
        AND LOWER(status) NOT IN ('completed','expired_unpaid')
    `, [orderRow.id]);

    return { ok: true, sentCount: 0, skipped: 'expired_unpaid' };
  }

  // HARD STOP #2: soft-delete unpaid cases at 48h, notify patient once.
  // Idempotent — `deleted_at IS NULL` guard makes re-runs no-ops.
  //
  // TECH DEBT: orders.deleted_at is `timestamp with time zone` while orders.updated_at
  // is `timestamp without time zone`. Binding the same $1 to both made Postgres deduce
  // two conflicting types ("inconsistent types deduced for parameter $1"), failing every
  // sweep. We pass the timestamp as TWO separate parameters here so each casts cleanly
  // against its column type. A schema migration to align deleted_at to tz-naive (or
  // updated_at to tz-aware) is the proper fix but is deferred — touching every order
  // every time would be a heavy migration.
  if (!force && elapsedSeconds >= 48 * 60 * 60) {
    const ts = nowIso();
    const result = await execute(`
      UPDATE ${CASE_TABLE}
      SET deleted_at = $1,
          status = 'expired_unpaid',
          updated_at = $2
      WHERE id = $3
        AND deleted_at IS NULL
        AND paid_at IS NULL
        AND (payment_status IS NULL OR LOWER(TRIM(payment_status)) NOT IN (${UNPAID_SWEEP_STATUS_SQL_LIST}))
    `, [ts, ts, orderRow.id]);

    if (result && result.rowCount > 0) {
      const toPatientId = getPatientUserIdFromOrder(orderRow);
      if (toPatientId) {
        try {
          const { queueNotification } = require('./notify');
          await queueNotification({
            orderId: orderRow.id,
            toUserId: toPatientId,
            channel: 'internal',
            template: 'case_auto_deleted_unpaid_patient',
            status: 'queued',
            dedupeKey: `auto_delete:${orderRow.id}`,
            response: {
              case_id: orderRow.id,
              reference_id: orderRow.reference_id || null,
              reason: 'unpaid_48h'
            }
          });
        } catch (e) {
          // Best-effort: notification failure must not roll back the soft-delete.
          console.error('[unpaid-reminder] auto-delete notification failed', e && e.message);
        }
      }
      try {
        await logCaseEvent(orderRow.id, 'CASE_AUTO_DELETED_UNPAID', {
          elapsed_hours: Math.floor(elapsedSeconds / 3600)
        });
      } catch (_) {}
    }

    return { ok: true, sentCount: 0, skipped: 'auto_deleted' };
  }

  const toPatientId = getPatientUserIdFromOrder(orderRow);
  if (!toPatientId) {
    return { ok: true, sentCount: 0, skipped: 'missing_patient' };
  }

  const paymentUrl = getPaymentUrlFromOrder(orderRow);

  const thresholds = [
    { level: '30m', seconds: 30 * 60 },
    { level: '6h', seconds: 6 * 60 * 60 },
    { level: '24h', seconds: 24 * 60 * 60 }
  ];

  const sent = [];
  for (const t of thresholds) {
    if (force || elapsedSeconds >= t.seconds) {
      sent.push(await queuePaymentReminder({
        caseId,
        level: t.level,
        toUserId: toPatientId,
        channel: 'whatsapp',
        paymentUrl,
        elapsedSeconds
      }));
      sent.push(await queuePaymentReminder({
        caseId,
        level: t.level,
        toUserId: toPatientId,
        channel: 'email',
        paymentUrl,
        elapsedSeconds
      }));
    }
  }

  if (!sent.length) {
    return { ok: true, sentCount: 0, skipped: 'not_due' };
  }

  return { ok: true, sentCount: sent.length, skipped: null };
}


const CASE_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  PAID: 'PAID',
  ASSIGNED: 'ASSIGNED',
  IN_REVIEW: 'IN_REVIEW',
  REJECTED_FILES: 'REJECTED_FILES',
  COMPLETED: 'COMPLETED',
  SLA_BREACH: 'SLA_BREACH',
  // AUDIT-STATE-8 — BREACHED_SLA and DELAYED used to be frozen in here as
  // "compatibility" canonical statuses. They were dead on arrival:
  // STATUS_ALIASES maps both to SLA_BREACH (see below), and normalizeStatus
  // consults STATUS_ALIASES FIRST, so it could never return either name. What
  // they DID do was widen assertCanonicalDbStatus's accept-list to two statuses
  // that have no STATUS_TRANSITIONS entry, no CASE_STATUS_UI entry and no
  // DB_STATUS variant of their own — i.e. two ways to write a status that
  // nothing downstream could route or render.
  //
  // They are NOT gone from the codebase: STATUS_ALIASES and DB_STATUS_VARIANTS
  // still carry both spellings, which is where legacy DB values belong. Callers
  // that pass the literal 'BREACHED_SLA' / 'DELAYED' to statusDbValues()
  // (routes/admin.js:656,803,1036 and routes/superadmin.js:1246,1453) are
  // unaffected: those go through normalizeStatus → STATUS_ALIASES → SLA_BREACH
  // → the SLA_BREACH variant list, exactly as they did before.
  REASSIGNED: 'REASSIGNED',
  CANCELLED: 'CANCELLED',
  // AUDIT-P1-4 — first-class statuses that were previously written by raw SQL
  // which deliberately bypassed assertCanonicalDbStatus, and appeared in NO
  // map: not CASE_STATUS, not STATUS_ALIASES, not STATUS_TRANSITIONS, not
  // CASE_STATUS_UI, not DB_STATUS_VARIANTS. normalizeStatus produced
  // 'EXPIRED_UNPAID', assertTransition then threw
  // "No transitions defined from EXPIRED_UNPAID" for EVERY target, and
  // getStatusUi fell through to its raw-string fallback so patients literally
  // saw the badge text "EXPIRED_UNPAID".
  EXPIRED_UNPAID: 'EXPIRED_UNPAID',
  PENDING_REVIEW: 'PENDING_REVIEW',
  // AUDIT 2026-08-17 — 'refunded' was a status the codebase READ in eight
  // places and NOTHING ever wrote.
  //
  // auto_assign.js TERMINAL_STATUSES, admin_bulk_assign's LOAD_EXCLUDED_STATUSES
  // (twice), three doctor-load calculations in routes/api/admin.js, its status
  // guard, and routes/api/cases.js's closed-case filter all test for
  // 'refunded' — but no code path could produce it. The only route to that
  // value was a superadmin manually overriding payment_status by hand.
  //
  // The consequence, observed on live data: a case refunded IN FULL kept
  // status='in_progress' and payment_status='paid', so it stayed an active
  // case, kept occupying one of its doctor's four concurrent slots, remained
  // eligible for reassignment, and sat in the Command app's "NEEDS ACTION NOW"
  // card permanently — three months past a dead deadline.
  //
  // Making it first-class turns all eight of those readers from dead code into
  // working code. See services/refund_closure.js for the writer.
  REFUNDED: 'REFUNDED'
});

// Legacy / UI-facing status aliases -> canonical CASE_STATUS
// This prevents old values like "new", "accepted", "breached" from leaking into templates.
const STATUS_ALIASES = Object.freeze({
  NEW: CASE_STATUS.SUBMITTED,
  PENDING: CASE_STATUS.SUBMITTED,

  // Some parts of the app historically used ACCEPTED to mean the case is assigned/active
  ACCEPTED: CASE_STATUS.ASSIGNED,

  // Common variations
  IN_PROGRESS: CASE_STATUS.IN_REVIEW,
  INREVIEW: CASE_STATUS.IN_REVIEW,

  // Files requested / rejected files synonyms
  FILES_REQUESTED: CASE_STATUS.REJECTED_FILES,
  FILE_REQUESTED: CASE_STATUS.REJECTED_FILES,
  MORE_INFO_NEEDED: CASE_STATUS.REJECTED_FILES,

  // Breach synonyms
  BREACHED: CASE_STATUS.SLA_BREACH,
  SLA_BREACHED: CASE_STATUS.SLA_BREACH,
  BREACHED_SLA: CASE_STATUS.SLA_BREACH,
  SLA_BREACH: CASE_STATUS.SLA_BREACH,
  DELAYED: CASE_STATUS.SLA_BREACH,
  OVERDUE: CASE_STATUS.SLA_BREACH,

  // Completion synonyms
  DONE: CASE_STATUS.COMPLETED,
  FINISHED: CASE_STATUS.COMPLETED,

  // Cancelled synonyms
  CANCELLED: CASE_STATUS.CANCELLED,
  CANCELED: CASE_STATUS.CANCELLED,
  CANCEL: CASE_STATUS.CANCELLED,

  // AUDIT-P1-4
  EXPIRED: CASE_STATUS.EXPIRED_UNPAID,
  EXPIRED_UNPAID: CASE_STATUS.EXPIRED_UNPAID,
  PENDING_REVIEW: CASE_STATUS.PENDING_REVIEW
});

// Resolve SLA hours from an orders row. The orders row's sla_hours
// column is the source of truth — locked at order creation by the
// patient wizard's Step 4 or by the mobile API at intake.
//
// Per docs/PAYOUT_AND_URGENCY_POLICY.md §2:
//   Standard 48h, VIP 18h, Urgent 4h.
//
// Fallback: when sla_hours is NULL, undefined, 0, or non-finite —
// i.e., legacy DRAFT rows that never reached Step 4, or pre-wizard
// rows — default to the canonical Standard value (48h). This is the
// safer choice than priority/urgent: missing data never accidentally
// accelerates an SLA promise we can't keep.
function resolveSlaHoursForCase(orderRow) {
  const v = orderRow && orderRow.sla_hours;
  const n = (v === null || v === undefined) ? null : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 48;
}

// AUDIT-P0-8 — canonical tier -> SLA hours. THE single source of truth.
//
// Four different maps existed: this file's fallback (48/18/4), the mobile API
// (48/18/4), routes/intake.js (72/24 — deleted with the guest funnel), and the
// accept-window default inside assignDoctor (72). Two patients could pick
// "standard" at the same price and be promised 48h or 72h depending on which
// form they used, and the doctor's acceptance window diverged with it.
// Per docs/PAYOUT_AND_URGENCY_POLICY.md §2. 'fast_track' is the legacy alias
// for 'vip' (migration 031 backfills existing rows).
const SLA_HOURS_BY_TIER = Object.freeze({
  urgent: 4,
  vip: 18,
  fast_track: 18,
  standard: 48
});

function slaHoursForTier(tier) {
  const key = String(tier || '').trim().toLowerCase();
  return SLA_HOURS_BY_TIER[key] || SLA_HOURS_BY_TIER.standard;
}

// Cairo time restriction for urgent tier (7am–7pm Cairo). Single source
// of truth: services/urgency_window (DST-aware via Intl — Egypt has DST
// again since April 2023, so local offset math is not safe here).
const { isUrgentWindowOpen, nextSevenAmCairoUtc } = require('./services/urgency_window');
const { acceptanceMinutesForOrder, acceptanceDeadlineIso } = require('./acceptance_window');

// ─────────────────────────────────────────────────────────────────────────────
// URGENT WINDOW — WORKING DAYS  (AUDIT-2026-08-22)
//
// There is no Friday/Saturday concept anywhere in this codebase today.
// isUrgentWindowOpen() gates on the Cairo HOUR only (07:00–18:59) and
// nextSevenAmCairoUtc() anchors to the next calendar 07:00 whatever day that
// lands on. So an urgent case paid at 19:02 on a Thursday is promised
// Friday 07:00 + 4h regardless of whether anyone is rostered on a Friday.
//
// WHY THIS IS CONFIGURATION AND NOT A POLICY. Asked about weekend cover the
// owner said "depends on doctor availability, I have no knowledge of
// coverage". Hardcoding Fri/Sat closed would invent a roster that does not
// exist; hardcoding nothing leaves the promise unbacked the day one does. So
// the working days are a setting, and THE DEFAULT IS ALL SEVEN DAYS — with the
// variable unset, behaviour is identical to before this change, byte for byte.
//
// TO SET IT once the roster exists (Cairo-local days):
//
//     URGENT_WINDOW_WORKING_DAYS=0,1,2,3,4      # Sun–Thu, the usual EG week
//     URGENT_WINDOW_WORKING_DAYS=sun,mon,tue,wed,thu
//
// 0=Sunday … 6=Saturday, comma separated; three-letter day names also work.
// Anything unparseable — or a value that parses to nothing — falls back to all
// seven days. A typo must never silently close the urgent tier.
//
// Deliberately ENV-ONLY rather than an admin_settings row: this is consulted
// from inside markCasePaid's payment transaction, where a DB read would take a
// SECOND pool connection while the orders row is held FOR UPDATE (see the
// "peak is 1" note in markCasePaid). If it must become live-tunable, resolve it
// BEFORE withTransaction() and pass the value in.
//
// HAND-OFF: routes/patient.js:2113 and routes/api/cases.js:358 call the bare
// isUrgentWindowOpen() and routes/patient.js:2207 the bare
// nextSevenAmCairoUtc(). Those files are owned elsewhere; they should switch to
// the two exports below so the sell-side gate and the pay-side anchor agree.
// ─────────────────────────────────────────────────────────────────────────────

const _DAY_NAME_TO_INDEX = Object.freeze({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 });
const _ALL_DAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);

function parseUrgentWorkingDays(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return _ALL_DAYS.slice();
  const out = [];
  for (const part of text.split(',')) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const idx = /^[0-6]$/.test(token) ? Number(token) : _DAY_NAME_TO_INDEX[token.slice(0, 3)];
    if (!Number.isInteger(idx)) continue;
    if (out.indexOf(idx) === -1) out.push(idx);
  }
  return out.length ? out : _ALL_DAYS.slice();
}

// Parsed once per distinct env value (re-parses if a test mutates process.env).
let _urgentWorkingDays = null;
let _urgentWorkingDaysRaw;
function urgentWorkingDays() {
  const raw = process.env.URGENT_WINDOW_WORKING_DAYS;
  if (_urgentWorkingDays === null || raw !== _urgentWorkingDaysRaw) {
    _urgentWorkingDaysRaw = raw;
    _urgentWorkingDays = parseUrgentWorkingDays(raw);
  }
  return _urgentWorkingDays;
}

// Cairo-local day of week (0=Sunday) for an instant. Via Intl, not a fixed
// offset — same reason services/urgency_window.js does: Egypt has DST again
// since 2023, so a UTC+2 assumption is wrong for half the year and can land the
// weekday on the wrong side of midnight.
const _CAIRO_WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', weekday: 'short' });
function cairoDayOfWeek(date) {
  const d = date || new Date();
  const idx = _DAY_NAME_TO_INDEX[String(_CAIRO_WEEKDAY_FMT.format(d)).slice(0, 3).toLowerCase()];
  return Number.isInteger(idx) ? idx : d.getUTCDay();
}

/** Urgent window open = inside the Cairo hours AND on a configured working day. */
function isUrgentWindowOpenNow(now) {
  const d = now || new Date();
  if (!isUrgentWindowOpen(d)) return false;
  return urgentWorkingDays().indexOf(cairoDayOfWeek(d)) !== -1;
}

/** The next 07:00 Cairo that falls on a configured working day, as a UTC Date. */
function nextUrgentWindowOpenUtc(now) {
  let target = nextSevenAmCairoUtc(now);
  const days = urgentWorkingDays();
  // At most 7 hops; nextSevenAmCairoUtc(07:00) returns the FOLLOWING day's
  // 07:00 (its `cur.hour >= 7` branch) and re-anchors across a DST change.
  for (let i = 0; i < 7 && days.indexOf(cairoDayOfWeek(target)) === -1; i++) {
    target = nextSevenAmCairoUtc(target);
  }
  return target;
}

const STATUS_TRANSITIONS = Object.freeze({
  [CASE_STATUS.DRAFT]: [CASE_STATUS.SUBMITTED],
  [CASE_STATUS.SUBMITTED]: [CASE_STATUS.PAID],
  // AUDIT 2026-08-17 — REFUNDED is reachable from every state in which the
  // patient's money is already taken. A full refund ends the case wherever it
  // had got to: sitting unassigned, with a doctor, mid-review, awaiting files,
  // or breached. It is terminal, so it has no outbound transitions.
  [CASE_STATUS.PAID]: [CASE_STATUS.ASSIGNED, CASE_STATUS.REFUNDED],
  [CASE_STATUS.ASSIGNED]: [
    CASE_STATUS.IN_REVIEW,
    CASE_STATUS.REJECTED_FILES,
    CASE_STATUS.REASSIGNED,
    CASE_STATUS.REFUNDED
  ],
  // AUDIT-2026-08-22 — REASSIGNED added. reassignCase() accepts IN_REVIEW as a
  // reassignable status (and routes/api/admin.js's /cases/:id/assign offers it
  // in the UI), but its transitionCase(REASSIGNED) call threw
  // "Cannot transition from IN_REVIEW to REASSIGNED" because this list did not
  // contain it — so taking an in-review case off a doctor was impossible
  // through the lifecycle. Nothing hit it before only because the Command app
  // reassigned with raw SQL that bypassed the lifecycle entirely (the A1 bug).
  [CASE_STATUS.IN_REVIEW]: [CASE_STATUS.COMPLETED, CASE_STATUS.REJECTED_FILES, CASE_STATUS.REASSIGNED, CASE_STATUS.REFUNDED],
  // AUDIT-2026-08-22 — SLA_BREACH added: case_sla_worker's SCAN_STATUSES has
  // always included REJECTED_FILES, so a resumed (unpaused) rejected-files case
  // with a live deadline is a legitimate breach. See the transitionCase guard.
  [CASE_STATUS.REJECTED_FILES]: [CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW, CASE_STATUS.SLA_BREACH, CASE_STATUS.REFUNDED],
  [CASE_STATUS.SLA_BREACH]: [CASE_STATUS.REASSIGNED, CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW, CASE_STATUS.REFUNDED],
  [CASE_STATUS.REASSIGNED]: [CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW, CASE_STATUS.REFUNDED],
  // A completed case can still be refunded in full afterwards — the patient
  // received the report and disputed it. Money state changes; the work stands.
  [CASE_STATUS.COMPLETED]: [CASE_STATUS.REFUNDED],
  [CASE_STATUS.REFUNDED]: [],
  [CASE_STATUS.CANCELLED]: [],
  // AUDIT-P1-4 — the unpaid-expiry sweep flips a case here at 24h. The Paymob
  // callback has no expiry guard, so a patient paying from an emailed link 30
  // hours later WAS charged, payment_status went to 'paid', and markCasePaid
  // then threw — swallowed and logged as "Payment lifecycle transition
  // skipped/failed (idempotent)". Money in, case never assigned, no alert.
  // Allowing EXPIRED_UNPAID -> PAID means a late payment revives the case
  // instead of bricking it. CANCELLED remains available for a deliberate close.
  [CASE_STATUS.EXPIRED_UNPAID]: [CASE_STATUS.PAID, CASE_STATUS.CANCELLED],
  // Anonymous marketing-site intake (routes/api/cases_intake.js) lands here
  // awaiting ops triage, which either prices and submits it or closes it.
  [CASE_STATUS.PENDING_REVIEW]: [CASE_STATUS.SUBMITTED, CASE_STATUS.PAID, CASE_STATUS.CANCELLED]
});

// -----------------------------------------------------------------------------
// Status → UI mapping (single source of truth)
//
// Goal: prevent raw/internal status strings leaking into the UI and provide
// consistent titles/descriptions per role (patient/doctor/admin/superadmin).
// -----------------------------------------------------------------------------

const UI_BADGE = Object.freeze({
  neutral: 'neutral',
  info: 'info',
  warning: 'warning',
  success: 'success',
  danger: 'danger'
});

const CASE_STATUS_UI = Object.freeze({
  [CASE_STATUS.DRAFT]: {
    patient: {
      title: { en: 'Draft started', ar: 'تم بدء طلب جديد' },
      description: { en: 'Complete your details and upload files to proceed.', ar: 'أكمل بياناتك وارفع الملفات للمتابعة.' },
      badge: UI_BADGE.neutral,
      visible: false
    },
    doctor: {
      title: { en: 'Not available', ar: 'غير متاح' },
      description: { en: 'This case is not yet submitted.', ar: 'هذه الحالة لم تُرسل بعد.' },
      badge: UI_BADGE.neutral,
      visible: false
    },
    admin: {
      title: { en: 'Draft', ar: 'مسودة' },
      description: { en: 'Patient has not submitted the case yet.', ar: 'المريض لم يرسل الحالة بعد.' },
      badge: UI_BADGE.neutral,
      visible: true
    }
  },

  [CASE_STATUS.SUBMITTED]: {
    patient: {
      title: { en: 'Case received', ar: 'تم استلام الحالة' },
      description: { en: 'We are preparing your case for specialist assignment.', ar: 'نقوم بتجهيز حالتك لتعيين الطبيب المختص.' },
      badge: UI_BADGE.info,
      visible: true
    },
    doctor: {
      title: { en: 'Pending activation', ar: 'قيد التفعيل' },
      description: { en: 'Case is not yet ready for assignment.', ar: 'الحالة ليست جاهزة للتعيين بعد.' },
      badge: UI_BADGE.neutral,
      visible: false
    },
    admin: {
      title: { en: 'Submitted', ar: 'تم الإرسال' },
      description: { en: 'Awaiting operational triage (assignment, checks).', ar: 'بانتظار المعالجة التشغيلية (التعيين، المراجعة).' },
      badge: UI_BADGE.info,
      visible: true
    }
  },

  [CASE_STATUS.PAID]: {
    patient: {
      title: { en: 'Case confirmed', ar: 'تم تأكيد الحالة' },
      description: { en: 'Your case is confirmed and will be assigned shortly.', ar: 'تم تأكيد حالتك وسيتم تعيين الطبيب قريباً.' },
      badge: UI_BADGE.info,
      visible: true
    },
    doctor: {
      title: { en: 'Ready for assignment', ar: 'جاهزة للتعيين' },
      description: { en: 'Case is eligible to be assigned to a doctor.', ar: 'الحالة مؤهلة لتعيين طبيب.' },
      badge: UI_BADGE.info,
      visible: false
    },
    admin: {
      title: { en: 'Confirmed', ar: 'مؤكدة' },
      description: { en: 'Ready to assign to a doctor.', ar: 'جاهزة لتعيين طبيب.' },
      badge: UI_BADGE.info,
      visible: true
    }
  },

  [CASE_STATUS.ASSIGNED]: {
    patient: {
      title: { en: 'Specialist assigned', ar: 'تم تعيين الطبيب المختص' },
      description: { en: 'A specialist has been assigned and will begin review.', ar: 'تم تعيين طبيب مختص وسيبدأ المراجعة.' },
      badge: UI_BADGE.info,
      visible: true
    },
    doctor: {
      title: { en: 'Assigned', ar: 'تم التعيين' },
      description: { en: 'Accept the case to view details and begin work.', ar: 'اقبل الحالة لعرض التفاصيل وبدء العمل.' },
      badge: UI_BADGE.info,
      visible: true
    },
    admin: {
      title: { en: 'Assigned', ar: 'تم التعيين' },
      description: { en: 'Assigned to a doctor; awaiting acceptance/review.', ar: 'تم تعيينها لطبيب وبانتظار القبول/المراجعة.' },
      badge: UI_BADGE.info,
      visible: true
    }
  },

  [CASE_STATUS.IN_REVIEW]: {
    patient: {
      title: { en: 'In review', ar: 'قيد المراجعة' },
      description: { en: 'Your specialist is reviewing your files and clinical question.', ar: 'يقوم الطبيب المختص بمراجعة ملفاتك وسؤالك الطبي.' },
      badge: UI_BADGE.info,
      visible: true
    },
    doctor: {
      title: { en: 'In review', ar: 'قيد المراجعة' },
      description: { en: 'You can draft notes and generate the report when ready.', ar: 'يمكنك كتابة الملاحظات وإنشاء التقرير عند الجاهزية.' },
      badge: UI_BADGE.info,
      visible: true
    },
    admin: {
      title: { en: 'In review', ar: 'قيد المراجعة' },
      description: { en: 'Doctor is actively working on the case.', ar: 'الطبيب يعمل على الحالة حالياً.' },
      badge: UI_BADGE.info,
      visible: true
    }
  },

  [CASE_STATUS.REJECTED_FILES]: {
    patient: {
      title: { en: 'More information needed', ar: 'نحتاج معلومات إضافية' },
      description: { en: 'Please upload the requested files so the review can continue.', ar: 'يرجى رفع الملفات المطلوبة حتى نكمل المراجعة.' },
      badge: UI_BADGE.warning,
      visible: true,
      actionRequired: true
    },
    doctor: {
      title: { en: 'Waiting for patient files', ar: 'بانتظار ملفات المريض' },
      description: { en: 'Review is paused until the patient uploads requested files.', ar: 'تم إيقاف المراجعة حتى يرفع المريض الملفات المطلوبة.' },
      badge: UI_BADGE.warning,
      visible: true
    },
    admin: {
      title: { en: 'Files requested', ar: 'تم طلب ملفات' },
      description: { en: 'Pending patient re-upload (and/or approval workflow).', ar: 'بانتظار إعادة رفع الملفات (و/أو الموافقة).' },
      badge: UI_BADGE.warning,
      visible: true
    }
  },

  // UI-only status used by the admin approval workflow for additional-files requests.
  // This is NOT a canonical CASE_STATUS stored in `cases.status`.
  //
  // Theme 7 sub-issue D (2026-05-10): kept as a transitional fallback
  // for any caller of getStatusUi() that somehow receives the legacy
  // string. Writers of 'awaiting_files' have been removed; migration
  // 047 converts existing rows to 'REJECTED_FILES'. This UI block is
  // unreachable in normal operation but preserved as defense-in-depth
  // until the 30-day cleanup PR.
  ['AWAITING_FILES']: {
    patient: {
      title: { en: 'More information needed', ar: 'نحتاج معلومات إضافية' },
      description: { en: 'Please upload the requested files so the review can continue.', ar: 'يرجى رفع الملفات المطلوبة حتى نكمل المراجعة.' },
      badge: UI_BADGE.warning,
      visible: true,
      actionRequired: true
    },
    doctor: {
      title: { en: 'Waiting for patient files', ar: 'بانتظار ملفات المريض' },
      description: { en: 'Review is paused until the patient uploads the requested files.', ar: 'تم إيقاف المراجعة حتى يرفع المريض الملفات المطلوبة.' },
      badge: UI_BADGE.warning,
      visible: true
    },
    admin: {
      title: { en: 'Awaiting patient files', ar: 'بانتظار ملفات المريض' },
      description: { en: 'Approved request; waiting for the patient to re-upload files.', ar: 'تمت الموافقة على الطلب وبانتظار إعادة رفع الملفات من المريض.' },
      badge: UI_BADGE.warning,
      visible: true
    }
  },

  [CASE_STATUS.COMPLETED]: {
    patient: {
      title: { en: 'Report ready', ar: 'التقرير جاهز' },
      description: { en: 'Your specialist report is ready to view and download.', ar: 'تقرير الطبيب المختص جاهز للعرض والتنزيل.' },
      badge: UI_BADGE.success,
      visible: true,
      terminal: true
    },
    doctor: {
      title: { en: 'Completed', ar: 'مكتملة' },
      description: { en: 'Report submitted. Edits are locked unless unlocked by admin.', ar: 'تم إرسال التقرير. التعديلات مقفلة إلا إذا فتحها الأدمن.' },
      badge: UI_BADGE.success,
      visible: true,
      terminal: true
    },
    admin: {
      title: { en: 'Completed', ar: 'مكتملة' },
      description: { en: 'Report delivered to patient.', ar: 'تم تسليم التقرير للمريض.' },
      badge: UI_BADGE.success,
      visible: true,
      terminal: true
    }
  },

  [CASE_STATUS.SLA_BREACH]: {
    patient: {
      title: { en: 'Delayed', ar: 'تأخير' },
      description: { en: 'Your case is being escalated to ensure completion.', ar: 'يتم تصعيد حالتك لضمان إتمامها.' },
      badge: UI_BADGE.danger,
      visible: true
    },
    doctor: {
      title: { en: 'SLA breach', ar: 'تجاوز وقت التنفيذ' },
      description: { en: 'This case is escalated and may be reassigned.', ar: 'تم تصعيد الحالة وقد يتم إعادة تعيينها.' },
      badge: UI_BADGE.danger,
      visible: true
    },
    admin: {
      title: { en: 'SLA breach', ar: 'تجاوز وقت التنفيذ' },
      description: { en: 'Escalate or reassign immediately.', ar: 'صعّد أو أعد التعيين فوراً.' },
      badge: UI_BADGE.danger,
      visible: true
    }
  },

  [CASE_STATUS.REASSIGNED]: {
    patient: {
      title: { en: 'Reassigning specialist', ar: 'إعادة تعيين الطبيب' },
      description: { en: 'We are assigning a different specialist to keep things moving.', ar: 'نقوم بتعيين طبيب آخر لضمان سرعة التنفيذ.' },
      badge: UI_BADGE.warning,
      visible: true
    },
    doctor: {
      title: { en: 'Reassigned', ar: 'تمت إعادة التعيين' },
      description: { en: 'Case is being moved to another specialist.', ar: 'يتم نقل الحالة لطبيب آخر.' },
      badge: UI_BADGE.warning,
      visible: true
    },
    admin: {
      title: { en: 'Reassigned', ar: 'تمت إعادة التعيين' },
      description: { en: 'Awaiting new assignment/acceptance.', ar: 'بانتظار التعيين/القبول الجديد.' },
      badge: UI_BADGE.warning,
      visible: true
    }
  },

  [CASE_STATUS.CANCELLED]: {
    patient: {
      title: { en: 'Cancelled', ar: 'تم الإلغاء' },
      description: { en: 'This case has been cancelled.', ar: 'تم إلغاء هذه الحالة.' },
      badge: UI_BADGE.neutral,
      visible: true,
      terminal: true
    },
    doctor: {
      title: { en: 'Cancelled', ar: 'تم الإلغاء' },
      description: { en: 'This case was cancelled and is no longer active.', ar: 'تم إلغاء هذه الحالة ولم تعد نشطة.' },
      badge: UI_BADGE.neutral,
      visible: true,
      terminal: true
    },
    admin: {
      title: { en: 'Cancelled', ar: 'تم الإلغاء' },
      description: { en: 'Case cancelled. No further actions required.', ar: 'تم إلغاء الحالة. لا توجد إجراءات مطلوبة.' },
      badge: UI_BADGE.neutral,
      visible: true,
      terminal: true
    }
  },

  // AUDIT 2026-08-17 — a fully refunded case. Distinct from CANCELLED: the
  // patient paid, the money has been returned, and the case ends there. Kept
  // visible to the patient so their history explains itself rather than the
  // case simply vanishing.
  [CASE_STATUS.REFUNDED]: {
    patient: {
      title: { en: 'Refunded', ar: 'تم استرداد المبلغ' },
      description: {
        en: 'This case was closed and your payment has been refunded in full.',
        ar: 'تم إغلاق هذه الحالة وتم استرداد مبلغك بالكامل.'
      },
      badge: UI_BADGE.neutral,
      visible: true,
      terminal: true
    },
    doctor: {
      title: { en: 'Refunded', ar: 'تم استرداد المبلغ' },
      description: {
        en: 'This case was refunded and is no longer active.',
        ar: 'تم استرداد مبلغ هذه الحالة ولم تعد نشطة.'
      },
      badge: UI_BADGE.neutral,
      visible: true,
      terminal: true
    },
    admin: {
      title: { en: 'Refunded', ar: 'تم استرداد المبلغ' },
      description: {
        en: 'Refunded in full and closed. No further actions required.',
        ar: 'تم الاسترداد بالكامل والإغلاق. لا توجد إجراءات مطلوبة.'
      },
      badge: UI_BADGE.neutral,
      visible: true,
      terminal: true
    }
  },

  // AUDIT-P1-4 — without these entries getStatusUi fell through to its
  // raw-string fallback and patients literally saw the badge text
  // "EXPIRED_UNPAID" on their own case page.
  [CASE_STATUS.EXPIRED_UNPAID]: {
    patient: {
      title: { en: 'Payment window closed', ar: 'انتهت مهلة الدفع' },
      description: { en: 'This case was held for payment and has now been released. You can start a new case any time.', ar: 'تم حفظ هذه الحالة في انتظار الدفع وتم إغلاقها الآن. يمكنك بدء حالة جديدة في أي وقت.' },
      badge: UI_BADGE.neutral,
      visible: true
    },
    doctor: {
      title: { en: 'Not available', ar: 'غير متاح' },
      description: { en: 'This case expired before payment.', ar: 'انتهت مهلة هذه الحالة قبل الدفع.' },
      badge: UI_BADGE.neutral,
      visible: false
    },
    admin: {
      title: { en: 'Expired (unpaid)', ar: 'منتهية (غير مدفوعة)' },
      description: { en: 'Held for payment past the window and released. A late payment revives it to PAID.', ar: 'تجاوزت مهلة الدفع وتم إغلاقها. الدفع المتأخر يعيدها إلى حالة مدفوعة.' },
      badge: UI_BADGE.neutral,
      visible: true
    }
  },

  [CASE_STATUS.PENDING_REVIEW]: {
    patient: {
      title: { en: 'Case received', ar: 'تم استلام الحالة' },
      description: { en: 'Our team is reviewing your request and will be in touch shortly.', ar: 'فريقنا يراجع طلبك وسنتواصل معك قريبًا.' },
      badge: UI_BADGE.info,
      visible: true
    },
    doctor: {
      title: { en: 'Not available', ar: 'غير متاح' },
      description: { en: 'This case has not been triaged yet.', ar: 'لم يتم فرز هذه الحالة بعد.' },
      badge: UI_BADGE.neutral,
      visible: false
    },
    admin: {
      title: { en: 'Pending triage', ar: 'في انتظار الفرز' },
      description: { en: 'Website intake awaiting ops review and pricing.', ar: 'طلب من الموقع في انتظار المراجعة والتسعير.' },
      badge: UI_BADGE.warning,
      visible: true
    }
  }
});

function pickLang(obj, lang) {
  if (!obj) return '';
  if (obj[lang]) return obj[lang];
  return obj.en || Object.values(obj)[0] || '';
}

function normalizeRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'superadmin') return 'admin';
  if (r === 'administrator') return 'admin';
  return r || 'patient';
}

function getStatusUi(status, { role = 'patient', lang = 'en' } = {}) {
  const s = normalizeStatus(status);
  const r = normalizeRole(role);
  const meta = CASE_STATUS_UI[s] || null;
  const fallback = {
    title: { en: s, ar: s },
    description: { en: '', ar: '' },
    badge: UI_BADGE.neutral,
    visible: true
  };
  const roleMeta = (meta && (meta[r] || meta.patient)) || fallback;
  return {
    status: s,
    badge: roleMeta.badge || UI_BADGE.neutral,
    visible: roleMeta.visible !== false,
    terminal: Boolean(roleMeta.terminal),
    actionRequired: Boolean(roleMeta.actionRequired),
    title: pickLang(roleMeta.title, lang),
    description: pickLang(roleMeta.description, lang)
  };
}

function isVisibleToPatient(status) {
  const ui = getStatusUi(status, { role: 'patient', lang: 'en' });
  return ui.visible !== false;
}

function normalizeStatus(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  // Normalize common formats: "in_review", "IN REVIEW", "in-review" -> "IN_REVIEW"
  const cleaned = raw
    .replace(/\s+/g, '_')
    .replace(/-/g, '_')
    .toUpperCase();

  // Map legacy/alias values to the canonical enum
  if (Object.prototype.hasOwnProperty.call(STATUS_ALIASES, cleaned)) {
    return STATUS_ALIASES[cleaned];
  }
  // If the normalized value is one of our known statuses, return it.
  if (Object.prototype.hasOwnProperty.call(CASE_STATUS, cleaned)) {
    return CASE_STATUS[cleaned];
  }

  // Support legacy values that might not match enum casing exactly.
  // (If cleaned isn't in CASE_STATUS, fall back to cleaned.)
  return cleaned;
}

// -----------------------------------------------------------------------------
// DB status helpers
//
// Historically, some routes/templates used lowercase or alternate strings.
// These helpers provide a single source of truth for:
// - converting DB/raw values -> canonical CASE_STATUS
// - providing DB WHERE-IN lists that match both canonical + legacy values
// -----------------------------------------------------------------------------

const DB_STATUS = Object.freeze({
  [CASE_STATUS.DRAFT]: CASE_STATUS.DRAFT,
  [CASE_STATUS.SUBMITTED]: CASE_STATUS.SUBMITTED,
  [CASE_STATUS.PAID]: CASE_STATUS.PAID,
  [CASE_STATUS.ASSIGNED]: CASE_STATUS.ASSIGNED,
  [CASE_STATUS.IN_REVIEW]: CASE_STATUS.IN_REVIEW,
  [CASE_STATUS.REJECTED_FILES]: CASE_STATUS.REJECTED_FILES,
  [CASE_STATUS.COMPLETED]: CASE_STATUS.COMPLETED,
  [CASE_STATUS.SLA_BREACH]: CASE_STATUS.SLA_BREACH,
  [CASE_STATUS.REASSIGNED]: CASE_STATUS.REASSIGNED,
  [CASE_STATUS.CANCELLED]: CASE_STATUS.CANCELLED,
  [CASE_STATUS.REFUNDED]: CASE_STATUS.REFUNDED
});

// Canonical -> list of DB values seen historically (for SQL WHERE IN)
const DB_STATUS_VARIANTS = Object.freeze({
  [CASE_STATUS.DRAFT]: [CASE_STATUS.DRAFT, 'draft', 'DRAFT'],
  [CASE_STATUS.SUBMITTED]: [CASE_STATUS.SUBMITTED, 'submitted', 'SUBMITTED', 'new', 'NEW', 'pending', 'PENDING'],
  [CASE_STATUS.PAID]: [CASE_STATUS.PAID, 'paid', 'PAID'],
  [CASE_STATUS.ASSIGNED]: [CASE_STATUS.ASSIGNED, 'assigned', 'ASSIGNED', 'accepted', 'ACCEPTED'],
  // AUDIT 2026-08-17 — 'in_progress' added. normalizeStatus already mapped it
  // to IN_REVIEW via STATUS_ALIASES, but it was missing from THIS list, which
  // is what SQL scans expand through. Production held a row with that exact
  // spelling (demo-order-in-progress-001), and the SLA breach sweep — which
  // built its WHERE clause from this map — could not see it. The case sat
  // three months past its deadline and was never breached.
  [CASE_STATUS.IN_REVIEW]: [CASE_STATUS.IN_REVIEW, 'in_review', 'IN_REVIEW', 'in_progress', 'IN_PROGRESS', 'review', 'REVIEW', 'inreview', 'INREVIEW'],
  [CASE_STATUS.REJECTED_FILES]: [CASE_STATUS.REJECTED_FILES, 'rejected_files', 'REJECTED_FILES', 'files_requested', 'FILES_REQUESTED', 'file_requested', 'FILE_REQUESTED', 'more_info_needed', 'MORE_INFO_NEEDED'],
  [CASE_STATUS.COMPLETED]: [CASE_STATUS.COMPLETED, 'completed', 'COMPLETED', 'done', 'DONE', 'finished', 'FINISHED'],
  [CASE_STATUS.SLA_BREACH]: [CASE_STATUS.SLA_BREACH, 'sla_breach', 'SLA_BREACH', 'breached', 'BREACHED', 'breached_sla', 'BREACHED_SLA', 'sla_breached', 'SLA_BREACHED', 'delayed', 'DELAYED', 'overdue', 'OVERDUE'],
  [CASE_STATUS.REFUNDED]: [CASE_STATUS.REFUNDED, 'refunded', 'REFUNDED'],
  [CASE_STATUS.REASSIGNED]: [CASE_STATUS.REASSIGNED, 'reassigned', 'REASSIGNED'],
  [CASE_STATUS.CANCELLED]: [CASE_STATUS.CANCELLED, 'cancelled', 'CANCELLED', 'canceled', 'CANCELED', 'cancel', 'CANCEL'],
  // AUDIT-P1-4: lowercase is what the raw-SQL writers actually store.
  [CASE_STATUS.EXPIRED_UNPAID]: [CASE_STATUS.EXPIRED_UNPAID, 'expired_unpaid', 'EXPIRED_UNPAID', 'expired', 'EXPIRED'],
  [CASE_STATUS.PENDING_REVIEW]: [CASE_STATUS.PENDING_REVIEW, 'pending_review', 'PENDING_REVIEW']
});

function toCanonStatus(dbValue) {
  return normalizeStatus(dbValue);
}

function toDbStatus(canonKey) {
  const k = normalizeStatus(canonKey);
  return DB_STATUS[k] || null;
}

function dbStatusValuesFor(canonKey) {
  const k = normalizeStatus(canonKey);
  return DB_STATUS_VARIANTS[k] || [k];
}

function isUnacceptedStatus(dbValue) {
  // "Unaccepted" in the doctor workflow means the case is assigned to a doctor
  // but not yet accepted/started (i.e., still in ASSIGNED state).
  return toCanonStatus(dbValue) === CASE_STATUS.ASSIGNED;
}

// Pure deadline arithmetic — paidAtIso + slaHours hours, returned as ISO.
// Exported for tests and external symmetry; production deadline
// computation uses deadlineFromAcceptance (see line 205) — SLA starts
// at acceptance, not at payment.
function calculateDeadline(paidAtIso, slaHours) {
  if (!paidAtIso) {
    throw new Error('Cannot calculate SLA deadline without paid_at');
  }
  const hours = Number(slaHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error('Cannot calculate SLA deadline without positive slaHours');
  }
  const paidAt = new Date(paidAtIso);
  return new Date(paidAt.getTime() + hours * 60 * 60 * 1000).toISOString();
}

// Theme 5 sub-issue A: helpers below accept an optional `client` parameter.
// When called from inside a withTransaction() block, the caller threads the
// txn client through and queries run on that single connection. When called
// from any other context, the parameter is undefined and we fall back to
// the module-level pool. Backwards-compatible — existing callers pass fewer
// args and get `undefined` for `client`.
async function logCaseEvent(caseId, eventType, payload = null, client) {
  try {
    const meta = payload ? JSON.stringify(payload) : null;
    const params = [randomUUID(), caseId, eventType, meta, nowIso()];
    const sql = `INSERT INTO case_events (id, case_id, event_type, event_payload, created_at)
       VALUES ($1, $2, $3, $4, $5)`;
    if (client) {
      await client.query(sql, params);
    } else {
      await execute(sql, params);
    }
  } catch (e) {
    // Optional table in some environments; do not crash core flows.
  }
}

async function triggerNotification(caseId, type, payload, client) {
  await logCaseEvent(caseId, `notification:${type}`, payload, client);
}

async function getCase(caseIdOrParams, client) {
  const caseId =
    caseIdOrParams && typeof caseIdOrParams === 'object'
      ? (caseIdOrParams.caseId || caseIdOrParams.orderId || caseIdOrParams.id)
      : caseIdOrParams;

  if (!caseId) return null;
  // Filters soft-deleted cases — getCase returning null for a soft-deleted
  // id is the right behavior (callers treat "case not found" identically).
  const sql = `SELECT * FROM ${CASE_TABLE} WHERE id = $1 AND deleted_at IS NULL`;
  if (client) {
    const r = await client.query(sql, [caseId]);
    return r.rows[0] || null;
  }
  return await queryOne(sql, [caseId]);
}

async function attachFileToCase(caseId, { filename, file_type, storage_path = null }) {
  try {
    await execute(
      `INSERT INTO case_files (id, case_id, filename, file_type, storage_path)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), caseId, filename, file_type || 'unknown', storage_path]
    );
    await logCaseEvent(caseId, 'FILE_UPLOADED', { filename, file_type });
  } catch (e) {
    // Optional table in some environments; do not crash core flows.
  }
}
// -----------------------------------------------------------------------------
// HARD GUARD: prevent non-canonical statuses from ever being written to the DB
// -----------------------------------------------------------------------------

function assertCanonicalDbStatus(value) {
  const canon = normalizeStatus(value);
  // Reject empty/unknown statuses explicitly and self-document
  if (!canon) {
    throw new Error('Attempted to write empty/invalid case status to DB');
  }
  if (!Object.values(CASE_STATUS).includes(canon)) {
    throw new Error(
      `Attempted to write non-canonical case status to DB: "${value}"`
    );
  }
  return canon;
}
async function updateCase(caseId, fields, client) {
  const updates = Object.keys(fields);
  if (!updates.length) return;

  // Enforce canonical DB status and require caseId for status updates
  if (Object.prototype.hasOwnProperty.call(fields, 'status')) {
    if (!caseId) {
      throw new Error('Missing caseId for status update');
    }
    // Normalize and validate status, and force DB value to canonical string
    fields.status = assertCanonicalDbStatus(fields.status);
  }

  const sets = updates.map((column, i) => `${column} = $${i + 1}`).join(', ');
  const values = updates.map((key) => fields[key]);
  values.push(caseId);
  const sql = `UPDATE ${CASE_TABLE} SET ${sets} WHERE id = $${values.length}`;
  if (client) {
    await client.query(sql, values);
  } else {
    await execute(sql, values);
  }
}
function assertTransition(current, next) {
  const from = normalizeStatus(current);
  const to = normalizeStatus(next);

  if (from === to) return;
  if (!STATUS_TRANSITIONS[from]) {
    throw new Error(`No transitions defined from ${from}`);
  }
  if (!STATUS_TRANSITIONS[from].includes(to)) {
    throw new Error(`Cannot transition from ${from} to ${to}`);
  }
}

async function transitionCase(caseId, nextStatus, data = {}, client) {
  await ensureColumnCache();
  const existing = await getCase(caseId, client);
  if (!existing) {
    throw new Error('Case not found');
  }
  if (!assertPaidGate(existing, nextStatus)) {
    return existing; // blocked by payment gate — return unchanged
  }
  const currentStatus = normalizeStatus(existing.status);
  let desiredStatus = normalizeStatus(nextStatus);
  // Validate and canonicalize status before any further checks (fail fast)
  desiredStatus = assertCanonicalDbStatus(desiredStatus);
  // HARD INVARIANT: PAID cases must always have SLA hours
  if (desiredStatus === CASE_STATUS.PAID) {
    const hasSla =
      Object.prototype.hasOwnProperty.call(data, 'sla_hours') &&
      Number(data.sla_hours) > 0;

    if (!hasSla) {
      throw new Error(
        'Invariant violation: cannot transition to PAID without sla_hours'
      );
    }
  }

  if (desiredStatus === CASE_STATUS.SLA_BREACH) {
    // AUDIT-2026-08-22 — REJECTED_FILES admitted. The breach SCAN and this
    // guard disagreed: case_sla_worker.SCAN_STATUSES is
    // [IN_REVIEW, REJECTED_FILES] and case_lifecycle.sweepSlaBreaches scans the
    // same two, but only IN_REVIEW could actually transition here. The
    // `sla_paused_at IS NULL` filter covers a PAUSED rejected-files case; it
    // does not cover a RESUMED one. resumeSla() clears the pause and writes a
    // live deadline_at, and the REJECTED_FILES -> IN_REVIEW flip that should
    // follow is an independently-failing try block in routes/patient.js. When
    // that flip failed the row was selected on every 5-minute tick, handleBreach
    // threw, breached_at was never set, no breach and no refund — forever.
    // A resumed rejected-files case has a running clock and a waiting patient;
    // missing that clock is a breach like any other.
    if (![CASE_STATUS.IN_REVIEW, CASE_STATUS.REJECTED_FILES].includes(currentStatus)) {
      throw new Error('Only active review cases can escalate to SLA breach');
    }
  } else {
    assertTransition(currentStatus, desiredStatus);
  }

  const now = nowIso();

  // Ensure acceptance timestamp exists when entering IN_REVIEW.
  // SLA starts at acceptance (accepted_at), so we must never enter IN_REVIEW without it.
  if (desiredStatus === CASE_STATUS.IN_REVIEW) {
    const hasAcceptedField = Object.prototype.hasOwnProperty.call(data, 'accepted_at');
    if (!hasAcceptedField && !existing.accepted_at) {
      data.accepted_at = now;
    }
  }

  if (desiredStatus === CASE_STATUS.IN_REVIEW) {
    const hasDeadlineField = Object.prototype.hasOwnProperty.call(data, 'deadline_at');
    const currentDeadline = hasDeadlineField ? data.deadline_at : existing.deadline_at;

    // SLA starts at acceptance. Ensure deadline_at matches accepted_at + sla_hours.
    if (existing.sla_hours) {
      const acceptedAt =
        (Object.prototype.hasOwnProperty.call(data, 'accepted_at') && data.accepted_at) ||
        existing.accepted_at ||
        now;

      // SLA starts at acceptance. Deadline = accepted_at + sla_hours (hours).
      const acceptedMs = new Date(acceptedAt).getTime();
      const expectedDeadline = Number.isFinite(acceptedMs)
        ? new Date(acceptedMs + Number(existing.sla_hours) * 60 * 60 * 1000).toISOString()
        : null;
      if (!expectedDeadline) {
        throw new Error('Cannot compute deadline_at from accepted_at');
      }
      // AUDIT-2026-08-22 — ACCEPTANCE ONLY EVER *BACKFILLS* A DEADLINE.
      //
      // This used to overwrite deadline_at with accepted_at + sla_hours in
      // BOTH directions. markCasePaid anchors an urgent case paid outside the
      // Cairo window to nextUrgentWindowOpenUtc() + sla_hours and the patient
      // is told that exact time (urgent_case_window_deferred_patient). The
      // first transition into IN_REVIEW then silently threw it away:
      // paid 19:02 -> promised 11:00 -> a doctor accepts at 10:30 -> deadline
      // becomes 14:30. Three and a half hours of the promise vanish, so the
      // case never breaches and the patient never gets the breach refund they
      // were owed. dispatchSlaReminders already goes to lengths to protect this
      // anchor (see AUDIT-SLA-10); transitionCase runs first and reverted it.
      //
      // The first repair gated on DIRECTION ("never move later"), and that was
      // exactly backwards for the case that matters most. A resumed deadline
      // is ALWAYS later than accepted_at + sla_hours — that is what the pause
      // credit IS — so the direction guard let the recompute through and moved
      // the deadline EARLIER, frequently into the past:
      //   doctor accepts T0 (48h) -> requests files T0+2h (pauseSla banks 46h)
      //   -> patient uploads T0+72h -> resumeSla writes T0+118h
      //   -> routes/patient.js transitions IN_REVIEW -> rewritten to T0+48h,
      //   24h in the past -> next 5-minute tick breaches the case, zeroes the
      //   doctor's earnings to a 10% token, reassigns, and refunds the patient
      //   BECAUSE THE PATIENT TOOK THREE DAYS TO UPLOAD THE FILMS.
      //
      // The rule is now the same one dispatchSlaReminders applies (AUDIT-SLA-10),
      // and for the same reasons: never touch a deadline somebody deliberately
      // set. Write only when
      //   (a) there is no usable deadline at all — the genuine backfill this
      //       block exists for; or
      //   (b) the stored deadline is at or before accepted_at, which no valid
      //       post-acceptance SLA can be. That shape is the legacy
      //       paid-anchored value, and repairing it moves the deadline LATER,
      //       in the doctor's favour, never into a surprise breach.
      // A paused case is skipped outright: its deadline_at is stale ON PURPOSE
      // (pauseSla banks the remainder in sla_remaining_seconds) and resumeSla
      // owns recomputing it. Without this a pause taken while the deadline had
      // already slipped past accepted_at would fall into (b) and be "repaired"
      // straight over the credit.
      const currentMs = currentDeadline ? new Date(currentDeadline).getTime() : NaN;
      const acceptedMsForGuard = new Date(acceptedAt).getTime();
      const deadlineMissing = !currentDeadline || !Number.isFinite(currentMs);
      const atOrBeforeAcceptance =
        !deadlineMissing && Number.isFinite(acceptedMsForGuard) && currentMs <= acceptedMsForGuard;
      const slaPaused = HAS_SLA_PAUSED_AT_COLUMN && Boolean(existing.sla_paused_at);
      if (!slaPaused &&
          (deadlineMissing || atOrBeforeAcceptance) &&
          shouldUpdateDeadline(currentDeadline, expectedDeadline)) {
        data.deadline_at = expectedDeadline;
      }
    }
    // Close any open doctor_assignments rows once the case is accepted/in review.
    await closeOpenDoctorAssignments(caseId, client);
  }

  const updates = {
    status: desiredStatus,
    updated_at: now,
    ...data
  };

  await updateCase(caseId, updates, client);
  await logCaseEvent(caseId, `status:${updates.status}`, { from: currentStatus }, client);
  return await getCase(caseId, client);
}
// ---------------------------------------------------------------------------
// Helper: isTerminalStatus -- returns true if status is terminal (completed/cancelled)
function isTerminalStatus(status) {
  const s = normalizeStatus(status);
  const ui = CASE_STATUS_UI[s];
  const meta = ui && ui.admin;
  return Boolean(meta && meta.terminal);
}

async function createDraftCase({ language = 'en', urgency_flag = false, reason_for_review = '' }) {

  const caseId = randomUUID();
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO ${CASE_TABLE}(id, status, language, urgency_flag, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [caseId, CASE_STATUS.DRAFT, language, urgency_flag, now, now]
  );
  await execute(
    `INSERT INTO case_context (case_id, reason_for_review, urgency_flag, language)
     VALUES ($1, $2, $3, $4)`,
    [caseId, reason_for_review, urgency_flag, language]
  );
  await logCaseEvent(caseId, 'CASE_DRAFT_CREATED', { language, urgency_flag, reason_for_review });
  return caseId;
}

async function submitCase(caseId) {
  const result = await transitionCase(caseId, CASE_STATUS.SUBMITTED);
  // 2026-08-25 — removed a write to orders.payment_due_at.
  //
  // That column does not exist on ANY table in this database
  // (information_schema returns nothing for it), so the UPDATE raised 42703
  // every single time a case was submitted and the bare `catch (e) {}` around
  // it threw the error away. Nobody ever saw it and the 24-hour payment window
  // it was meant to open was never actually recorded.
  //
  // Not fixed by adding the column: unpaid cases are ALREADY expired at 24h by
  // case_lifecycle.dispatchUnpaidCaseReminders / the expired_unpaid hard-stop,
  // and standing up a second, independent expiry mechanism a week before
  // launch is how you get two clocks disagreeing about the same order. The
  // reader is flagged where it sits — see assertPaidGate.
  await logCaseEvent(caseId, 'CASE_SUBMITTED');
  return result;
}

async function markCasePaid(caseId) {
  await ensureColumnCache();

  // Set inside the txn when an urgent case is confirmed outside the Cairo
  // window (AUDIT-PAY-1); read after commit to tell the patient. Declared out
  // here so the post-commit block can see it.
  let urgentDeferredTo = null;

  const result = await withTransaction(async (client) => {
    // Lock the row for the duration of this transaction — prevents concurrent double-processing.
    // deleted_at filter prevents a late Paymob webhook from marking a soft-deleted
    // (auto-expired-unpaid) case as paid — orders are soft-deleted at 48h unpaid;
    // any payment after that should be refunded, not retroactively applied.
    const existing = await client.query(
      `SELECT * FROM ${CASE_TABLE} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [caseId]
    ).then(r => r.rows[0]);
    if (!existing) throw new Error('Case not found');

    // Idempotency: if already paid and lifecycle fields set, skip
    const currentStatus = normalizeStatus(existing.status);
    const alreadyProcessed = (
      currentStatus === CASE_STATUS.PAID ||
      currentStatus === CASE_STATUS.ASSIGNED ||
      currentStatus === CASE_STATUS.IN_REVIEW ||
      currentStatus === CASE_STATUS.COMPLETED
    );
    if (alreadyProcessed) return existing;

  // SLA hours resolved from orders.sla_hours (locked at order
  // creation), with a 48h Standard fallback for legacy/missing rows.
  const slaHours = resolveSlaHoursForCase(existing);
  const paidAt = existing.paid_at || nowIso();

  // Urgent tier time restriction: 7am–7pm Cairo time only.
  //
  // AUDIT-PAY-1 — this used to `throw` when an urgent case was confirmed
  // outside the window. The webhook caller (routes/payments.js) swallows the
  // throw as "Payment lifecycle transition skipped/failed (idempotent)", so a
  // patient who picked Urgent at 18:55 and cleared 3DS at 19:02 had their money
  // taken and their case left at SUBMITTED: no PAID transition, no assign, no
  // broadcast, no SLA row, no alert, no refund. The gate punished the patient
  // for the two minutes Paymob spent on 3DS.
  //
  // DECIDED POLICY (Ziad, 2026-08-17): take the payment and anchor the clock at
  // the next 07:00 Cairo + the tier's SLA hours. This is not a new rule — it is
  // exactly what the wizard's own out-of-window "wait" branch already promises
  // the patient (routes/patient.js:2138-2143), written with the same DST-aware
  // helper. Intake (routes/api/cases.js:349) still refuses to SELL urgent out
  // of window; this path only handles money that has already moved.
  //
  // deadline_at is normally NULL at PAID (the SLA clock starts at acceptance).
  // For this one case it is set at payment, because the promise the patient
  // was given is anchored to the calendar, not to when a doctor happens to
  // accept. sla_deadline gets the same value so the patient-facing countdown
  // (routes/api/cases.js reads COALESCE(deadline_at, sla_deadline)) agrees.
  // AUDIT-2026-08-22 — isUrgentWindowOpenNow / nextUrgentWindowOpenUtc instead
  // of the bare hour-only helpers, so the anchor lands on a day the roster
  // actually covers once URGENT_WINDOW_WORKING_DAYS is set. Unset (the default)
  // means all seven days and this is the same computation as before.
  if (String(existing.urgency_tier || '').trim().toLowerCase() === 'urgent' && !isUrgentWindowOpenNow()) {
    urgentDeferredTo = new Date(
      nextUrgentWindowOpenUtc().getTime() + slaHours * 60 * 60 * 1000
    ).toISOString();
  }

  // IMPORTANT: payment processor/webhook should set payment_status='paid'.
  // Here we only lock lifecycle fields and paid_at (if not already set).
  // Theme 5 sub-issue A: thread `client` so all helper writes happen
  // on the same txn connection as the SELECT FOR UPDATE above. Before
  // this fix, each helper ran on a fresh module-pool connection — peak
  // 2 slots per payment. After, peak is 1.
  await transitionCase(caseId, CASE_STATUS.PAID, {
    sla_hours: slaHours,
    paid_at: paidAt,
    // SLA starts at acceptance; do not carry a pre-accept deadline —
    // EXCEPT for an urgent case paid outside the Cairo window, whose
    // deadline is anchored to the calendar (see above).
    deadline_at: urgentDeferredTo,
    ...(urgentDeferredTo ? { sla_deadline: urgentDeferredTo } : {})
  }, client);

  if (urgentDeferredTo) {
    await logCaseEvent(caseId, 'URGENT_WINDOW_DEFERRED', {
      paid_at: paidAt,
      sla_hours: slaHours,
      deadline_at: urgentDeferredTo,
      reason: 'paid_outside_cairo_urgent_window'
    }, client);
  }

  // Note: a payment-reminder cancellation UPDATE used to live here. It
  // referenced notifications.cancelled_at (column does not exist) and
  // response->>'case_id' (response is text, not jsonb), so the statement
  // had been silently failing inside the swallow-try block — which left
  // the txn in 'aborted' state and broke every subsequent statement
  // including the final getCase. Deleted so this txn actually commits.
  // Functional consequence: payment-reminder notifications still fire
  // after the patient pays. Tracked as a pre-existing UX bug in
  // /Users/ziadelwahsh/.claude/projects/.../project_payment_reminder_cancellation.md.

  await logCaseEvent(caseId, 'PAYMENT_CONFIRMED', { sla_hours: slaHours, urgency_tier: existing.urgency_tier || 'standard' }, client);
  await logCaseEvent(caseId, 'CASE_READY_FOR_ASSIGNMENT', null, client);
  await triggerNotification(caseId, 'payment_confirmation', { sla_hours: slaHours, urgency_tier: existing.urgency_tier || 'standard' }, client);

  // Best-effort: queue reminder notifications (deduped) for patient + doctor.
  // These will only send once the case has an active status + deadline.
  try {
    await dispatchSlaReminders(caseId, {}, client);
  } catch (e) {
    // do not block payment flow
  }

  return await getCase(caseId, client);
  }); // end withTransaction

  // Stage 2 P0-PAY-3: unified post-payment hook. Fires AFTER the txn
  // commits so a queue-enqueue failure cannot roll back payment status;
  // also outside the txn because pg-boss takes its own pool connections
  // and would deadlock against the txn client. Every caller — the Paymob
  // webhook (routes/payments.js callback), the stub success path
  // (routes/patient.js GET /payment-success?stub=1), and any future
  // surface — runs through here, guaranteeing the "paid order ends up
  // with a doctor" invariant pinned in tests/core/post-payment-hook-pinning.
  //
  // Lazy require to avoid a circular boot-order surprise — auto_assign →
  // notify → case_lifecycle would otherwise close the loop.
  if (result && !result.doctor_id) {
    const { enqueueAutoAssign } = require('./job_queue');
    const { broadcastOrderToSpecialty } = require('./notify/broadcast');
    enqueueAutoAssign(caseId).catch(function (err) {
      console.error('[markCasePaid] enqueueAutoAssign failed:', err && err.message);
    });
    broadcastOrderToSpecialty(caseId).catch(function (err) {
      console.error('[markCasePaid] broadcastOrderToSpecialty failed:', err && err.message);
    });
  }

  // AUDIT-PAY-1 — tell the patient what happened to their Urgent case. Without
  // this they paid an urgent premium at 19:02 and see a deadline the next
  // morning with no explanation, which reads as a bug or a bait-and-switch.
  //
  // Post-commit and fire-and-forget, same rationale as the hook above: a
  // notification failure must never roll back a confirmed payment.
  //
  // Channel is 'internal' deliberately: a WhatsApp send would need a
  // Meta-approved template that does not exist yet.
  //
  // REGRESSION FIX (F2) — the comment that used to sit here said the bell
  // "degrades gracefully" via humanizeTemplate() and that the copy was
  // "specified in the handoff notes". It does not degrade gracefully: the bell
  // rendered the literal slug "Urgent Case Window Deferred Patient" with an
  // empty body, and that was the ONLY thing telling a patient who paid an
  // urgency premium at 19:02 why their deadline is now tomorrow morning. The
  // template is now registered for real in notify/notification_titles.js
  // (bilingual title) and notify.renderNotificationMessage (bilingual body,
  // which formats deadline_at in Cairo time).
  //
  // `lang` rides in the payload because queueNotification resolves BOTH the
  // title and the body against `response.lang` — without it an Arabic patient
  // gets the English copy for a case they paid a premium on.
  if (urgentDeferredTo) {
    try {
      const { queueNotification } = require('./notify');
      const patientId = getPatientUserIdFromOrder(result);
      if (patientId) {
        Promise.resolve(queueNotification({
          orderId: caseId,
          toUserId: patientId,
          channel: 'internal',
          template: 'urgent_case_window_deferred_patient',
          response: {
            case_id: caseId,
            deadline_at: urgentDeferredTo,
            reason: 'paid_outside_cairo_urgent_window',
            lang: String((result && result.language) || '').toLowerCase() === 'ar' ? 'ar' : 'en'
          },
          dedupe_key: 'urgent_deferred:' + caseId
        })).catch(function (err) {
          console.error('[markCasePaid] urgent-deferred notification failed:', err && err.message);
        });
      }
    } catch (err) {
      console.error('[markCasePaid] urgent-deferred notification threw:', err && err.message);
    }
  }

  return result;
}

async function markSlaBreach(caseId) {
  await ensureColumnCache();
  const existing = await getCase(caseId);
  if (!existing) throw new Error('Case not found');

  const currentStatus = normalizeStatus(existing.status);

  // AUDIT-2026-08-22 — a PAUSED SLA cannot breach. pauseSla stops the clock and
  // deliberately leaves a stale deadline_at behind (the remainder is banked in
  // sla_remaining_seconds), so the stored deadline of a paused case is not a
  // promise that has been missed — it is a promise that is on hold. Both sweeps
  // filter `sla_paused_at IS NULL`, but the per-id callers do not
  // (routes/doctor.js accept handler, /superadmin recalc), and neither did this
  // function. Breaching here would zero the doctor's earnings for a case that is
  // waiting on the PATIENT.
  if (HAS_SLA_PAUSED_AT_COLUMN && existing.sla_paused_at) {
    return existing;
  }

  // SLA model: the deadline is normally accepted_at + sla_hours, and a sweep
  // that selected a case before that moment must not breach it (AUDIT-TZ-2:
  // under the old Cairo/UTC skew the sweep ran ~3h early and this guard was the
  // only thing standing between a punctual doctor and a wrongful clawback).
  //
  // AUDIT-2026-08-22 — but the acceptance-derived value is NOT always the
  // promise. markCasePaid can anchor an urgent case to the next Cairo window,
  // and an admin can shorten a deadline; where the STORED deadline_at is
  // EARLIER than accepted_at + sla_hours, the stored value is what the patient
  // was told and what the sweep selected on. Deferring to the acceptance
  // arithmetic there meant the case could not breach until accepted_at +
  // sla_hours no matter what the row said — so preserving the anchor above
  // would only have changed the displayed countdown, and the patient still
  // would not get their breach refund. Take the EARLIER of the two.
  //
  // A stored deadline that is LATER (a pause credit, an admin extension) is
  // deliberately NOT taken as the floor here: the sweeps already hold those
  // back with `deadline_at <= NOW()`, and widening this guard to trust a later
  // stored value would disarm the acceptance recheck for any caller that
  // selected on some other predicate.
  try {
    const expected = deadlineFromAcceptance(existing);
    if (expected) {
      const expectedMs = new Date(expected).getTime();
      const storedMs = existing.deadline_at ? new Date(existing.deadline_at).getTime() : NaN;
      const effectiveMs = (Number.isFinite(storedMs) && storedMs < expectedMs) ? storedMs : expectedMs;
      if (Number.isFinite(effectiveMs) && Date.now() < effectiveMs) {
        return existing;
      }
    }
  } catch (e) {
    // best-effort; fall through to existing logic
  }

  // Do not breach unpaid or terminal cases
  if (!isPaymentConfirmed(existing)) {
    console.warn(`[sla] Skipping SLA breach for unpaid case ${caseId}`);
    return existing;
  }
  if (isTerminalStatus(currentStatus)) {
    return existing;
  }

  // Idempotency: do not re-breach
  if (currentStatus === CASE_STATUS.SLA_BREACH) {
    return existing;
  }

  await transitionCase(caseId, CASE_STATUS.SLA_BREACH, {
    breached_at: nowIso()
  });

  // B11 (launch audit): reassignment is owned by the SLA sweep's handleBreach
  // (case_sla_worker.js), which selects via findAlternateDoctor —
  // specialty-matched and active/approved/unpaused-filtered. The old inline
  // pickNextAvailableDoctor reassign here ignored all of those and then the
  // sweep reassigned AGAIN, causing double reassignment and notifications to
  // ineligible doctors. Removed so the sweep is the single reassignment owner.

  await logCaseEvent(caseId, 'SLA_BREACHED');

  // AUDIT 2026-08-17 — the day going wrong was SILENT on the phone.
  // A breach already fans out to WhatsApp (dispatchSlaBreach) and the
  // patient's bell, but nothing reached the Command app, so "today has
  // started breaching" was something you found out by opening a dashboard.
  // Keyed on the CAIRO DAY, not the case: this fires on the FIRST breach of
  // the operator's day and then stays quiet. A per-case push would be a
  // running commentary on a bad afternoon — exactly the pattern that trains
  // someone to swipe the channel away. Best-effort and after the state
  // change, like every other notification in this function.
  try {
    const { pushOpsEvent, cairoDayKey } = require('./services/ops_push');
    const caseRef = existing.reference_id || String(caseId).slice(0, 12).toUpperCase();
    const tier = existing.urgency_tier || existing.tier || 'standard';
    await pushOpsEvent({
      kind: 'sla_breach_first',
      dedupeKey: cairoDayKey(),
      title: 'First SLA breach today — ' + caseRef,
      body: 'A ' + tier + ' case missed its deadline. Check the breach queue before more follow.',
      data: { orderId: caseId, tier: tier },
      orderId: caseId,
    });
  } catch (e) {
    // pushOpsEvent does not throw; this guards the require itself.
  }

  // Theme 7 sub-issue B: refund hook — moved from the deprecated
  // server.js:runSlaReminderJob and sla_status.enforceBreachIfNeeded
  // paths. issueBreachRefundSafe is idempotent (refunds-row + uplift>0
  // gates) and swallows + logs its own errors, so a transient hiccup
  // here can never poison the breach mark above.
  try {
    const { issueBreachRefundSafe } = require('./services/sla_breach');
    await issueBreachRefundSafe(caseId);
  } catch (e) {
    // best-effort; helper logs internally
  }

  // Theme 7 sub-issue B: patient in-app bell ("Case delayed") — the only
  // patient-facing breach signal in the system. Was previously fired by
  // routes/superadmin.js:performSlaCheck (now deprecated).
  if (existing.patient_id) {
    try {
      const { queueNotification } = require('./notify');
      await queueNotification({
        orderId: caseId,
        toUserId: existing.patient_id,
        channel: 'internal',
        template: 'order_breached_patient',
        status: 'queued',
        dedupe_key: 'sla:breach:' + caseId + ':patient'
      });
    } catch (e) {
      // best-effort; never block lifecycle
    }
  }

  // WhatsApp SLA breach alerts -- dedupe-safe
  try {
    const { dispatchSlaBreach, sendSlaReminder } = require('./notify');

    // 1) Escalation to superadmin (single-fire via dedupe_key).
    //    Theme 7 sub-issue B: dispatchSlaBreach now queries active
    //    superadmins instead of a hardcoded 'superadmin-1' user.
    dispatchSlaBreach(caseId);

    // 2) Notify assigned doctor (single-fire via dedupe_key)
    if (existing.doctor_id) {
      sendSlaReminder({
        order: { id: caseId, doctor_id: existing.doctor_id },
        level: 'breach'
      });
    }
  } catch (e) {
    // Notifications are best-effort; do not block lifecycle
  }

  return await getCase(caseId);
}

// Sweep all candidate cases past their SLA deadline and breach each one.
// Used by dashboard refresh handlers and the manual /superadmin/sla/recalc
// trigger — these previously called the per-id `markSlaBreach` with no
// argument and silently logged UnhandledRejection on every dashboard load
// (commit 74cd5f6, 2026-03-15). The fix is to give them real sweep
// semantics here.
//
// NOTE: the candidate query duplicates case_sla_worker.fetchSlaCandidates
// intentionally — see the worker for the same shape. Consolidating
// later is fine; for now the duplication keeps the worker untouched.
async function sweepSlaBreaches() {
  // AUDIT-2026-08-22 — the pause filter below is the FIRST hard reference to
  // sla_paused_at in this query, and this file already carries a schema flag
  // for exactly that column. Without the cache the filter is emitted blind: on
  // an environment that has not run the pause migration the whole SELECT
  // throws, the catch below turns it into `{ swept: 0 }`, and the sweep
  // degrades from "over-selects paused cases" to "silently breaches nothing" —
  // strictly worse, and invisible.
  await ensureColumnCache();
  // AUDIT-2026-08-22 — expand through dbStatusValuesFor, the same map
  // case_sla_worker.scanStatusValues uses. This listed only the two canonical
  // keys lowercased, so the twin sweeps did not scan the same set: a row stored
  // as 'in_progress' or 'files_requested' (both real spellings in this table —
  // see the DB_STATUS_VARIANTS note) was swept by the worker and invisible here.
  const statuses = [...new Set(
    [CASE_STATUS.IN_REVIEW, CASE_STATUS.REJECTED_FILES]
      .reduce((acc, canon) => acc.concat(dbStatusValuesFor(canon)), [])
      .map((v) => String(v).toLowerCase())
  )];
  const statusPlaceholders = statuses.map((_, i) => '$' + (i + 1)).join(', ');

  let candidates;
  try {
    // AUDIT-TZ-1 / migration 081 — deadline_at is timestamptz, so plain NOW()
    // is an unambiguous instant comparison. See the note in
    // case_sla_worker.js fetchSlaCandidates for why the previous
    // NOW()::timestamp form swept cases ~3h early.
    candidates = await queryAll(
      `SELECT o.id AS case_id
         FROM ${CASE_TABLE} o
        WHERE LOWER(COALESCE(o.status, '')) IN (${statusPlaceholders})
          AND o.deadline_at IS NOT NULL
          AND o.breached_at IS NULL
          AND o.deleted_at IS NULL
          -- AUDIT-2026-08-22 — case_sla_worker.fetchSlaCandidates has carried
          -- an sla_paused_at IS NULL filter since AUDIT-P0-4; this twin query, which
          -- scans the SAME two statuses and is fired by dashboard refreshes and
          -- the manual /superadmin/sla/recalc, had no pause filter at all.
          -- pauseSla deliberately leaves a stale deadline_at behind, so every
          -- dashboard load re-selected every paused rejected-files case and
          -- pushed it at markSlaBreach.
          ${HAS_SLA_PAUSED_AT_COLUMN ? 'AND o.sla_paused_at IS NULL' : ''}
          AND o.deadline_at <= NOW()`,
      statuses
    );
  } catch (err) {
    // Surface as a structured failure rather than throwing — callers
    // are fire-and-forget and we don't want one bad query to kill the
    // sweep silently.
    return { swept: 0, breached: 0, errors: [{ case_id: null, error: err.message }] };
  }

  const errors = [];
  let breached = 0;
  for (const row of candidates) {
    try {
      await markSlaBreach(row.case_id);
      breached++;
    } catch (err) {
      // Don't let one bad row poison the whole sweep — record and continue.
      // Common causes: case deleted between SELECT and markSlaBreach
      // (race), or a transient DB error on the per-id transaction.
      errors.push({ case_id: row.case_id, error: err.message });
    }
  }

  return { swept: candidates.length, breached, errors };
}

async function pauseSla(caseId, reason = 'rejected_files') {
  await ensureColumnCache();
  const existing = await getCase(caseId);
  if (!existing) return existing;

  // Schema guard: some environments don't have pause columns yet.
  if (!HAS_SLA_PAUSED_AT_COLUMN || !HAS_SLA_REMAINING_SECONDS_COLUMN) {
    try {
      await logCaseEvent(caseId, 'SLA_PAUSE_SKIPPED', { reason: 'columns_missing' });
    } catch (e) {}
    return existing;
  }

  if (existing.sla_paused_at) return existing;
  if (!existing.deadline_at) return existing;

  const now = new Date();
  const deadline = new Date(existing.deadline_at);
  const remainingSeconds = Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000));

  await updateCase(caseId, {
    sla_paused_at: now.toISOString(),
    sla_remaining_seconds: remainingSeconds,
    updated_at: now.toISOString()
  });

  await logCaseEvent(caseId, 'SLA_PAUSED', { reason, remaining_seconds: remainingSeconds });
  return await getCase(caseId);
}

async function resumeSla(caseId, { reason = 'files_uploaded' } = {}) {
  await ensureColumnCache();
  const existing = await getCase(caseId);
  if (!existing) return existing;

  // Schema guard: some environments don't have pause columns yet.
  if (!HAS_SLA_PAUSED_AT_COLUMN || !HAS_SLA_REMAINING_SECONDS_COLUMN) {
    try {
      await logCaseEvent(caseId, 'SLA_RESUME_SKIPPED', { reason: 'columns_missing' });
    } catch (e) {}
    return existing;
  }

  if (!existing.sla_paused_at) return existing;

  const remaining = Number(existing.sla_remaining_seconds) || 0;
  const now = new Date();
  const deadline = new Date(now.getTime() + remaining * 1000).toISOString();

  await updateCase(caseId, {
    deadline_at: deadline,
    sla_paused_at: null,
    sla_remaining_seconds: null,
    updated_at: now.toISOString()
  });

  await logCaseEvent(caseId, 'SLA_RESUMED', { reason, remaining_seconds: remaining });
  return await getCase(caseId);
}

async function markOrderRejectedFiles(caseId, doctorId, reason = '', opts = {}) {
  // Backward/forward compatibility: allow calling with a single object payload
  // (e.g., markOrderRejectedFiles({ caseId, doctorId, reason, opts })).
  if (caseId && typeof caseId === 'object') {
    const payload = caseId;
    const extractedCaseId = payload.caseId || payload.orderId || payload.id;
    const extractedDoctorId = payload.doctorId || payload.requested_by || null;
    const extractedReason = typeof payload.reason === 'string' ? payload.reason : '';
    const extractedOpts = payload.opts || payload.options || {};

    caseId = extractedCaseId;
    doctorId = extractedDoctorId;
    reason = extractedReason;
    opts = extractedOpts;
  }

  opts = opts || {};

  const options = {
    requireAdminApproval: true,
    ...opts
  };

  const existing = await getCase(caseId);
  if (!existing) {
    throw new Error('Case not found');
  }

  const currentStatus = normalizeStatus(existing.status);
  if (![CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW].includes(currentStatus)) {
    throw new Error(`Cannot request additional files in status ${currentStatus}`);
  }

  // Transition into REJECTED_FILES so the system understands the case is blocked waiting for files.
  // IMPORTANT: We only log an admin/superadmin approval-required event here. Patient notification happens AFTER approval.
  //
  // AUDIT-2026-08-22 — the transition and the pause are ONE UPDATE.
  //
  // These used to be two statements: transitionCase(REJECTED_FILES) and then
  // pauseSla(). Between them the case is REJECTED_FILES with sla_paused_at
  // still NULL, and REJECTED_FILES -> SLA_BREACH is now a permitted transition
  // (see the SLA_BREACH block in transitionCase). Both breach sweeps scan
  // REJECTED_FILES and select on `deadline_at <= NOW() AND sla_paused_at IS
  // NULL`, so on a case whose deadline had already slipped past — precisely the
  // case a doctor is most likely to be asking for more films on — that window
  // is now a REAL breach where it previously threw harmlessly. Anything that
  // fails in between (a crash, a lost connection) leaves the case permanently
  // in that shape.
  //
  // pauseSla's own arithmetic and guards are reproduced here rather than
  // called, because pauseSla takes its own pool connection and cannot join this
  // write. It stays as the fallback below for the paths this cannot cover
  // (missing columns, no deadline_at, already paused) so its skip events are
  // still emitted.
  await ensureColumnCache();
  const rejectedNow = new Date();
  const transitionData = { rejected_files_at: rejectedNow.toISOString() };

  let pausedRemainingSeconds = null;
  if (HAS_SLA_PAUSED_AT_COLUMN && HAS_SLA_REMAINING_SECONDS_COLUMN &&
      !existing.sla_paused_at && existing.deadline_at) {
    const deadlineMs = new Date(existing.deadline_at).getTime();
    if (Number.isFinite(deadlineMs)) {
      pausedRemainingSeconds = Math.max(0, Math.floor((deadlineMs - rejectedNow.getTime()) / 1000));
      transitionData.sla_paused_at = rejectedNow.toISOString();
      transitionData.sla_remaining_seconds = pausedRemainingSeconds;
    }
  }

  await transitionCase(caseId, CASE_STATUS.REJECTED_FILES, transitionData);

  if (pausedRemainingSeconds != null) {
    // Same event pauseSla writes, so resumeSla / the timeline / any consumer
    // reading SLA_PAUSED sees no difference between the two paths.
    await logCaseEvent(caseId, 'SLA_PAUSED', {
      reason: 'rejected_files',
      remaining_seconds: pausedRemainingSeconds
    });
  } else {
    await pauseSla(caseId, 'rejected_files');
  }

  await logCaseEvent(caseId, 'FILES_REQUESTED', {
    requested_by: doctorId || null,
    reason: reason || '',
    require_admin_approval: options.requireAdminApproval,
    approved: false
  });

  // Notify admins/superadmins only (no patient notification at this stage).
  await triggerNotification(caseId, 'admin_files_request', {
    requested_by: doctorId || null,
    reason: reason || '',
    case_id: caseId
  });

  return await getCase(caseId);
}


async function getLatestAssignment(caseId) {
  try {
    return await queryOne(
      `SELECT *
       FROM doctor_assignments
       WHERE case_id = $1
       ORDER BY assigned_at DESC
       LIMIT 1`,
      [caseId]
    );
  } catch (e) {
    // doctor_assignments table may not exist
    return null;
  }
}

async function closeOpenDoctorAssignments(caseId, client) {
  if (!caseId) return;
  try {
    const now = nowIso();
    const sql = `UPDATE doctor_assignments
       SET completed_at = COALESCE(completed_at, $1)
       WHERE case_id = $2
         AND completed_at IS NULL`;
    if (client) {
      await client.query(sql, [now, caseId]);
    } else {
      await execute(sql, [now, caseId]);
    }
  } catch (e) {
    // doctor_assignments table may not exist in some environments
  }
}

// AUDIT-P0-2b — expireStaleAssignments() and pickNextAvailableDoctor() removed.
//
// expireStaleAssignments was a byte-identical copy of sweepExpiredDoctorAccepts
// with zero callers. Both drove pickNextAvailableDoctor, which selected a
// replacement with `WHERE u.role = 'doctor' ... ORDER BY RANDOM()` — no
// specialty, is_paused, pending_approval, onboarding_complete or doctor_services
// filter — and raced case_sla_worker.handleDoctorTimeout over the same rows.
// A doctor auto-paused for breaching SLAs was a valid target; so was a
// dermatologist for a cardiology case.
//
// Accept-timeout reassignment is now owned solely by
// case_sla_worker.handleDoctorTimeout -> findAlternateDoctor, which applies the
// full eligibility gate. Same reasoning as the B11 removal in markSlaBreach.

async function finalizePreviousAssignment(caseId) {
  const existing = await getLatestAssignment(caseId);
  if (!existing) return null;
  if (!existing.completed_at) {
    try {
      const now = nowIso();
      await execute(
        `UPDATE doctor_assignments
         SET completed_at = $1
         WHERE id = $2`,
        [now, existing.id]
      );
    } catch (e) {
      // doctor_assignments table may not exist
    }
  }
  return existing;
}

async function assignDoctor(caseId, doctorId, { replacedDoctorId = null } = {}) {
  await ensureColumnCache();
  const existing = await getCase(caseId);
  if (!existing) {
    throw new Error('Case not found');
  }

  // HARD PAYMENT GATE: never allow assignment unless payment is confirmed.
  if (!isPaymentConfirmed(existing)) {
    throw new Error('Cannot assign doctor unless payment is confirmed');
  }

  const currentStatus = normalizeStatus(existing.status);
  // Allow assignment from PAID (first assignment) and from REASSIGNED (auto/manual reassignment flow).
  if (![CASE_STATUS.PAID, CASE_STATUS.REASSIGNED].includes(currentStatus)) {
    throw new Error(
      `Cannot assign doctor unless case is PAID or REASSIGNED (current: ${currentStatus})`
    );
  }

  // Phase 4: only the FIRST assignment (PAID → ASSIGNED) sends the
  // "case assigned" email. Subsequent assignments routed via reassignCase
  // get the "case reassigned" email instead, avoiding duplicate notifications.
  const wasInitialAssignment = (currentStatus === CASE_STATUS.PAID);

  await finalizePreviousAssignment(caseId);

  // Doctor must accept within a window proportional to the SLA tier.
  // AUDIT-P0-8: was `|| 72`, a fourth SLA default that stretched the doctor's
  // acceptance window on any row with a NULL sla_hours. Falls back to the
  // order's own tier, then to canonical Standard (48h).
  // AUDIT-ACCEPT-1 — this used to carry its OWN acceptance table (30m / 4h /
  // 24h) that disagreed with notify/broadcast.js's (10m / 60m / 240m) for the
  // same three tiers. A case therefore had two live acceptance deadlines and
  // whichever worker swept first decided which one counted. Both now read
  // src/acceptance_window.js — the only place that answers this question.
  //
  // Computed BEFORE the transition (it used to re-SELECT the row afterwards)
  // so acceptance_deadline_at can go into the same UPDATE. The tier columns it
  // reads are not touched by the transition, so the value is identical.
  const ACCEPT_WINDOW_MINUTES = acceptanceMinutesForOrder(existing);
  const acceptByAt = acceptanceDeadlineIso(ACCEPT_WINDOW_MINUTES);

  const assignUpdates = { doctor_id: doctorId };
  if (HAS_ASSIGNED_AT_COLUMN) {
    assignUpdates.assigned_at = nowIso();
  }

  // AUDIT-SLA-6 — the acceptance deadline now lands on the ORDERS row too, not
  // only on doctor_assignments.accept_by_at. acceptance_watcher's expiry sweep
  // reads orders.acceptance_deadline_at, and it was only ever written by
  // notify/broadcast.js at payment time — so after any assignment it still held
  // the ORIGINAL broadcast deadline, long past, describing a doctor who no
  // longer has the case.
  assignUpdates.acceptance_deadline_at = acceptByAt;

  // AUDIT-SLA-6 — a REASSIGNED -> ASSIGNED transition must reset the SLA clock.
  // It used to write doctor_id (+ assigned_at) and nothing else, so the
  // replacement doctor inherited the previous doctor's accepted_at, their
  // already-expired deadline_at, and their breached_at. The consequences are
  // both directions of "never swept again":
  //   * fetchSlaCandidates filters `breached_at IS NULL` — a case that breached
  //     once can never breach again, no matter how long doctor #2 sits on it.
  //   * fetchDoctorTimeouts filters `accepted_at IS NULL` — an inherited
  //     accepted_at means doctor #2 ignoring the case is never a timeout.
  //   * deadlineFromAcceptance(accepted_at + sla_hours) resolves to a moment in
  //     the past, so doctor #2 is born already late and every countdown in the
  //     product shows a negative number.
  // Nulling all three restarts the clock at the new doctor's acceptance, which
  // is what the acceptance-based SLA model means. The patient's total wait is
  // unchanged — a case reassigned late is a patient-comms problem, not a
  // reason to hold a new doctor to a dead deadline.
  if (currentStatus === CASE_STATUS.REASSIGNED) {
    assignUpdates.accepted_at = null;
    assignUpdates.deadline_at = null;
    assignUpdates.breached_at = null;
  }

  await transitionCase(caseId, CASE_STATUS.ASSIGNED, assignUpdates);
  const now = nowIso();

  try {
    await execute(
      `INSERT INTO doctor_assignments (
  id,
  case_id,
  doctor_id,
  assigned_at,
  accept_by_at,
  reassigned_from_doctor_id
)
VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        caseId,
        doctorId,
        now,
        acceptByAt,
        replacedDoctorId
      ]
    );
  } catch (e) {
    // doctor_assignments table may not exist
  }
  await logCaseEvent(caseId, 'CASE_ASSIGNED', { doctorId, replacedDoctorId });

  // Auto-create case-scoped conversation for messaging
  try {
    const freshOrder = await getCase(caseId);
    if (freshOrder && freshOrder.patient_id && doctorId) {
      const existingConvo = await queryOne(
        'SELECT id FROM conversations WHERE order_id = $1 AND patient_id = $2 AND doctor_id = $3',
        [caseId, freshOrder.patient_id, doctorId]
      );
      if (!existingConvo) {
        const convoNow = nowIso();
        await execute(
          'INSERT INTO conversations (id, order_id, patient_id, doctor_id, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [randomUUID(), caseId, freshOrder.patient_id, doctorId, 'active', convoNow, convoNow]
        );
      }
    }
  } catch (_) {
    // Non-blocking: conversation creation must not break assignment
  }

  // Phase 4: notify patient that case was assigned. Fire-and-forget — a
  // failed email must NEVER crash or roll back the assignment transition.
  if (wasInitialAssignment) {
    try {
      const ctx = await getEmailContext(caseId);
      const freshCase = await getCase(caseId);
      if (ctx && ctx.patient && ctx.patient.email) {
        await emailService.notifyCaseAssigned(ctx.patient, ctx.referenceId, ctx.doctor.name || 'a specialist', freshCase && freshCase.sla_hours);
      }
    } catch (err) {
      console.error('[EMAIL] notifyCaseAssigned failed:', err && err.message);
    }
  }

  return await getCase(caseId);
}

// AUDIT-2026-08-22 — `operatorInitiated` marks a reassignment a HUMAN ordered
// for a non-fault reason (doctor on leave, the patient asked for a different
// reader, wrong subspecialty). The only caller today is the Command app's
// assign endpoint (routes/api/admin.js), which was routed through this function
// in the same fix series. See the auto-pause suppression at the bottom of this
// function for why it exists.
async function reassignCase(caseId, newDoctorId, { reason = 'auto', operatorInitiated = false } = {}) {
  await ensureColumnCache();
  const existing = await getCase(caseId);
  if (!existing) {
    throw new Error('Case not found');
  }
  const currentStatus = normalizeStatus(existing.status);
  if (![CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW, CASE_STATUS.SLA_BREACH, CASE_STATUS.REASSIGNED].includes(currentStatus)) {
    throw new Error(`Cannot reassign case in status ${currentStatus}`);
  }

  // AUDIT-2026-08-22 — refuse to hand a doctor their own case back.
  //
  // Neither this function nor assignDoctor checked it. routes/api/admin.js does
  // check, but under SELECT … FOR UPDATE that it then RELEASES before calling
  // us, so two operators racing on the same case (or one racing the SLA worker)
  // could both pass that check and the loser would arrive here with
  // newDoctorId === the doctor already on the row. The consequence is not a
  // no-op: markPartialPayOnReassignment below would zero that doctor's earnings
  // row and write them a 10% token, then assignDoctor would hand them back the
  // very case they are still working on — paid 10% for it, and counted toward
  // the 3-in-30 auto-pause. Rejecting is the safe side of the race: the caller
  // surfaces it as "already assigned to this doctor", which is the truth.
  if (newDoctorId && existing.doctor_id && String(newDoctorId) === String(existing.doctor_id)) {
    throw new Error('Case is already assigned to this doctor');
  }

  const previousAssignment = await getLatestAssignment(caseId);
  // P1-FIN-2: capture original doctor BEFORE finalize/transition wipes the link.
  const originalDoctorId = (previousAssignment && previousAssignment.doctor_id) || existing.doctor_id || null;

  // Close the current assignment window (if any) when we are reassigning.
  await finalizePreviousAssignment(caseId);

  // If we are already in REASSIGNED, don't re-transition; just continue the flow.
  if (currentStatus !== CASE_STATUS.REASSIGNED) {
    await transitionCase(caseId, CASE_STATUS.REASSIGNED);
  }
  await logCaseEvent(caseId, 'CASE_REASSIGNED', {
    reason,
    from: originalDoctorId,
    to: newDoctorId
  });

  // P1-FIN-2: financial step (atomic). Mark the original doctor's pending
  // earnings row as 'reassigned' and write a 10% partial-pay row. Wrapped
  // in withTransaction inside the helper. Step 1+2 (earnings + orders
  // audit fields below) are NOT in the same outer transaction — keeping
  // the existing reassignCase non-atomic surface unchanged, but each step
  // is individually idempotent (see helpers).
  let partialPayResult = null;
  if (originalDoctorId) {
    try {
      const { markPartialPayOnReassignment } = require('./services/earnings_writer');
      partialPayResult = await markPartialPayOnReassignment(originalDoctorId, caseId, reason);
    } catch (err) {
      console.error('[earnings] markPartialPayOnReassignment failed:', err && err.message);
    }
  }

  // P1-FIN-2: orders audit fields. UPDATE on top of the existing
  // reassigned_count bump elsewhere — these columns explain WHO/WHY/WHEN
  // for end-of-month reconciliation.
  try {
    await execute(
      `UPDATE orders
          SET reassigned_to_doctor_id = $1,
              reassigned_at = NOW(),
              reassignment_reason = $2
        WHERE id = $3`,
      [newDoctorId || null, reason, caseId]
    );
  } catch (err) {
    console.error('[orders] reassignment audit UPDATE failed:', err && err.message);
  }

  if (!newDoctorId) {
    // No alternate doctor available: unassign so it leaves doctor dashboards and awaits admin action.
    //
    // AUDIT-2026-08-22 (P0) — this used to write doctor_id = null and nothing
    // else, and that combination made a PAID case invisible to every sweep in
    // the system at once:
    //   * fetchSlaCandidates      — wrong status, and breached_at is set;
    //   * fetchDoctorTimeouts     — requires LOWER(status)='assigned';
    //   * acceptance_watcher      — its status list did not include
    //                               'reassigned' (fixed alongside this), and
    //                               acceptance_deadline_at could be NULL;
    //   * Command "Pending assign" — counted only doctor_id IS NULL AND
    //                               status='paid' (fixed alongside this).
    // A patient who paid and whose case breached during a doctor shortage was
    // dropped permanently, with no worker, no queue and no tile holding it.
    //
    // Three changes make it findable again:
    //  1. The SLA clock is reset here, not only inside assignDoctor. The stale
    //     accepted_at / deadline_at / breached_at belong to a doctor who no
    //     longer has the case; leaving breached_at set is specifically what
    //     stops the case ever breaching again for whoever picks it up next.
    //  2. acceptance_deadline_at is stamped so the acceptance_watcher's
    //     `acceptance_deadline_at < NOW()` predicate matches it and retries
    //     auto-assign against a fresh doctor pool — the case retries itself
    //     instead of waiting for a human. (The offset is 0 on the first
    //     attempt and grows with reassigned_count; see the backoff below.)
    //  3. A case event, so /ops and the timeline show WHY it is sitting there.
    // The patient's total wait is unchanged; a case reassigned late is a
    // patient-comms problem, not a reason to hold the next doctor to a dead
    // deadline (same reasoning as AUDIT-SLA-6 in assignDoctor).
    // AUDIT-2026-08-22 — the doctor_id null-out is its OWN statement, and
    // nothing here is silently swallowed any more.
    //
    // This UPDATE grew from 2 columns to 6 inside a bare `catch (e) {}`, and
    // updateCase has no per-column schema guard (contrast HAS_ASSIGNED_AT_COLUMN
    // / HAS_SLA_PAUSED_AT_COLUMN above). One absent column, or any transient
    // write failure, and the WHOLE update is lost — including `doctor_id = null`
    // — leaving the case at REASSIGNED with a doctor still attached, which
    // matches NO sweep in the system. That is exactly the P0 this branch was
    // written to fix, reintroduced by the failure mode of the fix itself.
    //
    // Nulling the doctor is therefore attempted alone first: it is the one
    // column that decides whether anything can ever pick this case up again,
    // and it has existed since the initial schema. The clock reset follows as a
    // separate best-effort write, and a failure of either is logged rather than
    // discarded.
    //
    // AUDIT-2026-08-22 — acceptance_deadline_at BACKS OFF instead of being
    // stamped `now` unconditionally. `now` + acceptance_watcher admitting
    // 'reassigned' is what makes the case retry itself on the next 2-minute
    // tick, and that property is kept for the first attempt (offset 0). But on
    // a case that keeps coming back — a specialty with nobody eligible — an
    // immediate stamp is a 2-minute retry loop that bumps reassigned_count and
    // writes case_events every cycle until /ops/silent-failures is one case
    // repeated. The offset grows with reassigned_count and is capped, so the
    // case stays visible and self-healing without spinning.
    const reassignAttempts = Math.max(0, Number(existing.reassigned_count) || 0);
    const retryDelayMinutes = Math.min(30, reassignAttempts * 2);
    const retryAtIso = new Date(Date.now() + retryDelayMinutes * 60 * 1000).toISOString();

    let doctorCleared = false;
    try {
      await updateCase(caseId, { doctor_id: null, updated_at: nowIso() });
      doctorCleared = true;
    } catch (e) {
      console.error('[reassign] could not clear doctor_id on ' + caseId +
                    ' — case is REASSIGNED with a doctor still attached:', e && e.message);
      try {
        await logCaseEvent(caseId, 'CASE_UNASSIGN_FAILED', {
          reason,
          from: originalDoctorId,
          error: String((e && e.message) || e).slice(0, 500)
        });
      } catch (_) {}
    }

    try {
      await updateCase(caseId, {
        accepted_at: null,
        deadline_at: null,
        breached_at: null,
        acceptance_deadline_at: retryAtIso,
        updated_at: nowIso()
      });
    } catch (e) {
      console.error('[reassign] SLA clock reset failed on ' + caseId + ':', e && e.message);
      try {
        await logCaseEvent(caseId, 'CASE_SLA_RESET_FAILED', {
          reason,
          from: originalDoctorId,
          error: String((e && e.message) || e).slice(0, 500)
        });
      } catch (_) {}
    }

    await logCaseEvent(caseId, 'CASE_AWAITING_REASSIGNMENT', {
      reason,
      from: originalDoctorId,
      sla_clock_reset: true,
      doctor_cleared: doctorCleared,
      retry_after: retryAtIso
    });

    // P1-FIN-2: still notify original doctor + check auto-pause when
    // partial pay was written, even if no replacement doctor was found.
    if (originalDoctorId && partialPayResult && (partialPayResult.written || partialPayResult.idempotent)) {
      _queueOriginalDoctorNotification(caseId, originalDoctorId, reason, partialPayResult);
      if (!operatorInitiated) _checkPauseAsync(originalDoctorId);
    }

    return await getCase(caseId);
  }
  await assignDoctor(caseId, newDoctorId, {
    replacedDoctorId: originalDoctorId
  });

  // Phase 4: notify patient that case was reassigned. Fires AFTER the inner
  // assignDoctor() call — note that the inner call's notifyCaseAssigned is
  // suppressed because currentStatus there is REASSIGNED (not PAID), so the
  // patient receives one email here, not two.
  try {
    const ctx = await getEmailContext(caseId);
    if (ctx && ctx.patient && ctx.patient.email) {
      await emailService.notifyCaseReassigned(ctx.patient, ctx.referenceId);
    }
  } catch (err) {
    console.error('[EMAIL] notifyCaseReassigned failed:', err && err.message);
  }

  // P1-FIN-2: notify ORIGINAL doctor + run auto-pause check. Both are
  // best-effort — financial state is already correct in DB regardless.
  //
  // AUDIT-2026-08-22 — the auto-pause is SKIPPED for an operator-initiated
  // reassignment. checkAndAutoPauseDoctor counts every `earn-reassign-%` row in
  // 30 days with no notion of why, and at 3 it sets is_paused with
  // pause_reason='auto:sla_breach_threshold:3_in_30d'. Routing the Command
  // app's reassign through this function (routes/api/admin.js, same fix series)
  // fed it a class of reassignment that is not the doctor's fault at all —
  // doctor on leave, patient asked for a different reader, wrong subspecialty.
  // Three of those in a month silently removed a good doctor from
  // findAlternateDoctor and every broadcast, labelled an SLA offender, in a
  // launch-sized pool where that is most of the specialty's capacity. The
  // 'admin_manual' reason was already being stored and simply never consulted;
  // services/doctor_pause.js now also excludes those rows from the count, so a
  // caller that forgets this flag still cannot trip the pause on a non-fault
  // reassignment.
  //
  // The 10% partial pay is deliberately NOT suppressed: the pending earnings
  // row is per (order, doctor) and skipping the write-down would leave a doctor
  // who did not deliver the case holding a full-fee pending row that
  // markCaseEarningsPaid can later pay out. Correcting the compensation policy
  // for non-fault reassignment is an earnings_writer change — see the hand-off.
  if (originalDoctorId && partialPayResult && (partialPayResult.written || partialPayResult.idempotent)) {
    _queueOriginalDoctorNotification(caseId, originalDoctorId, reason, partialPayResult);
    if (!operatorInitiated) _checkPauseAsync(originalDoctorId);
  }

  return await getCase(caseId);
}

// P1-FIN-2: queue the partial-pay explainer to the booted doctor.
// Best-effort: failure here doesn't block the reassignment.
function _queueOriginalDoctorNotification(caseId, doctorId, reason, partialPayResult) {
  try {
    const { queueMultiChannelNotification } = require('./notify');
    // AUDIT-2026-08-22 — `data:` -> `response:`, and the email channel added.
    //
    // queueMultiChannelNotification takes { orderId, toUserId, channels,
    // template, response, dedupe_key }. There is no `data` parameter, so every
    // one of these figures was silently dropped and the notification went out
    // with response = null — the 'case-reassigned-original' email template
    // renders "You'll receive % partial pay (EGP )" off exactly these fields.
    //
    // The email channel is explicit because routes/api/admin.js used to queue a
    // SECOND copy of this same template to the same doctor for the same event
    // on ['internal','email'] with a different dedupe key, so the booted doctor
    // got two messages — one mentioning the 10% and one not. That duplicate is
    // removed and this is now the single owner of the notification, so it has
    // to carry the channel the admin path was providing. No whatsapp: the
    // template is unmapped there (notification_worker whatsappTemplateMap).
    queueMultiChannelNotification({
      orderId: caseId,
      toUserId: doctorId,
      channels: ['internal', 'email'],
      template: 'order_reassigned_from_doctor',
      response: {
        case_id: caseId,
        partialPct: partialPayResult.partialPct,
        partialAmount: partialPayResult.partialAmount,
        reason: reason,
        isAcceptanceBreach: reason === 'doctor_timeout' || reason === 'sla_breach_acceptance'
      },
      dedupe_key: 'reassign:from:' + caseId + ':' + doctorId
    }).catch(function (err) {
      console.error('[notify] reassign-from-doctor queue failed:', err && err.message);
    });
  } catch (err) {
    console.error('[notify] reassign-from-doctor queue threw:', err && err.message);
  }
}

// P1-FIN-2: fire-and-forget pause check.
function _checkPauseAsync(doctorId) {
  try {
    const { checkAndAutoPauseDoctor } = require('./services/doctor_pause');
    checkAndAutoPauseDoctor(doctorId).catch(function (err) {
      console.error('[pause] checkAndAutoPauseDoctor failed:', err && err.message);
    });
  } catch (err) {
    console.error('[pause] checkAndAutoPauseDoctor threw:', err && err.message);
  }
}

async function logNotification(caseId, template, payload) {
  await triggerNotification(caseId, template, payload);
}

module.exports = {
  transitionCase,
  CASE_STATUS,
  CANON_STATUS: CASE_STATUS,
  resolveSlaHoursForCase,
  slaHoursForTier,
  SLA_HOURS_BY_TIER,
  calculateDeadline,
  STATUS_TRANSITIONS,
  CASE_STATUS_UI,
  getStatusUi,
  isVisibleToPatient,
  createDraftCase,
  submitCase,
  markCasePaid,
  attachFileToCase,
  getCase,
  logCaseEvent,
  logNotification,
  SILENT_FAILURE_EVENTS,
  markSlaBreach,
  triggerNotification,
  assignDoctor,
  reassignCase,
  pauseSla,
  resumeSla,
  markOrderRejectedFiles,
  dispatchSlaReminders,
  runSlaReminderSweep,
  dispatchUnpaidCaseReminders,
  DB_STATUS,
  toCanonStatus,
  toDbStatus,
  dbStatusValuesFor,
  isUnacceptedStatus,
  isTerminalStatus,
  ensureColumnCache,
  sweepSlaBreaches,
  // AUDIT-2026-08-22 — working-day-aware urgent window. Exported so the
  // sell-side gate (routes/api/cases.js, routes/patient.js) can adopt the same
  // answer as the pay-side anchor once those files' owners pick it up; see the
  // URGENT_WINDOW_WORKING_DAYS block above for the env format.
  isUrgentWindowOpenNow,
  nextUrgentWindowOpenUtc,
  parseUrgentWorkingDays,
  // recalcSlaBreaches is the historical name from the deleted sla.js.
  // It now resolves to sweepSlaBreaches (no-arg sweep) — the previous
  // alias to markSlaBreach was a per-id function and threw "Case not
  // found" on every no-arg dashboard call.
  recalcSlaBreaches: sweepSlaBreaches
};
