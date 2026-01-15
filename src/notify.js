// src/notify.js

const { randomUUID } = require('crypto');
const { db } = require('./db');
const { sendWhatsApp } = require('./notify/whatsapp');

const WHATSAPP_ENABLED = String(process.env.WHATSAPP_ENABLED || 'false') === 'true';
const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || 'false') === 'true';

/**
 * Hard rule:
 * notifications.to_user_id must ALWAYS be users.id (NOT email).
 * If an email is passed, resolve to users.id. If not resolvable, skip insert.
 */
function normalizeToUserId(toUserId) {
  const raw = String(toUserId == null ? '' : toUserId).trim();
  if (!raw) return null;

  // If it's an email, resolve to the user's id
  if (raw.includes('@')) {
    const row = db
      .prepare(`SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`)
      .get(raw);
    return row ? row.id : null;
  }

  return raw;
}

function queueNotification({
  id,
  orderId = null,
  toUserId,
  channel = 'internal',
  template,
  status = 'queued',
  response = null,
  dedupe_key = null
}) {
  const uid = normalizeToUserId(toUserId);

  if (dedupe_key) {
    const exists = db.prepare(`
      SELECT 1 FROM notifications
      WHERE dedupe_key = ?
        AND channel = ?
        AND to_user_id = ?
      LIMIT 1
    `).get(dedupe_key, channel, uid);

    if (exists) {
      return { ok: true, skipped: 'deduped', dedupe_key };
    }
  }

  // If uid can't be resolved, do NOT insert (prevents trigger abort + bad data)
  if (!uid) {
    return { ok: false, skipped: true, reason: 'invalid_to_user_id', toUserId };
  }

  const notifId = id || randomUUID();

  const safeResponse = response == null ? null : (typeof response === 'string' ? response : JSON.stringify(response));

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
      safeResponse,
      dedupe_key
    );

    // Fire-and-forget external channels
    if (channel === 'whatsapp') {
      if (!WHATSAPP_ENABLED) {
        console.log('[notify] whatsapp disabled, queued only', { template, to: uid });
        return;
      }
      try {
        // Resolve phone from user profile (language is optional; default to 'en').
        const user = db
          .prepare(`SELECT phone FROM users WHERE id = ? LIMIT 1`)
          .get(uid);

        if (user && user.phone) {
          sendWhatsApp({
            to: user.phone,
            template,
            lang: 'en',
            vars: typeof response === 'object' && response !== null ? response : {}
          });
        }
      } catch (e) {
        console.error('[notify] whatsapp dispatch failed', e);
      }
    }

    return { ok: true, id: notifId };
  } catch (err) {
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

  // Prevent duplicate reminders (unique by dedupe_key index)
  const dedupeKey = `sla:${level}:${order.id}`;
  const exists = db.prepare(`
    SELECT 1 FROM notifications
    WHERE dedupe_key = ?
    LIMIT 1
  `).get(dedupeKey);

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
  sendSlaReminder
};