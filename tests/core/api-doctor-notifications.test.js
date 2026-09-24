// tests/core/api-doctor-notifications.test.js
//
// Doctor push — the decision (services/doctor_push.js) and the settings
// surface (/api/v1/doctor/{push-token,notification-prefs,quiet-hours}).
//
//   1. shouldPush is a PURE function over already-read inputs, so the rules
//      the app promises (locked 'offer' always pushes; a disabled preference
//      is silent; quiet hours are silent except for locked keys; a window
//      may cross midnight) are pinned without a database.
//   2. The template -> key map covers every doctor-facing template the portal
//      queues, and nothing operator-facing.
//   3. pushForDoctorNotification does nothing for an unknown template or a
//      non-doctor recipient, and sends to a doctor through
//      middleware/push.sendPushNotification (the every-device fan-out).
//   4. The routes: token format is refused up front (INVALID_TOKEN), writes
//      hit the session row (when the JWT names one) AND the mirror column,
//      prefs enumerate DOCTOR_PREF_KEYS with a missing row ON, the locked key
//      is 409 PREF_LOCKED, quiet hours validate HH:MM.
//
// Hermetic: helpers {safeGet, safeAll, safeRun} are fakes; pg and push are
// stubbed by assigning onto the REAL module objects (doctor_push reads them
// at call time for exactly this reason).
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'doctor-notifications-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const pg = require(path.join(__dirname, '../../src/pg'));
const pushMw = require(path.join(__dirname, '../../src/middleware/push'));
const doctorPush = require(path.join(__dirname, '../../src/services/doctor_push'));
const buildRouter = require(path.join(__dirname, '../../src/routes/api/doctor_inbox'));

const { shouldPush, doctorPushKey, hhmmToMinutes, inQuietWindow, DOCTOR_PREF_KEYS, DOCTOR_PUSH_TEMPLATES } = doctorPush;

// ── 1. the decision ───────────────────────────────────────────
test('shouldPush: a locked key pushes through a disabled row and through quiet hours', () => {
  assert.equal(shouldPush({ key: 'offer', prefs: { offer: false } }).push, true);
  const r = shouldPush({ key: 'offer', prefs: { offer: false }, quiet: { on: true, from: '00:00', to: '23:59' }, nowCairoMinutes: 12 * 60 });
  assert.equal(r.push, true);
  assert.equal(r.reason, 'locked');
});

test('shouldPush: a missing preference row is enabled; an explicit false is silent', () => {
  assert.equal(shouldPush({ key: 'deadline', prefs: {} }).push, true);
  assert.equal(shouldPush({ key: 'deadline' }).push, true);
  const r = shouldPush({ key: 'deadline', prefs: { deadline: false } });
  assert.equal(r.push, false);
  assert.equal(r.reason, 'pref_disabled');
  // another key's row does not leak
  assert.equal(shouldPush({ key: 'message', prefs: { deadline: false } }).push, true);
});

test('shouldPush: inside the quiet window is silent, outside is not, and off means no window', () => {
  const quiet = { on: true, from: '13:00', to: '15:00' };
  assert.equal(shouldPush({ key: 'message', quiet, nowCairoMinutes: 14 * 60 }).push, false);
  assert.equal(shouldPush({ key: 'message', quiet, nowCairoMinutes: 14 * 60 }).reason, 'quiet_hours');
  assert.equal(shouldPush({ key: 'message', quiet, nowCairoMinutes: 13 * 60 }).push, false, 'start is inclusive');
  assert.equal(shouldPush({ key: 'message', quiet, nowCairoMinutes: 15 * 60 }).push, true, 'end is exclusive');
  assert.equal(shouldPush({ key: 'message', quiet, nowCairoMinutes: 9 * 60 }).push, true);
  assert.equal(shouldPush({ key: 'message', quiet: { on: false, from: '13:00', to: '15:00' }, nowCairoMinutes: 14 * 60 }).push, true);
  // a window with no ends cannot silence anything
  assert.equal(shouldPush({ key: 'message', quiet: { on: true, from: '', to: '' }, nowCairoMinutes: 14 * 60 }).push, true);
});

test('shouldPush: a window crossing midnight (22:00 -> 07:00) is silent late at night AND early morning', () => {
  const quiet = { on: true, from: '22:00', to: '07:00' };
  assert.equal(shouldPush({ key: 'files', quiet, nowCairoMinutes: 23 * 60 }).push, false);
  assert.equal(shouldPush({ key: 'files', quiet, nowCairoMinutes: 2 * 60 }).push, false);
  assert.equal(shouldPush({ key: 'files', quiet, nowCairoMinutes: 6 * 60 + 59 }).push, false);
  assert.equal(shouldPush({ key: 'files', quiet, nowCairoMinutes: 7 * 60 }).push, true);
  assert.equal(shouldPush({ key: 'files', quiet, nowCairoMinutes: 12 * 60 }).push, true);
  assert.equal(shouldPush({ key: 'files', quiet, nowCairoMinutes: 21 * 60 + 59 }).push, true);
  // the locked key still gets through at 3am
  assert.equal(shouldPush({ key: 'offer', quiet, nowCairoMinutes: 3 * 60 }).push, true);
});

test('hhmmToMinutes accepts HH:MM and the HH:MM:SS pg returns for a time column; rejects garbage', () => {
  assert.equal(hhmmToMinutes('07:30'), 450);
  assert.equal(hhmmToMinutes('22:00:00'), 1320);
  assert.equal(hhmmToMinutes('0:05'), 5);
  assert.equal(hhmmToMinutes(''), null);
  assert.equal(hhmmToMinutes(null), null);
  assert.equal(hhmmToMinutes('24:00'), null);
  assert.equal(hhmmToMinutes('12:60'), null);
  assert.equal(hhmmToMinutes('noon'), null);
  assert.equal(inQuietWindow(600, 600, 600), false, 'from === to is no window, not a 24h one');
});

// ── 2. the map ────────────────────────────────────────────────
test('DOCTOR_PREF_KEYS is the app vocabulary with exactly one locked key, and every template maps into it', () => {
  assert.deepEqual(DOCTOR_PREF_KEYS.map((k) => k.key), ['offer', 'window', 'deadline', 'message', 'files', 'payout', 'news']);
  assert.deepEqual(DOCTOR_PREF_KEYS.filter((k) => k.locked).map((k) => k.key), ['offer']);
  for (const k of DOCTOR_PREF_KEYS) assert.ok(['push', 'push_email', 'email'].includes(k.channel), k.key + ' channel');
  const keys = new Set(DOCTOR_PREF_KEYS.map((k) => k.key));
  for (const [tpl, key] of Object.entries(DOCTOR_PUSH_TEMPLATES)) assert.ok(keys.has(key), tpl + ' -> ' + key);
});

test('the template -> key map covers the doctor-facing templates and none of the operator ones', () => {
  const expect = {
    new_case_available: 'offer', tashkheesa_new_case_urgent: 'offer', order_assigned_doctor: 'offer',
    order_auto_assigned_doctor: 'offer', new_case_assigned_doctor: 'offer', tashkheesa_case_auto_assigned: 'offer',
    order_reassigned_doctor: 'offer',
    sla_reminder_doctor: 'deadline', sla_reminder_1h: 'deadline', sla_breach: 'deadline', order_breached_doctor: 'deadline',
    new_message: 'message', patient_reply_info: 'message',
    patient_uploaded_files_doctor: 'files',
    payment_success_doctor: 'payout',
    doctor_approved: 'news',
  };
  for (const [tpl, key] of Object.entries(expect)) assert.equal(doctorPushKey(tpl), key, tpl);
  for (const tpl of ['order_sla_prebreach', 'sla_breach_superadmin', 'acceptance_timeout_auto_assigned_admin',
    'report_ready_patient', 'payment_failed_patient', 'chat_conduct_warning', 'constructor', 'toString', '']) {
    assert.equal(doctorPushKey(tpl), null, tpl + ' must not push to a doctor');
  }
});

// ── 3. the push ───────────────────────────────────────────────
test('pushForDoctorNotification: unknown template and non-doctor recipient never touch push; a doctor is pushed to every device', async () => {
  const realOne = pg.queryOne, realAll = pg.queryAll, realSend = pushMw.sendPushNotification;
  let userRow = { role: 'doctor', quiet_hours_on: false, quiet_from: null, quiet_to: null };
  let prefRows = [];
  let queries = [];
  let sent = [];
  pg.queryOne = async (sql, params) => { queries.push(sql); return userRow; };
  pg.queryAll = async (sql) => { queries.push(sql); return prefRows; };
  pushMw.sendPushNotification = async (db, userId, msg) => { sent.push([userId, msg]); };
  try {
    // unknown template: no query, no send
    let r = await doctorPush.pushForDoctorNotification({ userId: 'doc_1', template: 'report_ready_patient', title: 'x' });
    assert.equal(r.sent, false); assert.equal(r.reason, 'not_doctor_template');
    assert.equal(queries.length, 0); assert.equal(sent.length, 0);

    // the patient also receives new_message: one SELECT, then stop
    userRow = { role: 'patient' };
    r = await doctorPush.pushForDoctorNotification({ userId: 'pat_1', template: 'new_message', title: 'New message' });
    assert.equal(r.reason, 'not_doctor');
    assert.equal(queries.length, 1); assert.equal(sent.length, 0);

    // a doctor, with the preference on and a conversation id -> chat screen
    queries = [];
    userRow = { role: 'doctor', quiet_hours_on: false, quiet_from: null, quiet_to: null };
    r = await doctorPush.pushForDoctorNotification({
      userId: 'doc_1', template: 'new_message', title: 'رسالة جديدة', body: 'Ali: hello', orderId: 'ord_9',
      payload: { conversation_id: 'conv_3' },
    });
    assert.equal(r.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'doc_1');
    assert.equal(sent[0][1].title, 'رسالة جديدة');
    assert.equal(sent[0][1].body, 'Ali: hello');
    assert.deepEqual(sent[0][1].data, { screen: 'chat', template: 'new_message', kind: 'message', caseId: 'ord_9', conversationId: 'conv_3' });
    assert.ok(queries.some((q) => /doctor_notification_prefs/.test(q)), 'prefs are read for an unlocked key');

    // disabled preference -> silent
    sent = []; prefRows = [{ key: 'message', enabled: false }];
    r = await doctorPush.pushForDoctorNotification({ userId: 'doc_1', template: 'new_message', title: 't' });
    assert.equal(r.reason, 'pref_disabled'); assert.equal(sent.length, 0);

    // locked key: prefs are not even read, and quiet hours do not apply
    queries = []; sent = [];
    userRow = { role: 'doctor', quiet_hours_on: true, quiet_from: '00:00:00', quiet_to: '23:59:00' };
    r = await doctorPush.pushForDoctorNotification({ userId: 'doc_1', template: 'new_case_available', title: 'New case', orderId: 'ord_1' });
    assert.equal(r.sent, true); assert.equal(r.reason, 'locked');
    assert.ok(!queries.some((q) => /doctor_notification_prefs/.test(q)), 'no prefs read for a locked key');
    assert.equal(sent[0][1].data.screen, 'case-detail');

    // quiet hours silence an unlocked key
    sent = []; prefRows = [];
    r = await doctorPush.pushForDoctorNotification({ userId: 'doc_1', template: 'sla_reminder_doctor', title: 'Deadline' });
    assert.equal(r.reason, 'quiet_hours'); assert.equal(sent.length, 0);

    // a throwing send is swallowed
    userRow = { role: 'doctor', quiet_hours_on: false };
    pushMw.sendPushNotification = async () => { throw new Error('expo down'); };
    r = await doctorPush.pushForDoctorNotification({ userId: 'doc_1', template: 'sla_reminder_doctor', title: 'Deadline' });
    assert.equal(r.sent, false); assert.equal(r.reason, 'error');
  } finally {
    pg.queryOne = realOne; pg.queryAll = realAll; pushMw.sendPushNotification = realSend;
  }
});

// ── 4. the routes ─────────────────────────────────────────────
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

function makeDb() {
  const db = { gets: [], alls: [], runs: [], runThrows: false, runResult: { rowCount: 1 }, helpers: null };
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

async function drive(db, method, routePath, { body = {}, user = { id: 'doc_1', role: 'doctor', sid: 'sess_7' } } = {}) {
  const router = buildRouter({}, db.helpers);
  const req = { params: {}, body, query: {}, user, headers: {} };
  const res = mockRes();
  await handlerFor(router, method, routePath)(req, res);
  return res;
}

const data = (res) => res._json && res._json.data;

test('POST /push-token refuses anything that is not an Expo token, before any write', async () => {
  for (const token of [undefined, '', 'abc', 'ExponentPushToken[', 'ExponentPushToken[]', 'FCM:xyz', 42]) {
    const db = makeDb();
    const res = await drive(db, 'post', '/push-token', { body: { token } });
    assert.equal(res.statusCode, 400, String(token));
    assert.equal(res._code, 'INVALID_TOKEN');
    assert.equal(db.runs.length, 0);
  }
});

test('POST /push-token writes the session row (scoped to me) and the users mirror; without a sid only the mirror', async () => {
  let db = makeDb();
  let res = await drive(db, 'post', '/push-token', { body: { token: ' ExponentPushToken[abc123] ' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(data(res), { ok: true });
  assert.equal(db.runs.length, 2);
  assert.match(db.runs[0][0], /UPDATE user_sessions SET push_token = \$1/);
  assert.match(db.runs[0][0], /user_id = \$3/);
  assert.deepEqual(db.runs[0][1], ['ExponentPushToken[abc123]', 'sess_7', 'doc_1']);
  assert.match(db.runs[1][0], /UPDATE users SET push_token = \$1 WHERE id = \$2/);
  assert.deepEqual(db.runs[1][1], ['ExponentPushToken[abc123]', 'doc_1']);

  db = makeDb();
  res = await drive(db, 'post', '/push-token', { body: { token: 'ExpoPushToken[zz]' }, user: { id: 'doc_1', role: 'doctor' } });
  assert.equal(res.statusCode, 200);
  assert.equal(db.runs.length, 1);
  assert.match(db.runs[0][0], /UPDATE users SET push_token/);

  db = makeDb(); db.runThrows = true;
  res = await drive(db, 'post', '/push-token', { body: { token: 'ExpoPushToken[zz]' } });
  assert.equal(res.statusCode, 500); assert.equal(res._code, 'PUSH_TOKEN_SAVE_FAILED');
});

test('DELETE /push-token nulls this session and the mirror', async () => {
  const db = makeDb();
  const res = await drive(db, 'delete', '/push-token');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(data(res), { ok: true });
  assert.equal(db.runs.length, 2);
  assert.match(db.runs[0][0], /UPDATE user_sessions SET push_token = NULL WHERE id = \$1 AND user_id = \$2/);
  assert.deepEqual(db.runs[0][1], ['sess_7', 'doc_1']);
  assert.match(db.runs[1][0], /UPDATE users SET push_token = NULL WHERE id = \$1/);
  assert.deepEqual(db.runs[1][1], ['doc_1']);
});

test('GET /notification-prefs enumerates every key: missing row ON, stored row honoured, locked key ON regardless', async () => {
  const db = makeDb();
  db.alls.push(['doctor_notification_prefs', [{ key: 'deadline', enabled: false }, { key: 'offer', enabled: false }, { key: 'bogus', enabled: false }]]);
  db.gets.push(['quiet_hours_on', { quiet_hours_on: true, quiet_from: '22:00:00', quiet_to: '07:00:00' }]);
  const res = await drive(db, 'get', '/notification-prefs');
  assert.equal(res.statusCode, 200);
  const d = data(res);
  assert.deepEqual(d.prefs.map((p) => p.key), DOCTOR_PREF_KEYS.map((k) => k.key));
  const by = Object.fromEntries(d.prefs.map((p) => [p.key, p]));
  assert.deepEqual(by.offer, { key: 'offer', on: true, locked: true, channel: 'push_email' }, 'a stored false on the locked key is ignored');
  assert.equal(by.deadline.on, false);
  assert.equal(by.deadline.locked, false);
  assert.equal(by.message.on, true, 'no row means on');
  assert.equal(by.payout.on, true);
  assert.ok(!('bogus' in by), 'unknown stored keys are not surfaced');
  assert.deepEqual(d.quiet, { on: true, from: '22:00', to: '07:00' });

  // nothing stored at all
  const empty = await drive(makeDb(), 'get', '/notification-prefs');
  assert.deepEqual(data(empty).quiet, { on: false, from: '', to: '' });
  assert.ok(data(empty).prefs.every((p) => p.on === true));
});

test('PUT /notification-prefs upserts one key; locked -> 409 PREF_LOCKED; bad body -> 400', async () => {
  let db = makeDb();
  let res = await drive(db, 'put', '/notification-prefs', { body: { key: 'deadline', on: false } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(data(res), { key: 'deadline', on: false, locked: false });
  assert.equal(db.runs.length, 1);
  assert.match(db.runs[0][0], /INSERT INTO doctor_notification_prefs/);
  assert.match(db.runs[0][0], /ON CONFLICT \(doctor_id, key\) DO UPDATE/);
  assert.deepEqual(db.runs[0][1], ['doc_1', 'deadline', false]);

  db = makeDb();
  res = await drive(db, 'put', '/notification-prefs', { body: { key: 'offer', on: false } });
  assert.equal(res.statusCode, 409); assert.equal(res._code, 'PREF_LOCKED');
  assert.equal(db.runs.length, 0);

  for (const body of [{}, { key: 'nope', on: true }, { key: 'deadline' }, { key: 'deadline', on: 'yes' }]) {
    db = makeDb();
    res = await drive(db, 'put', '/notification-prefs', { body });
    assert.equal(res.statusCode, 400, JSON.stringify(body)); assert.equal(res._code, 'INVALID_REQUEST');
    assert.equal(db.runs.length, 0);
  }

  db = makeDb(); db.runThrows = true;
  res = await drive(db, 'put', '/notification-prefs', { body: { key: 'files', on: true } });
  assert.equal(res.statusCode, 500); assert.equal(res._code, 'PREF_SAVE_FAILED');
});

test('PUT /quiet-hours validates HH:MM, needs both ends to turn on, writes the three columns, keeps times when turning off', async () => {
  let db = makeDb();
  let res = await drive(db, 'put', '/quiet-hours', { body: { on: true, from: '22:00', to: '07:00' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(data(res), { quiet: { on: true, from: '22:00', to: '07:00' } });
  assert.equal(db.runs.length, 1);
  assert.match(db.runs[0][0], /UPDATE users SET quiet_hours_on = \$1, quiet_from = \$2, quiet_to = \$3 WHERE id = \$4/);
  assert.deepEqual(db.runs[0][1], [true, '22:00', '07:00', 'doc_1']);

  for (const body of [{ on: true, from: '25:00', to: '07:00' }, { on: true, from: '22:00', to: '7:00' }, { on: true, from: 'ten', to: '07:00' }, { on: false, from: '22:61' }]) {
    db = makeDb();
    res = await drive(db, 'put', '/quiet-hours', { body });
    assert.equal(res.statusCode, 400, JSON.stringify(body)); assert.equal(res._code, 'INVALID_TIME');
    assert.equal(db.runs.length, 0);
  }

  db = makeDb();
  res = await drive(db, 'put', '/quiet-hours', { body: { on: 'yes' } });
  assert.equal(res.statusCode, 400); assert.equal(res._code, 'INVALID_REQUEST');

  // on with nothing stored and only one end given
  db = makeDb();
  res = await drive(db, 'put', '/quiet-hours', { body: { on: true, from: '22:00' } });
  assert.equal(res.statusCode, 400); assert.equal(res._code, 'QUIET_RANGE_REQUIRED');
  assert.equal(db.runs.length, 0);

  // on with one end given and the other already stored
  db = makeDb();
  db.gets.push(['quiet_hours_on', { quiet_hours_on: false, quiet_from: '21:00:00', quiet_to: '06:30:00' }]);
  res = await drive(db, 'put', '/quiet-hours', { body: { on: true, from: '23:00' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(data(res), { quiet: { on: true, from: '23:00', to: '06:30' } });
  assert.deepEqual(db.runs[0][1], [true, '23:00', '06:30', 'doc_1']);

  // off keeps the stored window
  db = makeDb();
  db.gets.push(['quiet_hours_on', { quiet_hours_on: true, quiet_from: '22:00:00', quiet_to: '07:00:00' }]);
  res = await drive(db, 'put', '/quiet-hours', { body: { on: false } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(data(res), { quiet: { on: false, from: '22:00', to: '07:00' } });
  assert.deepEqual(db.runs[0][1], [false, '22:00', '07:00', 'doc_1']);

  db = makeDb(); db.runThrows = true;
  res = await drive(db, 'put', '/quiet-hours', { body: { on: false } });
  assert.equal(res.statusCode, 500); assert.equal(res._code, 'QUIET_SAVE_FAILED');
});

test('every new route needs a resolved doctor id', async () => {
  for (const [m, p] of [['post', '/push-token'], ['delete', '/push-token'], ['get', '/notification-prefs'], ['put', '/notification-prefs'], ['put', '/quiet-hours']]) {
    const db = makeDb();
    const res = await drive(db, m, p, { body: { token: 'ExpoPushToken[x]', key: 'files', on: true }, user: {} });
    assert.equal(res.statusCode, 400, `${m} ${p}`); assert.equal(res._code, 'INVALID_REQUEST');
    assert.equal(db.runs.length, 0);
  }
});

// ── 5. the hook in notify.js ──────────────────────────────────
test('notify.js calls the doctor push beside the patient push on both internal write paths, and the patient hook is untouched', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '../../src/notify.js'), 'utf8');
  assert.equal((src.match(/pushForNotification\(\{/g) || []).length, 2, 'patient hook: insert + requeue');
  assert.equal((src.match(/await pushDoctorSafely\(\{/g) || []).length, 2, 'doctor hook: insert + requeue');
  assert.ok(/require\('\.\/services\/doctor_push'\)/.test(src));
  // the doctor call sits inside the same channel gate as the patient one
  const gate = src.indexOf("if (channel === 'internal')");
  assert.ok(gate !== -1);
  assert.ok(src.indexOf('await pushDoctorSafely(', gate) !== -1);
});
