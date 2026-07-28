/**
 * Expo Push Notification Sender
 *
 * Sends push notifications to patient devices via Expo Push API.
 * Called from case lifecycle events, messaging, and payment hooks.
 *
 * Requires: expo-server-sdk (npm install expo-server-sdk)
 */

// NOTE: Install with: npm install expo-server-sdk
// const { Expo } = require('expo-server-sdk');
// const expo = new Expo();

// For now, we use a direct fetch implementation that doesn't need the SDK.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Role-agnostic core: send ONE Expo push to an already-resolved (userId, token).
 *
 * This is the raw Expo send extracted verbatim from sendPushNotification so the
 * patient path AND notifySuperadmins share a single implementation of token-
 * format validation, the exp.host call, and DeviceNotRegistered cleanup. It has
 * NO try/catch of its own — the caller owns error handling (sendPushNotification
 * wraps it exactly as before), so behaviour for existing patient consumers is
 * unchanged. Never returns a value.
 *
 * @param {Object} db - Database instance (better-sqlite3 or pg)
 * @param {string} userId - User whose token this is (for cleanup + log context)
 * @param {string} pushToken - the Expo token to send to
 * @param {Object} notification - { title, body, data? }
 */
async function _sendExpoPush(db, userId, pushToken, { title, body, data = {} }) {
  // Validate Expo push token format
  if (!pushToken.startsWith('ExponentPushToken[') && !pushToken.startsWith('ExpoPushToken[')) {
    console.warn(`[push] Invalid push token for user ${userId}`);
    return;
  }

  const message = {
    to: pushToken,
    title,
    body,
    data,
    sound: 'default',
    priority: 'high',
  };

  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify([message]),
  });

  const result = await response.json();

  if (result.data?.[0]?.status === 'error') {
    console.error(`[push] Failed for user ${userId}:`, result.data[0].message);

    // If the token is invalid, remove it
    if (result.data[0].details?.error === 'DeviceNotRegistered') {
      if (db.prepare) {
        db.prepare('UPDATE users SET push_token = NULL WHERE id = ?').run(userId);
      } else {
        await db.query('UPDATE users SET push_token = NULL WHERE id = $1', [userId]);
      }
      console.log(`[push] Removed invalid token for user ${userId}`);
    }
  }
}

/**
 * Send a push notification to a user.
 *
 * Behaviour is unchanged from before the _sendExpoPush extraction: look up the
 * user's push_token, no-op if absent, else send via the shared core, swallowing
 * any error with the same log line. Signature is byte-compatible — live patient
 * consumers (routes/api/conversations.js → notifyNewMessage) are unaffected.
 *
 * @param {Object} db - Database instance (better-sqlite3 or pg)
 * @param {string} userId - User ID to notify
 * @param {Object} notification
 * @param {string} notification.title - Notification title
 * @param {string} notification.body - Notification body text
 * @param {Object} [notification.data] - Extra data (screen, caseId, etc.)
 */
async function sendPushNotification(db, userId, { title, body, data = {} }) {
  try {
    // Get user's push token
    let pushToken;
    if (db.prepare) {
      // SQLite (better-sqlite3)
      const row = db.prepare('SELECT push_token FROM users WHERE id = ?').get(userId);
      pushToken = row?.push_token;
    } else {
      // PostgreSQL
      const result = await db.query('SELECT push_token FROM users WHERE id = $1', [userId]);
      pushToken = result.rows[0]?.push_token;
    }

    if (!pushToken) return;

    await _sendExpoPush(db, userId, pushToken, { title, body, data });
  } catch (err) {
    console.error(`[push] Error sending to user ${userId}:`, err.message);
  }
}

/**
 * Notify every superadmin device.
 *
 * Looks up users.push_token for role='superadmin' rows (reusing the SAME column
 * the patient path uses) and sends each via the shared core. Swallow-and-log at
 * BOTH levels: a single bad recipient never stops the rest, and a lookup failure
 * (DB down, unexpected schema, no superadmin registered) never throws. Callers
 * such as the worker watchdog must never break because a push failed.
 *
 * @param {Object} db - pg Pool / better-sqlite3 handle (same shape as sendPushNotification)
 * @param {Object} notification - { title, body, data? }
 */
async function notifySuperadmins(db, { title, body, data = {} }) {
  try {
    let rows;
    if (db.prepare) {
      // SQLite (better-sqlite3)
      rows = db.prepare("SELECT id, push_token FROM users WHERE role = 'superadmin' AND push_token IS NOT NULL").all();
    } else {
      // PostgreSQL
      const result = await db.query("SELECT id, push_token FROM users WHERE role = 'superadmin' AND push_token IS NOT NULL");
      rows = result.rows;
    }

    for (const row of (rows || [])) {
      if (!row || !row.push_token) continue;
      try {
        await _sendExpoPush(db, row.id, row.push_token, { title, body, data });
      } catch (err) {
        // One bad recipient must not abort the rest.
        console.error(`[push] Error notifying superadmin ${row.id}:`, err.message);
      }
    }
  } catch (err) {
    // Lookup / unexpected failure must never break the caller.
    console.error('[push] notifySuperadmins failed:', err.message);
  }
}

/**
 * Helper: Notify patient about case status change.
 */
async function notifyCaseUpdate(db, patientId, caseData) {
  const statusMessages = {
    under_review: { title: 'Case under review', body: `Your ${caseData.serviceName} case is being reviewed.` },
    assigned: { title: 'Doctor assigned', body: `Dr. ${caseData.doctorName} is now reviewing your case.` },
    in_progress: { title: 'Case in progress', body: `Dr. ${caseData.doctorName} is working on your report.` },
    completed: { title: 'Report ready', body: `Your ${caseData.serviceName} second opinion is ready to view.` },
    cancelled: { title: 'Case cancelled', body: `Your ${caseData.serviceName} case has been cancelled.` },
  };

  const msg = statusMessages[caseData.status];
  if (!msg) return;

  await sendPushNotification(db, patientId, {
    ...msg,
    data: { screen: 'case-detail', caseId: caseData.id },
  });
}

/**
 * Helper: Notify patient about new message.
 */
async function notifyNewMessage(db, patientId, doctorName, conversationId, preview) {
  await sendPushNotification(db, patientId, {
    title: `New message from Dr. ${doctorName}`,
    body: preview.length > 80 ? preview.slice(0, 80) + '...' : preview,
    data: { screen: 'chat', conversationId },
  });
}

/**
 * Helper: Notify patient about payment.
 */
async function notifyPaymentConfirmed(db, patientId, caseData) {
  await sendPushNotification(db, patientId, {
    title: 'Payment confirmed',
    body: `${caseData.currency} ${caseData.price} received for ${caseData.serviceName}.`,
    data: { screen: 'case-detail', caseId: caseData.id },
  });
}

module.exports = {
  sendPushNotification,
  notifyCaseUpdate,
  notifyNewMessage,
  notifyPaymentConfirmed,
  notifySuperadmins,
};
