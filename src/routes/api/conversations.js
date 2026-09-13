/**
 * Conversations API Routes — /api/v1/conversations/*
 *
 * Case-scoped messaging between patient and doctor.
 */

const router = require('express').Router();
const { randomUUID } = require('crypto');
// Lazy-load express-validator — top-level require takes ~120s and starves DB pool on boot.
let _ev;
function body(...a) { if (!_ev) _ev = require('express-validator'); return _ev.body(...a); }
// NOTIFICATIONS 2026-09-13 (Part B, item 1) — the doctor-side notification for
// a message sent from the patient APP goes through the same helper the web
// send uses (routes/messaging.js), so the doctor gets the bell row AND the
// email. It used to be a raw INSERT with no channel, no template and no dedupe
// key: the row had channel NULL, so it matched no reader that filters on
// channel, and nothing ever emailed the doctor. The push helper that was
// imported here (middleware/push.notifyNewMessage) was never invoked; the
// patient-side push now hooks queueNotification itself (services/patient_push),
// so this file has no reason to import it.
const { queueMultiChannelNotification } = require('../../notify');

module.exports = function (db, { safeGet, safeAll, safeRun }) {

  // ─── GET /conversations ──────────────────────────────────
  // List patient's conversations

  router.get('/', async (req, res) => {
    const conversations = await safeAll(`
      SELECT
        c.id, c.order_id as "orderId", c.status,
        d.name as "doctorName",
        s.name as "serviceName",
        o.reference_id as "caseRef",
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as "lastMessage",
        (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as "lastMessageAt",
        (SELECT COUNT(*)::int FROM messages WHERE conversation_id = c.id AND sender_id != $1 AND is_read = false) as "unreadCount"
      FROM conversations c
      LEFT JOIN users d ON c.doctor_id = d.id
      LEFT JOIN orders_active o ON c.order_id = o.id
      LEFT JOIN services s ON o.service_id = s.id
      WHERE c.patient_id = $2
      ORDER BY "lastMessageAt" DESC NULLS LAST
    `, [req.user.id, req.user.id]);

    return res.ok(conversations);
  });

  // ─── GET /conversations/:id ──────────────────────────────
  // Conversation detail with messages

  router.get('/:id', async (req, res) => {
    const convo = await safeGet(`
      SELECT
        c.id, c.order_id as "orderId", c.status,
        d.name as "doctorName",
        s.name as "serviceName",
        o.reference_id as "caseRef"
      FROM conversations c
      LEFT JOIN users d ON c.doctor_id = d.id
      LEFT JOIN orders_active o ON c.order_id = o.id
      LEFT JOIN services s ON o.service_id = s.id
      WHERE c.id = $1 AND c.patient_id = $2
    `, [req.params.id, req.user.id]);

    if (!convo) return res.fail('Conversation not found', 404);

    const messages = await safeAll(`
      SELECT id, sender_id as "senderId", content as body, created_at as "createdAt"
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
    `, [convo.id]);

    // Mark messages as read
    await safeRun(`
      UPDATE messages SET is_read = true
      WHERE conversation_id = $1 AND sender_id != $2 AND is_read = false
    `, [convo.id, req.user.id]);

    convo.messages = messages;
    return res.ok(convo);
  });

  // ─── GET /conversations/:id/messages ─────────────────────
  // Poll for new messages (used for real-time updates)

  router.get('/:id/messages', async (req, res) => {
    const convo = await safeGet(
      'SELECT id FROM conversations WHERE id = $1 AND patient_id = $2',
      [req.params.id, req.user.id]
    );
    if (!convo) return res.fail('Conversation not found', 404);

    let paramIndex = 1;
    let sql = `SELECT id, sender_id as "senderId", content as body, created_at as "createdAt" FROM messages WHERE conversation_id = $${paramIndex++}`;
    const params = [convo.id];

    if (req.query.after) {
      sql += ` AND created_at > $${paramIndex++}`;
      params.push(req.query.after);
    }

    sql += ' ORDER BY created_at ASC';
    const messages = await safeAll(sql, params);

    return res.ok(messages);
  });

  // ─── POST /conversations/:id/messages ────────────────────
  // Send a message

  router.post('/:id/messages', [
    body('body').trim().isLength({ min: 1, max: 2000 }),
  ], async (req, res) => {
    const convo = await safeGet(`
      SELECT c.*, d.name as "doctorName"
      FROM conversations c
      LEFT JOIN users d ON c.doctor_id = d.id
      WHERE c.id = $1 AND c.patient_id = $2
    `, [req.params.id, req.user.id]);

    if (!convo) return res.fail('Conversation not found', 404);

    if (convo.status !== 'active') {
      return res.fail('This conversation is closed.', 400, 'CONVO_CLOSED');
    }

    const msgId = randomUUID();
    await safeRun(`
      INSERT INTO messages (id, conversation_id, sender_id, content, is_read, created_at)
      VALUES ($1, $2, $3, $4, false, NOW())
    `, [msgId, convo.id, req.user.id, req.body.body]);

    const message = await safeGet(
      'SELECT id, sender_id as "senderId", content as body, created_at as "createdAt" FROM messages WHERE id = $1',
      [msgId]
    );

    // Notify the doctor — same template, channels and 10-minute dedupe window
    // as the web send in routes/messaging.js, so a burst of short messages is
    // one bell row + one email, not one per message. queueMultiChannelNotification
    // never throws (each channel resolves to {ok:false} on failure); the
    // message itself is already committed above, so a notify failure must not
    // fail the request — it is logged to error_logs by the queue.
    if (convo.doctor_id) {
      try {
        const dedupeWindow = Math.floor(Date.now() / (10 * 60 * 1000));
        await queueMultiChannelNotification({
          orderId: convo.order_id,
          toUserId: convo.doctor_id,
          channels: ['internal', 'email'],
          template: 'new_message',
          response: {
            case_id: convo.order_id,
            caseReference: convo.order_id ? String(convo.order_id).slice(0, 12).toUpperCase() : '',
            conversation_id: convo.id,
            senderName: req.user.name || 'Patient',
            messagePreview: String(req.body.body || '').slice(0, 100)
          },
          dedupe_key: 'message:' + convo.id + ':' + dedupeWindow
        });
      } catch (_) {
        // Non-critical — see above.
      }
    }

    return res.ok(message);
  });

  return router;
};
