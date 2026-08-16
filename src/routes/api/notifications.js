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
      SELECT id, type, template, title, message, is_read as read,
             -- AUDIT-APP-H9: the app navigates on notif.data.caseId, but NO
             -- INSERT anywhere in the codebase writes the data column — it is
             -- always NULL, so every notification was inert, including "your
             -- report is ready". order_id IS populated by notify.js, so return
             -- it and synthesize the payload below.
             order_id as "orderId",
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
      } catch { n.data = null; }
      // AUDIT-APP-H9: synthesize a navigable payload from order_id when the
      // stored `data` blob is absent (which is every row today). Keeps the
      // app's existing `notif.data?.caseId` contract working unchanged.
      if (!n.data && n.orderId) {
        n.data = { screen: 'case-detail', caseId: n.orderId };
      }
      n.read = !!n.read;
    });

    // AUDIT-APP — localise the title to the RECIPIENT's language.
    // notifications.title is written once at insert time in English
    // (notify.js), and title_ar was never used anywhere, so Arabic patients —
    // the primary market — saw English titles throughout. Re-derive from the
    // template against the user's stored lang; fall back to the stored title
    // for any template with no registered copy.
    try {
      const { getNotificationTitles } = require('../../notify/notification_titles');
      const me = await safeGet('SELECT lang FROM users WHERE id = $1', [req.user.id]);
      const isAr = String((me && me.lang) || 'en').toLowerCase() === 'ar';
      notifications.forEach(n => {
        const t = getNotificationTitles(n.template || n.type);
        const localized = isAr ? (t && t.title_ar) : (t && t.title_en);
        if (localized) n.title = localized;
        delete n.template;
      });
    } catch (_) {
      // Never fail the list because a title could not be localised.
    }

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
