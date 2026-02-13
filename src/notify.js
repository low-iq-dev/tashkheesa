// src/notify.js

const { randomUUID } = require('crypto');
const { db } = require('./db');
const { sendWhatsApp } = require('./notify/whatsapp');

const WHATSAPP_ENABLED = String(process.env.WHATSAPP_ENABLED || 'false') === 'true';
const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || 'false') === 'true';

// === PHASE 2: FIX #7 - CACHE FOR N+1 QUERY PREVENTION ===
// Cache email→id resolutions within a sweep to avoid repeated queries
// Cleared after each notification batch to prevent stale data
const emailToIdCache = new Map();

function clearEmailCache() {
  emailToIdCache.clear();
}

function getCachedUserId(email) {
  const normalized = String(email || '').toLowerCase().trim();
  if (!normalized) return null;

  // Check cache first
  if (emailToIdCache.has(normalized)) {
    return emailToIdCache.get(normalized);
  }

  // Query if not in cache
  try {
    const row = db
      .prepare(`SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`)
      .get(normalized);
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
function normalizeToUserId(toUserId) {
  const raw = String(toUserId == null ? '' : toUserId).trim();
  if (!raw) return null;

  // If it's an email, resolve to the user's id using cache
  if (raw.includes('@')) {
    return getCachedUserId(raw);
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
 * @returns {Object} Result object
 * @returns {boolean} result.ok - Whether insertion succeeded
 * @returns {string} result.id - Notification ID (if created)
 * @returns {boolean} result.skipped - Whether notification was skipped (deduped)
 * @returns {string} result.reason - Reason for skip (e.g., 'invalid_to_user_id', 'deduped')
 * 
 * Behavior:
 * - Normalizes toUserId (resolves emails to user IDs via cache)
 * - Auto-generates dedupe keys for SLA and payment reminders if missing
 * - Prevents duplicates via unique dedupe_key constraint
 * - Stores response payload as JSON in database
 * - For WhatsApp: Dispatches immediately (fire-and-forget)
 * - All failures are logged; no exceptions thrown
 * 
 * Side Effects:
 * - Inserts into notifications table
 * - Populates email cache (getCachedUserId)
 * - May dispatch WhatsApp message
 * - Logs errors and dispatch attempts
 * 
 * Deduplication:
 * - dedupe_key uniqueness prevents duplicate notifications
 * - Examples: 'sla:reminder:order-123:doctor', 'payment:reminder:order-456:patient'
 * - NULL dedupe_key is allowed (not deduplicated)
 * 
 * @example
 * // Queue a simple reminder
 * queueNotification({
 *   orderId: 'order-123',
 *   toUserId: 'doctor-1',
 *   template: 'sla_reminder_doctor',
 *   dedupe_key: 'sla:reminder:order-123:doctor'
 * });
 * 
 * @example
 * // Queue with response metadata
 * queueNotification({
 *   orderId: 'order-456',
 *   toUserId: 'patient-1@example.com',  // Resolves to user ID via cache
 *   channel: 'whatsapp',
 *   template: 'payment_reminder',
 *   response: { payment_url: 'https://pay.example.com/order-456' },
 *   dedupe_key: 'payment:reminder:order-456:patient'
 * });
 */
function queueNotification({
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
  const uid = normalizeToUserId(toUserId);

  // If uid can't be resolved, do NOT insert (prevents trigger abort + bad data)
  if (!uid) {
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

  if (normalizedDedupeKey) {
    const exists = db.prepare(`
      SELECT 1 FROM notifications
      WHERE dedupe_key = ?
        AND channel = ?
        AND to_user_id = ?
      LIMIT 1
    `).get(normalizedDedupeKey, channel, uid);

    if (exists) {
      return { ok: true, skipped: 'deduped', dedupe_key: normalizedDedupeKey };
    }
  }

  const notifId = id || randomUUID();

  // Always store response as JSON text (SQLite binding safety)
  const responseJson = (typeof response === 'string')
    ? response
    : JSON.stringify(response ?? null);

  try {
    db.prepare(
      `INSERT INTO notifications (id, order_id, to_user_id, channel, template, status, response, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      notifId,
      orderId,
      uid,
      channel,
      template,
      status,
      responseJson,
      normalizedDedupeKey
    );

    // Fire-and-forget external channels
    // === PHASE 2: FIX #8 - IMPROVED ERROR HANDLING FOR EXTERNAL NOTIFICATIONS ===
    if (channel === 'whatsapp') {
      if (!WHATSAPP_ENABLED) {
        console.log('[notify] whatsapp disabled, queued only', { id: notifId, template, to: uid });
        return { ok: true, id: notifId, status: 'queued' };
      }
      try {
        // Resolve phone from user profile (language is optional; default to 'en').
        const user = db
          .prepare(`SELECT phone FROM users WHERE id = ? LIMIT 1`)
          .get(uid);

        if (user && user.phone) {
          try {
            const dispatchResult = sendWhatsApp({
              to: user.phone,
              template,
              lang: 'en',
              vars: typeof response === 'object' && response !== null ? response : {}
            });

            if (dispatchResult && dispatchResult.ok === false) {
              // sendWhatsApp returned error; log but don't fail the notification queue
              console.error('[notify] whatsapp dispatch returned error', {
                id: notifId,
                template,
                to: uid,
                phone: user.phone,
                error: dispatchResult.error || 'unknown'
              });
            } else {
              console.log('[notify] whatsapp dispatched successfully', {
                id: notifId,
                template,
                to: uid,
                phone: user.phone
              });
            }
          } catch (dispatchErr) {
            // Catch errors from sendWhatsApp itself
            console.error('[notify] whatsapp dispatch exception', {
              id: notifId,
              template,
              to: uid,
              error: dispatchErr && dispatchErr.message ? dispatchErr.message : String(dispatchErr)
            });
          }
        } else {
          console.warn('[notify] whatsapp dispatch skipped: no phone number for user', {
            id: notifId,
            template,
            to: uid
          });
        }
      } catch (e) {
        console.error('[notify] whatsapp user lookup failed', {
          id: notifId,
          template,
          to: uid,
          error: e && e.message ? e.message : String(e)
        });
      }
    }

    return { ok: true, id: notifId };
  } catch (err) {
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

function sendSlaReminder({ order, level }) {
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
  const exists = db.prepare(`
    SELECT 1 FROM notifications
    WHERE dedupe_key = ?
      AND channel = ?
      AND to_user_id = ?
    LIMIT 1
  `).get(dedupeKey, 'whatsapp', order.doctor_id);

  if (exists) return { ok: true, skipped: true };

  return queueNotification({
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
function doctorNotify({ doctor, template, order }) {
  if (!doctor || !doctor.id || !template) return { ok: false, skipped: true };
  return queueNotification({
    orderId: order && order.id ? order.id : null,
    toUserId: doctor.id,
    channel: 'internal',
    template,
    status: 'queued'
  });
}

function processCaseEvent(event) {
  if (!event || event.event_type !== 'SLA_BREACHED') return;

  // Prevent duplicate alerts (unique by dedupe_key index)
  const dedupeKey = `sla:breach:${event.case_id}`;
  const exists = db.prepare(`
    SELECT 1 FROM notifications
    WHERE dedupe_key = ?
    LIMIT 1
  `).get(dedupeKey);

  if (exists) return;

  queueNotification({
    channel: 'whatsapp',
    toUserId: 'superadmin-1',
    template: 'sla_breach',
    dedupe_key: dedupeKey,
    response: {
      case_id: event.case_id,
      status: 'breached'
    }
  });
}

function dispatchSlaBreach(caseId) {
  if (!caseId) return;

  // Prevent duplicate alerts (unique by dedupe_key index)
  const dedupeKey = `sla:breach:${caseId}`;
  const exists = db.prepare(`
    SELECT 1 FROM notifications
    WHERE dedupe_key = ?
    LIMIT 1
  `).get(dedupeKey);

  if (exists) return;

  queueNotification({
    channel: 'whatsapp',
    toUserId: 'superadmin-1',
    template: 'sla_breach',
    dedupe_key: dedupeKey,
    response: {
      case_id: caseId,
      status: 'breached'
    }
  });
}

module.exports = {
  queueNotification,
  doctorNotify,
  processCaseEvent,
  dispatchSlaBreach,
  sendSlaReminder,
  PAYMENT_REMINDER_TEMPLATES,
  buildPaymentReminderPayload,
  clearEmailCache  // === PHASE 2: Export cache clearing for batch operations ===
};
