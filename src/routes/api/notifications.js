/**
 * Notifications API Routes — /api/v1/notifications/*
 */

const router = require('express').Router();

// Which app screen a notification should open.
//
// NOTIFICATIONS 2026-08-25. Kept deliberately small: anything not listed lands
// on the case, which is the right default for a platform where almost every
// notification is about a case. The exceptions are the ones where the case page
// offers nothing to do about what the notification just said.
const PAYMENT_SCREEN_TEMPLATES = new Set([
  'payment_reminder_30m',
  'payment_reminder_6h',
  'payment_reminder_24h',
  'payment_failed_patient'
]);

function screenForTemplate(template) {
  if (PAYMENT_SCREEN_TEMPLATES.has(String(template || ''))) return 'payment';
  if (String(template || '') === 'new_message') return 'chat';
  return 'case-detail';
}

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
      -- NOTIFICATIONS 2026-08-25 — channel = 'internal'.
      --
      -- The notifications table holds ONE ROW PER CHANNEL. Without this
      -- filter the app listed the patient's emails and WhatsApp messages as if
      -- they were in-app notifications. On production one patient had 40 rows
      -- of payment_reminder_30m and 38 of payment_reminder_6h in their bell --
      -- all of them email/whatsapp deliveries of the same handful of events.
      --
      -- The SLA and payment reminder dispatchers (case_lifecycle.js) were sent
      -- on whatsapp+email only and appeared here purely BECAUSE this filter was
      -- missing; both now also queue an 'internal' row, in the same change, so
      -- adding this does not silently delete them from the app.
      WHERE to_user_id = $1 AND channel = 'internal'
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
        // NOTIFICATIONS 2026-08-25 — route by template, not always to the case.
        //
        // Every notification landed on case detail. For the payment nudges that
        // is the wrong screen: the ONE notification whose entire purpose is to
        // get the patient to pay dropped them on a page with no payment action.
        // (Those rows also carried order_id NULL until today, so they did not
        // even reach the case — see case_lifecycle.queuePaymentReminder.)
        n.data = { screen: screenForTemplate(n.template || n.type), caseId: n.orderId };
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
        // NOTIFICATIONS 2026-08-25 — `template` is no longer deleted.
        //
        // The app keys its icon, title and body maps on `type`, which
        // notify.js writes as the raw template name. The app's map used a
        // legacy vocabulary (case_update / report_ready / payment) whose
        // intersection with the real template names was exactly ONE value:
        // new_message. Everything else fell through to a generic bell, so a
        // report-ready row and a refund-denied row looked identical.
        //
        // Deleting the one field that could have fixed it left the client with
        // nothing to map on. It is small, stable, and now the documented key.
      });
    } catch (_) {
      // Never fail the list because a title could not be localised.
    }

    return res.ok(notifications);
  });

  // ─── GET /notifications/unread-count ─────────────────────

  router.get('/unread-count', async (req, res) => {
    const row = await safeGet(
      // Same channel filter as the list, or the badge counts emails the
      // patient can never mark read from inside the app.
      "SELECT COUNT(*)::int as count FROM notifications WHERE to_user_id = $1 AND channel = 'internal' AND is_read = false",
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
