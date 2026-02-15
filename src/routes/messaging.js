// src/routes/messaging.js
// Patient ↔ Doctor Messaging System (Phase 6)

const express = require('express');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { requireRole } = require('../middleware');
const { sanitizeHtml, sanitizeString } = require('../validators/sanitize');
const { logErrorToDb } = require('../logger');
const { safeAll, safeGet } = require('../sql-utils');
const { queueMultiChannelNotification } = require('../notify');

const router = express.Router();

// Helper: ensure user belongs to conversation
function getConversationForUser(conversationId, userId) {
  return safeGet(
    'SELECT * FROM conversations WHERE id = ? AND (patient_id = ? OR doctor_id = ?)',
    [conversationId, userId, userId],
    null
  );
}

// Helper: auto-create conversation when doctor accepts a case
function ensureConversation(orderId, patientId, doctorId) {
  if (!orderId || !patientId || !doctorId) return null;

  // Check if already exists for this order
  var existing = safeGet(
    'SELECT id FROM conversations WHERE order_id = ? AND patient_id = ? AND doctor_id = ?',
    [orderId, patientId, doctorId],
    null
  );
  if (existing) return existing.id;

  var id = randomUUID();
  var now = new Date().toISOString();
  try {
    db.prepare(
      'INSERT INTO conversations (id, order_id, patient_id, doctor_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, orderId, patientId, doctorId, 'active', now, now);
    return id;
  } catch (e) {
    // Might fail due to race condition, try fetching again
    var retry = safeGet(
      'SELECT id FROM conversations WHERE order_id = ? AND patient_id = ? AND doctor_id = ?',
      [orderId, patientId, doctorId],
      null
    );
    return retry ? retry.id : null;
  }
}

// GET /portal/messages — Conversation list
router.get('/portal/messages', requireRole('patient', 'doctor'), function(req, res) {
  try {
    var userId = req.user.id;
    var role = req.user.role;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var conversations = safeAll(
      `SELECT c.*,
              p.name as patient_name,
              d.name as doctor_name,
              o.service_id,
              o.specialty_id,
              sv.name as service_name,
              sp.name as specialty_name,
              (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
              (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
              (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_read = 0 AND sender_id != ?) as unread_count
       FROM conversations c
       LEFT JOIN users p ON p.id = c.patient_id
       LEFT JOIN users d ON d.id = c.doctor_id
       LEFT JOIN orders o ON o.id = c.order_id
       LEFT JOIN services sv ON sv.id = o.service_id
       LEFT JOIN specialties sp ON sp.id = o.specialty_id
       WHERE (c.patient_id = ? OR c.doctor_id = ?)
       ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC`,
      [userId, userId, userId], []
    );

    res.render('messages', {
      portalFrame: true,
      portalRole: role === 'doctor' ? 'doctor' : role,
      portalActive: 'messages',
      brand: 'Tashkheesa',
      title: isAr ? 'الرسائل' : 'Messages',
      conversations: conversations,
      activeConversationId: null,
      activeMessages: [],
      activeConversation: null,
      user: req.user,
      lang: lang,
      isAr: isAr,
      role: role,
      pageTitle: isAr ? 'الرسائل' : 'Messages'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// GET /portal/messages/:conversationId — View conversation
router.get('/portal/messages/:conversationId', requireRole('patient', 'doctor'), function(req, res) {
  try {
    var userId = req.user.id;
    var role = req.user.role;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';
    var conversationId = String(req.params.conversationId).trim();

    var conversation = getConversationForUser(conversationId, userId);
    if (!conversation) {
      return res.redirect('/portal/messages');
    }

    // Mark messages as read
    db.prepare(
      'UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ? AND is_read = 0'
    ).run(conversationId, userId);

    // Load messages
    var messages = safeAll(
      `SELECT m.*, u.name as sender_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ?
       ORDER BY m.created_at ASC`,
      [conversationId], []
    );

    // Load all conversations for sidebar
    var conversations = safeAll(
      `SELECT c.*,
              p.name as patient_name,
              d.name as doctor_name,
              o.service_id,
              o.specialty_id,
              sv.name as service_name,
              sp.name as specialty_name,
              (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
              (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
              (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_read = 0 AND sender_id != ?) as unread_count
       FROM conversations c
       LEFT JOIN users p ON p.id = c.patient_id
       LEFT JOIN users d ON d.id = c.doctor_id
       LEFT JOIN orders o ON o.id = c.order_id
       LEFT JOIN services sv ON sv.id = o.service_id
       LEFT JOIN specialties sp ON sp.id = o.specialty_id
       WHERE (c.patient_id = ? OR c.doctor_id = ?)
       ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC`,
      [userId, userId, userId], []
    );

    // Get names for header
    var otherUser = safeGet(
      'SELECT name FROM users WHERE id = ?',
      [role === 'patient' ? conversation.doctor_id : conversation.patient_id],
      { name: '' }
    );

    res.render('messages', {
      portalFrame: true,
      portalRole: role === 'doctor' ? 'doctor' : role,
      portalActive: 'messages',
      brand: 'Tashkheesa',
      title: isAr ? 'الرسائل' : 'Messages',
      conversations: conversations,
      activeConversationId: conversationId,
      activeMessages: messages,
      activeConversation: conversation,
      otherUserName: otherUser ? otherUser.name : '',
      user: req.user,
      lang: lang,
      isAr: isAr,
      role: role,
      pageTitle: isAr ? 'الرسائل' : 'Messages'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// POST /portal/messages/:conversationId/send — Send text message
router.post('/portal/messages/:conversationId/send', requireRole('patient', 'doctor'), function(req, res) {
  try {
    var userId = req.user.id;
    var role = req.user.role;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';
    var conversationId = String(req.params.conversationId).trim();

    var conversation = getConversationForUser(conversationId, userId);
    if (!conversation) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    // Block sending on closed conversations
    if (conversation.status === 'closed') {
      return res.status(403).json({ ok: false, error: isAr ? 'تم إغلاق هذه المحادثة' : 'This conversation has been closed' });
    }

    // Block sending if user is muted
    var senderRow = safeGet('SELECT muted_until FROM users WHERE id = ?', [userId], null);
    if (senderRow && senderRow.muted_until && new Date(senderRow.muted_until) > new Date()) {
      return res.status(403).json({ ok: false, error: isAr ? 'تم تعليق الرسائل مؤقتاً. يرجى التواصل مع الدعم.' : 'Your messaging has been temporarily suspended. Please contact support.' });
    }

    var content = sanitizeHtml(sanitizeString(req.body.content || '', 5000)).trim();
    if (!content) {
      return res.status(400).json({ ok: false, error: isAr ? 'الرسالة مطلوبة' : 'Message is required' });
    }

    var messageId = randomUUID();
    var now = new Date().toISOString();

    db.prepare(
      'INSERT INTO messages (id, conversation_id, sender_id, sender_role, content, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(messageId, conversationId, userId, role, content, 'text', now);

    // Update conversation timestamp
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);

    // Notify recipient of new message (at most once per conversation per 10 minutes)
    try {
      var recipientId = (userId === conversation.patient_id) ? conversation.doctor_id : conversation.patient_id;
      var dedupeWindow = Math.floor(Date.now() / (10 * 60 * 1000));
      queueMultiChannelNotification({
        orderId: conversation.order_id,
        toUserId: recipientId,
        channels: ['internal', 'email'],
        template: 'new_message',
        response: {
          case_id: conversation.order_id,
          caseReference: conversation.order_id ? conversation.order_id.slice(0, 12).toUpperCase() : '',
          senderName: req.user.name || 'Someone',
          messagePreview: (content || '').slice(0, 100)
        },
        dedupe_key: 'message:' + conversationId + ':' + dedupeWindow
      });
    } catch (_) {}

    return res.json({
      ok: true,
      message: {
        id: messageId,
        content: content,
        sender_id: userId,
        sender_role: role,
        sender_name: req.user.name || '',
        created_at: now,
        message_type: 'text'
      }
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /portal/messages/:conversationId/read — Mark messages as read
router.post('/portal/messages/:conversationId/read', requireRole('patient', 'doctor'), function(req, res) {
  try {
    var userId = req.user.id;
    var conversationId = String(req.params.conversationId).trim();

    var conversation = getConversationForUser(conversationId, userId);
    if (!conversation) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    db.prepare(
      'UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ? AND is_read = 0'
    ).run(conversationId, userId);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/messages/:conversationId/unread-count — Unread count for conversation
router.get('/api/messages/:conversationId/unread-count', requireRole('patient', 'doctor'), function(req, res) {
  try {
    var userId = req.user.id;
    var conversationId = String(req.params.conversationId).trim();

    var conversation = getConversationForUser(conversationId, userId);
    if (!conversation) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    var row = safeGet(
      'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND sender_id != ? AND is_read = 0',
      [conversationId, userId],
      { count: 0 }
    );

    return res.json({ ok: true, count: row ? row.count : 0 });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/messages/total-unread — Total unread across all conversations
router.get('/api/messages/total-unread', requireRole('patient', 'doctor'), function(req, res) {
  try {
    var userId = req.user.id;

    var row = safeGet(
      `SELECT COUNT(*) as count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.status = 'active'
         AND (c.patient_id = ? OR c.doctor_id = ?)
         AND m.sender_id != ?
         AND m.is_read = 0`,
      [userId, userId, userId],
      { count: 0 }
    );

    return res.json({ ok: true, count: row ? row.count : 0 });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/messages/:conversationId/poll — Poll for new messages (for real-time feel)
router.get('/api/messages/:conversationId/poll', requireRole('patient', 'doctor'), function(req, res) {
  try {
    var userId = req.user.id;
    var conversationId = String(req.params.conversationId).trim();
    var after = String(req.query.after || '').trim();

    var conversation = getConversationForUser(conversationId, userId);
    if (!conversation) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    var messages;
    if (after) {
      messages = safeAll(
        `SELECT m.*, u.name as sender_name
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = ? AND m.created_at > ?
         ORDER BY m.created_at ASC`,
        [conversationId, after], []
      );
    } else {
      messages = [];
    }

    // Mark received messages as read
    if (messages.length > 0) {
      db.prepare(
        'UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ? AND is_read = 0'
      ).run(conversationId, userId);
    }

    return res.json({ ok: true, messages: messages });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Auto-close conversations 30 days after case completion
function closeStaleConversations() {
  try {
    var result = db.prepare(`
      UPDATE conversations SET status = 'closed', closed_at = datetime('now')
      WHERE status = 'active'
      AND order_id IN (
        SELECT id FROM orders
        WHERE status = 'completed'
        AND completed_at < datetime('now', '-30 days')
      )
    `).run();
    return result.changes || 0;
  } catch (_) {
    return 0;
  }
}

// POST /portal/messages/report — Report a message
router.post('/portal/messages/report', requireRole('patient', 'doctor'), function(req, res) {
  try {
    var userId = req.user.id;
    var { message_id, conversation_id, reason, details } = req.body;

    if (!conversation_id || !reason) {
      return res.redirect('back');
    }

    // Verify reporter is a participant
    var convo = safeGet('SELECT * FROM conversations WHERE id = ? AND (patient_id = ? OR doctor_id = ?)',
      [conversation_id, userId, userId], null);
    if (!convo) return res.status(403).send('Unauthorized');

    var reportId = randomUUID();
    db.prepare(`
      INSERT INTO chat_reports (id, conversation_id, message_id, reported_by, reporter_role, reason, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(reportId, conversation_id, message_id || null, userId, req.user.role, reason, details || null);

    // Log audit event
    try {
      var { logOrderEvent } = require('../audit');
      logOrderEvent({ order_id: convo.order_id || conversation_id, label: 'Chat message reported: ' + reason, actor_id: userId });
    } catch (_) {}

    res.redirect('/portal/messages/' + conversation_id);
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    res.redirect('back');
  }
});

module.exports = router;
module.exports.ensureConversation = ensureConversation;
module.exports.closeStaleConversations = closeStaleConversations;
