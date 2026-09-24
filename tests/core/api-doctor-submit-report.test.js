// tests/core/api-doctor-submit-report.test.js
//
// POST /api/v1/doctor/cases/:id/submit — the doctor app's report submission.
//
// The endpoint is deliberately thin: it calls the SAME service the portal's
// submit button calls (services/report_submission.submitDoctorReport) and
// maps its result codes onto HTTP. These tests pin three things:
//
//   1. The three report fields reach the service under the names it expects,
//      and `via` says the report came from the app (ops can tell them apart).
//   2. Every result code the service can return has a stable HTTP status and
//      code the app can branch on — including alreadyCompleted, which is a
//      SUCCESS (the retry of a submit that already landed), not an error.
//   3. "not yours" and "does not exist" are the same 404, as GET /cases/:id.
//
// Hermetic: the service is stubbed through the require cache; no DB, no boot.
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'doctor-submit-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Stub ONLY submitDoctorReport on the real module. Test files share the
// require cache, and routes/doctor.js imports the module's other helpers
// (getReportUrlColumnName, …) — replacing the whole export broke seven
// unrelated case-page tests the first time this ran.
const service = require(path.join(__dirname, '../../src/services/report_submission'));
let nextResult = { ok: true, completed: true, reportUrl: 'r2://reports/x.pdf', earnings: { earnedAmount: 780 } };
let lastArgs = null;
const realSubmit = service.submitDoctorReport;
service.submitDoctorReport = async (args) => { lastArgs = args; return nextResult; };
test.after(() => { service.submitDoctorReport = realSubmit; });

// The router reads submitDoctorReport at CALL time, not at require time, so
// the stub above is what it sees.
const buildRouter = require('../../src/routes/api/doctor_cases');

function submitHandler(router) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === '/cases/:id/submit' && layer.route.methods.post) {
      const st = layer.route.stack;
      return st[st.length - 1].handle;
    }
  }
  throw new Error('POST /cases/:id/submit not registered');
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

async function drive(body, result) {
  nextResult = result;
  lastArgs = null;
  const router = buildRouter({}, { safeGet: async () => null, safeAll: async () => [] });
  const req = { params: { id: 'ord_42' }, body, user: { id: 'doc_1', role: 'doctor' }, query: {}, headers: {} };
  const res = mockRes();
  await submitHandler(router)(req, res);
  return res;
}

test('passes the three fields to the service and marks the report as from the app', async () => {
  const res = await drive(
    { findings: '  MRI shows a tear. ', impression: 'Bankart lesion', recommendation: 'Repair' },
    { ok: true, completed: true, reportUrl: 'r2://reports/ord_42.pdf', earnings: { earnedAmount: 780 } },
  );
  assert.equal(lastArgs.orderId, 'ord_42');
  assert.equal(lastArgs.doctorId, 'doc_1');
  assert.equal(lastArgs.diagnosisText, 'MRI shows a tear.');
  assert.equal(lastArgs.impressionText, 'Bankart lesion');
  assert.equal(lastArgs.recommendationsText, 'Repair');
  assert.equal(lastArgs.via, 'doctor_app_report');
  assert.equal(res.statusCode, 200);
  assert.equal(res._json.success, true);
  assert.equal(res._json.data.completed, true);
  assert.equal(res._json.data.already_completed, false);
  assert.equal(res._json.data.earned_amount, 780);
  assert.equal(res._json.data.report_url, 'r2://reports/ord_42.pdf');
});

test('accepts the portal field names too (diagnosis / recommendations)', async () => {
  await drive({ diagnosis: 'A', impression: 'B', recommendations: 'C' }, { ok: true, completed: true });
  assert.equal(lastArgs.diagnosisText, 'A');
  assert.equal(lastArgs.recommendationsText, 'C');
});

test('a retry of a submit that already landed is a success, not an error', async () => {
  const res = await drive({}, { ok: true, alreadyCompleted: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res._json.data.completed, true);
  assert.equal(res._json.data.already_completed, true);
  assert.equal(res._json.data.earned_amount, null);
});

test('maps every service result code onto a stable HTTP status and code', async () => {
  const table = [
    ['invalid_request', 400, 'INVALID_REQUEST'],
    ['not_found', 404, 'CASE_NOT_AVAILABLE'],
    ['forbidden', 404, 'CASE_NOT_AVAILABLE'],   // same shape as not_found, as GET does
    ['report_empty', 422, 'REPORT_INCOMPLETE'],
    ['case_not_open', 409, 'CASE_NOT_OPEN'],
    ['report_save_failed', 500, 'REPORT_SAVE_FAILED'],
    ['report_pdf_failed', 502, 'REPORT_PDF_FAILED'],
    ['report_complete_failed', 500, 'REPORT_COMPLETE_FAILED'],
    ['something_new', 500, 'REPORT_SUBMIT_FAILED'],
  ];
  for (const [code, status, apiCode] of table) {
    const res = await drive({ findings: 'x' }, { ok: false, code });
    assert.equal(res.statusCode, status, `service code ${code} → HTTP ${status}`);
    assert.equal(res._code, apiCode, `service code ${code} → ${apiCode}`);
    assert.equal(res._json.success, false);
  }
});

test('a missing doctor id never reaches the service', async () => {
  nextResult = { ok: true, completed: true };
  lastArgs = null;
  const router = buildRouter({}, { safeGet: async () => null, safeAll: async () => [] });
  const req = { params: { id: 'ord_42' }, body: {}, user: {}, query: {}, headers: {} };
  const res = mockRes();
  await submitHandler(router)(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res._code, 'INVALID_REQUEST');
  assert.equal(lastArgs, null);
});
