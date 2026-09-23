// tests/core/final-audit-cases-and-catalogue.test.js
//
// Final-audit batch (2026-09-23) — the patient API's case list/detail and the
// service catalogue:
//   A-2         GET /cases/:id/files/:fileId/url — a URL the app can open
//               (R2 → 1h signed, legacy Uploadcare → CDN), ownership-scoped.
//   NEW-CASE-5  drafts are not listed (list + count share the clause).
//   NEW-CASE-6  the cancel window counts from SUBMISSION; detail exposes
//               cancellableUntil.
//   NEW-CASE-7  slaDeadline is null until payment_status = 'paid'.
//   NEW-CASE-8  services + case list/detail carry the Arabic service name.
//   NEW-CASE-4  every catalogue item says whether Urgent is on sale now, by
//               the same rule the submit path enforces.
//
// The file-URL route runs for real against a fake safeGet and a stubbed
// storage module; the SQL-shape properties are pinned on the source.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'final-audit-cases-secret';

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n📁 final audit — case files, drafts, cancel window, SLA, Arabic names, urgent window\n');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const express = require('express');
const { stripComments } = require('../_helpers/strip-comments');

const ROOT = path.join(__dirname, '..', '..');
const CASES = stripComments(fs.readFileSync(path.join(ROOT, 'src/routes/api/cases.js'), 'utf8'));
const SERVICES = stripComments(fs.readFileSync(path.join(ROOT, 'src/routes/api/services.js'), 'utf8'));

function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
}
async function checkAsync(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

// ── Source pins ─────────────────────────────────────────────────────────────

function routeBody(src, re) {
  const m = re.exec(src);
  if (!m) return '';
  const next = src.indexOf('router.', m.index + m[0].length);
  return src.slice(m.index, next === -1 ? undefined : next);
}
const LIST = routeBody(CASES, /router\.get\('\/',/);
const DETAIL = routeBody(CASES, /router\.get\('\/:id',/);
const CANCEL = routeBody(CASES, /router\.post\('\/:id\/cancel'/);

check('NEW-CASE-5: the list clause (shared by list and count) excludes DRAFT, case-folded', () => {
  if (!/let whereClause = `[^`]*UPPER\(COALESCE\(o\.status, ''\)\) <> 'DRAFT'/.test(LIST)) return 'no DRAFT exclusion in the base whereClause';
  if (!/COUNT\(\*\)[\s\S]*\$\{whereClause\}/.test(LIST)) return 'count no longer shares whereClause';
  if (/IN \('draft'/.test(LIST)) return "the Active filter still lists 'draft'";
  return null;
});

check('NEW-CASE-7: list and detail gate slaDeadline on payment_status = paid', () => {
  if (!/const SLA_DEADLINE_SQL = `CASE WHEN LOWER\(COALESCE\(o\.payment_status, ''\)\) = 'paid'/.test(CASES)) return 'SLA_DEADLINE_SQL missing or changed';
  for (const [n, b] of [['list', LIST], ['detail', DETAIL]]) {
    if (!/\$\{SLA_DEADLINE_SQL\} as "slaDeadline"/.test(b)) return n + ' does not use SLA_DEADLINE_SQL';
    if (/COALESCE\(o\.deadline_at, o\.sla_deadline\) as "slaDeadline"/.test(b)) return n + ' still returns the ungated deadline';
  }
  return null;
});

check('NEW-CASE-6: cancel window and cancellableUntil both count from the submission timestamp', () => {
  if (!/SUBMITTED_AT_SQL/.test(CANCEL)) return 'cancel route does not read the submission time';
  if (/minutesSinceCreation/.test(CANCEL)) return 'cancel route still counts from creation';
  if (!/\$\{SUBMITTED_AT_SQL\} as "submittedAt"/.test(DETAIL)) return 'detail does not select submittedAt';
  if (!/caseData\.cancellableUntil = cancellableUntilIso\(/.test(DETAIL)) return 'detail does not expose cancellableUntil';
  return null;
});

check('NEW-CASE-8: list + detail return serviceNameAr; the catalogue returns nameAr', () => {
  if (!/s\.name_ar as "serviceNameAr"/.test(LIST)) return 'list lacks serviceNameAr';
  if (!/s\.name_ar as "serviceNameAr"/.test(DETAIL)) return 'detail lacks serviceNameAr';
  const svc = routeBody(SERVICES, /router\.get\('\/services',/);
  if (!/s\.name_ar as "nameAr"/.test(svc)) return 'GET /services lacks nameAr';
  return null;
});

check('NEW-CASE-4: catalogue items carry urgentAvailable from the submit path\'s own window rule', () => {
  if (!/require\('\.\.\/\.\.\/services\/urgency_window'\)/.test(SERVICES)) return 'services.js does not use urgency_window';
  const svc = routeBody(SERVICES, /router\.get\('\/services',/);
  if (!/withAvailability\(services\)/.test(svc)) return 'GET /services does not stamp availability';
  const cip = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/case_intake_pricing.js'), 'utf8'));
  if (!/isUrgentWindowOpen\(\)[\s\S]{0,200}'URGENT_UNAVAILABLE'/.test(cip)) return 'submit gate no longer throws URGENT_UNAVAILABLE on the same rule';
  return null;
});

// ── Behaviour: GET /cases/:id/files/:fileId/url ─────────────────────────────

const STORAGE_PATH = require.resolve(path.join(ROOT, 'src', 'storage.js'));
const realStorage = require.cache[STORAGE_PATH];
const signed = [];
require.cache[STORAGE_PATH] = {
  id: STORAGE_PATH, filename: STORAGE_PATH, loaded: true,
  exports: {
    getSignedDownloadUrl: async (key, ttl, opts) => { signed.push({ key, ttl, opts }); return 'https://r2.example/signed/' + key + '?X-Amz-Expires=' + ttl; },
    uploadFile: async () => 'k', getFileBuffer: async () => Buffer.alloc(0), deleteFile: async () => {},
  },
};
// cases.js destructures getSignedDownloadUrl at load: load it fresh under the stub.
const CASES_PATH = require.resolve(path.join(ROOT, 'src', 'routes', 'api', 'cases.js'));
const prevRoute = require.cache[CASES_PATH];
delete require.cache[CASES_PATH];

const FILES = {
  'f-r2': { id: 'f-r2', order_id: 'case-1', patient_id: 'pat-1', url: 'orders/draft/pat-1/abc.jpg', uploadcare_uuid: null, filename: 'IMG_1.jpg', label: 'Chest X-ray.jpg', mime_type: 'image/jpeg' },
  'f-uc': { id: 'f-uc', order_id: 'case-1', patient_id: 'pat-1', url: null, uploadcare_uuid: '0f8b1f3e-1b2c-4d5e-8f90-123456789abc', filename: 'old.pdf', label: null, mime_type: 'application/pdf' },
  'f-evil': { id: 'f-evil', order_id: 'case-1', patient_id: 'pat-1', url: 'https://evil.example/x.pdf', uploadcare_uuid: null, filename: 'x.pdf', label: null, mime_type: 'application/pdf' },
};
const helpers = {
  safeGet: async (sql, p) => {
    if (/FROM order_files f\s+JOIN orders_active o/.test(sql)) {
      const f = FILES[p[0]];
      return f && f.order_id === p[1] && f.patient_id === p[2] ? Object.assign({}, f) : null;
    }
    throw new Error('unexpected SQL: ' + sql.slice(0, 120));
  },
  safeAll: async () => [], safeRun: async () => ({ rowCount: 0 }),
};
const casesRouter = require(CASES_PATH)(null, helpers);
if (realStorage) require.cache[STORAGE_PATH] = realStorage; else delete require.cache[STORAGE_PATH];
if (prevRoute) require.cache[CASES_PATH] = prevRoute; else delete require.cache[CASES_PATH];

const app = express();
app.use(require('../../src/middleware/apiResponse'));
app.use((req, _res, next) => { req.user = { id: req.headers['x-user'] || 'pat-1', role: 'patient' }; next(); });
app.use('/cases', casesRouter);

(async () => {
  const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async (p, user) => {
    const r = await fetch(base + p, { headers: user ? { 'x-user': user } : {} });
    return { status: r.status, body: await r.json() };
  };
  try {
    await checkAsync('A-2: an R2 file → 1-hour signed URL with expiresAt, mimeType and the display filename', async () => {
      const r = await get('/cases/case-1/files/f-r2/url');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const d = r.body.data;
      assert.ok(/^https:\/\/r2\.example\/signed\/orders\/draft\/pat-1\/abc\.jpg/.test(d.url));
      assert.strictEqual(signed[signed.length - 1].ttl, 3600);
      assert.ok(!(signed[signed.length - 1].opts && signed[signed.length - 1].opts.downloadName), 'inline, not a forced download');
      const ms = Date.parse(d.expiresAt) - Date.now();
      assert.ok(ms > 3500 * 1000 && ms <= 3600 * 1000, 'expiresAt ~1h ahead');
      assert.strictEqual(d.mimeType, 'image/jpeg');
      assert.strictEqual(d.filename, 'Chest X-ray.jpg');
    });
    await checkAsync('A-2: a legacy Uploadcare row → its CDN URL, expiresAt null', async () => {
      const r = await get('/cases/case-1/files/f-uc/url');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.data.url, 'https://ucarecdn.com/0f8b1f3e-1b2c-4d5e-8f90-123456789abc/');
      assert.strictEqual(r.body.data.expiresAt, null);
      assert.strictEqual(r.body.data.filename, 'old.pdf');
    });
    await checkAsync('A-2: another patient\'s file, a wrong case id, or an unknown id → 404 FILE_NOT_FOUND', async () => {
      for (const [p, u] of [['/cases/case-1/files/f-r2/url', 'pat-2'], ['/cases/case-2/files/f-r2/url', null], ['/cases/case-1/files/nope/url', null]]) {
        const r = await get(p, u);
        assert.strictEqual(r.status, 404, p);
        assert.strictEqual(r.body.code, 'FILE_NOT_FOUND');
      }
    });
    await checkAsync('A-2: a stored URL on a non-allowlisted host is refused (404), never handed to the app', async () => {
      const r = await get('/cases/case-1/files/f-evil/url');
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.body.code, 'FILE_NOT_FOUND');
    });
  } finally {
    server.close();
  }
})();
