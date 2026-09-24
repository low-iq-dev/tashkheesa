'use strict';
// tests/core/launch-eve-annotator-same-origin-source.test.js
//
// 2026-09-24 (launch eve, T8). The annotator loads the original image from
// GET /api/annotations/:imageId/source, which streams the bytes same-origin
// under EXACTLY /files/:fileId's authorisation (services/file_access.js is
// shared by both), instead of following /files' 302 to an R2 signed URL that
// needs a bucket CORS rule.

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🖼️  annotator image bytes: same-origin, /files authorisation\n');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const fileAccess = require('../../src/services/file_access');
const { makeAnnotationSourceHandler } = require('../../src/routes/annotations');

const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489', 'hex');

// A fake DB: one order_files row (R2 key) on an order assigned to doc-1.
function fakeDb({ acceptedAt }) {
  return async function safeGet(sql, params) {
    if (/FROM order_files/.test(sql)) {
      return params[0] === 'img-1' ? { id: 'img-1', order_id: 'ord-1', url: 'uploads/abc.png', label: 'chest.png' } : null;
    }
    if (/FROM orders_active/.test(sql)) {
      return { id: 'ord-1', patient_id: 'pat-1', doctor_id: 'doc-1', accepted_at: acceptedAt, status: 'assigned' };
    }
    return null; // messages / order_additional_files
  };
}

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.set = (h) => { Object.assign(r.headers, h); return r; };
  r.end = (b) => { r.body = b; return r; };
  return r;
}

function handlerFor({ acceptedAt, bytes }) {
  const db = fakeDb({ acceptedAt });
  return makeAnnotationSourceHandler({
    fileAccess: Object.assign({}, fileAccess, {
      resolveFileAccess: (id, user) => fileAccess.resolveFileAccess(id, user, { safeGet: db })
    }),
    storage: { getFileBuffer: async (key) => { if (key !== 'uploads/abc.png') throw new Error('wrong key ' + key); return bytes || PNG; } }
  });
}

function check(name, fn) {
  return Promise.resolve().then(fn).then(() => t.pass(name), (e) => t.fail(name, e));
}

(async () => {
  await check('403 for the assigned doctor who has NOT accepted', async () => {
    const res = fakeRes();
    await handlerFor({ acceptedAt: null })({ params: { imageId: 'img-1' }, user: { id: 'doc-1', role: 'doctor' } }, res);
    if (res.statusCode !== 403) throw new Error('expected 403, got ' + res.statusCode);
    if (Buffer.isBuffer(res.body)) throw new Error('bytes leaked on a 403');
  });

  await check('image bytes for the assigned doctor who HAS accepted', async () => {
    const res = fakeRes();
    await handlerFor({ acceptedAt: '2026-09-24T08:00:00Z' })({ params: { imageId: 'img-1' }, user: { id: 'doc-1', role: 'doctor' } }, res);
    if (res.statusCode !== 200) throw new Error('expected 200, got ' + res.statusCode + ' ' + JSON.stringify(res.body));
    if (!Buffer.isBuffer(res.body) || !res.body.equals(PNG)) throw new Error('body is not the stored bytes');
    if (res.headers['Content-Type'] !== 'image/png') throw new Error('Content-Type ' + res.headers['Content-Type']);
    if (!/^private/.test(res.headers['Cache-Control'] || '')) throw new Error('Cache-Control not private');
    if (res.headers['X-Content-Type-Options'] !== 'nosniff') throw new Error('nosniff missing');
  });

  await check('a different doctor (accepted, not assigned) gets 403', async () => {
    const res = fakeRes();
    await handlerFor({ acceptedAt: '2026-09-24T08:00:00Z' })({ params: { imageId: 'img-1' }, user: { id: 'doc-2', role: 'doctor' } }, res);
    if (res.statusCode !== 403) throw new Error('expected 403, got ' + res.statusCode);
  });

  await check('the owning patient gets the bytes; another patient gets 403', async () => {
    const h = handlerFor({ acceptedAt: null });
    const own = fakeRes();
    await h({ params: { imageId: 'img-1' }, user: { id: 'pat-1', role: 'patient' } }, own);
    if (own.statusCode !== 200) throw new Error('owner got ' + own.statusCode);
    const other = fakeRes();
    await h({ params: { imageId: 'img-1' }, user: { id: 'pat-2', role: 'patient' } }, other);
    if (other.statusCode !== 403) throw new Error('other patient got ' + other.statusCode);
  });

  await check('unknown id is 404', async () => {
    const res = fakeRes();
    await handlerFor({ acceptedAt: 'x' })({ params: { imageId: 'nope' }, user: { id: 'doc-1', role: 'doctor' } }, res);
    if (res.statusCode !== 404) throw new Error('expected 404, got ' + res.statusCode);
  });

  await check('non-raster content (SVG) is refused, never served on our origin', async () => {
    const res = fakeRes();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await handlerFor({ acceptedAt: 'x', bytes: svg })({ params: { imageId: 'img-1' }, user: { id: 'doc-1', role: 'doctor' } }, res);
    if (res.statusCode !== 415) throw new Error('expected 415, got ' + res.statusCode);
  });

  await check('/files/:fileId and the new route share one authorisation implementation', () => {
    if (!/require\('\.\/services\/file_access'\)\.resolveFileAccess\(fileId, req\.user/.test(read('src/server.js'))) {
      throw new Error('server.js /files does not call services/file_access.resolveFileAccess');
    }
    if (/isAssigned && isAccepted/.test(read('src/server.js'))) throw new Error('a second copy of the doctor rule is still in server.js');
  });

  await check('annotator.html loads the same-origin source route, not /files', () => {
    const src = read('public/annotator.html');
    if (!/'\/api\/annotations\/' \+ encodeURIComponent\(imageId\) \+ '\/source'/.test(src)) throw new Error('annotator not pointed at /source');
    if (/var imageUrl = '\/files\//.test(src)) throw new Error('annotator still loads /files');
  });

  await check('the route is rate-limited like /files', () => {
    if (!/app\.use\(\/\^\\\/api\\\/annotations\\\/\[\^\/\]\+\\\/source/.test(read('src/middleware.js'))) {
      throw new Error('fileDownloadLimiter not mounted on the source route');
    }
  });

  await check('doctor guides no longer promise "measurements"', () => {
    for (const rel of ['src/views/portal_doctor_guide.ejs', 'src/views/help_doctor_guide.ejs']) {
      if (/measurements|وقياسات/.test(read(rel))) throw new Error(rel);
    }
  });
})();
