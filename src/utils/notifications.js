// src/utils/notifications.js
// Shared notification helpers — replaces duplicated logic in patient/doctor/admin/superadmin routes.
// P3 fix: extracted from 4 separate route files (each had ~200 lines of identical logic).

const { queryOne, queryAll } = require('../pg');

// Cache column names once per process startup to avoid repeated information_schema queries (P2-14 fix)
let _colCache = null;
let _colCacheReady = false;

async function getNotificationTableColumns() {
  if (_colCacheReady) return _colCache;
  try {
    const cols = await queryAll(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'notifications'"
    );
    _colCache = Array.isArray(cols) ? cols.map((c) => c.name) : [];
  } catch (_) {
    _colCache = [];
  }
  _colCacheReady = true;
  return _colCache;
}

function pickNotificationTimestampColumn(cols) {
  const c = cols || [];
  if (c.includes('at')) return 'at';
  if (c.includes('created_at')) return 'created_at';
  if (c.includes('timestamp')) return 'timestamp';
  return null;
}

/**
 * Build the WHERE clause + params for a given userId/email combo.
 * Works for any role — just pass the user's id and optionally email.
 */
function buildOwnerClause(cols, userId, userEmail) {
  const hasUserId = cols.includes('user_id');
  const hasToUserId = cols.includes('to_user_id');
  const where = [];
  const params = [];
  let paramIdx = 0;

  if (hasUserId) {
    paramIdx++;
    where.push(`user_id = $${paramIdx}`);
    params.push(String(userId));
  }
  if (hasToUserId) {
    paramIdx++;
    where.push(`to_user_id = $${paramIdx}`);
    params.push(String(userId));
    const email = String(userEmail || '').trim();
    if (email) {
      paramIdx++;
      where.push(`to_user_id = $${paramIdx}`);
      params.push(email);
    }
  }
  return { where, params, paramIdx, hasOwner: where.length > 0 };
}

/**
 * Fetch notifications for any user (patient, doctor, admin, superadmin).
 */
async function fetchNotifications(userId, userEmail = '', limit = 50) {
  const cols = await getNotificationTableColumns();
  const tsCol = pickNotificationTimestampColumn(cols);
  if (!tsCol) return [];

  const { where, params, paramIdx, hasOwner } = buildOwnerClause(cols, userId, userEmail);
  if (!hasOwner) return [];

  const selectCols = [
    'id',
    cols.includes('order_id') ? 'order_id' : null,
    cols.includes('channel') ? 'channel' : null,
    cols.includes('template') ? 'template' : null,
    cols.includes('status') ? 'status' : null,
    cols.includes('is_read') ? 'is_read' : null,
    cols.includes('response') ? 'response' : null,
    tsCol
  ].filter(Boolean);

  const sql = `SELECT ${selectCols.join(', ')} FROM notifications WHERE (${where.join(' OR ')}) ORDER BY ${tsCol} DESC LIMIT $${paramIdx + 1}`;
  try {
    return await queryAll(sql, [...params, Number(limit)]);
  } catch (_) {
    return [];
  }
}

/**
 * Count unseen notifications for any user.
 */
async function countUnseenNotifications(userId, userEmail = '') {
  try {
    const cols = await getNotificationTableColumns();
    const { where, params, hasOwner } = buildOwnerClause(cols, userId, userEmail);
    if (!hasOwner) return 0;

    const ownerClause = `(${where.join(' OR ')})`;

    if (cols.includes('is_read')) {
      const row = await queryOne(
        `SELECT COUNT(*) as c FROM notifications WHERE ${ownerClause} AND COALESCE(is_read, false) = false`,
        params
      );
      return row ? Number(row.c || 0) : 0;
    }
    if (cols.includes('status')) {
      const row = await queryOne(
        `SELECT COUNT(*) as c FROM notifications WHERE ${ownerClause} AND COALESCE(LOWER(status), '') NOT IN ('seen','read')`,
        params
      );
      return row ? Number(row.c || 0) : 0;
    }
    return 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Mark all notifications as read for any user.
 */
async function markAllNotificationsRead(userId, userEmail = '') {
  try {
    const cols = await getNotificationTableColumns();
    const { where, params, hasOwner } = buildOwnerClause(cols, userId, userEmail);
    if (!hasOwner) return;

    const ownerClause = `(${where.join(' OR ')})`;
    const { execute } = require('../pg');

    if (cols.includes('is_read')) {
      await execute(
        `UPDATE notifications SET is_read = true${cols.includes('status') ? ", status = 'seen'" : ''} WHERE ${ownerClause} AND COALESCE(is_read, false) = false`,
        params
      );
    } else if (cols.includes('status')) {
      await execute(
        `UPDATE notifications SET status = 'seen' WHERE ${ownerClause} AND COALESCE(LOWER(status), '') NOT IN ('seen','read')`,
        params
      );
    }
  } catch (_) {}
}

/**
 * Normalise a notification row for template consumption.
 * Returns a plain object safe for EJS rendering.
 */
function normalizeNotification(n) {
  if (!n) return null;
  let parsedResponse = null;
  try {
    if (n.response) parsedResponse = typeof n.response === 'string' ? JSON.parse(n.response) : n.response;
  } catch (_) {}
  return {
    id: n.id,
    orderId: n.order_id || null,
    channel: n.channel || 'internal',
    template: n.template || '',
    status: n.status || 'queued',
    isRead: n.is_read === true || n.status === 'seen' || n.status === 'read',
    response: parsedResponse,
    at: n.at || n.created_at || n.timestamp || null
  };
}

module.exports = {
  getNotificationTableColumns,
  fetchNotifications,
  countUnseenNotifications,
  markAllNotificationsRead,
  normalizeNotification
};
