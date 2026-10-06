// tests/core/api-doctor-files.test.js
//
// /api/v1/doctor/files/:fileId/link and /api/v1/doctor/cases/:id/report-link
// (src/routes/api/doctor_files.js) — how the doctor app opens a case file.
//
// What these pin:
//   1. Access is the web rule (services/file_access.resolveFileAccess):
//      assigned AND accepted. Not accepted, another doctor's case and an
//      unknown id are all the same 404 — never a link.
//   2. The role handed to that rule is always 'doctor', whatever the token
//      says, so this route can never answer the admin question.
//   3. `kind` — image (the web annotator's set), pdf, other (DICOM, HEIC…).
//   4. Viewable types are signed inline with their content type; the rest
//      keep the attachment default. Links live 15 minutes.
//   5. The report link is scoped to the doctor's own case.
//
// Hermetic: storage.getSignedDownloadUrl is stubbed by assignment on the real
// module object and restored after; helpers are fakes; no DB, no R2.
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'doctor-files-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const storage = require(path.join(__dirname, '../../src/storage'));
const buildRouter = require('../../src/routes/api/doctor_files');

const realSign = storage.getSignedDownloadUrl;
test.after(() => { storage.getSignedDownloadUrl = realSign; });

let signed;
function stubSign() {
  signed = [];
  storage.getSignedDownloadUrl = async (key, ttl, opts) => { signed.push({ key, ttl, opts }); return 'https://r2.example/' + key + '?sig=1'; };
}

function handler(router, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods.get) {
      const st = layer.route.stack;
      return st[st.length - 1].handle;
    }
  }
  throw new Error('GET ' + routePath + ' not registered');
}

function mockRes() {
  return {
    statusCode: 200, _json: null, _code: null,
    ok(data) { this._json = { success: true, data }; return this; },
    fail(message, status = 400, code) { this.statusCode = status; this._code = code; this._json = { success: false, error: message, code }; return this; },
  };
}

// A tiny fake of the three lookups resolveFileAccess and the report route make.
function helpersFor({ files = {}, orders = {}, exportsByCase = {} } = {}) {
  return {
    safeGet: async (sql, params, fallback = null) => {
      const q = String(sql).replace(/\s+/g, ' ');
      if (q.includes('FROM order_files')) return files[params[0]] || fallback;
      if (q.includes('FROM messages')) return fallback;
      if (q.includes('FROM order_additional_files')) return fallback;
      if (q.includes('FROM report_exports')) return exportsByCase[params[0]] || fallback;
      if (q.includes('FROM orders_active')) {
        const o = orders[params[0]];
        if (!o) return fallback;
        if (params.length > 1 && String(o.doctor_id) !== String(params[1])) return fallback;
        return o;
      }
      throw new Error('unexpected SQL: ' + q.slice(0, 80));
    },
  };
}

async function drive(routePath, params, { user = { id: 'doc_1', role: 'doctor' }, helpers } = {}) {
  const router = buildRouter({}, helpers);
  const req = { params, body: {}, user, query: {}, headers: {} };
  const res = mockRes();
  await handler(router, routePath)(req, res);
  return res;
}

const ACCEPTED = { id: 'o1', patient_id: 'p1', doctor_id: 'doc_1', accepted_at: '2026-10-01T10:00:00Z', status: 'in_review', report_url: null };

test('file link: an accepted case image is signed inline, 15 minutes, kind=image', async () => {
  stubSign();
  const helpers = helpersFor({
    files: { f1: { id: 'f1', order_id: 'o1', url: 'uploads/abc.jpg', label: 'Knee MRI', filename: 'knee.jpg', mime_type: 'image/jpeg' } },
    orders: { o1: ACCEPTED },
  });
  const res = await drive('/files/:fileId/link', { fileId: 'f1' }, { helpers });
  assert.equal(res.statusCode, 200);
  assert.equal(res._json.data.kind, 'image');
  assert.equal(res._json.data.mime, 'image/jpeg');
  assert.equal(res._json.data.name, 'Knee MRI');
  assert.equal(res._json.data.expires_in, 900);
  assert.match(res._json.data.url, /^https:\/\/r2\.example\/uploads\/abc\.jpg/);
  assert.equal(signed.length, 1);
  assert.equal(signed[0].ttl, 900);
  assert.equal(signed[0].opts.inline, true);
  assert.equal(signed[0].opts.contentType, 'image/jpeg');
});

test('file link: a PDF is kind=pdf and inline; a DICOM is kind=other and stays an attachment', async () => {
  stubSign();
  const helpers = helpersFor({
    files: {
      f2: { id: 'f2', order_id: 'o1', url: 'uploads/lab.pdf', label: null, filename: 'lab.pdf', mime_type: 'application/pdf' },
      f3: { id: 'f3', order_id: 'o1', url: 'uploads/series.dcm', label: null, filename: 'series.dcm', mime_type: 'application/dicom' },
    },
    orders: { o1: ACCEPTED },
  });
  const pdf = await drive('/files/:fileId/link', { fileId: 'f2' }, { helpers });
  assert.equal(pdf._json.data.kind, 'pdf');
  assert.equal(signed[0].opts.inline, true);
  const dcm = await drive('/files/:fileId/link', { fileId: 'f3' }, { helpers });
  assert.equal(dcm._json.data.kind, 'other');
  assert.equal(signed[1].opts.inline, undefined);
});

test('file link: assigned but NOT accepted, another doctor, and unknown id are all the same 404 — nothing is signed', async () => {
  stubSign();
  const file = { id: 'f1', order_id: 'o1', url: 'uploads/abc.jpg', label: 'x', filename: 'x.jpg', mime_type: 'image/jpeg' };
  const notAccepted = await drive('/files/:fileId/link', { fileId: 'f1' }, {
    helpers: helpersFor({ files: { f1: file }, orders: { o1: { ...ACCEPTED, accepted_at: null } } }),
  });
  const otherDoctor = await drive('/files/:fileId/link', { fileId: 'f1' }, {
    helpers: helpersFor({ files: { f1: file }, orders: { o1: { ...ACCEPTED, doctor_id: 'doc_2' } } }),
  });
  const unknown = await drive('/files/:fileId/link', { fileId: 'nope' }, { helpers: helpersFor() });
  for (const r of [notAccepted, otherDoctor, unknown]) {
    assert.equal(r.statusCode, 404);
    assert.equal(r._code, 'FILE_NOT_AVAILABLE');
  }
  assert.equal(signed.length, 0);
});

test('file link: a token claiming role=admin is still judged as a doctor', async () => {
  stubSign();
  const helpers = helpersFor({
    files: { f1: { id: 'f1', order_id: 'o1', url: 'uploads/abc.jpg', label: 'x', filename: 'x.jpg', mime_type: 'image/jpeg' } },
    orders: { o1: { ...ACCEPTED, doctor_id: 'doc_2' } },
  });
  const res = await drive('/files/:fileId/link', { fileId: 'f1' }, { helpers, user: { id: 'doc_1', role: 'admin' } });
  assert.equal(res.statusCode, 404);
  assert.equal(signed.length, 0);
});

test('file link: a legacy row pointing at a non-allowlisted host is refused', async () => {
  stubSign();
  const helpers = helpersFor({
    files: { f9: { id: 'f9', order_id: 'o1', url: 'https://evil.example/x.jpg', label: 'x', filename: 'x.jpg', mime_type: 'image/jpeg' } },
    orders: { o1: ACCEPTED },
  });
  const res = await drive('/files/:fileId/link', { fileId: 'f9' }, { helpers });
  assert.equal(res.statusCode, 404);
});

test('report link: own case with a stored report is signed inline as a PDF', async () => {
  stubSign();
  const helpers = helpersFor({ orders: { o1: { ...ACCEPTED, status: 'completed', report_url: 'reports/o1.pdf' } } });
  const res = await drive('/cases/:id/report-link', { id: 'o1' }, { helpers });
  assert.equal(res.statusCode, 200);
  assert.equal(res._json.data.kind, 'pdf');
  assert.equal(signed[0].key, 'reports/o1.pdf');
  assert.equal(signed[0].opts.inline, true);
});

test('report link: falls back to report_exports; none → REPORT_NOT_READY; another doctor → CASE_NOT_AVAILABLE', async () => {
  stubSign();
  const viaExport = await drive('/cases/:id/report-link', { id: 'o1' }, {
    helpers: helpersFor({ orders: { o1: ACCEPTED }, exportsByCase: { o1: { file_path: 'exports/o1.pdf' } } }),
  });
  assert.equal(viaExport.statusCode, 200);
  assert.equal(signed[0].key, 'exports/o1.pdf');

  const none = await drive('/cases/:id/report-link', { id: 'o1' }, { helpers: helpersFor({ orders: { o1: ACCEPTED } }) });
  assert.equal(none._code, 'REPORT_NOT_READY');

  const other = await drive('/cases/:id/report-link', { id: 'o1' }, {
    helpers: helpersFor({ orders: { o1: { ...ACCEPTED, doctor_id: 'doc_2', report_url: 'reports/o1.pdf' } } }),
  });
  assert.equal(other._code, 'CASE_NOT_AVAILABLE');
});
