// src/audit.js
const { randomUUID } = require('crypto');
const { db } = require('./db');
const { major: logMajor } = require('./logger');

/**
 * Log an order event to the audit trail.
 * Used for tracking order status changes, doctor actions, SLA events, etc.
 *
 * @param {Object} options - Event details
 * @param {string} options.orderId - Order ID
 * @param {string} options.label - Event description (e.g., "Doctor accepted order")
 * @param {Object} options.meta - Optional metadata (JSON serializable)
 * @param {string} options.actorUserId - User who triggered the event (null for system events)
 * @param {string} options.actorRole - Role of the actor (doctor, patient, admin, superadmin, system)
 * @returns {void}
 */
function logOrderEvent({ orderId, label, meta = null, actorUserId = null, actorRole = null }) {
  if (!orderId || !label) return;
  try {
    const eventId = randomUUID();
    const metaJson = meta ? JSON.stringify(meta) : null;

    db.prepare(
      `INSERT INTO order_events (id, order_id, label, meta, actor_user_id, actor_role, at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(eventId, orderId, label, metaJson, actorUserId, actorRole);

    // === PHASE 3: FIX #14 - AUDIT LOGGING ===
    // Log sensitive operations to application logs for monitoring
    if (actorRole && ['doctor', 'admin', 'superadmin'].includes(actorRole)) {
      logMajor(`[AUDIT] ${actorRole.toUpperCase()} action: ${label}`, {
        orderId,
        actorUserId,
        eventId
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('logOrderEvent error', err);
  }
}

module.exports = { logOrderEvent };
