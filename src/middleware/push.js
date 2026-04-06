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
 * Send a push notification to a user.
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
  } catch (err) {
    console.error(`[push] Error sending to user ${userId}:`, err.message);
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
};
