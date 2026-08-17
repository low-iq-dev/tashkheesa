// src/notify.js

const { randomUUID } = require('crypto');
const { queryOne, queryAll, execute } = require('./pg');
const { logErrorToDb } = require('./logger');
const { sendWhatsApp } = require('./notify/whatsapp');
const { getNotificationTitles } = require('./notify/notification_titles');
// AUDIT-PAY-1 — one locale table for the whole product (ar-EG / en-GB).
// utils/formatNumber has no requires of its own, so this cannot cycle.
const { pickLocale } = require('./utils/formatNumber');

// ---------------------------------------------------------------------------
// Theme 8 Phase 3 (§3-C) — emit a NOTIFICATION_DROPPED case_event whenever
// queueNotification / queueMultiChannelNotification silently drops a
// notification on a skip path. Surfaced on /ops/silent-failures (Phase 5)
// and registered in case_lifecycle.SILENT_FAILURE_EVENTS.
//
// Two guardrails:
//   (a) orderId-gated — system notifications without an order context
//       (e.g. admin-only fan-outs) don't emit, to avoid unbounded
//       event spam on case_events for non-case-tied notifications.
//   (b) Lazy-required to avoid circular dep (case_lifecycle requires
//       notify, so a top-level `require('./case_lifecycle')` here would
//       create a load-order race).
//   (c) Fire-and-forget — never blocks the surrounding return shape.
//       logCaseEvent has its own internal try/catch; this outer wrap
//       protects against `require()` failures only.
// ---------------------------------------------------------------------------
function emitNotificationDropped({ orderId, reason, channel, template, toUserId }) {
  if (!orderId) return;
  try {
    const { logCaseEvent } = require('./case_lifecycle');
    // Intentionally not awaited — emit is fire-and-forget. Floating
    // promise is safe because logCaseEvent swallows its own errors.
    logCaseEvent(orderId, 'NOTIFICATION_DROPPED', {
      reason: reason || 'unknown',
      channel: channel || null,
      template: template || null,
      toUserId: toUserId || null
    });
  } catch (_) {
    // THEME8-LINT-EXEMPT-HELPER: silent-failure emit failure must not
    // cascade. The require itself can fail at boot if the module graph
    // loads in an unexpected order; queueNotification must remain
    // callable in every environment.
  }
}

const WHATSAPP_ENABLED = String(process.env.WHATSAPP_ENABLED || 'false') === 'true';
const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || 'false') === 'true';

// === PHASE 2: FIX #7 - CACHE FOR N+1 QUERY PREVENTION ===
// Cache email->id resolutions within a sweep to avoid repeated queries
// Cleared after each notification batch to prevent stale data
const emailToIdCache = new Map();

function clearEmailCache() {
  emailToIdCache.clear();
}

async function getCachedUserId(email) {
  const normalized = String(email || '').toLowerCase().trim();
  if (!normalized) return null;

  // Check cache first
  if (emailToIdCache.has(normalized)) {
    return emailToIdCache.get(normalized);
  }

  // Query if not in cache
  try {
    const row = await queryOne(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [normalized]
    );
    const userId = row ? row.id : null;

    // Store result in cache (even null, to avoid repeated failed queries)
    emailToIdCache.set(normalized, userId);

    return userId;
  } catch (e) {
    console.error('[notify] Error querying user by email:', e.message);
    return null;
  }
}

const PAYMENT_REMINDER_TEMPLATES = Object.freeze({
  payment_reminder_30m: true,
  payment_reminder_6h: true,
  payment_reminder_24h: true
});

function buildPaymentReminderPayload({ caseId, paymentUrl }) {
  return {
    case_id: caseId || null,
    payment_url: paymentUrl || null
  };
}

/**
 * Hard rule:
 * notifications.to_user_id must ALWAYS be users.id (NOT email).
 * If an email is passed, resolve to users.id. If not resolvable, skip insert.
 * === PHASE 2: Now uses cache to prevent N+1 queries ===
 */
async function normalizeToUserId(toUserId) {
  const raw = String(toUserId == null ? '' : toUserId).trim();
  if (!raw) return null;

  // If it's an email, resolve to the user's id using cache
  if (raw.includes('@')) {
    return await getCachedUserId(raw);
  }

  return raw;
}

/**
 * === PHASE 3: FIX #17 - JSDOC DOCUMENTATION ===
 * Queue a notification to be stored and sent to a user.
 *
 * Core responsibility: Insert notification record into database.
 * Secondary: Dispatch to external channels (WhatsApp) if configured.
 *
 * @param {Object} options - Notification options
 * @param {string} [options.id] - Notification ID (auto-generated if omitted)
 * @param {string} [options.orderId] - Related order ID (for filtering/context)
 * @param {string} options.toUserId - User ID or email to send to (required)
 * @param {string} [options.channel='internal'] - Channel: 'internal', 'whatsapp', 'email'
 * @param {string} options.template - Notification template name (e.g., 'sla_reminder_doctor')
 * @param {string} [options.status='queued'] - Initial status: 'queued', 'sent', 'failed'
 * @param {Object|string} [options.response] - Response/metadata payload (stored as JSON)
 * @param {string} [options.dedupe_key] - Deduplication key to prevent duplicate notifications
 * @param {string} [options.dedupeKey] - Alias for dedupe_key (for API flexibility)
 *
 * @returns {Promise<Object>} Result object
 *
 * Behavior:
 * - Normalizes toUserId (resolves emails to user IDs via cache)
 * - Auto-generates dedupe keys for SLA and payment reminders if missing
 * - Prevents duplicates via unique dedupe_key constraint
 * - Stores response payload as JSON in database
 * - For WhatsApp: Dispatches immediately (fire-and-forget)
 * - All failures are logged; no exceptions thrown
 */
/**
 * Format an ISO timestamp as a Cairo-local date + time for patient-facing copy.
 *
 * AUDIT-PAY-1 needs to state a concrete deadline, and the stored value is a UTC
 * ISO string while every patient reads it as a Cairo wall clock. Africa/Cairo is
 * pinned explicitly (Egypt observes DST again since 2023, so a fixed +2 offset
 * would be wrong for half the year). Returns '' on any bad input so the caller
 * can degrade to copy without a timestamp rather than printing "Invalid Date".
 *
 * Locale comes from utils/formatNumber.pickLocale so this matches the rest of
 * the product (ar-EG → Arabic-Indic numerals, en-GB → "18 August"); a private
 * locale table here would be the fourth one in the codebase.
 *
 * @param {string} iso
 * @param {string} [lang='en']
 * @returns {string}
 */
function formatCairoDateTime(iso, lang) {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return new Intl.DateTimeFormat(pickLocale(lang), {
      timeZone: 'Africa/Cairo',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(d);
  } catch (_) {
    return '';
  }
}

/**
 * Render a short in-app notification body for the given template + payload.
 * The mobile app shows this directly as the notification's message line.
 * Kept intentionally terse — titles carry the primary meaning; messages
 * just add the one piece of context the user cares about (which case,
 * which doctor, etc.). Falls back to null when nothing meaningful can be
 * said, and the mobile app will show title alone.
 *
 * @param {string} template
 * @param {Object|null} payload
 * @param {string} [lang='en'] - Recipient language. Most entries are English-
 *   only for historical reasons; entries added from AUDIT-PAY-1 onward are
 *   bilingual, because a body that is the ONLY explanation of a money-relevant
 *   decision cannot be delivered in a language the patient may not read.
 */
function renderNotificationMessage(template, payload, lang) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const ref = p.reference_id || p.reference_code || p.case_ref || null;
  const caseLabel = ref ? `Case ${ref}` : (p.case_id ? 'Your case' : null);
  const doctor = p.doctor_name || null;
  const service = p.service_name || null;
  const isAr = String(lang || 'en').toLowerCase() === 'ar';

  switch (template) {
    case 'order_created_patient':
    case 'public_order_created_patient':
      return caseLabel ? `${caseLabel} submitted. We'll notify you once a doctor is assigned.` : "Case submitted.";

    case 'order_status_accepted_patient':
    case 'order_assigned_patient':
      return doctor
        ? `Dr. ${doctor} has accepted ${caseLabel || 'your case'}.`
        : `${caseLabel || 'Your case'} has been assigned to a doctor.`;

    case 'order_assigned_doctor':
    case 'order_auto_assigned_doctor':
    case 'public_order_assigned_doctor':
      return caseLabel ? `${caseLabel} is ready for your review.` : "A new case is ready for your review.";

    case 'order_reassigned_doctor':
    case 'order_reassigned_to_doctor':
      return caseLabel ? `${caseLabel} has been reassigned to you.` : "A case has been reassigned to you.";

    case 'order_reassigned_from_doctor':
      return caseLabel ? `${caseLabel} has been reassigned to another doctor.` : "A case has been reassigned.";

    case 'order_reassigned_patient':
      return `${caseLabel || 'Your case'} has been assigned to a different doctor.`;

    case 'report_ready_patient':
      return `Your second-opinion report for ${caseLabel || 'your case'} is ready to view.`;

    case 'additional_files_requested_patient':
    case 'additional_files_request_approved_patient':
      return `The doctor needs additional files for ${caseLabel || 'your case'}. Please upload them when you can.`;

    case 'patient_uploaded_files_doctor':
      return `Patient uploaded additional files for ${caseLabel || 'the case'}.`;

    case 'patient_reply_info':
      return `Patient sent additional information on ${caseLabel || 'the case'}.`;

    case 'payment_success_patient':
    case 'payment_marked_paid_patient':
    case 'payment_marked_paid':
      return `Payment received for ${caseLabel || 'your case'}.`;

    case 'payment_success_doctor':
      return `Payment received for ${caseLabel || 'the case'}.`;

    case 'payment_reminder_30m':
      return `Reminder: complete payment for ${caseLabel || 'your case'} to start your second-opinion review.`;

    case 'payment_reminder_6h':
      return `${caseLabel || 'Your case'} is still awaiting payment. Complete it now so a doctor can begin.`;

    case 'payment_reminder_24h':
      // #66: the spot will be released soon if not paid — informational
      // framing, not punitive (see email template tone).
      return `${caseLabel || 'Your case'} has been held for 24 hours. The spot will be released soon if payment isn't completed.`;

    case 'case_auto_deleted_unpaid_patient':
      return `${caseLabel || 'Your case'} was removed because payment wasn't completed within 48 hours. You can submit a new case anytime.`;

    // AUDIT-PAY-1 (regression F2) — urgent case confirmed outside the Cairo
    // urgent window (07:00–19:00). This body is the ONLY thing that explains to
    // someone who paid an urgency premium at 19:02 why their deadline reads as
    // tomorrow. It previously did not exist: the template was queued but never
    // registered, so the bell showed the humanized slug over an empty message.
    //
    // Three things it must do, in order: name the hours so the deferral looks
    // like a policy and not a fault, give the concrete deadline so the patient
    // can stop calculating, and say plainly that the turnaround they paid for
    // is unchanged — otherwise this reads as a downgrade of a paid upgrade.
    case 'urgent_case_window_deferred_patient': {
      const when = formatCairoDateTime(p.deadline_at, isAr ? 'ar' : 'en');
      if (isAr) {
        return when
          ? `المراجعة العاجلة بتشتغل من 7 الصبح لـ 7 بالليل بتوقيت القاهرة. الدفع تم بعد المواعيد دي، فالطبيب هيبدأ 7 الصبح وتقريرك موعده ${when}. مدة المراجعة العاجلة اللي دفعتها زي ما هي.`
          : 'المراجعة العاجلة بتشتغل من 7 الصبح لـ 7 بالليل بتوقيت القاهرة. الدفع تم بعد المواعيد دي، فالطبيب هيبدأ 7 الصبح. مدة المراجعة العاجلة اللي دفعتها زي ما هي.';
      }
      return when
        ? `Urgent reviews run 7 AM–7 PM Cairo time. Your payment came in after hours, so your specialist starts at 7 AM and your report is due by ${when}. The urgent turnaround you paid for is unchanged.`
        : 'Urgent reviews run 7 AM–7 PM Cairo time. Your payment came in after hours, so your specialist starts at 7 AM. The urgent turnaround you paid for is unchanged.';
    }

    case 'sla_reminder_doctor':
    case 'order_sla_pre_breach':
    case 'order_sla_pre_breach_doctor':
      return `${caseLabel || 'A case'} is approaching its SLA deadline. Please review soon.`;

    case 'sla_breached_doctor':
    case 'order_breached_doctor':
      return `${caseLabel || 'A case'} has passed its SLA deadline.`;

    case 'order_breached_patient':
      return `We're sorry — ${caseLabel || 'your case'} is taking longer than expected. We're on it.`;

    case 'order_breached_superadmin':
      return `SLA breached on ${caseLabel || 'a case'}.`;

    case 'prescription_uploaded_patient':
      return `A new prescription is available for ${caseLabel || 'your case'}.`;

    case 'new_message':
      return caseLabel ? `You have a new message about ${caseLabel}.` : "You have a new message.";

    case 'appointment_cancelled':
      return "Your appointment has been cancelled.";

    case 'appointment_rescheduled':
      return "Your appointment has been rescheduled.";

    case 'doctor_signup_pending':
      return "A new doctor signup is awaiting review.";

    case 'doctor_approved':
      return "Your doctor account has been approved.";

    case 'doctor_rejected':
      return "Your doctor application was not approved at this time.";

    default:
      return null;
  }
}

async function queueNotification({
  id,
  orderId = null,
  toUserId,
  channel = 'internal',
  template,
  status = 'queued',
  response = null,
  dedupe_key = null,
  dedupeKey = null
}) {
  const uid = await normalizeToUserId(toUserId);

  // If uid can't be resolved, do NOT insert (prevents trigger abort + bad data)
  if (!uid) {
    emitNotificationDropped({ orderId, reason: 'invalid_to_user_id', channel, template, toUserId });
    return { ok: false, skipped: true, reason: 'invalid_to_user_id', toUserId };
  }

  let normalizedDedupeKey = dedupe_key || dedupeKey || null;

  // Guardrail: auto-generate a dedupe key for SLA reminder templates if caller forgot to pass one.
  // This prevents duplicate spam and fixes prior missing-dedupe inserts.
  if (!normalizedDedupeKey && typeof template === 'string' && template.startsWith('sla_reminder_')) {
    let payload = null;
    try {
      if (response && typeof response === 'object') {
        payload = response;
      } else if (typeof response === 'string' && response.trim()) {
        payload = JSON.parse(response);
      }
    } catch (e) {
      payload = null;
    }

    const caseId = payload && payload.case_id ? String(payload.case_id) : (orderId ? String(orderId) : null);
    if (caseId) {
      normalizedDedupeKey = `sla:${template}:${channel}:${caseId}:${uid}`;
      console.warn('[notify] missing dedupe_key for sla reminder; auto-generated', { template, channel, to: uid, caseId });
    }
  }

  // Guardrail: auto-generate a dedupe key for payment reminders if caller forgot to pass one.
  if (!normalizedDedupeKey && PAYMENT_REMINDER_TEMPLATES && PAYMENT_REMINDER_TEMPLATES[template]) {
    let payload = null;
    try {
      if (response && typeof response === 'object') {
        payload = response;
      } else if (typeof response === 'string' && response.trim()) {
        payload = JSON.parse(response);
      }
    } catch (e) {
      payload = null;
    }

    const caseId = payload && payload.case_id ? String(payload.case_id) : (orderId ? String(orderId) : null);
    if (caseId) {
      normalizedDedupeKey = `payment:${template}:${channel}:${caseId}:${uid}`;
      console.warn('[notify] missing dedupe_key for payment reminder; auto-generated', { template, channel, to: uid, caseId });
    }
  }

  // Set when the dedupe pre-check finds an existing row that is 'failed'. The
  // event is then RE-ARMED in place (see the UPDATE below) rather than
  // re-INSERTed, because the unique index makes a second row impossible.
  let requeueRowId = null;

  if (normalizedDedupeKey) {
    // queueNotification is documented as "never throws" and is invoked
    // fire-and-forget from many callers. A transient DB error on this dedupe
    // read must NOT reject — an unhandled rejection would trip server.js's
    // process.exit(1) guard. Degrade to "skip dedupe, proceed": a possible
    // duplicate is far cheaper than a crash.
    try {
      // AUDIT — a historical 'failed' row used to suppress the event
      // permanently: the pre-check matched, queueNotification returned
      // { skipped: 'deduped' }, and that (dedupe_key, channel, to_user_id)
      // triple could never be re-queued again for the rest of the row's
      // lifetime. A doctor whose case-assigned WhatsApp failed three times
      // during a provider outage was never re-notified, for that case, ever.
      //
      // ── REGRESSION FIX (F3) ──────────────────────────────────────────────
      //
      // The first attempt at that fix was `AND status <> 'failed'` on this
      // pre-check alone. It cannot work, and it is strictly worse than the bug
      // it replaced. Skipping the failed row here just falls through to the
      // INSERT below, which carries the IDENTICAL (dedupe_key, channel,
      // to_user_id) triple — exactly what migration 082's index constrains.
      // There is no ON CONFLICT, so it raises 23505 on EVERY attempt, and the
      // catch writes both an error_logs row and a NOTIFICATION_DROPPED
      // case_event. On a 5-minute cron that is a permanent, self-renewing
      // false-positive feed into /ops/errors and /ops/silent-failures — the
      // dashboards this whole series exists to make trustworthy.
      //
      // The retry is now expressed as what it actually is: re-arming the
      // EXISTING row. Deliberately NOT `INSERT ... ON CONFLICT DO UPDATE`:
      // 082's index is PARTIAL (`WHERE dedupe_key IS NOT NULL`), so the
      // inference clause would have to repeat that predicate, and on any
      // instance where 082 has not yet run Postgres answers 42P10 ("no unique
      // or exclusion constraint matching the ON CONFLICT specification") —
      // which would break EVERY notification insert, including the ones that
      // work today. An UPDATE keyed on the row's own id is correct against
      // either index shape, so this fix is safe in both migration orders.
      const existing = await queryOne(`
        SELECT id, status FROM notifications
        WHERE dedupe_key = $1
          AND channel = $2
          AND to_user_id = $3
        ORDER BY at DESC NULLS LAST
        LIMIT 1
      `, [normalizedDedupeKey, channel, uid]);

      if (existing && String(existing.status || '').toLowerCase() !== 'failed') {
        return { ok: true, skipped: 'deduped', dedupe_key: normalizedDedupeKey };
      }
      if (existing) {
        requeueRowId = existing.id;
      }
    } catch (err) {
      logErrorToDb(err, {
        context: 'queueNotification.dedupe_check',
        category: 'notification_queue_failure',
        orderId,
        toUserId: uid,
        channel,
        template
      });
      console.error('[notify] queueNotification dedupe check failed; proceeding without dedupe', err && err.message ? err.message : err);
    }
  }

  const notifId = id || randomUUID();

  // Always store response as JSON text
  const responseJson = (typeof response === 'string')
    ? response
    : JSON.stringify(response ?? null);

  // Resolve human-readable title + message so the mobile app's notifications
  // list doesn't render empty rows. `type` mirrors `template` so the mobile
  // app can branch on it without depending on template naming stability.
  // The response payload is also used to render a one-line message body.
  const parsedResponse = (typeof response === 'object' && response !== null)
    ? response
    : (() => { try { return JSON.parse(responseJson); } catch { return null; } })();
  // AUDIT — `vars` was omitted here, so every `{caseReference}` /
  // `{doctorName}` / `{patientName}` placeholder in TEMPLATE_TITLES
  // interpolated to '' and interpolate() then stripped the dangling
  // punctuation: the bell showed "New case in your specialty" with the
  // reference gone. `parsedResponse` is the same payload the email path
  // feeds getNotificationTitles (notification_worker.js:235), so titles
  // now render identically on both surfaces.
  const titles = getNotificationTitles(template, parsedResponse);
  // AUDIT-APP — was hardcoded to title_en, so Arabic patients (the primary
  // market) saw English titles throughout the app's notification list, with the
  // title_ar variant never used anywhere. Resolve against the recipient's
  // language; fall back to English when there is no Arabic copy.
  const _notifLang = String(
    (parsedResponse && (parsedResponse.lang || parsedResponse.language)) || ''
  ).toLowerCase();
  const inAppTitle = (_notifLang === 'ar' ? (titles?.title_ar || titles?.title_en) : titles?.title_en) || null;
  // AUDIT-PAY-1 — the body is resolved against the same language as the title.
  // It was called without a language, so a bilingual body had no way to reach
  // an Arabic patient even once one existed.
  const inAppMessage = renderNotificationMessage(template, parsedResponse, _notifLang);

  // REGRESSION FIX (F3) — re-arm a previously-failed row in place.
  //
  // The unique index means the retry cannot be a second row, so it is an
  // UPDATE of the one that is already there: status back to 'queued', the
  // attempt counter cleared so the worker gets a full budget again (a fresh
  // lifecycle event deserves one; the old count belongs to the old attempt),
  // retry_after cleared so it is picked up on the next tick, and the payload /
  // title / message refreshed from THIS call rather than left stale from the
  // failed one. `at` is bumped so the bell surfaces it as new instead of
  // burying it at the original timestamp.
  if (requeueRowId) {
    try {
      await execute(
        `UPDATE notifications
            SET status = $1,
                response = $2,
                order_id = COALESCE($3, order_id),
                template = $4,
                type = $4,
                title = $5,
                message = $6,
                attempts = 0,
                retry_after = NULL,
                is_read = false,
                at = NOW()
          WHERE id = $7`,
        [status, responseJson, orderId, template, inAppTitle, inAppMessage, requeueRowId]
      );
      return { ok: true, id: requeueRowId, requeued: true, dedupe_key: normalizedDedupeKey };
    } catch (err) {
      // Same contract as the insert path: never throw, always leave a trace.
      logErrorToDb(err, {
        context: 'queueNotification.requeue_failed_row',
        category: 'notification_queue_failure',
        orderId,
        toUserId: uid,
        channel,
        template
      });
      emitNotificationDropped({ orderId, reason: 'requeue_failed', channel, template, toUserId: uid });
      console.error('[notify] queueNotification requeue of failed row failed', err);
      return {
        ok: false,
        skipped: true,
        reason: 'requeue_failed',
        error: err && err.message ? err.message : String(err)
      };
    }
  }

  try {
    await execute(
      `INSERT INTO notifications (
         id, order_id, to_user_id, channel, template, status, response, dedupe_key,
         type, title, message, is_read
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)`,
      [notifId, orderId, uid, channel, template, status, responseJson, normalizedDedupeKey,
       template, inAppTitle, inAppMessage]
    );

    // P1-NOTIF-1: WhatsApp dispatch is now WORKER-ONLY.
    //
    // Previously this branch fired sendWhatsApp inline AND the worker
    // (notification_worker.js) also picked up the same row, causing
    // every WhatsApp send to be attempted twice — once synchronously
    // here (with hardcoded lang='en' and the raw event name as the
    // Meta template name), and once asynchronously by the worker
    // (with user.lang and the same raw template name).
    //
    // Killing the inline path: (a) eliminates duplicate sends,
    // (b) drops the hardcoded English lang, (c) lets the worker be
    // the single canonical dispatch site, (d) keeps the request
    // path fast (no synchronous Meta API round-trip).
    //
    // The notifications row still gets INSERTed above (status='queued')
    // and the worker polls for it in runNotificationWorker.

    return { ok: true, id: notifId };
  } catch (err) {
    // REGRESSION FIX (F3) — a unique violation on the dedupe index is a
    // DEDUPE, not an incident. Two concurrent callers can both clear the
    // pre-check above and race to insert; the loser lands here. Logging that
    // as an error_logs row plus a NOTIFICATION_DROPPED case_event reports a
    // notification as lost when the winner has in fact queued it, which is a
    // false positive on both /ops/errors and /ops/silent-failures.
    //
    // Narrow on purpose: 23505 is claimed as benign ONLY when this row carried
    // a dedupe key, i.e. only where a conflict is the documented behaviour. A
    // 23505 on the primary key, or any other constraint, still reports.
    if (err && err.code === '23505' && normalizedDedupeKey) {
      console.warn('[notify] queueNotification lost a dedupe race; the winning row is already queued', {
        template, channel, to: uid, dedupe_key: normalizedDedupeKey
      });
      return { ok: true, skipped: 'deduped_race', dedupe_key: normalizedDedupeKey };
    }
    logErrorToDb(err, {
      context: 'queueNotification.db_insert',
      category: 'notification_queue_failure',
      orderId,
      toUserId: uid,
      channel,
      template
    });
    emitNotificationDropped({ orderId, reason: 'db_insert_failed', channel, template, toUserId: uid });
    console.error('[notify] queueNotification insert failed', err);
    // If DB trigger blocks it or anything else happens, don't crash the app.
    // Surface a clean return so routes can continue safely.
    return {
      ok: false,
      skipped: true,
      reason: 'db_insert_failed',
      error: err && err.message ? err.message : String(err)
    };
  }
}

async function sendSlaReminder({ order, level }) {
  if (!order || !order.id || !order.doctor_id || !level) return { ok: false, skipped: true };

  const templateMap = {
    '75': 'sla_warning_75',
    '90': 'sla_warning_urgent',
    'breach': 'sla_breach'
  };

  const template = templateMap[level];
  if (!template) return { ok: false, skipped: true };

  // Prevent duplicate reminders (unique by dedupe_key+channel+user index)
  const dedupeKey = `sla:${level}:${order.id}`;
  const exists = await queryOne(`
    SELECT 1 FROM notifications
    WHERE dedupe_key = $1
      AND channel = $2
      AND to_user_id = $3
    LIMIT 1
  `, [dedupeKey, 'whatsapp', order.doctor_id]);

  if (exists) return { ok: true, skipped: true };

  return await queueNotification({
    channel: 'whatsapp',
    toUserId: order.doctor_id,
    template,
    dedupe_key: dedupeKey,
    response: {
      case_id: order.id
    }
  });
}

/**
 * Keep this minimal + safe:
 * Always call queueNotification using doctor.id (never doctor.email).
 */
async function doctorNotify({ doctor, template, order }) {
  if (!doctor || !doctor.id || !template) return { ok: false, skipped: true };
  return await queueNotification({
    orderId: order && order.id ? order.id : null,
    toUserId: doctor.id,
    channel: 'internal',
    template,
    status: 'queued'
  });
}

// AUDIT — `processCaseEvent` was DELETED here.
//
// It queued the SLA-breach WhatsApp alert to the literal user id
// 'superadmin-1' — a demo-seed id that does not exist in production, so
// normalizeToUserId returned it verbatim, the INSERT hit the FK/trigger
// guard, and the alert went nowhere. It had zero callers repo-wide (only
// its own definition and its module.exports entry), and the live SLA-breach
// path is `dispatchSlaBreach` below, which fans out to every active
// superadmin via notifyAdmins. Keeping a dead second implementation of the
// same escalation, wired to a fake recipient, was a trap for the next
// person to grep for 'sla_breach'.

/**
 * Fan out an admin notification to every active superadmin.
 *
 * Theme 7b Phase 1 (per OQ-8): factored from two pre-existing inline
 * copies — one in `dispatchSlaBreach` below (Theme 7 Phase 2) and one
 * in `src/video_scheduler.js notifyAdmins` (Theme 6 Phase 4). Both old
 * call sites now route through this canonical helper.
 *
 * Per-recipient dedupe key suffix (`${dedupeKey}:${r.id}`) matches the
 * unique index on notifications(dedupe_key, channel, to_user_id),
 * making each (event × recipient) pair idempotent on re-fire. The
 * inline pre-INSERT SELECT used by the old dispatchSlaBreach is now
 * redundant — queueNotification's own dedupe pre-check at
 * notify.js:280-290 catches existing rows just as well.
 *
 * @param {Object} opts
 * @param {string} opts.template     - Notification template name.
 * @param {Object} [opts.payload]    - JSON-serializable response payload.
 * @param {string} opts.dedupeKey    - Base dedupe key; per-recipient suffix
 *                                     `${dedupeKey}:${r.id}` is appended
 *                                     automatically.
 * @param {string} [opts.orderId]    - Optional order id for linking.
 * @param {string} [opts.channel]    - Notification channel; defaults to
 *                                     'internal' (in-app admin queue).
 *                                     Pass 'whatsapp' for SLA-breach
 *                                     escalations.
 * @returns {Promise<Array>} - Per-recipient queueNotification results.
 */
async function notifyAdmins({ template, payload, dedupeKey, orderId, channel } = {}) {
  if (!template || !dedupeKey) return [];
  const ch = channel || 'internal';

  let recipients = [];
  try {
    recipients = await queryAll(
      "SELECT id FROM users WHERE role = 'superadmin' AND COALESCE(is_active, true) = true"
    );
  } catch (e) {
    console.error('[notify.notifyAdmins] superadmin lookup failed:', e && e.message);
    return [];
  }
  if (!recipients || recipients.length === 0) {
    return [];
  }

  const results = [];
  for (const r of recipients) {
    try {
      const result = await queueNotification({
        orderId: orderId || null,
        toUserId: r.id,
        channel: ch,
        template,
        status: 'queued',
        response: (payload && typeof payload === 'object') ? JSON.stringify(payload) : payload,
        dedupe_key: `${dedupeKey}:${r.id}`,
      });
      results.push(result);
    } catch (e) {
      console.error('[notify.notifyAdmins] enqueue failed for', r.id, ':', e && e.message);
    }
  }
  return results;
}

/**
 * Dispatch the SLA-breach WhatsApp alert to every active superadmin.
 *
 * Theme 7 sub-issue B: queries active superadmins instead of the
 * hardcoded 'superadmin-1' placeholder. Theme 7b Phase 1: refactored
 * to delegate to the shared `notifyAdmins` helper — no behaviour
 * change for callers (return value still ignored at every callsite).
 */
async function dispatchSlaBreach(caseId) {
  if (!caseId) return;
  return notifyAdmins({
    template: 'sla_breach',
    payload: { case_id: caseId, status: 'breached' },
    dedupeKey: `sla:breach:${caseId}`,
    channel: 'whatsapp',
  });
}

/**
 * Queue a notification across multiple channels simultaneously.
 * Respects user preferences: skips WhatsApp if user has no phone or notify_whatsapp=0,
 * skips email if user has no email address.
 *
 * @param {Object} options
 * @param {string} [options.orderId] - Related order ID
 * @param {string} options.toUserId - User ID or email
 * @param {string[]} options.channels - Array of channels: ['email', 'whatsapp', 'internal'] or ['both']
 * @param {string} options.template - Notification template name
 * @param {string} [options.status='queued'] - Initial status
 * @param {Object|string} [options.response] - Response/metadata payload
 * @param {string} [options.dedupe_key] - Base deduplication key (channel suffix auto-appended)
 * @returns {Promise<Object>} Result with per-channel outcomes
 */
async function queueMultiChannelNotification({
  orderId = null,
  toUserId,
  channels = ['internal'],
  template,
  status = 'queued',
  response = null,
  dedupe_key = null
}) {
  // Expand 'both' shorthand
  let resolvedChannels = channels;
  if (channels.includes('both')) {
    resolvedChannels = ['email', 'whatsapp', 'internal'];
  }

  const uid = await normalizeToUserId(toUserId);
  if (!uid) {
    emitNotificationDropped({ orderId, reason: 'invalid_to_user_id', channel: 'multi', template, toUserId });
    return { ok: false, skipped: true, reason: 'invalid_to_user_id', toUserId };
  }

  // Look up user preferences once
  let user = null;
  try {
    user = await queryOne(
      'SELECT id, email, phone, notify_whatsapp FROM users WHERE id = $1 LIMIT 1',
      [uid]
    );
  } catch (e) {
    console.error('[notify] user lookup for multi-channel failed', { uid, error: e.message });
  }

  const results = {};

  // P1-NOTIF-1: dispatch channels concurrently via Promise.allSettled.
  // Previously the for-await loop ran channels sequentially, so a slow
  // WhatsApp dispatch blocked email queueing. allSettled ensures one
  // channel's failure or slowness never affects another.
  const channelTasks = resolvedChannels.map(function (ch) {
    // Channel-specific preference checks. Resolve synchronously to
    // a "skipped" result so we don't even spawn a queueNotification
    // promise for channels that can't fire.
    if (ch === 'whatsapp') {
      if (!user || !user.phone) {
        emitNotificationDropped({ orderId, reason: 'no_phone', channel: ch, template, toUserId: uid });
        return Promise.resolve([ch, { ok: true, skipped: true, reason: 'no_phone' }]);
      }
      if (user.notify_whatsapp === 0 || user.notify_whatsapp === false) {
        emitNotificationDropped({ orderId, reason: 'whatsapp_opted_out', channel: ch, template, toUserId: uid });
        return Promise.resolve([ch, { ok: true, skipped: true, reason: 'whatsapp_opted_out' }]);
      }
    }
    if (ch === 'email') {
      if (!user || !user.email) {
        emitNotificationDropped({ orderId, reason: 'no_email', channel: ch, template, toUserId: uid });
        return Promise.resolve([ch, { ok: true, skipped: true, reason: 'no_email' }]);
      }
    }

    const channelDedupeKey = dedupe_key ? `${dedupe_key}:${ch}` : null;
    return queueNotification({
      orderId,
      toUserId: uid,
      channel: ch,
      template,
      status,
      response,
      dedupe_key: channelDedupeKey,
    }).then(function (r) { return [ch, r]; });
  });

  const settled = await Promise.allSettled(channelTasks);
  settled.forEach(function (s, idx) {
    if (s.status === 'fulfilled') {
      var pair = s.value;
      results[pair[0]] = pair[1];
    } else {
      results[resolvedChannels[idx]] = { ok: false, error: s.reason && s.reason.message ? s.reason.message : String(s.reason) };
    }
  });

  return { ok: true, results };
}

module.exports = {
  queueNotification,
  queueMultiChannelNotification,
  doctorNotify,
  // `processCaseEvent` removed with its definition — see the comment above
  // dispatchSlaBreach. It had no callers and targeted the demo-seed id
  // 'superadmin-1'.
  dispatchSlaBreach,
  notifyAdmins,
  sendSlaReminder,
  PAYMENT_REMINDER_TEMPLATES,
  buildPaymentReminderPayload,
  clearEmailCache,
  // Side issue #46 — exported so notification_worker can emit the
  // NOTIFICATION_DROPPED case_event on max-retries-exceeded (the
  // enqueue-side already emits for invalid recipient / no channel /
  // db_insert_failed via the same helper).
  emitNotificationDropped
};
