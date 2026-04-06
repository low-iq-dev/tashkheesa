/**
 * Notifications API Routes — /api/v1/notifications/*
 */

const router = require('express').Router();

module.exports = function (db, { safeGet, safeAll, safeRun }) {

  // ─── GET /notifications ──────────────────────────────────

  router.get('/', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.per_page) || 30;
    const offset = (page - 1) * perPage;

    const notifications = await safeAll(`
      SELECT id, type, title, message, is_read as read,
             data, at as "createdAt"
      FROM notifications
      WHERE to_user_id = $1
      ORDER BY at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.id, perPage, offset]);

    // Parse JSON data field
    notifications.forEach(n => {
      try {
        n.data = n.data ? JSON.parse(n.data) : null;
        n.read = !!n.read;
      } catch { n.data = null; }
    });

    return res.ok(notifications);
  });

  // ─── GET /notifications/unread-count ─────────────────────

  router.get('/unread-count', async (req, res) => {
    const row = await safeGet(
      'SELECT COUNT(*)::int as count FROM notifications WHERE to_user_id = $1 AND is_read = false',
      [req.user.id]
    );
    return res.ok({ count: row?.count || 0 });
  });

  // ─── PATCH /notifications/:id/read ───────────────────────

  router.patch('/:id/read', async (req, res) => {
    await safeRun(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND to_user_id = $2',
      [req.params.id, req.user.id]
    );

    return res.ok({ message: 'Marked as read' });
  });

  // ─── POST /notifications/read-all ────────────────────────

  router.post('/read-all', async (req, res) => {
    await safeRun(
      'UPDATE notifications SET is_read = true WHERE to_user_id = $1 AND is_read = false',
      [req.user.id]
    );

    return res.ok({ message: 'All notifications marked as read' });
  });

  return router;
};
