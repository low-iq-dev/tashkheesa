// tests/core/final-audit-extensionless-dicom.test.js
//
// U-2 (2026-09-23) — DICOM from a CD/PACS export is often named with no
// extension ('IM_0001', 'DICOMDIR') or a bare number ('1.2.840.3'). The phone
// uploaded the whole file and the server then refused it on the extension,
// with raw English, forever. POST /api/v1/files now accepts such a file when
// bytes 128..131 are 'DICM' (DICOM Part 10 magic) and refuses it otherwise.
// The web routes' shared upload instance is unchanged.
//
// Drives the REAL mobile files router (storage stubbed) with multipart bodies.

'use strict';

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🩻 final audit — extensionless DICOM accepted by magic bytes (U-2)\n');

const path = require('path');
const assert = require('assert');
const http = require('http');
const express = require('express');

const ROOT = path.join(__dirname, '..', '..');
const STORAGE_PATH = require.resolve(path.join(ROOT, 'src', 'storage.js'));
const FILES_PATH = require.resolve(path.join(ROOT, 'src', 'routes', 'api', 'files.js'));
const realStorage = require.cache[STORAGE_PATH];
const uploads = [];
require.cache[STORAGE_PATH] = {
  id: STORAGE_PATH, filename: STORAGE_PATH, loaded: true,
  exports: {
    uploadFile: async (o) => { uploads.push(o); return o.folder + '/uuid' + path.extname(o.originalname || ''); },
    getSignedDownloadUrl: async () => 'x', getFileBuffer: async () => Buffer.alloc(0), deleteFile: async () => {},
  },
};
delete require.cache[FILES_PATH];
const filesRouter = require(FILES_PATH);
delete require.cache[FILES_PATH];
if (realStorage) require.cache[STORAGE_PATH] = realStorage; else delete require.cache[STORAGE_PATH];

const app = express();
app.use(require('../../src/middleware/apiResponse'));
app.use((req, _res, next) => { req.user = { id: 'pat-1', role: 'patient' }; next(); });
app.use('/files', filesRouter);

function dicomBytes(withMagic) {
  const b = Buffer.alloc(300, 0);
  if (withMagic) b.write('DICM', 128, 'latin1');
  return b;
}

(async () => {
  const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function send(name, bytes, type) {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type }), name);
    const r = await fetch(base + '/files', { method: 'POST', body: fd });
    return { status: r.status, body: await r.json() };
  }
  const checks = [
    ['an extensionless file with the DICM magic is accepted, typed application/dicom, stored as .dcm', async () => {
      const r = await send('IM_0001', dicomBytes(true), 'application/octet-stream');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.data.filename, 'IM_0001', 'patient-facing name unchanged');
      assert.strictEqual(r.body.data.mimeType, 'application/dicom');
      assert.ok(/\.dcm$/.test(r.body.data.key), 'object key ' + r.body.data.key);
    }],
    ['a numeric-"extension" DICOM name (a UID) with the magic is accepted', async () => {
      const r = await send('1.2.840.113619.2.55.3', dicomBytes(true), 'application/octet-stream');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    }],
    ['an extensionless file WITHOUT the magic is refused (400 UPLOAD_REJECTED) and never stored', async () => {
      const before = uploads.length;
      const r = await send('notes', dicomBytes(false), 'application/octet-stream');
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, 'UPLOAD_REJECTED');
      assert.strictEqual(uploads.length, before);
    }],
    ['an extensionless file declared as some other type is refused before it is read', async () => {
      const r = await send('IM_0002', dicomBytes(true), 'text/html');
      assert.strictEqual(r.status, 400);
    }],
    ['a dangerous extension is still refused', async () => {
      const r = await send('x.exe', dicomBytes(true), 'application/octet-stream');
      assert.strictEqual(r.status, 400);
    }],
    ['an ordinary .jpg still uploads under its own extension', async () => {
      const r = await send('scan.jpg', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.ok(/\.jpg$/.test(r.body.data.key));
    }],
    ['the shared web upload instance still refuses extensionless files (unchanged)', async () => {
      const upload = require('../../src/middleware/upload');
      // Exercise the default filter via a tiny app.
      const a2 = express();
      a2.post('/u', (req, res) => upload.single('file')(req, res, (err) => res.status(err ? 400 : 200).end()));
      const s2 = await new Promise((resolve) => { const s = http.createServer(a2).listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const fd = new FormData();
        fd.append('file', new Blob([dicomBytes(true)], { type: 'application/octet-stream' }), 'IM_0001');
        const r = await fetch('http://127.0.0.1:' + s2.address().port + '/u', { method: 'POST', body: fd });
        assert.strictEqual(r.status, 400);
      } finally { s2.close(); }
    }],
  ];
  try {
    for (const [name, fn] of checks) {
      try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
    }
  } finally {
    server.close();
  }
})();
