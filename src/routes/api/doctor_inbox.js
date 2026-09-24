'use strict';

/**
 * Tashkheesa — the doctor app's inbox surface: /api/v1/doctor/*
 *
 *   conversations  — the patient <-> doctor thread (routes/messaging.js)
 *   alerts         — the bell feed (routes/doctor.js _alerts)
 *   annotations    — markup on case images (routes/annotations.js)
 *
 * Same contract as the sibling doctor_cases.js: this file is a second client
 * onto the portal's rows, not a second set of rules. Ownership of a
 * conversation is messaging.getConversationForUser (the web thread page's own
 * gate); the alert helpers are the ones the web /portal/doctor/alerts page
 * calls; annotation writes are gated by doctorHasAcceptedCase exactly as
 * /api/annotations/save is. Where the web handler has a side effect (the
 * new_message notification, the dedupe window) this file performs the same
 * one with the same key, so a message sent from the phone cannot notify
 * twice or differently from one sent on the web.
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { requireJWT, requireRole } = require('../../middleware/requireJWT');
const { sanitizeHtml, sanitizeString } = require('../../validators/sanitize');
const { doctorHasAcceptedCase } = require('../../services/doctor_case_access');

// Portal modules, resolved at CALL time. routes/doctor.js requires this file's
// siblings at module load, so a top-level require of it here would close a
// cycle through src/server.js; messaging and notify are read late so a stub
// assigned onto the real module object is what the handler sees. Exported as
// `_deps` so a hermetic test can point one accessor at a stub without
// touching the require cache.
const deps = {
  messaging: () => require('../messaging'),
  alerts: () => require('../doctor')._alerts,
  notify: () => require('../../notify'),
};

// template -> AlertItem.kind. Built from the names registered in
// notify/notification_titles.js and queued across src/. Explicit entries win;
// the regex fallback catches new templates that follow the same naming. No
// template says "payout" today (the portal has no payout notification); the
// bucket exists so the app's switch is complete when one lands.
const TEMPLATE_KIND = Object.freeze({
  // Offers / acceptance window: a case the doctor can take or was handed.
  new_case_available: 'window',
  tashkheesa_new_case_urgent: 'window',
  tashkheesa_new_case_fasttrack: 'window',
  tashkheesa_new_case_standard: 'window',
  order_assigned_doctor: 'window',
  order_auto_assigned_doctor: 'window',
  public_order_assigned_doctor: 'window',
  new_case_assigned_doctor: 'window',
  tashkheesa_case_auto_assigned: 'window',
  order_reassigned_to_doctor: 'window',
  order_reassigned_doctor: 'window',
  // Thread activity.
  new_message: 'message',
  patient_reply_info: 'message',
  // Files landing on a case.
  patient_uploaded_files_doctor: 'files',
  additional_files_requested_patient: 'files',
  additional_files_request_approved_patient: 'files',
  // SLA clock.
  sla_reminder_doctor: 'sla',
  sla_breached_doctor: 'sla',
  order_sla_pre_breach_doctor: 'sla',
  order_sla_pre_breach: 'sla',
  order_sla_prebreach: 'sla',
  order_breached_doctor: 'sla',
  sla_breach: 'sla',
  sla_reminder_24h: 'sla',
  sla_reminder_6h: 'sla',
  sla_reminder_1h: 'sla',
  sla_warning_75: 'sla',
  sla_warning_urgent: 'sla',
  // Leaving the doctor's queue is not an offer, whatever the regex thinks.
  order_reassigned_from_doctor: 'system',
  chat_conduct_warning: 'system',
});

function alertKind(template) {
  const t = String(template || '').toLowerCase();
  if (TEMPLATE_KIND[t]) return TEMPLATE_KIND[t];
  if (/payout|statement/.test(t)) return 'payout';
  if (/sla|breach|deadline/.test(t)) return 'sla';
  if (/message|reply/.test(t)) return 'message';
  if (/files|upload/.test(t)) return 'files';
  if (/new_case|assigned|acceptance/.test(t)) return 'window';
  return 'system';
}

// The body under the title. normalizeDoctorNotification puts the stored
// `response` in `message`; for queued rows that is the JSON payload, which
// notify.renderNotificationMessage turns into the same localised sentence the
// in_app_message column holds. A non-JSON message is legacy free text.
function alertBody(n, lang) {
  const raw = String((n && n.message) || '').trim();
  if (!raw || raw === String(n.template || '')) return null;
  if (raw[0] === '{' || raw[0] === '[') {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    if (parsed && typeof parsed === 'object') {
      try {
        const rendered = deps.notify().renderNotificationMessage(n.template, parsed, lang);
        return rendered ? String(rendered) : null;
      } catch (_) { return null; }
    }
    return null;
  }
  return raw;
}

function isoOrNull(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return isNaN(t) ? String(v) : new Date(t).toISOString();
}

module.exports = function (db, helpers) {
  const { safeGet, safeAll, safeRun } = helpers || {};
  const router = express.Router();

  router.use(requireJWT);
  router.use(requireRole('doctor'));

  const meId = (req) => (req.user && req.user.id ? String(req.user.id) : '');
  const langOf = (req) => (String((req.query && req.query.lang) || '').toLowerCase() === 'ar' ? 'ar' : 'en');
  const paramId = (v) => String(v || '').trim();

  // The alert helpers match to_user_id on the email as well as the id (older
  // rows were addressed by email), so the email comes from the live users
  // row, not from a JWT that may predate an address change.
  async function liveDoctor(doctorId) {
    return await safeGet('SELECT id, email, name FROM users WHERE id = $1 LIMIT 1', [doctorId], null);
  }

  function threadMessage(m, me) {
    const mine = String(m.sender_id) === String(me);
    return {
      id: String(m.id),
      mine,
      content: m.content == null ? '' : String(m.content),
      translation: null,
      at: isoOrNull(m.created_at),
      // My own message: the patient's receipt. A patient message: I am the
      // reader, so it is read by the act of being shown.
      read: mine ? !!m.is_read : true,
    };
  }

  // ─── GET /conversations ───────────────────────────────────
  // Same rows, same A6 rule as the web sidebar (messaging.js list SQL): only
  // the case's CURRENT doctor lists the conversation.
  router.get('/conversations', async (req, res) => {
    const me = meId(req);
    if (!me) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const rows = await safeAll(
      `SELECT c.id AS conversation_id, c.order_id, c.status, c.created_at,
              o.reference_id,
              (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
              (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_at,
              (SELECT sender_id FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_sender_id,
              (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_read = false AND sender_id != $1) AS unread_count
         FROM conversations c
         LEFT JOIN orders_active o ON o.id = c.order_id
        WHERE c.doctor_id = $2 AND o.doctor_id = c.doctor_id
        ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC`,
      [me, me], []
    );

    const conversations = (rows || []).map((r) => ({
      conversation_id: String(r.conversation_id),
      order_id: r.order_id == null ? null : String(r.order_id),
      reference_id: r.reference_id == null ? null : String(r.reference_id),
      closed: String(r.status || '').toLowerCase() === 'closed',
      unread: Number(r.unread_count) || 0,
      last_message_at: isoOrNull(r.last_message_at),
      last_message_text: r.last_message == null ? null : String(r.last_message),
      last_message_mine: r.last_sender_id != null && String(r.last_sender_id) === me,
    }));

    return res.ok({ conversations });
  });

  // ─── GET /conversations/:id ───────────────────────────────
  // Read-only: the web thread page marks read on open; the app calls
  // POST /conversations/:id/read for that, so a background refresh never
  // consumes the unread state.
  router.get('/conversations/:id', async (req, res) => {
    const me = meId(req);
    const conversationId = paramId(req.params.id);
    if (!me || !conversationId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const conversation = await deps.messaging().getConversationForUser(conversationId, me);
    if (!conversation) return res.fail('Conversation not available', 404, 'CONVERSATION_NOT_AVAILABLE');

    const order = conversation.order_id
      ? await safeGet('SELECT reference_id FROM orders_active WHERE id = $1 LIMIT 1', [conversation.order_id], null)
      : null;

    const messages = await safeAll(
      `SELECT m.id, m.sender_id, m.content, m.is_read, m.created_at
         FROM messages m
        WHERE m.conversation_id = $1
        ORDER BY m.created_at ASC`,
      [conversationId], []
    );

    return res.ok({
      conversation: {
        conversation_id: String(conversation.id),
        order_id: conversation.order_id == null ? null : String(conversation.order_id),
        reference_id: order && order.reference_id != null ? String(order.reference_id) : null,
        closed: String(conversation.status || '').toLowerCase() === 'closed',
      },
      messages: (messages || []).map((m) => threadMessage(m, me)),
    });
  });

  // ─── POST /conversations/:id/messages ─────────────────────
  // Mirrors POST /portal/messages/:id/send step for step: ownership, closed,
  // muted, sanitise, insert, bump conversation, notify with the SAME
  // 10-minute dedupe key so a phone send and a web send share one window.
  router.post('/conversations/:id/messages', async (req, res) => {
    const me = meId(req);
    const conversationId = paramId(req.params.id);
    if (!me || !conversationId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const conversation = await deps.messaging().getConversationForUser(conversationId, me);
    if (!conversation) return res.fail('Conversation not available', 404, 'CONVERSATION_NOT_AVAILABLE');

    if (conversation.status === 'closed') {
      return res.fail('This conversation has been closed', 409, 'CONVERSATION_CLOSED');
    }

    const sender = await safeGet('SELECT muted_until, name FROM users WHERE id = $1', [me], null);
    if (sender && sender.muted_until && new Date(sender.muted_until) > new Date()) {
      return res.fail('Messaging temporarily suspended', 403, 'MUTED');
    }

    const body = req.body || {};
    const content = sanitizeHtml(sanitizeString(body.content || '', 5000)).trim();
    if (!content) return res.fail('Message is required', 400, 'EMPTY_MESSAGE');

    const messageId = randomUUID();
    const now = new Date().toISOString();

    try {
      await safeRun(
        'INSERT INTO messages (id, conversation_id, sender_id, sender_role, content, message_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [messageId, conversationId, me, 'doctor', content, 'text', now]
      );
      await safeRun('UPDATE conversations SET updated_at = $1 WHERE id = $2', [now, conversationId]);
    } catch (e) {
      return res.fail('Message could not be saved', 500, 'MESSAGE_SAVE_FAILED');
    }

    // The recipient is the patient (the doctor is the sender), and the
    // dedupe window is the web handler's: at most one notification per
    // conversation per 10 minutes across both clients.
    try {
      const dedupeWindow = Math.floor(Date.now() / (10 * 60 * 1000));
      deps.notify().queueMultiChannelNotification({
        orderId: conversation.order_id,
        toUserId: conversation.patient_id,
        channels: ['internal', 'email'],
        template: 'new_message',
        response: {
          case_id: conversation.order_id,
          caseReference: conversation.order_id ? String(conversation.order_id).slice(0, 12).toUpperCase() : '',
          senderName: (sender && sender.name) || (req.user && req.user.name) || 'Someone',
          messagePreview: content.slice(0, 100),
        },
        dedupe_key: 'message:' + conversationId + ':' + dedupeWindow,
      });
    } catch (_) { /* the message is saved; the alert is best effort, as on the web */ }

    return res.ok({
      message: {
        id: messageId,
        mine: true,
        content,
        translation: null,
        at: now,
        read: false,
      },
    });
  });

  // ─── POST /conversations/:id/read ─────────────────────────
  // Same UPDATE as the web page and its /read endpoint. Idempotent: a retry
  // finds nothing left to flip and reports 0.
  router.post('/conversations/:id/read', async (req, res) => {
    const me = meId(req);
    const conversationId = paramId(req.params.id);
    if (!me || !conversationId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const conversation = await deps.messaging().getConversationForUser(conversationId, me);
    if (!conversation) return res.fail('Conversation not available', 404, 'CONVERSATION_NOT_AVAILABLE');

    try {
      const r = await safeRun(
        'UPDATE messages SET is_read = true WHERE conversation_id = $1 AND sender_id != $2 AND is_read = false',
        [conversationId, me]
      );
      return res.ok({ updated: (r && r.rowCount) ? Number(r.rowCount) : 0 });
    } catch (e) {
      return res.fail('Could not mark read', 500, 'READ_UPDATE_FAILED');
    }
  });

  // ─── GET /alerts ──────────────────────────────────────────
  // Read-only, like the bell dropdown feed (/api/doctor/alerts/recent): it
  // does not mark anything read. Titles come from the shared registry via
  // normalizeDoctorNotification; order references are resolved in one query
  // for the whole page.
  router.get('/alerts', async (req, res) => {
    const me = meId(req);
    const lang = langOf(req);
    if (!me) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const doctor = await liveDoctor(me);
    if (!doctor) return res.fail('Doctor not found', 404, 'NOT_FOUND');
    const email = String(doctor.email || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const A = deps.alerts();
    const raw = await A.fetchDoctorNotifications(me, email, limit);
    const normalized = (raw || []).map(A.normalizeDoctorNotification);

    const orderIds = Array.from(new Set(normalized.map((n) => n.order_id).filter(Boolean)));
    const refByOrder = {};
    if (orderIds.length) {
      const refs = await safeAll(
        'SELECT id, reference_id FROM orders_active WHERE id = ANY($1::text[])',
        [orderIds], []
      );
      for (const r of refs || []) {
        if (r && r.id != null && r.reference_id != null) refByOrder[String(r.id)] = String(r.reference_id);
      }
    }

    const alerts = normalized.map((n) => ({
      id: n.id,
      kind: alertKind(n.template),
      title: lang === 'ar'
        ? (n.title_ar || n.title_en || 'إشعار')
        : (n.title_en || n.title_ar || 'Notification'),
      body: alertBody(n, lang),
      at: isoOrNull(n.at),
      order_ref: n.order_id ? (refByOrder[n.order_id] || null) : null,
      order_id: n.order_id || null,
      is_read: String(n.status || '').toLowerCase() === 'seen',
    }));

    const unseen = await A.countDoctorUnseenNotifications(me, email);
    return res.ok({ alerts, unseen: Number(unseen) || 0 });
  });

  // ─── POST /alerts/read ────────────────────────────────────
  router.post('/alerts/read', async (req, res) => {
    const me = meId(req);
    if (!me) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const doctor = await liveDoctor(me);
    if (!doctor) return res.fail('Doctor not found', 404, 'NOT_FOUND');

    const r = await deps.alerts().markAllDoctorNotificationsRead(me, String(doctor.email || '').trim());
    if (!r || !r.ok) return res.fail('Could not mark alerts read', 500, 'ALERTS_MARK_FAILED');
    return res.ok({ ok: true });
  });

  // ─── POST /alerts/:id/read ────────────────────────────────
  // The helper's UPDATE is scoped to the owner, so an id that is not mine
  // updates nothing — the same 404 as one that does not exist.
  router.post('/alerts/:id/read', async (req, res) => {
    const me = meId(req);
    const id = paramId(req.params.id);
    if (!me || !id) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const doctor = await liveDoctor(me);
    if (!doctor) return res.fail('Doctor not found', 404, 'NOT_FOUND');

    const r = await deps.alerts().markDoctorNotificationRead(me, String(doctor.email || '').trim(), id);
    if (r && r.ok) return res.ok({ ok: true });
    if (r && r.reason) return res.fail('Could not mark alert read', 500, 'ALERTS_MARK_FAILED');
    // ok:false with no reason — the UPDATE matched no row: not mine, or gone.
    return res.fail('Alert not available', 404, 'ALERT_NOT_AVAILABLE');
  });

  // ─── Annotations ──────────────────────────────────────────
  // Same gate as /api/annotations/save: assignment is not acceptance, so the
  // order row is read and handed to doctorHasAcceptedCase. "Not accepted by
  // me" and "does not exist" are the same 404.
  async function acceptedOrder(doctorId, caseId) {
    const row = await safeGet(
      'SELECT id, doctor_id, status FROM orders_active WHERE id = $1 AND doctor_id = $2 LIMIT 1',
      [caseId, doctorId], null
    );
    return doctorHasAcceptedCase(row, doctorId) ? row : null;
  }

  // GET /annotations/:imageId — this doctor's own markup on the image. A row
  // by another doctor (a reassigned case) is not returned: the app only ever
  // edits its own layer; the case page's GET picks the newest row across
  // doctors for display, which is a different question.
  router.get('/annotations/:imageId', async (req, res) => {
    const me = meId(req);
    const imageId = paramId(req.params.imageId);
    if (!me || !imageId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const row = await safeGet(
      `SELECT ca.case_id, ca.annotation_data, ca.annotations_count
         FROM case_annotations ca
        WHERE ca.image_id = $1 AND ca.doctor_id = $2
        ORDER BY ca.updated_at DESC NULLS LAST
        LIMIT 1`,
      [imageId, me], null
    );
    if (!row) return res.ok({ payload: null, count: 0 });

    // The row is mine, but the case may have moved on since I drew: the
    // acceptance gate the write applies covers reading it back too.
    if (!(await acceptedOrder(me, row.case_id))) return res.ok({ payload: null, count: 0 });

    return res.ok({
      payload: row.annotation_data == null ? null : String(row.annotation_data),
      count: Number(row.annotations_count) || 0,
    });
  });

  // PUT /annotations/:imageId — upsert keyed on (image_id, doctor_id), the
  // same two statements /api/annotations/save issues. `payload` is stored as
  // given when it is a string (the app serialises its own canvas state); an
  // object is serialised here so the column holds JSON text either way.
  // `annotated_image` (optional data URL) maps to annotated_image_data and,
  // as on the web, an omitted image clears the stale flattened copy rather
  // than leaving one that no longer matches the markup.
  router.put('/annotations/:imageId', async (req, res) => {
    const me = meId(req);
    const imageId = paramId(req.params.imageId);
    const body = req.body || {};
    const caseId = paramId(body.case_id);
    if (!me || !imageId || !caseId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    if (!(await acceptedOrder(me, caseId))) return res.fail('Case not available', 404, 'CASE_NOT_AVAILABLE');

    let payload;
    if (body.payload == null) payload = JSON.stringify({});
    else if (typeof body.payload === 'string') payload = body.payload;
    else payload = JSON.stringify(body.payload);
    const count = Math.max(0, Math.trunc(Number(body.count) || 0));
    const annotatedImage = typeof body.annotated_image === 'string' && body.annotated_image ? body.annotated_image : null;

    try {
      const existing = await safeGet(
        'SELECT id FROM case_annotations WHERE image_id = $1 AND doctor_id = $2 LIMIT 1',
        [imageId, me], null
      );
      if (existing) {
        await safeRun(
          `UPDATE case_annotations
              SET annotation_data = $1,
                  annotated_image_data = $2,
                  annotations_count = $3,
                  updated_at = NOW()
            WHERE id = $4`,
          [payload, annotatedImage, count, existing.id]
        );
      } else {
        await safeRun(
          `INSERT INTO case_annotations (
             id, case_id, image_id, doctor_id,
             annotation_data, annotated_image_data, annotations_count,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
          [randomUUID(), caseId, imageId, me, payload, annotatedImage, count]
        );
      }
    } catch (e) {
      return res.fail('Annotation could not be saved', 500, 'ANNOTATION_SAVE_FAILED');
    }

    return res.ok({ ok: true });
  });

  return router;
};

module.exports._deps = deps;
module.exports._alertKind = alertKind;
