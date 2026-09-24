// tests/core/api-doctor-me.test.js
//
// /api/v1/doctor/{profile,appearance,availability,services,signature,phrases,
// feedback,ops-ticket,account/closure,notification-prefs} — the doctor app's
// "me" surface (routes/api/doctor_me.js).
//
// What these pin:
//   1. Every write goes to the SAME columns and the SAME helpers the web
//      portal uses (is_paused/pause_reason for the self-pause, the turnaround
//      UPDATE for tiers, the services transaction body, storage for the
//      signature) — captured SQL and captured stub arguments, not behaviour
//      re-implemented in the test.
//   2. A doctor can never lift a pause the platform applied (409
//      PAUSED_BY_PLATFORM), and a self-pause never overwrites one.
//   3. Every error code the router returns has a stable status + code.
//
// Hermetic, same pattern as api-doctor-submit-report.test.js: build the router
// with mocked helpers, pull handlers out of router.stack, drive them with a
// fake req/res. Portal functions are stubbed BY ASSIGNMENT on the real module
// objects (never by replacing require.cache entries — test files share it).
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'doctor-me-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '../../src');
const pg = require(path.join(ROOT, 'pg'));
const catalogMod = require(path.join(ROOT, 'services/doctor_service_catalog'));
const syncMod = require(path.join(ROOT, 'services/services_coming_soon_sync'));
const storage = require(path.join(ROOT, 'storage'));
const opsPush = require(path.join(ROOT, 'services/ops_push'));
const notify = require(path.join(ROOT, 'notify'));
const emailService = require(path.join(ROOT, 'services/emailService'));
const logger = require(path.join(ROOT, 'logger'));
const caseLifecycle = require(path.join(ROOT, 'case_lifecycle'));

// ─── routes/doctor.js `_queue` ─────────────────────────────────────────────
// The router reads require('../doctor')._queue lazily. In a full checkout the
// real module loads and its _queue functions are stubbed by assignment below.
// In a partial checkout (no src/views) the module cannot load at all, and
// Node leaves no cache entry behind — so a minimal stand-in is SEEDED only
// when nothing is there, and removed again after. Nothing is ever replaced.
const doctorPath = require.resolve(path.join(ROOT, 'routes/doctor'));
let seededDoctor = false;
let doctorMod;
try {
  doctorMod = require(doctorPath);
} catch (_) {
  if (!require.cache[doctorPath]) {
    doctorMod = { _queue: {} };
    require.cache[doctorPath] = { id: doctorPath, filename: doctorPath, loaded: true, exports: doctorMod };
    seededDoctor = true;
  } else {
    doctorMod = require.cache[doctorPath].exports;
  }
}
const q = doctorMod._queue;
const savedQueue = {
  countActiveCasesForDoctor: q.countActiveCasesForDoctor,
  readDoctorTiers: q.readDoctorTiers,
  DOCTOR_SLA_TIERS: q.DOCTOR_SLA_TIERS,
};
let activeCount = 2;
q.countActiveCasesForDoctor = async () => activeCount;
q.DOCTOR_SLA_TIERS = q.DOCTOR_SLA_TIERS || ['standard', 'vip', 'urgent'];
q.readDoctorTiers = q.readDoctorTiers || function (raw) {
  let arr = raw;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_) { arr = null; } }
  if (!Array.isArray(arr)) return ['standard'];
  const out = ['standard', 'vip', 'urgent'].filter((t) => arr.includes(t));
  return out.length ? out : ['standard'];
};

// ─── Stubs by assignment on the real modules ───────────────────────────────
const saved = {
  withTransaction: pg.withTransaction,
  loadDoctorServiceCatalog: catalogMod.loadDoctorServiceCatalog,
  resyncComingSoon: syncMod.resyncComingSoon,
  uploadFile: storage.uploadFile,
  deleteFile: storage.deleteFile,
  pushOpsEvent: opsPush.pushOpsEvent,
  notifyAdmins: notify.notifyAdmins,
  sendMail: emailService.sendMail,
  logErrorToDb: logger.logErrorToDb,
};
const calls = { client: [], upload: [], del: [], push: [], notifyAdmins: [], mail: [], log: [], resync: 0 };
let catalogResult = { groups: [], allowedIds: new Set(), isEmpty: true };
let heldRows = [];
let pushShouldThrow = false;

pg.withTransaction = async (fn) => {
  const client = {
    query: async (sql, params) => {
      calls.client.push({ sql, params });
      if (/SELECT service_id FROM doctor_services/.test(sql)) return { rows: heldRows.map((id) => ({ service_id: id })) };
      return { rows: [], rowCount: 1 };
    },
  };
  return fn(client);
};
catalogMod.loadDoctorServiceCatalog = async () => catalogResult;
syncMod.resyncComingSoon = async () => { calls.resync += 1; };
storage.uploadFile = async (args) => { calls.upload.push(args); return args.folder + '/' + args.filename; };
storage.deleteFile = async (key) => { calls.del.push(key); };
opsPush.pushOpsEvent = async (o) => { calls.push.push(o); if (pushShouldThrow) throw new Error('push down'); return { sent: true }; };
notify.notifyAdmins = async (o) => { calls.notifyAdmins.push(o); return []; };
emailService.sendMail = async (o) => { calls.mail.push(o); return { ok: true }; };
logger.logErrorToDb = async (err, ctx) => { calls.log.push({ err, ctx }); return 'err_x'; };

test.after(() => {
  Object.assign(pg, { withTransaction: saved.withTransaction });
  catalogMod.loadDoctorServiceCatalog = saved.loadDoctorServiceCatalog;
  syncMod.resyncComingSoon = saved.resyncComingSoon;
  storage.uploadFile = saved.uploadFile;
  storage.deleteFile = saved.deleteFile;
  opsPush.pushOpsEvent = saved.pushOpsEvent;
  notify.notifyAdmins = saved.notifyAdmins;
  emailService.sendMail = saved.sendMail;
  logger.logErrorToDb = saved.logErrorToDb;
  if (seededDoctor) delete require.cache[doctorPath];
  else Object.assign(q, savedQueue);
});

const buildRouter = require(path.join(ROOT, 'routes/api/doctor_me'));

// ─── Harness ───────────────────────────────────────────────────────────────
function handler(router, method, routePath) {
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

const DOCTOR = {
  id: 'doc_1', name: 'Dr. Mona', name_ar: 'د. منى', email: 'mona@example.com', phone: '+2010',
  country_code: 'EG', specialty_id: 'spec_radiology', years_of_experience: 9,
  medical_license_number: 'L-1', license_country: 'EG', spoken_languages: '["ar","en"]',
  sub_specialties: ['neuro'], bio: 'Hi', bio_ar: null, profile_photo_url: null, signature_url: 'doctor-signatures/doc_1/1.png',
  lang: 'ar', appearance_preference: 'dark', onboarding_complete: true, approved_at: '2026-01-02T00:00:00Z',
  is_paused: false, paused_at: null, pause_reason: null, sla_tiers_supported: ['standard', 'vip'],
  sla_tiers_confirmed_at: null, max_active_cases: 4, is_available: true, created_at: '2025-12-01T00:00:00Z',
};

// A scriptable DB: `rows` maps a regex on the SQL to the row(s) to return;
// every safeRun call is recorded so tests can assert the exact write.
function makeDb(rows = [], runResult) {
  const runs = [];
  const match = (sql) => { for (const [re, v] of rows) if (re.test(sql)) return v; return undefined; };
  const helpers = {
    safeGet: async (sql, params, fallback = null) => { const v = match(sql); return v === undefined ? fallback : (typeof v === 'function' ? v(params) : v); },
    safeAll: async (sql, params, fallback = []) => { const v = match(sql); return v === undefined ? fallback : v; },
    safeRun: async (sql, params) => {
      runs.push({ sql, params });
      if (typeof runResult === 'function') return runResult(sql, params);
      return runResult || { rowCount: 1, rows: [] };
    },
  };
  return { helpers, runs };
}

async function drive({ method, route, body = {}, params = {}, user = { id: 'doc_1', role: 'doctor' }, db }) {
  db = db || makeDb();
  const router = buildRouter({}, db.helpers);
  const req = { params, body, user, query: {}, headers: { 'user-agent': 'TashkheesaDoctor/1.0' }, ip: '1.2.3.4', requestId: 'req_1', originalUrl: '/api/v1/doctor' + route, method: method.toUpperCase() };
  const res = mockRes();
  await handler(router, method, route)(req, res);
  return { res, runs: db.runs };
}

function reset() {
  for (const k of Object.keys(calls)) calls[k] = Array.isArray(calls[k]) ? [] : 0;
  pushShouldThrow = false;
  heldRows = [];
  catalogResult = { groups: [], allowedIds: new Set(), isEmpty: true };
}

const USER_RE = /FROM users WHERE id = \$1 AND role = 'doctor'/;

// ═══ Profile ═══════════════════════════════════════════════════════════════
test('GET /profile returns the sanitised row, specialty, rating and licence_verified', async () => {
  const db = makeDb([
    [USER_RE, { ...DOCTOR }],
    [/FROM specialties/, { id: 'spec_radiology', name: 'Radiology', name_ar: 'الأشعة' }],
    [/FROM reviews/, { avg_rating: '4.5', count: '6' }],
  ]);
  const { res } = await drive({ method: 'get', route: '/profile', db });
  assert.equal(res.statusCode, 200);
  const d = res._json.data;
  assert.equal(d.doctor.id, 'doc_1');
  assert.deepEqual(d.doctor.spoken_languages, ['ar', 'en']);
  assert.equal(d.doctor.appearance_preference, 'dark');
  assert.equal(d.doctor.approved_at, '2026-01-02T00:00:00.000Z');
  assert.equal(d.doctor.is_paused, false);
  assert.equal('paused_at' in d.doctor, false);
  assert.equal('password' in d.doctor, false);
  assert.equal(d.specialty_name, 'Radiology');
  assert.equal(d.specialty_name_ar, 'الأشعة');
  assert.deepEqual(d.rating, { avg: 4.5, count: 6 });
  assert.equal(d.licence_verified, true);
});

test('GET /profile: no approval → licence_verified false; no reviews → rating null', async () => {
  const db = makeDb([[USER_RE, { ...DOCTOR, approved_at: null }], [/FROM reviews/, { avg_rating: null, count: '0' }]]);
  const { res } = await drive({ method: 'get', route: '/profile', db });
  assert.equal(res._json.data.licence_verified, false);
  assert.equal(res._json.data.rating, null);
  assert.equal(res._json.data.specialty_name, '');
});

test('GET /profile: unknown doctor row → 404 NOT_FOUND; missing user id → 400', async () => {
  let r = await drive({ method: 'get', route: '/profile' });
  assert.equal(r.res.statusCode, 404); assert.equal(r.res._code, 'NOT_FOUND');
  r = await drive({ method: 'get', route: '/profile', user: {} });
  assert.equal(r.res.statusCode, 400); assert.equal(r.res._code, 'INVALID_REQUEST');
});

test('PATCH /profile: only bio/bio_ar/spoken_languages/name_ar; anything else is FIELD_NOT_EDITABLE', async () => {
  let r = await drive({ method: 'patch', route: '/profile', body: { bio: 'x', specialty_id: 'spec_other' } });
  assert.equal(r.res.statusCode, 400); assert.equal(r.res._code, 'FIELD_NOT_EDITABLE');
  assert.equal(r.runs.length, 0);
  r = await drive({ method: 'patch', route: '/profile', body: { medical_license_number: 'L-2' } });
  assert.equal(r.res._code, 'FIELD_NOT_EDITABLE');
  r = await drive({ method: 'patch', route: '/profile', body: {} });
  assert.equal(r.res._code, 'INVALID_REQUEST');
});

test('PATCH /profile trims, caps bio at 2000 and writes spoken_languages as jsonb', async () => {
  const long = 'a'.repeat(2500);
  const { res, runs } = await drive({
    method: 'patch', route: '/profile',
    body: { bio: '  ' + long + '  ', bio_ar: '   ', spoken_languages: ['ar', ' en ', 7], name_ar: ' د. منى ' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { ok: true });
  assert.equal(runs.length, 1);
  assert.match(runs[0].sql, /UPDATE users SET bio = \$2, bio_ar = \$3, name_ar = \$4, spoken_languages = \$5::jsonb WHERE id = \$1 AND role = 'doctor'/);
  assert.equal(runs[0].params[0], 'doc_1');
  assert.equal(runs[0].params[1].length, 2000);
  assert.equal(runs[0].params[2], null);
  assert.equal(runs[0].params[3], 'د. منى');
  assert.equal(runs[0].params[4], JSON.stringify(['ar', 'en']));
});

test('PATCH /profile: a failed UPDATE is a 500, not a silent 200', async () => {
  const db = makeDb([], () => { throw new Error('boom'); });
  const { res } = await drive({ method: 'patch', route: '/profile', body: { bio: 'x' }, db });
  assert.equal(res.statusCode, 500); assert.equal(res._code, 'PROFILE_SAVE_FAILED');
});

// ═══ Appearance ════════════════════════════════════════════════════════════
test('PUT /appearance whitelists the theme and writes users.appearance_preference', async () => {
  let r = await drive({ method: 'put', route: '/appearance', body: { theme: 'neon' } });
  assert.equal(r.res.statusCode, 400); assert.equal(r.res._code, 'INVALID_THEME');
  assert.equal(r.runs.length, 0);
  r = await drive({ method: 'put', route: '/appearance', body: { theme: 'System' } });
  assert.equal(r.res.statusCode, 200);
  assert.deepEqual(r.res._json.data, { ok: true, theme: 'system' });
  assert.match(r.runs[0].sql, /UPDATE users SET appearance_preference = \$2 WHERE id = \$1 AND role = 'doctor'/);
  assert.deepEqual(r.runs[0].params, ['doc_1', 'system']);
});

// ═══ Availability ══════════════════════════════════════════════════════════
test('GET /availability: taking_cases = NOT is_paused, tiers carry case_lifecycle hours, held count from _queue', async () => {
  activeCount = 3;
  const db = makeDb([[USER_RE, { ...DOCTOR, sla_tiers_supported: ['standard', 'urgent'] }]]);
  const { res } = await drive({ method: 'get', route: '/availability', db });
  assert.equal(res.statusCode, 200);
  const d = res._json.data;
  assert.equal(d.taking_cases, true);
  assert.equal(d.max_active, 4);
  assert.equal(d.currently_held, 3);
  assert.deepEqual(d.tiers.map((t) => [t.tier, t.label_hours, t.on]), [
    ['standard', caseLifecycle.SLA_HOURS_BY_TIER.standard, true],
    ['vip', caseLifecycle.SLA_HOURS_BY_TIER.vip, false],
    ['urgent', caseLifecycle.SLA_HOURS_BY_TIER.urgent, true],
  ]);
  assert.deepEqual(d.away, []);
  assert.equal(d.self_pause_supported, true);
  assert.equal(d.away_supported, false);
  assert.equal(d.max_active_editable, false);
  assert.equal(d.pause_reason, null);
});

test('GET /availability on a paused doctor exposes the reason and whether it is their own', async () => {
  const db = makeDb([[USER_RE, { ...DOCTOR, is_paused: true, pause_reason: 'doctor_self' }]]);
  const { res } = await drive({ method: 'get', route: '/availability', db });
  assert.equal(res._json.data.taking_cases, false);
  assert.equal(res._json.data.paused_by_self, true);
  const r2 = await drive({ method: 'get', route: '/availability' });
  assert.equal(r2.res.statusCode, 404); assert.equal(r2.res._code, 'NOT_FOUND');
});

test('PUT /availability/taking-cases on=false writes the self-pause on is_paused/pause_reason', async () => {
  const db = makeDb([[/SELECT is_paused, pause_reason FROM users/, { is_paused: false, pause_reason: null }]]);
  const { res, runs } = await drive({ method: 'put', route: '/availability/taking-cases', body: { on: false }, db });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { taking_cases: false });
  assert.equal(runs.length, 1);
  assert.match(runs[0].sql, /SET is_paused = true, paused_at = NOW\(\), pause_reason = \$2/);
  assert.deepEqual(runs[0].params, ['doc_1', 'doctor_self']);
});

test('PUT /availability/taking-cases on=false never overwrites a platform pause (idempotent)', async () => {
  const db = makeDb([[/SELECT is_paused, pause_reason FROM users/, { is_paused: true, pause_reason: 'auto:sla_breach_threshold:3_in_30d' }]]);
  const { res, runs } = await drive({ method: 'put', route: '/availability/taking-cases', body: { on: false }, db });
  assert.equal(res.statusCode, 200);
  assert.equal(runs.length, 0);
});

test('PUT /availability/taking-cases on=true lifts ONLY a self-pause', async () => {
  let db = makeDb([[/SELECT is_paused, pause_reason FROM users/, { is_paused: true, pause_reason: 'doctor_self' }]]);
  let r = await drive({ method: 'put', route: '/availability/taking-cases', body: { on: true }, db });
  assert.equal(r.res.statusCode, 200);
  assert.deepEqual(r.res._json.data, { taking_cases: true });
  assert.match(r.runs[0].sql, /SET is_paused = false, paused_at = NULL, pause_reason = NULL/);
  assert.match(r.runs[0].sql, /AND pause_reason = \$2/);
  assert.deepEqual(r.runs[0].params, ['doc_1', 'doctor_self']);

  for (const reason of ['auto:sla_breach_threshold:3_in_30d', 'ops: complaints', null]) {
    db = makeDb([[/SELECT is_paused, pause_reason FROM users/, { is_paused: true, pause_reason: reason }]]);
    r = await drive({ method: 'put', route: '/availability/taking-cases', body: { on: true }, db });
    assert.equal(r.res.statusCode, 409, `reason ${reason}`);
    assert.equal(r.res._code, 'PAUSED_BY_PLATFORM');
    assert.equal(r.runs.length, 0);
  }

  // Already taking cases: a no-op success, no write.
  db = makeDb([[/SELECT is_paused, pause_reason FROM users/, { is_paused: false, pause_reason: null }]]);
  r = await drive({ method: 'put', route: '/availability/taking-cases', body: { on: true }, db });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.runs.length, 0);
});

test('PUT /availability/taking-cases validates the body and the doctor row', async () => {
  let r = await drive({ method: 'put', route: '/availability/taking-cases', body: { on: 'yes' } });
  assert.equal(r.res.statusCode, 400); assert.equal(r.res._code, 'INVALID_REQUEST');
  r = await drive({ method: 'put', route: '/availability/taking-cases', body: { on: true } });
  assert.equal(r.res.statusCode, 404); assert.equal(r.res._code, 'NOT_FOUND');
});

test('PUT /availability/tiers whitelists against DOCTOR_SLA_TIERS, floors at standard, stamps confirmed_at', async () => {
  let r = await drive({ method: 'put', route: '/availability/tiers', body: { tiers: ['URGENT', 'priority', 'vip'] } });
  assert.equal(r.res.statusCode, 200);
  assert.deepEqual(r.res._json.data, { tiers: ['vip', 'urgent'] });
  assert.match(r.runs[0].sql, /sla_tiers_supported\s+= \$2::jsonb/);
  assert.match(r.runs[0].sql, /sla_tiers_confirmed_at = NOW\(\)/);
  assert.match(r.runs[0].sql, /WHERE id = \$1 AND role = 'doctor'/);
  assert.deepEqual(r.runs[0].params, ['doc_1', JSON.stringify(['vip', 'urgent'])]);

  r = await drive({ method: 'put', route: '/availability/tiers', body: { tiers: [] } });
  assert.deepEqual(r.res._json.data, { tiers: ['standard'] });
  assert.deepEqual(r.runs[0].params, ['doc_1', JSON.stringify(['standard'])]);
});

test('max-active and away are 501 NOT_SUPPORTED', async () => {
  let r = await drive({ method: 'put', route: '/availability/max-active', body: { max_active: 9 } });
  assert.equal(r.res.statusCode, 501); assert.equal(r.res._code, 'NOT_SUPPORTED');
  r = await drive({ method: 'post', route: '/availability/away', body: { from: 'x', to: 'y' } });
  assert.equal(r.res.statusCode, 501); assert.equal(r.res._code, 'NOT_SUPPORTED');
});

// ═══ Services ══════════════════════════════════════════════════════════════
const CATALOG = {
  groups: [{
    specialtyId: 'spec_radiology', specialtyName: 'Radiology', specialtyNameAr: 'الأشعة',
    services: [
      { id: 'svc_a', name: 'MRI read', name_ar: null, doctor_fee: '700', sla_hours: 48, is_visible: true, ticked: true },
      { id: 'svc_b', name: 'CT read', name_ar: null, doctor_fee: 500, sla_hours: 18, is_visible: false, ticked: false },
    ],
  }],
  allowedIds: new Set(['svc_a', 'svc_b']),
  isEmpty: false,
};

test('GET /services maps the catalog union: on = held row, coming_soon = !is_visible', async () => {
  reset();
  catalogResult = CATALOG;
  const db = makeDb([[/SELECT specialty_id FROM users/, { specialty_id: 'spec_radiology' }]]);
  const { res } = await drive({ method: 'get', route: '/services', db });
  assert.equal(res.statusCode, 200);
  const d = res._json.data;
  assert.equal(d.specialties.length, 1);
  assert.equal(d.specialties[0].name_ar, 'الأشعة');
  assert.deepEqual(d.specialties[0].services[0], { service_id: 'svc_a', name: 'MRI read', name_ar: null, doctor_fee: 700, sla_hours: 48, on: true, coming_soon: false });
  assert.equal(d.specialties[0].services[1].coming_soon, true);
  assert.equal(d.specialties[0].services[1].on, false);
  assert.equal(d.on_count, 1);
  assert.equal(d.total_count, 2);
  assert.equal(d.union_note, null);
  assert.equal('base_price' in d.specialties[0].services[0], false);
});

test('PUT /services: empty set needs confirm_empty; ids outside the union are SERVICE_NOT_ALLOWED', async () => {
  reset();
  catalogResult = CATALOG;
  const db = () => makeDb([[/SELECT specialty_id FROM users/, { specialty_id: 'spec_radiology' }]]);
  let r = await drive({ method: 'put', route: '/services', body: { service_ids: [] }, db: db() });
  assert.equal(r.res.statusCode, 400); assert.equal(r.res._code, 'CONFIRM_EMPTY');
  assert.equal(calls.client.length, 0);

  r = await drive({ method: 'put', route: '/services', body: { service_ids: ['svc_a', 'svc_other'] }, db: db() });
  assert.equal(r.res.statusCode, 400); assert.equal(r.res._code, 'SERVICE_NOT_ALLOWED');
  assert.equal(calls.client.some((c) => /INSERT INTO doctor_services/.test(c.sql)), false);
  assert.equal(calls.resync, 0);
});

test('PUT /services runs the web transaction body: diff insert/delete, onboarding_complete, resyncComingSoon', async () => {
  reset();
  catalogResult = CATALOG;
  heldRows = ['svc_a'];
  const db = makeDb([[/SELECT specialty_id FROM users/, { specialty_id: 'spec_radiology' }]]);
  const { res } = await drive({ method: 'put', route: '/services', body: { service_ids: ['svc_b'] }, db });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { on_count: 1 });
  const sqls = calls.client.map((c) => c.sql);
  const ins = calls.client.find((c) => /INSERT INTO doctor_services/.test(c.sql));
  assert.deepEqual(ins.params, ['doc_1', 'svc_b']);
  const del = calls.client.find((c) => /DELETE FROM doctor_services/.test(c.sql));
  assert.deepEqual(del.params, ['doc_1', ['svc_a']]);
  assert.ok(sqls.some((s) => /UPDATE users SET onboarding_complete = true/.test(s)));
  assert.equal(calls.resync, 1);
});

test('PUT /services: confirmed-empty clears the union and still completes onboarding', async () => {
  reset();
  catalogResult = CATALOG;
  heldRows = ['svc_a'];
  const db = makeDb([[/SELECT specialty_id FROM users/, { specialty_id: 'spec_radiology' }]]);
  const { res } = await drive({ method: 'put', route: '/services', body: { service_ids: [], confirm_empty: true }, db });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { on_count: 0 });
  assert.ok(calls.client.some((c) => /DELETE FROM doctor_services/.test(c.sql)));
  assert.ok(calls.client.some((c) => /onboarding_complete = true/.test(c.sql)));
});

// ═══ Signature ═════════════════════════════════════════════════════════════
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('PUT /signature uploads through storage under doctor-signatures/<id>, deletes the old key, writes signature_url', async () => {
  reset();
  const db = makeDb([[/SELECT signature_url FROM users/, { signature_url: 'doctor-signatures/doc_1/old.png' }]]);
  const { res, runs } = await drive({ method: 'put', route: '/signature', body: { data: 'data:image/png;base64,' + PNG_1x1 }, db });
  assert.equal(res.statusCode, 200);
  assert.equal(res._json.data.ok, true);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0].folder, 'doctor-signatures/doc_1');
  assert.equal(calls.upload[0].mimetype, 'image/png');
  assert.match(calls.upload[0].filename, /^\d+\.png$/);
  assert.ok(Buffer.isBuffer(calls.upload[0].buffer));
  assert.deepEqual(calls.del, ['doctor-signatures/doc_1/old.png']);
  assert.match(runs[0].sql, /UPDATE users SET signature_url = \$1 WHERE id = \$2/);
  assert.equal(runs[0].params[0], res._json.data.signature_url);
  assert.equal(runs[0].params[1], 'doc_1');
});

test('PUT /signature accepts raw base64 and never deletes a key outside doctor-signatures/', async () => {
  reset();
  const db = makeDb([[/SELECT signature_url FROM users/, { signature_url: 'uploads/legacy.png' }]]);
  const { res } = await drive({ method: 'put', route: '/signature', body: { data: PNG_1x1 }, db });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.del, []);
});

test('PUT /signature: garbage, non-image bytes, a lying mime and an empty body are INVALID_IMAGE', async () => {
  reset();
  for (const body of [
    { data: '' },
    { data: '!!!not-base64!!!' },
    { data: Buffer.from('hello world, not an image').toString('base64') },
    { data: 'data:image/gif;base64,' + PNG_1x1 },
    { data: 'data:image/jpeg;base64,' + PNG_1x1 },
  ]) {
    const { res } = await drive({ method: 'put', route: '/signature', body });
    assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(res._code, 'INVALID_IMAGE');
  }
  assert.equal(calls.upload.length, 0);
});

test('PUT /signature: over 2MB is 413 IMAGE_TOO_LARGE before any upload', async () => {
  reset();
  const big = Buffer.alloc(2 * 1024 * 1024 + 10, 1).toString('base64');
  const { res } = await drive({ method: 'put', route: '/signature', body: { data: 'data:image/png;base64,' + big } });
  assert.equal(res.statusCode, 413); assert.equal(res._code, 'IMAGE_TOO_LARGE');
  assert.equal(calls.upload.length, 0);
});

test('DELETE /signature mirrors the web remove handler', async () => {
  reset();
  const db = makeDb([[/SELECT signature_url FROM users/, { signature_url: 'doctor-signatures/doc_1/1.png' }]]);
  const { res, runs } = await drive({ method: 'delete', route: '/signature', db });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { ok: true });
  assert.deepEqual(calls.del, ['doctor-signatures/doc_1/1.png']);
  assert.match(runs[0].sql, /UPDATE users SET signature_url = NULL WHERE id = \$1/);
  assert.deepEqual(runs[0].params, ['doc_1']);
});

// ═══ Phrases ═══════════════════════════════════════════════════════════════
test('GET /phrases lists this doctor\'s phrases newest first in the app shape', async () => {
  const db = makeDb([[/FROM doctor_phrases WHERE doctor_id = \$1 ORDER BY created_at DESC/, [
    { id: 'phrase-1', text_en: 'No acute finding.', text_ar: null, category: 'mine', times_used: '3', created_at: '2026-09-01T00:00:00Z' },
  ]]]);
  const { res } = await drive({ method: 'get', route: '/phrases', db });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data.phrases, [{ id: 'phrase-1', text_en: 'No acute finding.', text_ar: null, category: 'mine', times_used: 3, created_at: '2026-09-01T00:00:00.000Z' }]);
});

test('POST /phrases inserts with a phrase-<uuid> id; empty text is EMPTY_PHRASE', async () => {
  let r = await drive({ method: 'post', route: '/phrases', body: { text_en: '   ' } });
  assert.equal(r.res.statusCode, 400); assert.equal(r.res._code, 'EMPTY_PHRASE');
  assert.equal(r.runs.length, 0);

  const db = makeDb([], () => ({ rowCount: 1, rows: [{ id: 'phrase-abc', text_en: 'Normal study.', text_ar: 'دراسة طبيعية', category: 'closing', times_used: 0, created_at: '2026-09-24T00:00:00Z' }] }));
  r = await drive({ method: 'post', route: '/phrases', body: { text_en: ' Normal study. ', text_ar: 'دراسة طبيعية', category: 'closing' }, db });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res._json.data.phrase.id, 'phrase-abc');
  assert.equal(r.res._json.data.phrase.times_used, 0);
  assert.match(r.runs[0].sql, /INSERT INTO doctor_phrases/);
  assert.match(r.runs[0].sql, /'phrase-' \|\| gen_random_uuid\(\)/);
  assert.deepEqual(r.runs[0].params, ['doc_1', 'Normal study.', 'دراسة طبيعية', 'closing']);
});

test('POST /phrases/:id/used bumps times_used only for the owner; someone else\'s phrase is 404', async () => {
  let db = makeDb([], { rowCount: 1 });
  let r = await drive({ method: 'post', route: '/phrases/:id/used', params: { id: 'phrase-1' }, db });
  assert.equal(r.res.statusCode, 200);
  assert.match(r.runs[0].sql, /times_used = times_used \+ 1/);
  assert.match(r.runs[0].sql, /WHERE id = \$1 AND doctor_id = \$2/);
  assert.deepEqual(r.runs[0].params, ['phrase-1', 'doc_1']);

  db = makeDb([], { rowCount: 0 });
  r = await drive({ method: 'post', route: '/phrases/:id/used', params: { id: 'phrase-of-someone-else' }, db });
  assert.equal(r.res.statusCode, 404); assert.equal(r.res._code, 'PHRASE_NOT_FOUND');
});

// ═══ Feedback / ops ticket / closure ═══════════════════════════════════════
const IDENTITY_RE = /SELECT id, name, email, lang FROM users/;
const identityDb = (runResult) => makeDb([[IDENTITY_RE, { id: 'doc_1', name: 'Dr. Mona', email: 'mona@example.com', lang: 'ar' }]], runResult);

test('POST /feedback writes contact_submissions (source doctor_app) and pushes an ops event', async () => {
  reset();
  const db = identityDb();
  const { res, runs } = await drive({
    method: 'post', route: '/feedback',
    body: { kind: 'bug', message: '  Report screen crashes on save  ', from_route: '/case/1/report', client: { app: '1.2.0', os: 'ios' } },
    db,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res._json.data.ok, true);
  assert.ok(res._json.data.id);
  assert.equal(runs.length, 1);
  assert.match(runs[0].sql, /INSERT INTO contact_submissions/);
  const p = runs[0].params;
  assert.equal(p[0], res._json.data.id);
  assert.equal(p[1], 'Dr. Mona');
  assert.equal(p[2], 'mona@example.com');
  assert.equal(p[3], 'Doctor app · bug');
  assert.ok(p[4].startsWith('Report screen crashes on save\n\n'));
  assert.deepEqual(JSON.parse(p[4].split('\n\n')[1]), { from_route: '/case/1/report', client: { app: '1.2.0', os: 'ios' }, doctor_id: 'doc_1' });
  assert.equal(p[5], 'new');
  assert.equal(p[6], 'doctor_app');
  assert.equal(p[7], 'ar');
  assert.equal(p[10], 'req_1');
  assert.equal(calls.push.length, 1);
  assert.equal(calls.push[0].kind, 'doctor_app_feedback');
  assert.equal(calls.push[0].dedupeKey, 'doctor_feedback:' + res._json.data.id);
});

test('POST /feedback: a push failure never fails the request; short message is EMPTY_MESSAGE', async () => {
  reset();
  pushShouldThrow = true;
  let r = await drive({ method: 'post', route: '/feedback', body: { kind: 'idea', message: 'Dark mode please' }, db: identityDb() });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res._json.data.ok, true);

  r = await drive({ method: 'post', route: '/feedback', body: { kind: 'idea', message: ' hi ' }, db: identityDb() });
  assert.equal(r.res.statusCode, 400); assert.equal(r.res._code, 'EMPTY_MESSAGE');
  assert.equal(r.runs.length, 0);

  const db = identityDb(() => { throw new Error('db down'); });
  r = await drive({ method: 'post', route: '/feedback', body: { kind: 'bug', message: 'It broke' }, db });
  assert.equal(r.res.statusCode, 500); assert.equal(r.res._code, 'FEEDBACK_SAVE_FAILED');
});

test('POST /ops-ticket writes source doctor_app_ops with an "Ops · " subject and notifies admins once', async () => {
  reset();
  const { res, runs } = await drive({ method: 'post', route: '/ops-ticket', body: { subject: 'Patient files unreadable', order_id: 'ord_9' }, db: identityDb() });
  assert.equal(res.statusCode, 200);
  assert.equal(res._json.data.ok, true);
  assert.equal(runs[0].params[3], 'Ops · Patient files unreadable');
  assert.equal(runs[0].params[6], 'doctor_app_ops');
  assert.match(runs[0].params[4], /"order_id":"ord_9"/);
  assert.equal(calls.notifyAdmins.length, 1);
  assert.equal(calls.notifyAdmins[0].template, 'admin_doctor_ops_ticket');
  assert.equal(calls.notifyAdmins[0].dedupeKey, 'ops_ticket:' + res._json.data.id);
  assert.equal(calls.notifyAdmins[0].orderId, 'ord_9');
  assert.equal(calls.notifyAdmins[0].payload.doctor_id, 'doc_1');

  const r2 = await drive({ method: 'post', route: '/ops-ticket', body: { subject: 'x' }, db: identityDb() });
  assert.equal(r2.res.statusCode, 400); assert.equal(r2.res._code, 'EMPTY_MESSAGE');
});

test('POST /account/closure records the request, logs account_deletion_request and mails privacy — deletes nothing', async () => {
  reset();
  const { res, runs } = await drive({ method: 'post', route: '/account/closure', body: { note: 'Moving abroad' }, db: identityDb() });
  assert.equal(res.statusCode, 200);
  assert.equal(res._json.data.ok, true);
  assert.equal(runs.length, 1);
  assert.match(runs[0].sql, /INSERT INTO contact_submissions/);
  assert.equal(runs[0].params[3], 'Account closure request');
  assert.equal(runs[0].params[6], 'doctor_app_closure');
  assert.equal(runs.some((r) => /DELETE|is_active|deactivat/i.test(r.sql)), false);
  assert.equal(calls.log.length, 1);
  assert.equal(calls.log[0].ctx.category, 'account_deletion_request');
  assert.equal(calls.log[0].ctx.userId, 'doc_1');
  assert.equal(calls.mail.length, 1);
  assert.equal(calls.mail[0].to, process.env.PRIVACY_NOTIFY_EMAIL || 'privacy@tashkheesa.com');
  assert.match(calls.mail[0].subject, /verify before acting/);
});

test('feedback, ops-ticket and closure all 404 when the doctor row is gone', async () => {
  for (const [route, body] of [['/feedback', { message: 'hello there' }], ['/ops-ticket', { subject: 'hello' }], ['/account/closure', {}]]) {
    const { res, runs } = await drive({ method: 'post', route, body });
    assert.equal(res.statusCode, 404, route); assert.equal(res._code, 'NOT_FOUND');
    assert.equal(runs.length, 0);
  }
});

// ═══ Notification prefs ════════════════════════════════════════════════════
test('notification-prefs is 501 NOT_SUPPORTED both ways', async () => {
  let r = await drive({ method: 'get', route: '/notification-prefs' });
  assert.equal(r.res.statusCode, 501); assert.equal(r.res._code, 'NOT_SUPPORTED');
  r = await drive({ method: 'put', route: '/notification-prefs', body: { key: 'x', on: true } });
  assert.equal(r.res.statusCode, 501); assert.equal(r.res._code, 'NOT_SUPPORTED');
});

// ═══ Router guards ═════════════════════════════════════════════════════════
test('the router keeps requireJWT + requireRole(doctor) in front of every route', () => {
  const router = buildRouter({}, makeDb().helpers);
  const mws = router.stack.filter((l) => !l.route).map((l) => l.handle.name);
  assert.equal(mws[0], 'requireJWT');
  assert.equal(router.stack.findIndex((l) => l.route) > 1, true);
});
