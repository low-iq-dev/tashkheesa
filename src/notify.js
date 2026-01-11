// src/notify.js

const { randomUUID } = require('crypto');
const { db } = require('./db');

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
  response = null
}) {
  const uid = normalizeToUserId(toUserId);

  // If uid can't be resolved, do NOT insert (prevents trigger abort + bad data)
  if (!uid) {
    return { ok: false, skipped: true, reason: 'invalid_to_user_id', toUserId };
  }

  const notifId = id || randomUUID();

  try {
    db.prepare(
      `INSERT INTO notifications (id, order_id, to_user_id, channel, template, status, response)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      notifId,
      orderId,
      uid,
      channel,
      template,
      status,
      response
    );

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

module.exports = {
  queueNotification,
  doctorNotify
};