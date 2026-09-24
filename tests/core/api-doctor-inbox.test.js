// tests/core/api-doctor-inbox.test.js
//
// /api/v1/doctor/{conversations,alerts,annotations} — the doctor app's inbox.
//
// The router is a second client onto the portal's own rows and helpers, so
// these tests pin the CONTRACT with those helpers rather than SQL results:
//
//   1. Conversation ownership is messaging.getConversationForUser — a null
//      from it is the same 404 whether the thread is someone else's or gone.
//   2. Sending mirrors the web handler: closed -> 409, muted -> 403, empty
//      after sanitising -> 400, and the new_message notification is queued
//      with the web's channels and the web's 10-minute dedupe key.
//   3. Alerts ride routes/doctor.js _alerts with the email from the LIVE
//      users row, template -> kind is deterministic, and titles follow ?lang.
//   4. Annotation writes are gated by doctorHasAcceptedCase (assignment is
//      not acceptance) and upsert on (image_id, doctor_id).
//
// Hermetic: helpers {safeGet, safeAll, safeRun} are fakes; messaging and
// notify are stubbed by assigning onto the REAL module objects; the doctor.js
// alert helpers are supplied through the router module's own `_deps` seam
// (routes/doctor.js cannot be required outside a booted server).
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'doctor-inbox-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const messaging = require(path.join(__dirname, '../../src/routes/messaging'));
const notify = require(path.join(__dirname, '../../src/notify'));
const buildRouter = require(path.join(__dirname, '../../src/routes/api/doctor_inbox'));

// ── stubs on the real module objects ──────────────────────────
let conversationRow = null;          // what getConversationForUser returns
let ownershipCalls = [];
const realGetConversation = messaging.getConversationForUser;
messaging.getConversationForUser = async (conversationId, userId) => {
  ownershipCalls.push([conversationId, userId]);
  return conversationRow;
};

let queued = [];
const realQueue = notify.queueMultiChannelNotification;
notify.queueMultiChannelNotification = (opts) => { queued.push(opts); return Promise.resolve({ ok: true }); };

// doctor.js _alerts, through the router's own seam.
const alertsStub = {
  calls: [],
  rows: [],
  unseen: 0,
  markAllResult: { ok: true, mode: 'is_read', changes: 2 },
  markOneResult: { ok: true, mode: 'is_read' },
  async fetchDoctorNotifications(userId, email, limit) { this.calls.push(['fetch', userId, email, limit]); return this.rows; },
  normalizeDoctorNotification(row) {
    // Same shape routes/doctor.js produces; titles pulled from the real registry.
    const { getNotificationTitles } = require(path.join(__dirname, '../../src/notify/notification_titles'));
    const t = getNotificationTitles(row.template);
    return {
      id: String(row.id), orderId: row.order_id || '', order_id: row.order_id || '',
      status: row.is_read ? 'seen' : 'queued', at: row.at, message: row.response || row.template || 'Notification',
      template: row.template, title_en: t.title_en, title_ar: t.title_ar, href: '',
    };
  },
  async countDoctorUnseenNotifications(userId, email) { this.calls.push(['count', userId, email]); return this.unseen; },
  async markAllDoctorNotificationsRead(userId, email) { this.calls.push(['markAll', userId, email]); return this.markAllResult; },
  async markDoctorNotificationRead(userId, email, id) { this.calls.push(['markOne', userId, email, id]); return this.markOneResult; },
  deriveAlertSeverity() { return 'info'; },
};
const realAlertsAccessor = buildRouter._deps.alerts;
buildRouter._deps.alerts = () => alertsStub;

test.after(() => {
  messaging.getConversationForUser = realGetConversation;
  notify.queueMultiChannelNotification = realQueue;
  buildRouter._deps.alerts = realAlertsAccessor;
});

// ── harness ───────────────────────────────────────────────────
function handlerFor(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      const st = layer.route.stack;
      return st[st.length - 1].handle;
    }
  }
  throw new Error(`${method.toUpperCase()} ${routePath} not registered`);
}

function mockRes() {
  return {
    statusCode: 200, _json: null, _code: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this._json = o; return this; },
    ok(data) { this._json = { success: true, data }; return this; },
    fail(message, status = 400, code) {
      this.statusCode = status; this._code = code;
      this._json = { success: false, error: message, code };
      return this;
    },
  };
}

// A scripted DB: safeGet/safeAll answer by matching a fragment of the SQL;
// safeRun records every write and can be told to throw.
function makeDb() {
  const db = {
    gets: [], alls: [], runs: [],
    runThrows: false,
    runResult: { rowCount: 3 },
    helpers: null,
  };
  db.helpers = {
    async safeGet(sql, params, fallback) {
      for (const [frag, val] of db.gets) if (sql.includes(frag)) return typeof val === 'function' ? val(params) : val;
      return fallback === undefined ? null : fallback;
    },
    async safeAll(sql, params, fallback) {
      for (const [frag, val] of db.alls) if (sql.includes(frag)) return typeof val === 'function' ? val(params) : val;
      return fallback === undefined ? [] : fallback;
    },
    async safeRun(sql, params) {
      db.runs.push([sql, params]);
      if (db.runThrows) throw new Error('boom');
      return db.runResult;
    },
  };
  return db;
}

async function drive(db, method, routePath, { params = {}, body = {}, query = {}, user = { id: 'doc_1', role: 'doctor', name: 'Dr. Mona' } } = {}) {
  const router = buildRouter({}, db.helpers);
  const req = { params, body, query, user, headers: {} };
  const res = mockRes();
  await handlerFor(router, method, routePath)(req, res);
  return res;
}

function reset() {
  conversationRow = null;
  ownershipCalls = [];
  queued = [];
  alertsStub.calls = [];
  alertsStub.rows = [];
  alertsStub.unseen = 0;
  alertsStub.markAllResult = { ok: true, mode: 'is_read', changes: 2 };
  alertsStub.markOneResult = { ok: true, mode: 'is_read' };
}

const ACTIVE_CONVO = { id: 'cv_1', order_id: 'ord_9', patient_id: 'pat_5', doctor_id: 'doc_1', status: 'active' };

// ══════════════════════════════════════════════════════════════
// Conversations
// ══════════════════════════════════════════════════════════════

test('GET /conversations lists only current-doctor threads with the list shape', async () => {
  reset();
  const db = makeDb();
  let listSql = null, listParams = null;
  db.helpers.safeAll = async (sql, params) => { listSql = sql; listParams = params; return [
    { conversation_id: 'cv_1', order_id: 'ord_9', status: 'active', reference_id: 'TSH-0009',
      last_message: 'hello', last_message_at: '2026-09-20T10:00:00.000Z', last_sender_id: 'pat_5', unread_count: '2' },
    { conversation_id: 'cv_2', order_id: 'ord_8', status: 'closed', reference_id: null,
      last_message: null, last_message_at: null, last_sender_id: null, unread_count: 0 },
  ]; };
  const res = await drive(db, 'get', '/conversations');
  assert.equal(res.statusCode, 200);
  assert.equal(res._json.success, true);
  // The A6 rule from messaging.js: doctor_id match AND the order's current doctor.
  assert.match(listSql, /FROM conversations c/);
  assert.match(listSql, /LEFT JOIN orders_active o ON o\.id = c\.order_id/);
  assert.match(listSql, /c\.doctor_id = \$2 AND o\.doctor_id = c\.doctor_id/);
  assert.match(listSql, /is_read = false AND sender_id != \$1/);
  assert.deepEqual(listParams, ['doc_1', 'doc_1']);

  const [a, b] = res._json.data.conversations;
  assert.deepEqual(a, {
    conversation_id: 'cv_1', order_id: 'ord_9', reference_id: 'TSH-0009', closed: false, unread: 2,
    last_message_at: '2026-09-20T10:00:00.000Z', last_message_text: 'hello', last_message_mine: false,
  });
  assert.deepEqual(b, {
    conversation_id: 'cv_2', order_id: 'ord_8', reference_id: null, closed: true, unread: 0,
    last_message_at: null, last_message_text: null, last_message_mine: false,
  });
});

test('GET /conversations/:id returns the thread and never marks read', async () => {
  reset();
  conversationRow = ACTIVE_CONVO;
  const db = makeDb();
  db.gets.push(['SELECT reference_id FROM orders_active', { reference_id: 'TSH-0009' }]);
  db.alls.push(['FROM messages m', [
    { id: 'm1', sender_id: 'pat_5', content: 'hi doctor', is_read: false, created_at: '2026-09-20T09:00:00.000Z' },
    { id: 'm2', sender_id: 'doc_1', content: 'hello', is_read: true, created_at: '2026-09-20T09:05:00.000Z' },
    { id: 'm3', sender_id: 'doc_1', content: 'anything else?', is_read: false, created_at: '2026-09-20T09:06:00.000Z' },
  ]]);
  const res = await drive(db, 'get', '/conversations/:id', { params: { id: ' cv_1 ' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(ownershipCalls, [['cv_1', 'doc_1']]);
  assert.deepEqual(res._json.data.conversation, { conversation_id: 'cv_1', order_id: 'ord_9', reference_id: 'TSH-0009', closed: false });
  assert.deepEqual(res._json.data.messages, [
    { id: 'm1', mine: false, content: 'hi doctor', translation: null, at: '2026-09-20T09:00:00.000Z', read: true },
    { id: 'm2', mine: true, content: 'hello', translation: null, at: '2026-09-20T09:05:00.000Z', read: true },
    { id: 'm3', mine: true, content: 'anything else?', translation: null, at: '2026-09-20T09:06:00.000Z', read: false },
  ]);
  assert.equal(db.runs.length, 0, 'GET must not write');
});

test('a conversation that is not mine (or does not exist) is 404 CONVERSATION_NOT_AVAILABLE on every route', async () => {
  reset();
  conversationRow = null;
  const db = makeDb();
  const cases = [
    ['get', '/conversations/:id', {}],
    ['post', '/conversations/:id/messages', { content: 'x' }],
    ['post', '/conversations/:id/read', {}],
  ];
  for (const [method, routePath, body] of cases) {
    const res = await drive(db, method, routePath, { params: { id: 'cv_other' }, body });
    assert.equal(res.statusCode, 404, `${method} ${routePath}`);
    assert.equal(res._code, 'CONVERSATION_NOT_AVAILABLE', `${method} ${routePath}`);
  }
  assert.equal(db.runs.length, 0);
  assert.equal(queued.length, 0);
});

test('POST /conversations/:id/messages mirrors the web send: insert, bump, notify with the web dedupe key', async () => {
  reset();
  conversationRow = ACTIVE_CONVO;
  const db = makeDb();
  db.gets.push(['SELECT muted_until, name FROM users', { muted_until: null, name: 'Dr. Mona Ali' }]);
  const before = Date.now();
  const res = await drive(db, 'post', '/conversations/:id/messages', {
    params: { id: 'cv_1' }, body: { content: '  Please <script>alert(1)</script>upload the MRI  ' },
  });
  assert.equal(res.statusCode, 200);
  const msg = res._json.data.message;
  assert.equal(msg.content, 'Please upload the MRI');
  assert.equal(msg.mine, true);
  assert.equal(msg.read, false);
  assert.equal(msg.translation, null);
  assert.ok(msg.id && msg.at);

  assert.equal(db.runs.length, 2);
  const [insSql, insParams] = db.runs[0];
  assert.match(insSql, /INSERT INTO messages \(id, conversation_id, sender_id, sender_role, content, message_type, created_at\)/);
  assert.equal(insParams[1], 'cv_1');
  assert.equal(insParams[2], 'doc_1');
  assert.equal(insParams[3], 'doctor');
  assert.equal(insParams[4], 'Please upload the MRI');
  assert.equal(insParams[5], 'text');
  assert.match(db.runs[1][0], /UPDATE conversations SET updated_at = \$1 WHERE id = \$2/);
  assert.deepEqual(db.runs[1][1].slice(1), ['cv_1']);

  assert.equal(queued.length, 1);
  const q = queued[0];
  assert.equal(q.template, 'new_message');
  assert.deepEqual(q.channels, ['internal', 'email']);
  assert.equal(q.toUserId, 'pat_5');
  assert.equal(q.orderId, 'ord_9');
  assert.equal(q.response.case_id, 'ord_9');
  assert.equal(q.response.caseReference, 'ORD_9');
  assert.equal(q.response.senderName, 'Dr. Mona Ali');
  assert.equal(q.response.messagePreview, 'Please upload the MRI');
  const win = Math.floor(before / (10 * 60 * 1000));
  assert.ok(q.dedupe_key === `message:cv_1:${win}` || q.dedupe_key === `message:cv_1:${win + 1}`);
});

test('POST /conversations/:id/messages error codes: EMPTY_MESSAGE, CONVERSATION_CLOSED, MUTED, MESSAGE_SAVE_FAILED', async () => {
  reset();
  // empty after sanitising
  conversationRow = ACTIVE_CONVO;
  let db = makeDb();
  let res = await drive(db, 'post', '/conversations/:id/messages', { params: { id: 'cv_1' }, body: { content: '<script>x</script>   ' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res._code, 'EMPTY_MESSAGE');
  assert.equal(db.runs.length, 0);

  // closed
  conversationRow = { ...ACTIVE_CONVO, status: 'closed' };
  db = makeDb();
  res = await drive(db, 'post', '/conversations/:id/messages', { params: { id: 'cv_1' }, body: { content: 'hi' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res._code, 'CONVERSATION_CLOSED');

  // muted (future muted_until)
  conversationRow = ACTIVE_CONVO;
  db = makeDb();
  db.gets.push(['SELECT muted_until, name FROM users', { muted_until: new Date(Date.now() + 3600e3).toISOString(), name: 'X' }]);
  res = await drive(db, 'post', '/conversations/:id/messages', { params: { id: 'cv_1' }, body: { content: 'hi' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res._code, 'MUTED');

  // an expired mute no longer blocks
  db = makeDb();
  db.gets.push(['SELECT muted_until, name FROM users', { muted_until: new Date(Date.now() - 3600e3).toISOString(), name: 'X' }]);
  res = await drive(db, 'post', '/conversations/:id/messages', { params: { id: 'cv_1' }, body: { content: 'hi' } });
  assert.equal(res.statusCode, 200);

  // insert failure
  db = makeDb();
  db.runThrows = true;
  queued = [];
  res = await drive(db, 'post', '/conversations/:id/messages', { params: { id: 'cv_1' }, body: { content: 'hi' } });
  assert.equal(res.statusCode, 500);
  assert.equal(res._code, 'MESSAGE_SAVE_FAILED');
  assert.equal(queued.length, 0, 'no notification for a message that was not saved');
});

test('POST /conversations/:id/read flips the patient messages and reports the count', async () => {
  reset();
  conversationRow = ACTIVE_CONVO;
  const db = makeDb();
  db.runResult = { rowCount: 4 };
  let res = await drive(db, 'post', '/conversations/:id/read', { params: { id: 'cv_1' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { updated: 4 });
  assert.match(db.runs[0][0], /UPDATE messages SET is_read = true WHERE conversation_id = \$1 AND sender_id != \$2 AND is_read = false/);
  assert.deepEqual(db.runs[0][1], ['cv_1', 'doc_1']);

  db.runResult = { rowCount: 0 };
  res = await drive(db, 'post', '/conversations/:id/read', { params: { id: 'cv_1' } });
  assert.deepEqual(res._json.data, { updated: 0 });

  db.runThrows = true;
  res = await drive(db, 'post', '/conversations/:id/read', { params: { id: 'cv_1' } });
  assert.equal(res.statusCode, 500);
  assert.equal(res._code, 'READ_UPDATE_FAILED');
});

test('a missing doctor id never reaches the ownership check', async () => {
  reset();
  const db = makeDb();
  const res = await drive(db, 'get', '/conversations/:id', { params: { id: 'cv_1' }, user: {} });
  assert.equal(res.statusCode, 400);
  assert.equal(res._code, 'INVALID_REQUEST');
  assert.equal(ownershipCalls.length, 0);
});

// ══════════════════════════════════════════════════════════════
// Alerts
// ══════════════════════════════════════════════════════════════

test('GET /alerts uses the live email, maps template -> kind, resolves order_ref and follows ?lang', async () => {
  reset();
  const db = makeDb();
  db.gets.push(['SELECT id, email, name FROM users', { id: 'doc_1', email: 'live@example.com', name: 'Dr' }]);
  let refParams = null;
  db.alls.push(['SELECT id, reference_id FROM orders_active WHERE id = ANY', (params) => { refParams = params; return [{ id: 'ord_9', reference_id: 'TSH-0009' }]; }]);
  alertsStub.rows = [
    { id: 1, order_id: 'ord_9', template: 'new_message', is_read: false, at: '2026-09-20T10:00:00Z',
      response: JSON.stringify({ case_id: 'ord_9', caseReference: 'TSH-0009', senderName: 'Sara' }) },
    { id: 2, order_id: 'ord_9', template: 'sla_reminder_6h', is_read: true, at: '2026-09-19T10:00:00Z', response: '' },
    { id: 3, order_id: null, template: 'doctor_approved', is_read: false, at: '2026-09-18T10:00:00Z', response: 'doctor_approved' },
    { id: 4, order_id: 'ord_gone', template: 'tashkheesa_new_case_urgent', is_read: false, at: '2026-09-17T10:00:00Z', response: '' },
  ];
  alertsStub.unseen = 3;

  let res = await drive(db, 'get', '/alerts', { query: {} });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(alertsStub.calls[0], ['fetch', 'doc_1', 'live@example.com', 50]);
  assert.deepEqual(refParams, [['ord_9', 'ord_gone']]);
  const { alerts, unseen } = res._json.data;
  assert.equal(unseen, 3);
  assert.equal(alerts.length, 4);

  assert.deepEqual(Object.keys(alerts[0]).sort(), ['at', 'body', 'id', 'is_read', 'kind', 'order_id', 'order_ref', 'title']);
  assert.equal(alerts[0].id, '1');
  assert.equal(alerts[0].kind, 'message');
  assert.equal(alerts[0].title, 'New message');
  assert.equal(typeof alerts[0].body, 'string');           // rendered from the JSON payload by notify
  assert.equal(alerts[0].at, '2026-09-20T10:00:00.000Z');
  assert.equal(alerts[0].order_ref, 'TSH-0009');
  assert.equal(alerts[0].order_id, 'ord_9');
  assert.equal(alerts[0].is_read, false);

  assert.equal(alerts[1].kind, 'sla');
  assert.equal(alerts[1].is_read, true);
  assert.equal(alerts[1].body, null);                     // message fell back to the template name

  assert.equal(alerts[2].kind, 'system');
  assert.equal(alerts[2].order_id, null);
  assert.equal(alerts[2].order_ref, null);

  assert.equal(alerts[3].kind, 'window');
  assert.equal(alerts[3].order_ref, null);                // order no longer in orders_active

  // Arabic titles on ?lang=ar
  res = await drive(db, 'get', '/alerts', { query: { lang: 'ar' } });
  assert.equal(res._json.data.alerts[0].title, 'رسالة جديدة');
  // Read-only: nothing marked.
  assert.ok(!alertsStub.calls.some((c) => c[0] === 'markAll' || c[0] === 'markOne'));
});

test('template -> kind covers every registered doctor-facing template deterministically', () => {
  const k = buildRouter._alertKind;
  const table = {
    new_case_available: 'window', tashkheesa_new_case_standard: 'window', tashkheesa_new_case_fasttrack: 'window',
    order_assigned_doctor: 'window', order_auto_assigned_doctor: 'window', new_case_assigned_doctor: 'window',
    tashkheesa_case_auto_assigned: 'window', order_reassigned_to_doctor: 'window',
    new_message: 'message', patient_reply_info: 'message',
    patient_uploaded_files_doctor: 'files',
    sla_reminder_doctor: 'sla', sla_breached_doctor: 'sla', order_breached_doctor: 'sla', sla_breach: 'sla',
    sla_reminder_24h: 'sla', sla_reminder_1h: 'sla', order_sla_pre_breach_doctor: 'sla', sla_warning_75: 'sla',
    order_reassigned_from_doctor: 'system', doctor_approved: 'system', doctor_confirm_services: 'system',
    prescription_unlocked_doctor: 'system', chat_conduct_warning: 'system', video_slot_review_requested: 'system',
    payment_success_doctor: 'system', appointment_reminder: 'system',
    doctor_payout_sent: 'payout', '': 'system', undefined: 'system',
  };
  for (const [tpl, kind] of Object.entries(table)) {
    assert.equal(k(tpl === 'undefined' ? undefined : tpl), kind, `${tpl} -> ${kind}`);
  }
});

test('POST /alerts/read marks all through the shared helper with the live email', async () => {
  reset();
  const db = makeDb();
  db.gets.push(['SELECT id, email, name FROM users', { id: 'doc_1', email: 'live@example.com' }]);
  let res = await drive(db, 'post', '/alerts/read');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { ok: true });
  assert.deepEqual(alertsStub.calls, [['markAll', 'doc_1', 'live@example.com']]);

  alertsStub.markAllResult = { ok: false, reason: 'update_failed' };
  res = await drive(db, 'post', '/alerts/read');
  assert.equal(res.statusCode, 500);
  assert.equal(res._code, 'ALERTS_MARK_FAILED');
});

test('POST /alerts/:id/read: mine -> ok, not mine / missing -> 404 ALERT_NOT_AVAILABLE, helper failure -> 500', async () => {
  reset();
  const db = makeDb();
  db.gets.push(['SELECT id, email, name FROM users', { id: 'doc_1', email: 'live@example.com' }]);
  let res = await drive(db, 'post', '/alerts/:id/read', { params: { id: '42' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { ok: true });
  assert.deepEqual(alertsStub.calls, [['markOne', 'doc_1', 'live@example.com', '42']]);

  alertsStub.markOneResult = { ok: false, mode: 'is_read' };   // UPDATE matched no owned row
  res = await drive(db, 'post', '/alerts/:id/read', { params: { id: '43' } });
  assert.equal(res.statusCode, 404);
  assert.equal(res._code, 'ALERT_NOT_AVAILABLE');

  alertsStub.markOneResult = { ok: false, reason: 'update_failed' };
  res = await drive(db, 'post', '/alerts/:id/read', { params: { id: '43' } });
  assert.equal(res.statusCode, 500);
  assert.equal(res._code, 'ALERTS_MARK_FAILED');
});

test('alerts routes refuse an unknown doctor row (NOT_FOUND) before touching the feed', async () => {
  reset();
  const db = makeDb();   // no users row scripted
  for (const [m, p, params] of [['get', '/alerts', {}], ['post', '/alerts/read', {}], ['post', '/alerts/:id/read', { id: '1' }]]) {
    const res = await drive(db, m, p, { params });
    assert.equal(res.statusCode, 404, `${m} ${p}`);
    assert.equal(res._code, 'NOT_FOUND', `${m} ${p}`);
  }
  assert.equal(alertsStub.calls.length, 0);
});

// ══════════════════════════════════════════════════════════════
// Annotations
// ══════════════════════════════════════════════════════════════

test('GET /annotations/:imageId returns my payload on an accepted case, nulls otherwise', async () => {
  reset();
  const db = makeDb();
  let annParams = null;
  db.gets.push(['FROM case_annotations ca', (params) => { annParams = params; return { case_id: 'ord_9', annotation_data: '{"shapes":[1,2]}', annotations_count: 2 }; }]);
  db.gets.push(['FROM orders_active WHERE id = $1 AND doctor_id = $2', { id: 'ord_9', doctor_id: 'doc_1', status: 'in_review' }]);
  let res = await drive(db, 'get', '/annotations/:imageId', { params: { imageId: 'img_1' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { payload: '{"shapes":[1,2]}', count: 2 });
  assert.deepEqual(annParams, ['img_1', 'doc_1']);   // scoped to THIS doctor's row

  // no row at all -> 200 with nulls
  const empty = makeDb();
  res = await drive(empty, 'get', '/annotations/:imageId', { params: { imageId: 'img_1' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { payload: null, count: 0 });

  // my row, but the case is no longer accepted by me (reassigned) -> nulls, not the markup
  const moved = makeDb();
  moved.gets.push(['FROM case_annotations ca', { case_id: 'ord_9', annotation_data: '{"x":1}', annotations_count: 1 }]);
  moved.gets.push(['FROM orders_active WHERE id = $1 AND doctor_id = $2', null]);
  res = await drive(moved, 'get', '/annotations/:imageId', { params: { imageId: 'img_1' } });
  assert.deepEqual(res._json.data, { payload: null, count: 0 });
});

test('PUT /annotations/:imageId upserts on (image_id, doctor_id) only when I have ACCEPTED the case', async () => {
  reset();
  // insert path
  let db = makeDb();
  db.gets.push(['FROM orders_active WHERE id = $1 AND doctor_id = $2', { id: 'ord_9', doctor_id: 'doc_1', status: 'in_review' }]);
  db.gets.push(['SELECT id FROM case_annotations WHERE image_id = $1 AND doctor_id = $2', null]);
  let res = await drive(db, 'put', '/annotations/:imageId', {
    params: { imageId: 'img_1' }, body: { case_id: 'ord_9', payload: '{"shapes":[1]}', count: 1 },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { ok: true });
  assert.equal(db.runs.length, 1);
  assert.match(db.runs[0][0], /INSERT INTO case_annotations/);
  const ins = db.runs[0][1];
  assert.equal(ins[1], 'ord_9'); assert.equal(ins[2], 'img_1'); assert.equal(ins[3], 'doc_1');
  assert.equal(ins[4], '{"shapes":[1]}'); assert.equal(ins[5], null); assert.equal(ins[6], 1);

  // update path; an object payload is serialised
  db = makeDb();
  db.gets.push(['FROM orders_active WHERE id = $1 AND doctor_id = $2', { id: 'ord_9', doctor_id: 'doc_1', status: 'awaiting_files' }]);
  db.gets.push(['SELECT id FROM case_annotations WHERE image_id = $1 AND doctor_id = $2', { id: 'ann_7' }]);
  res = await drive(db, 'put', '/annotations/:imageId', {
    params: { imageId: 'img_1' }, body: { case_id: 'ord_9', payload: { shapes: [1, 2] }, count: '2' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(db.runs[0][0], /UPDATE case_annotations/);
  assert.deepEqual(db.runs[0][1], ['{"shapes":[1,2]}', null, 2, 'ann_7']);

  // assigned but NOT accepted (status 'assigned') -> 404 CASE_NOT_AVAILABLE, nothing written
  db = makeDb();
  db.gets.push(['FROM orders_active WHERE id = $1 AND doctor_id = $2', { id: 'ord_9', doctor_id: 'doc_1', status: 'assigned' }]);
  res = await drive(db, 'put', '/annotations/:imageId', { params: { imageId: 'img_1' }, body: { case_id: 'ord_9', payload: '{}', count: 0 } });
  assert.equal(res.statusCode, 404);
  assert.equal(res._code, 'CASE_NOT_AVAILABLE');
  assert.equal(db.runs.length, 0);

  // someone else's case / no such case -> same 404
  db = makeDb();
  res = await drive(db, 'put', '/annotations/:imageId', { params: { imageId: 'img_1' }, body: { case_id: 'ord_x', payload: '{}', count: 0 } });
  assert.equal(res.statusCode, 404);
  assert.equal(res._code, 'CASE_NOT_AVAILABLE');

  // missing case_id -> 400
  res = await drive(db, 'put', '/annotations/:imageId', { params: { imageId: 'img_1' }, body: { payload: '{}' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res._code, 'INVALID_REQUEST');

  // write failure -> 500
  db = makeDb();
  db.gets.push(['FROM orders_active WHERE id = $1 AND doctor_id = $2', { id: 'ord_9', doctor_id: 'doc_1', status: 'in_review' }]);
  db.runThrows = true;
  res = await drive(db, 'put', '/annotations/:imageId', { params: { imageId: 'img_1' }, body: { case_id: 'ord_9', payload: '{}', count: 0 } });
  assert.equal(res.statusCode, 500);
  assert.equal(res._code, 'ANNOTATION_SAVE_FAILED');
});

test('the router keeps the JWT + doctor-role guards ahead of every route', () => {
  const router = buildRouter({}, makeDb().helpers);
  const guards = router.stack.filter((l) => !l.route).map((l) => l.name);
  assert.equal(guards[0], 'requireJWT');
  assert.equal(router.stack[0].route, undefined);
  assert.equal(router.stack[1].route, undefined);
  assert.ok(router.stack.slice(2).every((l) => l.route), 'no middleware after the guards');
  const paths = router.stack.slice(2).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  assert.deepEqual(paths, [
    'GET /conversations', 'GET /conversations/:id', 'POST /conversations/:id/messages', 'POST /conversations/:id/read',
    'GET /alerts', 'POST /alerts/read', 'POST /alerts/:id/read',
    'GET /annotations/:imageId', 'PUT /annotations/:imageId',
  ]);
});
