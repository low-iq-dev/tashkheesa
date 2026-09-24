// tests/core/api-doctor-cases.test.js
//
// /api/v1/doctor/{dashboard,cases,cases/:id/*} — the doctor app's case surface.
//
// The router is a second client onto the portal's own queue, so these tests
// pin the CONTRACT with the portal rather than SQL results:
//
//   1. The three audited actions RUN the portal's own Express handlers
//      (routes/doctor.js _actions) through a redirect-capturing shim, and
//      every redirect the handlers can end in maps to one stable HTTP code.
//      The ambiguous redirects (dashboard / bare case page) are settled by
//      re-reading the order row, never guessed.
//   2. Every post-accept read is gated by doctorHasAcceptedCase (assignment
//      is not acceptance) and refuses with the one 404 shape.
//   3. Pre-accept, the case detail carries the redacted brief and nothing
//      more: no patient name, history, medications, file names or prices.
//   4. The list/detail shapes the app is written against (SlaState, CaseRow,
//      OfferRow, RunningRow) come out exactly as documented.
//
// Hermetic: helpers {safeGet, safeAll} are fakes routed by SQL pattern; the
// doctor.js queue/actions/alerts and the earnings services are supplied
// through the router module's own `_deps` seam (routes/doctor.js cannot be
// required outside a booted server); persistReportText is stubbed by
// assigning onto the REAL report_submission module object.
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'doctor-cases-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const reportSubmission = require(path.join(__dirname, '../../src/services/report_submission'));
const buildRouter = require(path.join(__dirname, '../../src/routes/api/doctor_cases'));
const { CASE_ACCEPTED_STATUSES, CASE_UNACCEPTED_STATUSES } =
  require(path.join(__dirname, '../../src/services/doctor_case_access'));

// ── fixtures ──────────────────────────────────────────────────
const ME = 'doc-1';
const OTHER = 'doc-2';
const NOW = Date.now();
const iso = (deltaMs) => new Date(NOW + deltaMs).toISOString();
const H = 3600 * 1000;

const DOCTOR = {
  id: ME, role: 'doctor', specialty_id: 'spec-1', is_active: true, onboarding_complete: true,
  sla_tiers_supported: ['standard', 'vip', 'urgent'], max_active_cases: 5, max_active_cases_urgent: 2,
  is_paused: false, paused_at: null, pause_reason: null, pending_approval: false,
  rejection_reason: null, approved_at: '2025-01-01T00:00:00Z', name: 'Dr Mona', name_ar: 'د. منى',
  lang: 'en', email: 'mona@example.com', profile_photo_url: 'r2://photos/mona.jpg', signature_url: null,
  is_available: true,
};

function order(over) {
  return {
    id: 'ord-1', reference_id: 'TSH-2026-000123', patient_id: 'pat-1', doctor_id: ME, specialty_id: 'spec-1',
    service_id: 'svc-1', status: 'in_review', payment_status: 'paid', urgency_tier: 'vip', sla_hours: 18,
    language: 'ar', price: 1500, doctor_fee: 700, base_price: 1200, urgency_uplift_amount: 300,
    created_at: iso(-30 * H), updated_at: iso(-1 * H), accepted_at: iso(-2 * H), deadline_at: iso(16 * H),
    completed_at: null, breached_at: null, sla_paused_at: null, sla_remaining_seconds: null,
    acceptance_deadline_at: null, broadcast_sent_at: null, intelligence_status: 'ready',
    clinical_question: 'Is this a Bankart lesion?', medical_history: 'Shoulder dislocation 2024',
    current_medications: 'Ibuprofen', diagnosis_text: '', impression_text: '', recommendation_text: '',
    ...over,
  };
}

// ── fake helpers: route SQL by pattern ────────────────────────
// Each route is [regex, value | (params) => value]. First match wins; no
// match returns the caller's fallback, like the real safeGet/safeAll do.
function makeHelpers(routes) {
  const calls = [];
  const pick = (sql, params, fallback) => {
    for (const [re, v] of routes) {
      if (re.test(sql)) return typeof v === 'function' ? v(params, sql) : v;
    }
    return fallback;
  };
  return {
    calls,
    safeGet: async (sql, params, fallback = null) => { calls.push(['get', sql, params]); return pick(sql, params, fallback); },
    safeAll: async (sql, params, fallback = []) => { calls.push(['all', sql, params]); return pick(sql, params, fallback); },
    safeRun: async (sql, params) => { calls.push(['run', sql, params]); return { rowCount: 1 }; },
  };
}

const USERS_RE = /FROM users WHERE id = \$1/;
const ORDER_RE = /SELECT \* FROM orders_active WHERE id = \$1/;
const CTX_RE = /sv\.urgency_uplift_doctor_pct[\s\S]*FROM orders_active o/;
const META_RE = /WHERE o\.id = ANY\(\$1\)/;
const ASSIGNED_PENDING_RE = /COALESCE\(o\.accepted_at::text, ''\) = ''/;
const ASSIGNMENTS_RE = /FROM doctor_assignments/;
const UNREAD_RE = /FROM messages m[\s\S]*JOIN conversations c/;
const FILES_RE = /FROM order_files WHERE order_id = \$1 ORDER BY created_at ASC/;
const FLAGGED_FILES_RE = /ai_quality_status, ''\)\) = ANY\(\$2\)/;
const ADDL_RE = /FROM order_additional_files WHERE order_id = \$1/;
const CONVERSATION_RE = /SELECT id FROM conversations WHERE order_id/;
const EXTRACTION_RE = /FROM case_extractions/;
const RECORDS_COUNT_RE = /COUNT\(\*\) AS c FROM medical_records/;
const RECORDS_RE = /SELECT id, record_type, title[\s\S]*FROM medical_records/;
const EVENTS_RE = /FROM order_events WHERE order_id/;
const FILE_BY_ID_RE = /FROM order_files WHERE id = \$1 AND order_id = \$2/;
const ADDL_BY_ID_RE = /FROM order_additional_files WHERE id = \$1 AND order_id = \$2/;

// ── the portal seams, through _deps ───────────────────────────
function makeQueue(over) {
  return {
    ACCEPTED_STATUSES: CASE_ACCEPTED_STATUSES,
    UNACCEPTED_STATUSES: CASE_UNACCEPTED_STATUSES,
    DOCTOR_DECLINE_REASONS: ['unavailable', 'wrong_subspecialty', 'conflict_of_interest', 'workload', 'other'],
    enrichOrders: (rows) => rows.map((r) => ({ ...r, db_status: r.status })),
    mapPortalCaseItem: (o) => ({ ...o }),
    stripPricingFields(o) {
      const c = { ...o };
      delete c.price; delete c.doctor_fee; delete c.locked_price; delete c.locked_currency; delete c.price_snapshot_json;
      return c;
    },
    readDoctorSlaTiersRaw: async () => ['standard', 'vip'],
    countAssignedPendingCases: async () => 1,
    countPortalCasesUnassigned: async () => 2,
    countPortalCasesByStatuses: async () => 3,
    countActiveCasesForDoctor: async () => 1,
    buildPortalCasesUnassigned: async () => [],
    buildPortalCases: async () => [],
    getAdditionalFilesRequestState: async () => ({ state: 'none', requestedAt: null }),
    ...over,
  };
}

const deps = buildRouter._deps;
const realDeps = { ...deps };
test.after(() => { Object.assign(deps, realDeps); });

function install({ queue, actions, alerts, earnings, earningsWriter } = {}) {
  deps.queue = () => queue || makeQueue();
  deps.actions = () => actions || {};
  deps.alerts = () => alerts || { countDoctorUnseenNotifications: async () => 0 };
  deps.earnings = () => earnings || { getDoctorMonthSummary: async () => ({ total: 0 }) };
  deps.earningsWriter = () => earningsWriter || { previewCaseEarnings: async () => ({ baseShare: 600, upliftShare: 90, total: 690 }) };
}

// ── driving a handler ─────────────────────────────────────────
function handlerFor(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      const st = layer.route.stack;
      return st[st.length - 1].handle;
    }
  }
  throw new Error(method.toUpperCase() + ' ' + routePath + ' not registered');
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

async function drive(method, routePath, { helpers, params = {}, query = {}, body = {}, user } = {}) {
  const router = buildRouter({}, helpers || makeHelpers([]));
  const req = {
    params, query, body, headers: {}, requestId: 'req-1', originalUrl: '/api/v1/doctor' + routePath,
    user: user === undefined ? { id: ME, role: 'doctor', name: 'Dr Mona' } : user,
  };
  const res = mockRes();
  await handlerFor(router, method, routePath)(req, res);
  return res;
}

const data = (res) => res._json && res._json.data;

// ═══════════════════════════════════════════════════════════════
// Pure helpers
// ═══════════════════════════════════════════════════════════════

test('SlaState: tier from urgency_tier (legacy spellings folded), paused banks the remainder, breach from row or clock', () => {
  const { slaStateOf } = buildRouter._helpers;
  const live = slaStateOf(order({ urgency_tier: 'fast_track' }));
  assert.deepEqual(live, {
    tier: 'vip', accepted_at: iso(-2 * H), deadline_at: iso(16 * H), paused: false, remaining_seconds: null, breached: false,
  });
  const paused = slaStateOf(order({ sla_paused_at: iso(-1 * H), sla_remaining_seconds: 5400, deadline_at: iso(-3 * H), status: 'rejected_files' }));
  assert.equal(paused.paused, true);
  assert.equal(paused.remaining_seconds, 5400);
  assert.equal(paused.breached, false, 'a paused clock is never overdue, even with a stale past deadline');
  assert.equal(slaStateOf(order({ deadline_at: iso(-1 * H) })).breached, true, 'deadline passed on an open case');
  assert.equal(slaStateOf(order({ deadline_at: iso(-1 * H), completed_at: iso(-2 * H) })).breached, false, 'completed is not breached');
  assert.equal(slaStateOf(order({ breached_at: iso(-1 * H), deadline_at: iso(5 * H) })).breached, true);
  assert.equal(slaStateOf(order({ status: 'breached', db_status: 'sla_breach' })).breached, true);
  assert.equal(slaStateOf(order({ urgency_tier: null })).tier, 'standard');
  // list rows carry the effective status in `status` and the DB one in db_status
  assert.equal(slaStateOf(order({ status: 'breached', db_status: 'refunded', deadline_at: iso(-1 * H) })).breached, true);
});

test('status_label priority: offer > refunded > completed > breached > awaiting_files > drafting > accepted', () => {
  const { statusLabelOf } = buildRouter._helpers;
  assert.equal(statusLabelOf(order(), true), 'offer');
  assert.equal(statusLabelOf(order({ status: 'refunded', deadline_at: iso(-1 * H) }), false), 'refunded');
  assert.equal(statusLabelOf(order({ status: 'breached', db_status: 'canceled' }), false), 'refunded');
  assert.equal(statusLabelOf(order({ status: 'completed', completed_at: iso(-1 * H), deadline_at: iso(-2 * H) }), false), 'completed');
  assert.equal(statusLabelOf(order({ deadline_at: iso(-1 * H), sla_paused_at: null }), false), 'breached');
  assert.equal(statusLabelOf(order({ status: 'rejected_files', sla_paused_at: iso(-1 * H) }), false), 'awaiting_files');
  assert.equal(statusLabelOf(order({ diagnosis_text: 'Tear seen' }), false), 'drafting');
  assert.equal(statusLabelOf(order(), false), 'accepted');
});

test('pool accept_by_at: the broadcast deadline when written, derived from broadcast_sent_at otherwise, null when never broadcast', () => {
  const { poolAcceptBy } = buildRouter._helpers;
  assert.equal(poolAcceptBy(order({ acceptance_deadline_at: iso(1 * H) })), iso(1 * H));
  const sent = iso(-10 * 60 * 1000);
  assert.equal(poolAcceptBy(order({ urgency_tier: 'urgent', broadcast_sent_at: sent })), new Date(Date.parse(sent) + 15 * 60 * 1000).toISOString());
  assert.equal(poolAcceptBy(order({ urgency_tier: 'standard' })), null);
});

// ═══════════════════════════════════════════════════════════════
// GET /dashboard
// ═══════════════════════════════════════════════════════════════

test('GET /dashboard: doctor, stats from the queue counters + month total, offers (both arms), running rows, unread', async () => {
  const assigned = order({ id: 'ord-a', reference_id: 'TSH-A', status: 'assigned', accepted_at: null, deadline_at: null, acceptance_deadline_at: iso(3 * H), urgency_tier: 'urgent' });
  const pool = order({ id: 'ord-p', reference_id: 'TSH-P', doctor_id: null, status: 'paid', accepted_at: null, deadline_at: null, acceptance_deadline_at: iso(2 * H), urgency_tier: 'standard', db_status: 'paid' });
  const running1 = order({ id: 'ord-r1', reference_id: 'TSH-R1', diagnosis_text: 'draft', db_status: 'in_review' });
  const running2 = order({ id: 'ord-r2', reference_id: 'TSH-R2', status: 'paused', db_status: 'rejected_files', sla_paused_at: iso(-1 * H), sla_remaining_seconds: 600 });
  const fees = [];
  install({
    queue: makeQueue({
      buildPortalCasesUnassigned: async () => [pool],
      buildPortalCases: async (doctorId, statuses) => { assert.equal(doctorId, ME); assert.deepEqual(statuses, CASE_ACCEPTED_STATUSES); return [running1, running2]; },
    }),
    earnings: { getDoctorMonthSummary: async (id) => { assert.equal(id, ME); return { approved: 1000, notYetApproved: 250, total: 1250 }; } },
    earningsWriter: { previewCaseEarnings: async (id) => { fees.push(id); return id === 'ord-p' ? null : { baseShare: 500, upliftShare: 100, total: 600 }; } },
    alerts: { countDoctorUnseenNotifications: async (id, email) => { assert.equal(email, 'mona@example.com'); return 4; } },
  });
  const helpers = makeHelpers([
    [USERS_RE, DOCTOR],
    [ASSIGNED_PENDING_RE, [assigned]],
    [ASSIGNMENTS_RE, [{ case_id: 'ord-a', accept_by_at: iso(1 * H) }]],
    [META_RE, (p) => p[0].map((id) => ({ id, language: 'en', patient_dob: '1990-01-01', patient_gender: 'male', service_name: 'MRI review', service_name_ar: 'مراجعة رنين', service_sla_hours: 18, files_count: 3, rating: null }))],
    [UNREAD_RE, [{ order_id: 'ord-r1', unread: 2 }, { order_id: 'ord-r2', unread: 1 }]],
  ]);
  const res = await drive('get', '/dashboard', { helpers, query: { lang: 'en' } });
  assert.equal(res.statusCode, 200);
  const d = data(res);
  assert.deepEqual(d.doctor, { id: ME, name: 'Dr Mona', name_ar: 'د. منى', photo_url: 'r2://photos/mona.jpg', taking_cases: true });
  assert.deepEqual(d.stats, { to_accept: 3, in_progress: 3, month_egp: 1250 });
  assert.equal(d.offers.length, 2);
  const [oa, op] = d.offers;
  assert.deepEqual(Object.keys(oa).sort(), ['accept_by_at', 'fee_total', 'files_count', 'order_id', 'patient_age', 'patient_sex', 'reference_id', 'report_language', 'service_name', 'service_name_ar', 'sla_hours', 'tier'].sort());
  assert.equal(oa.order_id, 'ord-a');
  assert.equal(oa.tier, 'urgent');
  assert.equal(oa.accept_by_at, iso(1 * H), 'assigned offer: doctor_assignments.accept_by_at wins over the order column');
  assert.equal(oa.fee_total, 600);
  assert.equal(oa.patient_sex, 'male');
  assert.equal(typeof oa.patient_age, 'number');
  assert.equal(oa.files_count, 3);
  assert.equal(oa.service_name_ar, 'مراجعة رنين');
  assert.equal(op.order_id, 'ord-p');
  assert.equal(op.accept_by_at, iso(2 * H), 'pool offer: orders.acceptance_deadline_at');
  assert.equal(op.fee_total, null, 'no fee snapshot → null, never a guess');
  assert.ok(!('_order' in op) && !('clinical_question' in op) && !('price' in op));
  assert.deepEqual(fees.sort(), ['ord-a', 'ord-p']);
  assert.equal(d.running.length, 2);
  assert.deepEqual(d.running[0], {
    order_id: 'ord-r1', reference_id: 'TSH-R1', status: 'in_review',
    sla: { tier: 'vip', accepted_at: iso(-2 * H), deadline_at: iso(16 * H), paused: false, remaining_seconds: null, breached: false },
    has_draft: true, awaiting_files: false, unread_messages: 2,
  });
  assert.equal(d.running[1].awaiting_files, true);
  assert.equal(d.running[1].sla.paused, true);
  assert.equal(d.running[1].sla.remaining_seconds, 600);
  assert.equal(d.running[1].status, 'rejected_files', 'the stored status, not computeSla\'s effective one');
  assert.equal(d.unread_alerts, 4);
  assert.equal(d.unread_messages, 3);
});

test('GET /dashboard: unknown doctor → 404 NOT_FOUND; a paused doctor reads taking_cases=false and a failed money read reads null', async () => {
  install();
  let res = await drive('get', '/dashboard', { helpers: makeHelpers([[USERS_RE, null]]) });
  assert.equal(res.statusCode, 404);
  assert.equal(res._code, 'NOT_FOUND');
  install({ earnings: { getDoctorMonthSummary: async () => { throw new Error('db down'); } } });
  res = await drive('get', '/dashboard', { helpers: makeHelpers([[USERS_RE, { ...DOCTOR, is_paused: true }]]) });
  assert.equal(res.statusCode, 200);
  assert.equal(data(res).doctor.taking_cases, false);
  assert.equal(data(res).stats.month_egp, null);
  assert.deepEqual(data(res).offers, []);
});

// ═══════════════════════════════════════════════════════════════
// GET /cases
// ═══════════════════════════════════════════════════════════════

test('GET /cases?tab=open: offers first by accept_by_at, then running by deadline, CaseRow shape, awaiting excluded', async () => {
  const assigned = order({ id: 'ord-a', status: 'assigned', accepted_at: null, deadline_at: null, acceptance_deadline_at: iso(3 * H) });
  const pool = order({ id: 'ord-p', doctor_id: null, status: 'paid', accepted_at: null, deadline_at: null, acceptance_deadline_at: iso(1 * H), db_status: 'paid' });
  const late = order({ id: 'ord-late', deadline_at: iso(20 * H), db_status: 'in_review' });
  const soon = order({ id: 'ord-soon', deadline_at: iso(2 * H), diagnosis_text: 'x', db_status: 'in_review' });
  const seen = [];
  install({
    queue: makeQueue({
      buildPortalCasesUnassigned: async () => [pool],
      buildPortalCases: async (doctorId, statuses) => { seen.push(statuses); return [late, soon]; },
    }),
  });
  const helpers = makeHelpers([
    [USERS_RE, DOCTOR],
    [ASSIGNED_PENDING_RE, [assigned]],
    [META_RE, (p) => p[0].map((id) => ({ id, language: 'ar', patient_dob: '1980-06-15', patient_gender: 'female', service_name: 'X', service_name_ar: 'س', files_count: 2, rating: null }))],
    [UNREAD_RE, [{ order_id: 'ord-soon', unread: 5 }]],
  ]);
  const res = await drive('get', '/cases', { helpers, query: { tab: 'open' } });
  assert.equal(res.statusCode, 200);
  assert.equal(data(res).tab, 'open');
  const rows = data(res).cases;
  assert.deepEqual(rows.map((r) => r.id), ['ord-p', 'ord-a', 'ord-soon', 'ord-late']);
  assert.deepEqual(rows.map((r) => r.status_label), ['offer', 'offer', 'drafting', 'accepted']);
  assert.deepEqual(Object.keys(rows[2]).sort(), [
    'accept_by_at', 'completed_at', 'files_count', 'id', 'patient_age', 'patient_sex', 'rating', 'reference_id', 'refunded',
    'report_language', 'service_name', 'service_name_ar', 'sla', 'status', 'status_label', 'unread_messages',
  ].sort());
  assert.equal(rows[2].unread_messages, 5);
  assert.equal(rows[0].accept_by_at, iso(1 * H));
  assert.equal(rows[2].accept_by_at, null);
  assert.equal(rows[2].patient_sex, 'female');
  assert.equal(rows[2].report_language, 'ar');
  assert.ok(!seen[0].includes('rejected_files') && !seen[0].includes('awaiting_files'), 'open excludes the awaiting statuses');
});

test('GET /cases?tab=done: completed and refunded/cancelled spellings from case_lifecycle, newest completion first, rating carried', async () => {
  const done1 = order({ id: 'ord-d1', status: 'completed', db_status: 'completed', completed_at: iso(-5 * H), deadline_at: iso(-6 * H) });
  const done2 = order({ id: 'ord-d2', status: 'completed', db_status: 'done', completed_at: iso(-1 * H) });
  const refunded = order({ id: 'ord-rf', status: 'breached', db_status: 'canceled', completed_at: null, deadline_at: iso(-2 * H) });
  let wanted = null;
  install({ queue: makeQueue({ buildPortalCases: async (id, statuses) => { wanted = statuses; return [done1, refunded, done2]; } }) });
  const helpers = makeHelpers([
    [META_RE, (p) => p[0].map((id) => ({ id, language: 'en', patient_dob: null, patient_gender: null, service_name: 'X', service_name_ar: null, files_count: 1, rating: id === 'ord-d2' ? 5 : null }))],
  ]);
  const res = await drive('get', '/cases', { helpers, query: { tab: 'done' } });
  const rows = data(res).cases;
  for (const s of ['completed', 'done', 'finished', 'refunded', 'cancelled', 'canceled']) assert.ok(wanted.includes(s), 'done tab asks for ' + s);
  assert.deepEqual(rows.map((r) => r.id), ['ord-d2', 'ord-d1', 'ord-rf']);
  assert.deepEqual(rows.map((r) => r.status_label), ['completed', 'completed', 'refunded']);
  assert.equal(rows[0].rating, 5);
  assert.equal(rows[0].completed_at, iso(-1 * H));
  assert.equal(rows[2].refunded, true);
  assert.equal(rows[2].sla.breached, true, 'SlaState is the raw clock; the label is what says refunded');
});

test('GET /cases?tab=awaiting labels paused cases; an unknown tab falls back to open', async () => {
  const waiting = order({ id: 'ord-w', status: 'paused', db_status: 'rejected_files', sla_paused_at: iso(-1 * H), sla_remaining_seconds: 100 });
  install({ queue: makeQueue({ buildPortalCases: async (id, statuses) => { assert.deepEqual(statuses, ['awaiting_files', 'rejected_files']); return [waiting]; } }) });
  let res = await drive('get', '/cases', { helpers: makeHelpers([]), query: { tab: 'awaiting' } });
  assert.deepEqual(data(res).cases.map((r) => r.status_label), ['awaiting_files']);
  install({ queue: makeQueue({ buildPortalCases: async () => [] }) });
  res = await drive('get', '/cases', { helpers: makeHelpers([[USERS_RE, DOCTOR]]), query: { tab: 'bogus' } });
  assert.equal(data(res).tab, 'open');
});

test('GET /cases?status=completed keeps the original portal-row shape for existing clients', async () => {
  const rowOut = order({ id: 'ord-old' });
  install({ queue: makeQueue({
    buildPortalCases: async (id, statuses) => { assert.deepEqual(statuses, ['completed']); return [rowOut]; },
    countPortalCasesByStatuses: async () => 7,
  }) });
  const res = await drive('get', '/cases', { helpers: makeHelpers([]), query: { status: 'completed' } });
  assert.deepEqual(data(res), { cases: [rowOut], total: 7, status: 'completed' });
});

// ═══════════════════════════════════════════════════════════════
// GET /cases/:id
// ═══════════════════════════════════════════════════════════════

function detailHelpers(theOrder, over = []) {
  return makeHelpers([
    ...over,
    [USERS_RE, DOCTOR],
    [ORDER_RE, theOrder],
    [CTX_RE, { service_name: 'MRI shoulder review', service_name_ar: 'مراجعة رنين كتف', service_sla_hours: 18, urgency_uplift_doctor_pct: 40, patient_name: 'Ahmed Hassan', patient_dob: '1992-03-04', patient_gender: 'male' }],
    [ASSIGNMENTS_RE, []],
    [FILES_RE, [
      { id: 'f1', url: 'r2/a.jpg', filename: 'Ahmed Hassan MRI.jpg', label: null, mime_type: 'image/jpeg', size: 1000, created_at: iso(-20 * H), ai_quality_status: 'poor_quality', ai_quality_note: 'blurry' },
      { id: 'f2', url: 'r2/b.pdf', filename: 'report.pdf', label: 'Lab report', mime_type: 'application/pdf', size: 2000, created_at: iso(-1 * H), ai_quality_status: 'ok', ai_quality_note: null },
    ]],
    [ADDL_RE, [{ id: 'af1', label: 'Old X-ray', uploaded_at: iso(-30 * 60 * 1000) }]],
    [CONVERSATION_RE, { id: 'conv-9' }],
    [UNREAD_RE, [{ order_id: 'ord-1', unread: 2 }]],
    [EXTRACTION_RE, { documents_inventory: [{ filename: 'a' }, { filename: 'b' }], lab_values: '[{"test":"Hb"}]', missing_documents: ['No imaging reports (X-ray, CT, MRI, ultrasound)'], updated_at: iso(-1 * H) }],
    [RECORDS_COUNT_RE, { c: '3' }],
  ]);
}

test('GET /cases/:id FULL: keeps access/case/files and adds the enrichment; prices stripped; identity on patient only', async () => {
  install({ queue: makeQueue({ getAdditionalFilesRequestState: async () => ({ state: 'pending', requestedAt: iso(-2 * H) }) }) });
  const res = await drive('get', '/cases/:id', { helpers: detailHelpers(order()), params: { id: 'ord-1' } });
  assert.equal(res.statusCode, 200);
  const d = data(res);
  assert.equal(d.access, 'full');
  assert.equal(d.reference_id, 'TSH-2026-000123');
  assert.ok(!('price' in d.case) && !('doctor_fee' in d.case), 'the patient\'s price never reaches a doctor response');
  assert.ok(!('patient_name' in d.case) && !('name' in d.case));
  assert.equal(d.case.clinical_question, 'Is this a Bankart lesion?');
  assert.deepEqual(d.sla, { tier: 'vip', accepted_at: iso(-2 * H), deadline_at: iso(16 * H), paused: false, remaining_seconds: null, breached: false });
  assert.deepEqual(d.service, { name: 'MRI shoulder review', name_ar: 'مراجعة رنين كتف', sla_hours: 18 });
  assert.deepEqual(d.assignment, { accept_by_at: null });
  assert.deepEqual(d.fee, { service_fee: 600, uplift_share: 90, uplift_pct: 40, total: 690 });
  assert.deepEqual(d.patient, { age: reportSubmission.computeAgeFromDob('1992-03-04'), sex: 'male', report_language: 'ar', name: 'Ahmed Hassan', history: 'Shoulder dislocation 2024', medications: 'Ibuprofen' });
  assert.equal(d.conversation_id, 'conv-9');
  assert.equal(d.unread_messages, 2);
  assert.deepEqual(d.intelligence, { ready: true, documents_count: 2, lab_values_count: 1, missing_count: 1 });
  assert.equal(d.shared_records_count, 3);
  assert.equal(d.files.length, 3);
  const [f1, f2, af1] = d.files;
  assert.deepEqual(f1, {
    id: 'f1', source: 'order_files', name: 'Ahmed Hassan MRI.jpg', label: 'Ahmed Hassan MRI.jpg', filename: 'Ahmed Hassan MRI.jpg',
    mime_type: 'image/jpeg', size: 1000, url: '/files/f1', created_at: iso(-20 * H), quality_flag: 'poor_quality', quality_note: 'blurry', added_after_request: false,
  });
  assert.equal(f2.added_after_request, true, 'uploaded after the request went out');
  assert.equal(f2.quality_flag, 'ok');
  assert.deepEqual(af1, {
    id: 'af1', source: 'order_additional_files', name: 'Old X-ray', label: 'Old X-ray', filename: null, mime_type: null, size: null,
    url: '/files/af1', created_at: iso(-30 * 60 * 1000), quality_flag: null, quality_note: null, added_after_request: true,
  });
});

test('GET /cases/:id OFFER: the redacted brief only — no name, history, medications, file names, prices or conversation', async () => {
  install();
  const offered = order({ status: 'assigned', accepted_at: null, deadline_at: null, acceptance_deadline_at: iso(1 * H) });
  const helpers = detailHelpers(offered, [[ASSIGNMENTS_RE, [{ case_id: 'ord-1', accept_by_at: iso(2 * H) }]]]);
  const res = await drive('get', '/cases/:id', { helpers, params: { id: 'ord-1' } });
  assert.equal(res.statusCode, 200);
  const d = data(res);
  assert.equal(d.access, 'offer');
  for (const k of ['price', 'doctor_fee', 'medical_history', 'current_medications', 'clinical_question', 'diagnosis_text', 'patient_name']) {
    assert.ok(!(k in d.case), 'pre-accept case row must not carry ' + k);
  }
  assert.deepEqual(d.files, [{ id: 'f1', name: 'file.jpg' }, { id: 'f2', name: 'file' }], 'kind only, never a name (f2 is labelled without an extension)');
  assert.deepEqual(d.patient, { age: reportSubmission.computeAgeFromDob('1992-03-04'), sex: 'male', report_language: 'ar', name: null, history: null, medications: null });
  assert.equal(d.conversation_id, null);
  assert.equal(d.unread_messages, 0);
  assert.equal(d.shared_records_count, 0);
  assert.deepEqual(d.intelligence, { ready: true, documents_count: null, lab_values_count: null, missing_count: null });
  assert.equal(d.assignment.accept_by_at, iso(2 * H));
  assert.equal(d.fee.total, 690, 'the fee is part of the brief');
  assert.equal(d.sla.tier, 'vip');
  const queried = helpers.calls.map((c) => c[1]);
  assert.ok(!queried.some((s) => EXTRACTION_RE.test(s)), 'extractions are not read pre-accept');
  assert.ok(!queried.some((s) => RECORDS_COUNT_RE.test(s)), 'shared records are not read pre-accept');
});

test('GET /cases/:id: someone else\'s case, a missing case and a missing doctor row are the same 404', async () => {
  install();
  let res = await drive('get', '/cases/:id', { helpers: detailHelpers(order({ doctor_id: OTHER })), params: { id: 'ord-1' } });
  assert.equal(res.statusCode, 404); assert.equal(res._code, 'CASE_NOT_AVAILABLE');
  res = await drive('get', '/cases/:id', { helpers: detailHelpers(null), params: { id: 'ord-x' } });
  assert.equal(res.statusCode, 404); assert.equal(res._code, 'CASE_NOT_AVAILABLE');
  res = await drive('get', '/cases/:id', { helpers: makeHelpers([[USERS_RE, null], [ORDER_RE, order()]]), params: { id: 'ord-1' } });
  assert.equal(res.statusCode, 404); assert.equal(res._code, 'CASE_NOT_AVAILABLE');
});

// ═══════════════════════════════════════════════════════════════
// The FULL-only reads: draft, intelligence, records, timeline, suggestions
// ═══════════════════════════════════════════════════════════════

const FULL_ONLY = [
  ['get', '/cases/:id/draft'],
  ['get', '/cases/:id/intelligence'],
  ['get', '/cases/:id/records'],
  ['get', '/cases/:id/timeline'],
  ['get', '/cases/:id/file-suggestions'],
  ['put', '/cases/:id/draft'],
  ['post', '/cases/:id/request-files'],
  ['post', '/cases/:id/reject-file'],
];

test('every post-accept route refuses an ASSIGNED-not-accepted case, another doctor\'s case and a missing case with 404 CASE_NOT_AVAILABLE', async () => {
  install();
  const shapes = [
    order({ status: 'assigned', accepted_at: null }),   // offered, not accepted — assignment is not acceptance
    order({ doctor_id: OTHER }),
    null,
  ];
  for (const [method, routePath] of FULL_ONLY) {
    for (const o of shapes) {
      const res = await drive(method, routePath, { helpers: makeHelpers([[ORDER_RE, o]]), params: { id: 'ord-1' }, body: { items: ['std:bloods'], file_id: 'f1', reason: 'x', findings: 'y' } });
      assert.equal(res.statusCode, 404, method + ' ' + routePath);
      assert.equal(res._code, 'CASE_NOT_AVAILABLE', method + ' ' + routePath);
    }
  }
});

test('GET /cases/:id/draft splits the saved report the way the web editor does and reports updated_at as saved_at', async () => {
  install();
  const o = order({ diagnosis_text: 'Findings:\nTear\n\nImpression:\nBankart\n\nRecommendations:\nRepair', impression_text: '', recommendation_text: '' });
  const res = await drive('get', '/cases/:id/draft', { helpers: makeHelpers([[ORDER_RE, o]]), params: { id: 'ord-1' } });
  assert.equal(res.statusCode, 200);
  // Migration 117: the Arabic half reads '' / false on a row without it.
  const noAr = { findings_ar: '', impression_ar: '', recommendation_ar: '', arabic_approved: false };
  assert.deepEqual(data(res), { order_id: 'ord-1', findings: 'Tear', impression: 'Bankart', recommendation: 'Repair', ...noAr, saved_at: iso(-1 * H) });
  // a completed case still reads its draft
  const done = await drive('get', '/cases/:id/draft', { helpers: makeHelpers([[ORDER_RE, order({ status: 'completed', diagnosis_text: 'A', impression_text: 'B', recommendation_text: 'C' })]]), params: { id: 'ord-1' } });
  assert.deepEqual(data(done), { order_id: 'ord-1', findings: 'A', impression: 'B', recommendation: 'C', ...noAr, saved_at: iso(-1 * H) });
});

test('PUT /cases/:id/draft: partial overlay through persistReportText; completed → 409 CASE_COMPLETED; refused write → 409 CASE_NOT_OPEN; throw → 500', async () => {
  install();
  const real = reportSubmission.persistReportText;
  let persisted = null;
  let result = 1;
  reportSubmission.persistReportText = async (args) => { persisted = args; if (result instanceof Error) throw result; return result; };
  try {
    const o = order({ diagnosis_text: 'Old findings', impression_text: 'Old impression', recommendation_text: 'Old recs' });
    let res = await drive('put', '/cases/:id/draft', { helpers: makeHelpers([[ORDER_RE, o]]), params: { id: 'ord-1' }, body: { impression: 'New impression' } });
    assert.equal(res.statusCode, 200);
    assert.ok(Date.parse(data(res).saved_at) > 0);
    assert.deepEqual(persisted, { orderId: 'ord-1', diagnosisText: 'Old findings', impressionText: 'New impression', recommendationsText: 'Old recs' });

    persisted = null;
    res = await drive('put', '/cases/:id/draft', { helpers: makeHelpers([[ORDER_RE, order({ completed_at: iso(-1 * H), status: 'completed' })]]), params: { id: 'ord-1' }, body: { findings: 'x' } });
    assert.equal(res.statusCode, 409); assert.equal(res._code, 'CASE_COMPLETED');
    assert.equal(persisted, null, 'no write on a completed case');

    result = 0;
    res = await drive('put', '/cases/:id/draft', { helpers: makeHelpers([[ORDER_RE, o]]), params: { id: 'ord-1' }, body: { findings: 'x' } });
    assert.equal(res.statusCode, 409); assert.equal(res._code, 'CASE_NOT_OPEN');

    result = new Error('boom');
    res = await drive('put', '/cases/:id/draft', { helpers: makeHelpers([[ORDER_RE, o]]), params: { id: 'ord-1' }, body: { findings: 'x' } });
    assert.equal(res.statusCode, 500); assert.equal(res._code, 'DRAFT_SAVE_FAILED');

    result = 1; persisted = null;
    res = await drive('put', '/cases/:id/draft', { helpers: makeHelpers([[ORDER_RE, o]]), params: { id: 'ord-1' }, body: { findings: 42 } });
    assert.equal(res.statusCode, 400); assert.equal(res._code, 'INVALID_REQUEST');
    assert.equal(persisted, null);
  } finally {
    reportSubmission.persistReportText = real;
  }
});

test('GET /cases/:id/intelligence returns the raw extractions and the order\'s intelligence_status', async () => {
  install();
  const helpers = makeHelpers([
    [ORDER_RE, order({ intelligence_status: 'ready' })],
    [EXTRACTION_RE, { lab_values: [{ test: 'Hb', value: '11', unit: 'g/dL' }], patient_info: '{"name":"Ahmed"}', documents_inventory: [{ filename: 'a.pdf' }], missing_documents: ['No imaging reports (X-ray, CT, MRI, ultrasound)'], updated_at: iso(-1 * H) }],
  ]);
  const res = await drive('get', '/cases/:id/intelligence', { helpers, params: { id: 'ord-1' } });
  assert.deepEqual(data(res), {
    status: 'ready', updated_at: iso(-1 * H),
    documents: [{ filename: 'a.pdf' }], lab_values: [{ test: 'Hb', value: '11', unit: 'g/dL' }],
    missing_documents: ['No imaging reports (X-ray, CT, MRI, ultrasound)'], patient_info: { name: 'Ahmed' },
  });
  const none = await drive('get', '/cases/:id/intelligence', { helpers: makeHelpers([[ORDER_RE, order({ intelligence_status: null })]]), params: { id: 'ord-1' } });
  assert.deepEqual(data(none), { status: 'none', updated_at: null, documents: [], lab_values: [], missing_documents: [], patient_info: null });
});

test('GET /cases/:id/records mirrors the web patient-records JSON (shared, not hidden, this patient)', async () => {
  install();
  let params = null;
  const helpers = makeHelpers([
    [ORDER_RE, order()],
    [RECORDS_RE, (p) => { params = p; return [{ id: 'rec-1', record_type: 'lab', title: 'CBC', description: null, file_url: 'r2/cbc.pdf', file_name: 'cbc.pdf', date_of_record: '2026-01-02', provider: 'Alfa Lab', tags: '["cbc"]', created_at: iso(-40 * H) }]; }],
  ]);
  const res = await drive('get', '/cases/:id/records', { helpers, params: { id: 'ord-1' } });
  assert.deepEqual(params, ['pat-1']);
  assert.deepEqual(data(res), { records: [{ id: 'rec-1', record_type: 'lab', title: 'CBC', description: null, file_url: 'r2/cbc.pdf', file_name: 'cbc.pdf', date_of_record: '2026-01-02', provider: 'Alfa Lab', tags: '["cbc"]', created_at: iso(-40 * H) }] });
  const sql = helpers.calls.find((c) => RECORDS_RE.test(c[1]))[1];
  assert.match(sql, /is_shared_with_doctors = true AND is_hidden = false/);
});

test('GET /cases/:id/timeline: order_events plus synthetic milestones, deduplicated by label, report_due flagged future', async () => {
  install();
  const helpers = makeHelpers([
    [ORDER_RE, order()],
    [EVENTS_RE, [
      { id: 'e1', label: 'doctor_accepted_case', meta: '{"doctor_id":"doc-1"}', at: iso(-2 * H), actor_role: 'doctor' },
      { id: 'e2', label: 'doctor_requested_additional_files', meta: { reason: 'Recent blood tests' }, at: iso(-1 * H), actor_role: 'doctor' },
    ]],
  ]);
  const res = await drive('get', '/cases/:id/timeline', { helpers, params: { id: 'ord-1' } });
  const ev = data(res).events;
  assert.deepEqual(ev.map((e) => e.label), ['order_created', 'doctor_accepted_case', 'doctor_requested_additional_files', 'report_due']);
  assert.equal(ev.filter((e) => e.label === 'doctor_accepted_case').length, 1, 'no synthetic duplicate of a logged event');
  assert.deepEqual(ev[1].meta, { doctor_id: 'doc-1' });
  assert.equal(ev[1].actor_role, 'doctor');
  assert.equal(ev[3].future, true);
  assert.equal(ev[3].at, iso(16 * H));
  const done = await drive('get', '/cases/:id/timeline', { helpers: makeHelpers([[ORDER_RE, order({ status: 'completed', completed_at: iso(-1 * H) })]]), params: { id: 'ord-1' } });
  assert.deepEqual(data(done).events.map((e) => e.label), ['order_created', 'doctor_accepted_case', 'report_delivered']);
});

test('GET /cases/:id/file-suggestions: one per missing document, one per quality-flagged file, plus the two standard ones', async () => {
  install();
  const helpers = makeHelpers([
    [ORDER_RE, order()],
    [EXTRACTION_RE, { missing_documents: ['No lab/blood work results', 'Something new'] }],
    [FLAGGED_FILES_RE, (p) => { assert.deepEqual(p[1], ['poor_quality', 'not_medical', 'wrong_type']); return [{ id: 'f1', label: null, filename: 'MRI.jpg', ai_quality_status: 'poor_quality' }]; }],
  ]);
  const res = await drive('get', '/cases/:id/file-suggestions', { helpers, params: { id: 'ord-1' }, query: { lang: 'ar' } });
  assert.deepEqual(data(res).suggestions, [
    { key: 'missing:0', title_en: 'No lab/blood work results', title_ar: 'لا توجد نتائج تحاليل معملية', source: 'missing' },
    { key: 'missing:1', title_en: 'Something new', title_ar: 'Something new', source: 'missing' },
    { key: 'quality:f1', title_en: 'Clearer copy of MRI.jpg', title_ar: 'نسخة أوضح من MRI.jpg', source: 'quality' },
    { key: 'std:opnote', title_en: 'Previous operative note', title_ar: 'تقرير العملية السابق', source: 'standard' },
    { key: 'std:bloods', title_en: 'Recent blood tests', title_ar: 'تحاليل دم حديثة', source: 'standard' },
  ]);
});

// ═══════════════════════════════════════════════════════════════
// POST /cases/:id/accept — runs the portal handler, maps the redirect
// ═══════════════════════════════════════════════════════════════

// A fake web handler that records what it was given and redirects where told.
function fakeAction(redirectTo) {
  const calls = [];
  const fn = async (req, res) => {
    calls.push({ req, res });
    const to = typeof redirectTo === 'function' ? redirectTo(req) : redirectTo;
    if (to instanceof Error) throw to;
    return res.redirect(to);
  };
  fn.calls = calls;
  return fn;
}

test('accept: the web handler gets the portal req shape (params.caseId, user, requestId, method POST)', async () => {
  const accept = fakeAction('/portal/doctor/case/ord-1?msg=capacity');
  install({ actions: { accept } });
  await drive('post', '/cases/:id/accept', { helpers: makeHelpers([[ORDER_RE, order()]]), params: { id: 'ord-1' } });
  assert.equal(accept.calls.length, 1);
  const { req } = accept.calls[0];
  assert.deepEqual(req.params, { caseId: 'ord-1' });
  assert.deepEqual(req.user, { id: ME, name: 'Dr Mona', role: 'doctor' });
  assert.equal(req.method, 'POST');
  assert.equal(req.requestId, 'req-1');
  assert.equal(typeof req.get, 'function');
  assert.deepEqual(req.body, {});
});

test('accept: every ?msg= refusal, ?error=accept_failed, an unknown msg and a throwing handler map to stable codes', async () => {
  const table = [
    ['already_taken', 409, 'CASE_TAKEN'],
    ['capacity', 409, 'CAPACITY_FULL'],
    ['specialty', 409, 'SPECIALTY_MISMATCH'],
    ['tier_not_supported', 409, 'TIER_NOT_SUPPORTED'],
    ['case_unroutable', 409, 'CASE_UNROUTABLE'],
    ['account_check_failed', 503, 'ACCOUNT_CHECK_FAILED'],
    ['account_inactive', 403, 'ACCOUNT_INACTIVE'],
    ['paused', 403, 'ACCOUNT_PAUSED'],
    ['pending_approval', 403, 'ACCOUNT_PENDING'],
    ['something_new', 409, 'ACCEPT_REFUSED'],
  ];
  for (const [msg, status, code] of table) {
    install({ actions: { accept: fakeAction('/portal/doctor/case/ord-1?msg=' + msg) } });
    const res = await drive('post', '/cases/:id/accept', { helpers: makeHelpers([[ORDER_RE, order()]]), params: { id: 'ord-1' } });
    assert.equal(res.statusCode, status, 'msg=' + msg);
    assert.equal(res._code, code, 'msg=' + msg);
    if (code === 'ACCEPT_REFUSED') assert.equal(res._json.error, 'something_new');
  }
  install({ actions: { accept: fakeAction('/portal/doctor/case/ord-1?error=accept_failed') } });
  let res = await drive('post', '/cases/:id/accept', { helpers: makeHelpers([[ORDER_RE, order()]]), params: { id: 'ord-1' } });
  assert.equal(res.statusCode, 500); assert.equal(res._code, 'ACCEPT_FAILED');
  install({ actions: { accept: fakeAction(new Error('db exploded')) } });
  res = await drive('post', '/cases/:id/accept', { helpers: makeHelpers([[ORDER_RE, order()]]), params: { id: 'ord-1' } });
  assert.equal(res.statusCode, 500); assert.equal(res._code, 'ACCEPT_FAILED');
  install({ actions: { accept: async () => {} } });   // no redirect at all
  res = await drive('post', '/cases/:id/accept', { helpers: makeHelpers([[ORDER_RE, order()]]), params: { id: 'ord-1' } });
  assert.equal(res.statusCode, 500); assert.equal(res._code, 'ACCEPT_FAILED');
});

test('accept: the ambiguous redirects are settled by re-reading the row', async () => {
  const pending = order({ status: 'assigned', accepted_at: null, deadline_at: null });
  const acceptedNow = order({ status: 'in_review', accepted_at: iso(0), deadline_at: iso(18 * H) });

  // Success: the handler accepted and bounced to the dashboard. before → pending, after → accepted.
  let reads = 0;
  install({ actions: { accept: fakeAction('/portal/doctor/dashboard') } });
  let res = await drive('post', '/cases/:id/accept', {
    helpers: makeHelpers([[ORDER_RE, () => (reads++ === 0 ? pending : acceptedNow)]]), params: { id: 'ord-1' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(data(res), {
    accepted: true, already: false, deadline_at: iso(18 * H), reference_id: 'TSH-2026-000123',
    sla: { tier: 'vip', accepted_at: iso(0), deadline_at: iso(18 * H), paused: false, remaining_seconds: null, breached: false },
  });
  assert.equal(reads, 2, 'read once before and once after');

  // Idempotent retry: already mine before the call → already:true.
  install({ actions: { accept: fakeAction('/portal/doctor/dashboard') } });
  res = await drive('post', '/cases/:id/accept', { helpers: makeHelpers([[ORDER_RE, acceptedNow]]), params: { id: 'ord-1' } });
  assert.equal(res.statusCode, 200);
  assert.equal(data(res).already, true);

  // Bare case page: somebody else holds it.
  install({ actions: { accept: fakeAction('/portal/doctor/case/ord-1') } });
  res = await drive('post', '/cases/:id/accept', { helpers: makeHelpers([[ORDER_RE, order({ doctor_id: OTHER, accepted_at: iso(-1 * H) })]]), params: { id: 'ord-1' } });
  assert.equal(res.statusCode, 409); assert.equal(res._code, 'CASE_TAKEN');

  // Bare case page: unpaid.
  res = await drive('post', '/cases/:id/accept', { helpers: makeHelpers([[ORDER_RE, order({ doctor_id: null, accepted_at: null, status: 'submitted', payment_status: 'pending' })]]), params: { id: 'ord-1' } });
  assert.equal(res.statusCode, 402); assert.equal(res._code, 'CASE_UNPAID');

  // Bare case page: paid, unheld, but not in an acceptable status.
  res = await drive('post', '/cases/:id/accept', { helpers: makeHelpers([[ORDER_RE, order({ doctor_id: null, accepted_at: null, status: 'cancelled', payment_status: 'captured' })]]), params: { id: 'ord-1' } });
  assert.equal(res.statusCode, 409); assert.equal(res._code, 'CASE_NOT_ACCEPTABLE');

  // Dashboard bounce on a case that does not exist.
  install({ actions: { accept: fakeAction('/portal/doctor/dashboard') } });
  res = await drive('post', '/cases/:id/accept', { helpers: makeHelpers([[ORDER_RE, null]]), params: { id: 'ord-x' } });
  assert.equal(res.statusCode, 404); assert.equal(res._code, 'CASE_NOT_AVAILABLE');

  // Missing doctor id never reaches the handler.
  const accept = fakeAction('/portal/doctor/dashboard');
  install({ actions: { accept } });
  res = await drive('post', '/cases/:id/accept', { helpers: makeHelpers([]), params: { id: 'ord-1' }, user: {} });
  assert.equal(res.statusCode, 400); assert.equal(res._code, 'INVALID_REQUEST');
  assert.equal(accept.calls.length, 0);
});

// ═══════════════════════════════════════════════════════════════
// POST /cases/:id/decline
// ═══════════════════════════════════════════════════════════════

test('decline: reason validated against _queue.DOCTOR_DECLINE_REASONS before the handler runs; body forwarded', async () => {
  const decline = fakeAction('/portal/doctor/dashboard?msg=case_declined');
  install({ actions: { decline } });
  let res = await drive('post', '/cases/:id/decline', { helpers: makeHelpers([]), params: { id: 'ord-1' }, body: { reason: 'because' } });
  assert.equal(res.statusCode, 400); assert.equal(res._code, 'INVALID_REASON');
  assert.equal(decline.calls.length, 0);

  res = await drive('post', '/cases/:id/decline', { helpers: makeHelpers([]), params: { id: 'ord-1' }, body: { reason: 'workload', note: '  too many cases  ' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(data(res), { declined: true });
  assert.deepEqual(decline.calls[0].req.body, { reason: 'workload', note: 'too many cases' });
  assert.deepEqual(decline.calls[0].req.params, { caseId: 'ord-1' });
});

test('decline: every redirect the handler ends in maps to a stable code; the bare dashboard is settled by ownership', async () => {
  const table = [
    ['/portal/doctor/case/ord-1?error=decline_not_pending', 409, 'DECLINE_NOT_PENDING'],
    ['/portal/doctor/case/ord-1?error=reason_required', 400, 'INVALID_REASON'],
    ['/portal/doctor/case/ord-1?error=decline_failed', 500, 'DECLINE_FAILED'],
  ];
  for (const [to, status, code] of table) {
    install({ actions: { decline: fakeAction(to) } });
    const res = await drive('post', '/cases/:id/decline', { helpers: makeHelpers([]), params: { id: 'ord-1' }, body: { reason: 'other' } });
    assert.equal(res.statusCode, status, to);
    assert.equal(res._code, code, to);
  }
  install({ actions: { decline: fakeAction('/portal/doctor/dashboard') } });
  let res = await drive('post', '/cases/:id/decline', { helpers: makeHelpers([[ORDER_RE, order({ doctor_id: OTHER })]]), params: { id: 'ord-1' }, body: { reason: 'other' } });
  assert.equal(res.statusCode, 404); assert.equal(res._code, 'CASE_NOT_AVAILABLE');
  res = await drive('post', '/cases/:id/decline', { helpers: makeHelpers([[ORDER_RE, null]]), params: { id: 'ord-1' }, body: { reason: 'other' } });
  assert.equal(res.statusCode, 404); assert.equal(res._code, 'CASE_NOT_AVAILABLE');
  res = await drive('post', '/cases/:id/decline', { helpers: makeHelpers([[ORDER_RE, order()]]), params: { id: 'ord-1' }, body: { reason: 'other' } });
  assert.equal(res.statusCode, 500); assert.equal(res._code, 'DECLINE_FAILED');
  install({ actions: { decline: fakeAction(new Error('boom')) } });
  res = await drive('post', '/cases/:id/decline', { helpers: makeHelpers([]), params: { id: 'ord-1' }, body: { reason: 'other' } });
  assert.equal(res.statusCode, 500); assert.equal(res._code, 'DECLINE_FAILED');
});

// ═══════════════════════════════════════════════════════════════
// POST /cases/:id/request-files and /reject-file → the web reject-files handler
// ═══════════════════════════════════════════════════════════════

function requestHelpers(over = []) {
  return makeHelpers([
    ...over,
    [ORDER_RE, order()],
    [EXTRACTION_RE, { missing_documents: ['No lab/blood work results'] }],
    [FLAGGED_FILES_RE, [{ id: 'f1', label: 'Shoulder MRI', filename: null, ai_quality_status: 'poor_quality' }]],
  ]);
}

test('request-files: composes the reason from the titles (lang-aware) and custom text, then runs rejectFiles with it', async () => {
  const rejectFiles = fakeAction('/portal/doctor/case/ord-1');
  install({ actions: { rejectFiles } });
  let reads = 0;
  const helpers = requestHelpers([[ORDER_RE, () => (reads++ < 1 ? order() : order({ sla_paused_at: iso(0), sla_remaining_seconds: 100 }))]]);
  let res = await drive('post', '/cases/:id/request-files', {
    helpers, params: { id: 'ord-1' }, body: { items: ['missing:0', 'quality:f1', 'custom:  Discharge summary from 2024 ', 'std:bloods'] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(data(res), { requested: true, sla_paused: true });
  assert.equal(rejectFiles.calls[0].req.body.reason, 'No lab/blood work results · Clearer copy of Shoulder MRI · Discharge summary from 2024 · Recent blood tests');
  assert.deepEqual(rejectFiles.calls[0].req.params, { caseId: 'ord-1' });

  res = await drive('post', '/cases/:id/request-files', { helpers: requestHelpers(), params: { id: 'ord-1' }, query: { lang: 'ar' }, body: { items: ['std:opnote'] } });
  assert.equal(rejectFiles.calls[1].req.body.reason, 'تقرير العملية السابق');
  assert.equal(data(res).sla_paused, false);

  const long = 'custom:' + 'x'.repeat(400);
  await drive('post', '/cases/:id/request-files', { helpers: requestHelpers(), params: { id: 'ord-1' }, body: { items: [long] } });
  assert.equal(rejectFiles.calls[2].req.body.reason.length, 300);
});

test('request-files: empty or unknown items are refused before anything runs', async () => {
  const rejectFiles = fakeAction('/portal/doctor/case/ord-1');
  install({ actions: { rejectFiles } });
  for (const body of [{}, { items: [] }, { items: 'std:bloods' }, { items: ['   ', 'custom:   '] }]) {
    const res = await drive('post', '/cases/:id/request-files', { helpers: requestHelpers(), params: { id: 'ord-1' }, body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res._code, 'EMPTY_REQUEST', JSON.stringify(body));
  }
  const res = await drive('post', '/cases/:id/request-files', { helpers: requestHelpers(), params: { id: 'ord-1' }, body: { items: ['std:bloods', 'missing:7'] } });
  assert.equal(res.statusCode, 400); assert.equal(res._code, 'INVALID_ITEM');
  assert.equal(rejectFiles.calls.length, 0);
});

test('request-files: every redirect the handler ends in maps to a stable code; a pause failure is a success with a warning', async () => {
  const table = [
    ['/portal/doctor/case/ord-1?error=reason_required', 400, 'EMPTY_REQUEST', null],
    ['/portal/doctor/case/ord-1?error=reject_files_failed', 500, 'REQUEST_FAILED', null],
    ['/portal/doctor/dashboard', 404, 'CASE_NOT_AVAILABLE', null],
    ['/portal/doctor/case/ord-1?error=reject_files_sla_pause_failed', 200, null, { requested: true, sla_paused: false, warning: 'SLA_PAUSE_FAILED' }],
    ['/portal/doctor/case/ord-1?error=something_else', 500, 'REQUEST_FAILED', null],
  ];
  for (const [to, status, code, body] of table) {
    install({ actions: { rejectFiles: fakeAction(to) } });
    const res = await drive('post', '/cases/:id/request-files', { helpers: requestHelpers(), params: { id: 'ord-1' }, body: { items: ['std:bloods'] } });
    assert.equal(res.statusCode, status, to);
    if (code) assert.equal(res._code, code, to);
    if (body) assert.deepEqual(data(res), body);
  }
  install({ actions: { rejectFiles: fakeAction(new Error('boom')) } });
  const res = await drive('post', '/cases/:id/request-files', { helpers: requestHelpers(), params: { id: 'ord-1' }, body: { items: ['std:bloods'] } });
  assert.equal(res.statusCode, 500); assert.equal(res._code, 'REQUEST_FAILED');
});

test('reject-file: names the file by its label from order_files or order_additional_files; unknown file → 404 FILE_NOT_FOUND', async () => {
  const rejectFiles = fakeAction('/portal/doctor/case/ord-1');
  install({ actions: { rejectFiles } });
  let res = await drive('post', '/cases/:id/reject-file', {
    helpers: makeHelpers([[ORDER_RE, order()], [FILE_BY_ID_RE, { id: 'f1', label: null, filename: 'MRI.jpg' }]]),
    params: { id: 'ord-1' }, body: { file_id: 'f1', reason: 'too dark to read' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(data(res), { requested: true, sla_paused: false });
  assert.equal(rejectFiles.calls[0].req.body.reason, 'File MRI.jpg: too dark to read');

  res = await drive('post', '/cases/:id/reject-file', {
    helpers: makeHelpers([[ORDER_RE, order()], [FILE_BY_ID_RE, null], [ADDL_BY_ID_RE, { id: 'af1', label: 'Old X-ray' }]]),
    params: { id: 'ord-1' }, body: { file_id: 'af1', reason: 'wrong side' },
  });
  assert.equal(rejectFiles.calls[1].req.body.reason, 'File Old X-ray: wrong side');

  res = await drive('post', '/cases/:id/reject-file', {
    helpers: makeHelpers([[ORDER_RE, order()], [FILE_BY_ID_RE, null], [ADDL_BY_ID_RE, null]]),
    params: { id: 'ord-1' }, body: { file_id: 'nope', reason: 'x' },
  });
  assert.equal(res.statusCode, 404); assert.equal(res._code, 'FILE_NOT_FOUND');

  res = await drive('post', '/cases/:id/reject-file', { helpers: makeHelpers([[ORDER_RE, order()]]), params: { id: 'ord-1' }, body: { file_id: 'f1' } });
  assert.equal(res.statusCode, 400); assert.equal(res._code, 'INVALID_REQUEST');
  assert.equal(rejectFiles.calls.length, 2);
});
