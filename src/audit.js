// src/audit.js
const { randomUUID } = require('crypto');
const { db } = require('./db');

function logOrderEvent({ orderId, label, meta = null, actorUserId = null, actorRole = null }) {
  if (!orderId || !label) return;
  try {
    db.prepare(
      `INSERT INTO order_events (id, order_id, label, meta, actor_user_id, actor_role, at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(randomUUID(), orderId, label, meta, actorUserId, actorRole);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('logOrderEvent error', err);
  }
}

module.exports = { logOrderEvent };
