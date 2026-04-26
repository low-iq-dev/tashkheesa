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
const { notifyNewMessage } = require('../../middleware/push');

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
      LEFT JOIN orders o ON c.order_id = o.id
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
      LEFT JOIN orders o ON c.order_id = o.id
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

    // Notify the doctor
    try {
      await safeRun(`
        INSERT INTO notifications (id, to_user_id, type, title, message, at)
        VALUES ($1, $2, 'message', $3, $4, NOW())
      `, [
        randomUUID(),
        convo.doctor_id,
        `New message from ${req.user.name || 'Patient'}`,
        req.body.body.slice(0, 100)
      ]);
    } catch {
      // Non-critical
    }

    return res.ok(message);
  });

  return router;
};
