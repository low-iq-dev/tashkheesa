const { db } = require('./db');

function runNotificationWorker(limit = 50) {
  const nowIso = new Date().toISOString();
  let notifications = [];

  try {
    notifications = db
      .prepare(
        `SELECT * FROM notifications
         WHERE status IN ('queued','retry')
         ORDER BY at ASC
         LIMIT ?`
      )
      .all(limit);
  } catch (err) {
    console.error('[notify-worker] failed to load notifications', err);
    return;
  }

  notifications.forEach((n) => {
    try {
      const user = db
        .prepare('SELECT id, email, name, phone, lang FROM users WHERE id = ?')
        .get(n.to_user_id);
      const order = n.order_id
        ? db
            .prepare('SELECT id, status, sla_hours, deadline_at FROM orders WHERE id = ?')
            .get(n.order_id)
        : null;

      if (!user) {
        db.prepare('UPDATE notifications SET status = ?, response = ? WHERE id = ?').run(
          'failed',
          'error: user not found',
          n.id
        );
        return;
      }

      // Stubbed sending logic
      const channel = n.channel || 'internal';
      const template = n.template || 'unknown';
      const orderId = order ? order.id : 'n/a';
      let message = '';

      if (channel === 'email') {
        message = `[EMAIL] To: ${user.email || 'missing-email'} | Template: ${template} | Order: ${orderId}`;
      } else if (channel === 'whatsapp') {
        message = `[WHATSAPP] To: ${user.phone || 'missing-phone'} | Template: ${template} | Order: ${orderId}`;
      } else {
        message = `[INTERNAL] template=${template}, user=${user.email || user.id}, order=${orderId}`;
      }

      console.log(message);

      db.prepare('UPDATE notifications SET status = ?, response = ? WHERE id = ?').run(
        'sent',
        `stubbed send ok - ${nowIso}`,
        n.id
      );
    } catch (err) {
      console.error('[notify-worker] failed to process notification', n.id, err);
      db.prepare('UPDATE notifications SET status = ?, response = ? WHERE id = ?').run(
        'failed',
        `error: ${String(err).slice(0, 200)}`,
        n.id
      );
    }
  });
}

module.exports = { runNotificationWorker };
