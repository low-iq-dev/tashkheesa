// tests/core/case-files-open-inline.test.js
//
// "Open" must open (6 Oct 2026).
//
// GET /files/:fileId signed every R2 URL with
// ResponseContentDisposition: attachment, unconditionally. So the Open button
// on a case never displayed a scan or a PDF report — the browser saved it,
// which on a phone looks like the button did nothing. Dr Seif Abd El Momen
// reported exactly that on 25 Sep 2026 ("I accepted the case and pressed Open
// on the sonar and semen analysis reports and the result was not displayed")
// and it left NO row in error_logs, because the 302 itself succeeded. That
// silence is why it survived eleven days.
//
// Six pins:
//   1. storage.getSignedDownloadUrl defaults to attachment and only says
//      inline when the caller asks — no other caller's behaviour changes.
//   2. It sets ResponseContentType when given one, so a stored object with a
//      missing or octet-stream type cannot force a download anyway.
//   3. The route asks for inline on viewable types and honours ?download=1.
//   4. file_access carries a real mime and a real filename out of the lookup,
//      and prefers a human label over the raw R2 key — without moving the
//      authorisation answer by a single case.
//   5. The inline set stays narrow: a type a browser cannot render must keep
//      downloading, because an inline disposition there is a blank tab.
//   6. The case page offers Open and Download, both translated.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

module.exports = (async function () {
  console.log('\n📄 Case files — Open opens, Download downloads\n');

  // ─── 1 + 2. storage.js: disposition is caller-chosen, type is set ────────
  try {
    const src = read('src', 'storage.js');
    const start = src.indexOf('async function getSignedDownloadUrl(');
    if (start < 0) throw new Error('getSignedDownloadUrl not found in src/storage.js');
    const body = src.slice(start, src.indexOf('\n}', start));

    if (/ResponseContentDisposition\s*=\s*['"]attachment/.test(body)) {
      throw new Error('getSignedDownloadUrl still hardcodes attachment — Open will download instead of displaying');
    }
    if (!/options\.inline/.test(body)) {
      throw new Error('getSignedDownloadUrl must honour an `inline` option');
    }
    if (!/options\.inline\s*\?\s*['"]inline['"]\s*:\s*['"]attachment['"]/.test(body)) {
      throw new Error('the disposition must be inline ONLY when the caller asks; the default stays attachment');
    }
    if (!/ResponseContentType/.test(body)) {
      throw new Error('getSignedDownloadUrl must set ResponseContentType — a stored octet-stream downloads whatever the disposition says');
    }
    t.pass('storage: disposition is caller-chosen, defaults to attachment, content type is set');
  } catch (e) {
    t.fail('storage: disposition is caller-chosen, defaults to attachment, content type is set', e);
  }

  // ─── 3. The route decides view vs save ──────────────────────────────────
  try {
    const src = read('src', 'server.js');
    const start = src.indexOf("app.get('/files/:fileId'");
    if (start < 0) throw new Error('GET /files/:fileId not found in src/server.js');
    const body = src.slice(start, src.indexOf('\n});', start));

    if (!/req\.query\.download/.test(body)) {
      throw new Error('the route must offer an explicit ?download=1 escape hatch for saving a file');
    }
    if (!/isInlineViewableMime/.test(body)) {
      throw new Error('the route must consult the inline-viewable set rather than guessing');
    }
    if (!/\binline\s*[:=]\s*true/.test(body)) {
      throw new Error('the route must pass inline:true to the signer for a viewable type');
    }
    if (!/contentType\s*[:=]/.test(body)) {
      throw new Error('the route must pass the resolved content type to the signer');
    }
    // The guard that matters: a download request must never be served inline.
    if (!/!wantsDownload\s*&&/.test(body)) {
      throw new Error('?download=1 must defeat the inline path, not merely sit beside it');
    }
    t.pass('route: viewable types go inline, ?download=1 still saves');
  } catch (e) {
    t.fail('route: viewable types go inline, ?download=1 still saves', e);
  }

  // ─── 4. file_access carries mime + a usable filename ────────────────────
  try {
    const fa = require(path.join(ROOT, 'src', 'services', 'file_access.js'));

    if (typeof fa.mimeFromName !== 'function') throw new Error('file_access must export mimeFromName');
    if (typeof fa.isInlineViewableMime !== 'function') throw new Error('file_access must export isInlineViewableMime');

    const src = read('src', 'services', 'file_access.js');
    if (!/SELECT id, order_id, url, label, filename, mime_type FROM order_files/.test(src)) {
      throw new Error('the order_files lookup must read filename and mime_type — both exist (migration 043)');
    }

    // A row the upload wizard wrote: label NULL, filename real. The old code
    // fell through to path.basename(r2Key) and handed the doctor a file named
    // after a UUID. This is Dr Seif's actual row.
    const fakeGet = async (sql) => {
      if (/FROM order_files/.test(sql)) {
        return {
          id: 'pf_1', order_id: 'o1',
          url: 'orders/practice/bddf017f-e545-4fd7-95ea-74eaa4b16464.pdf',
          label: null,
          filename: 'semen-analysis-and-scrotal-doppler.pdf',
          mime_type: 'application/pdf'
        };
      }
      if (/FROM orders_active/.test(sql)) {
        return { id: 'o1', patient_id: 'p1', doctor_id: 'd1', accepted_at: '2026-09-25T09:00:00Z', status: 'in_review' };
      }
      return null;
    };

    const out = await fa.resolveFileAccess('pf_1', { id: 'd1', role: 'doctor' }, { safeGet: fakeGet });
    if (out.status !== 200) throw new Error('the accepting doctor must still be allowed (got ' + out.status + ') — the auth rule must not have moved');
    if (out.mimeType !== 'application/pdf') throw new Error('mimeType must come through, got ' + JSON.stringify(out.mimeType));
    if (out.fileLabel !== 'semen-analysis-and-scrotal-doppler.pdf') {
      throw new Error('with label NULL the real filename must be used, got ' + JSON.stringify(out.fileLabel));
    }
    t.pass('file_access: mime and filename reach the caller, auth answer unchanged');
  } catch (e) {
    t.fail('file_access: mime and filename reach the caller, auth answer unchanged', e);
  }

  // ─── 4b. The authorisation answers must not have shifted ────────────────
  try {
    const fa = require(path.join(ROOT, 'src', 'services', 'file_access.js'));
    const row = {
      id: 'pf_3', order_id: 'o1', url: 'k.pdf', label: null,
      filename: 'x.pdf', mime_type: 'application/pdf'
    };
    const mk = (order) => async (sql) => {
      if (/FROM order_files/.test(sql)) return row;
      if (/FROM orders_active/.test(sql)) return order;
      return null;
    };
    const assigned = { id: 'o1', patient_id: 'p1', doctor_id: 'd1', accepted_at: 'x', status: 'in_review' };

    // Assigned but NOT accepted — the doctor gate is accepted_at.
    let r = await fa.resolveFileAccess('pf_3', { id: 'd1', role: 'doctor' },
      { safeGet: mk({ ...assigned, accepted_at: null }) });
    if (r.status !== 403) throw new Error('an assigned-but-unaccepted doctor must still get 403, got ' + r.status);

    // A different doctor.
    r = await fa.resolveFileAccess('pf_3', { id: 'd2', role: 'doctor' }, { safeGet: mk(assigned) });
    if (r.status !== 403) throw new Error('another doctor must still get 403, got ' + r.status);

    // The owning patient.
    r = await fa.resolveFileAccess('pf_3', { id: 'p1', role: 'patient' }, { safeGet: mk(assigned) });
    if (r.status !== 200) throw new Error('the owning patient must still be allowed, got ' + r.status);

    // Missing parent order → 403, never 404 (no row-existence probing).
    r = await fa.resolveFileAccess('pf_3', { id: 'd1', role: 'doctor' }, { safeGet: mk(null) });
    if (r.status !== 403) throw new Error('a missing parent order must still be 403, got ' + r.status);

    // Unknown id in none of the three tables → 404.
    r = await fa.resolveFileAccess('nope', { id: 'd1', role: 'doctor' }, { safeGet: async () => null });
    if (r.status !== 404) throw new Error('an unknown file id must still be 404, got ' + r.status);

    t.pass('file_access: every authorisation answer is byte-for-byte what it was');
  } catch (e) {
    t.fail('file_access: every authorisation answer is byte-for-byte what it was', e);
  }

  // ─── 4c. A human label still wins over the stored filename ──────────────
  try {
    const fa = require(path.join(ROOT, 'src', 'services', 'file_access.js'));
    const fakeGet = async (sql) => {
      if (/FROM order_files/.test(sql)) {
        return { id: 'pf_2', order_id: 'o1', url: 'k.png', label: 'Scrotal US', filename: 'scan-scrotal-us.png', mime_type: null };
      }
      if (/FROM orders_active/.test(sql)) {
        return { id: 'o1', patient_id: 'p1', doctor_id: 'd1', accepted_at: 'x', status: 'in_review' };
      }
      return null;
    };
    const out = await fa.resolveFileAccess('pf_2', { id: 'd1', role: 'doctor' }, { safeGet: fakeGet });
    if (out.fileLabel !== 'Scrotal US') throw new Error('a label set by a human must win, got ' + JSON.stringify(out.fileLabel));
    // mime_type NULL on the row → fall back to the filename's extension.
    if (out.mimeType !== 'image/png') throw new Error('a NULL mime_type must fall back to the extension, got ' + JSON.stringify(out.mimeType));
    t.pass('file_access: a human label wins, a NULL mime falls back to the extension');
  } catch (e) {
    t.fail('file_access: a human label wins, a NULL mime falls back to the extension', e);
  }

  // ─── 5. The inline set stays narrow ─────────────────────────────────────
  try {
    const fa = require(path.join(ROOT, 'src', 'services', 'file_access.js'));

    ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'].forEach((m) => {
      if (!fa.isInlineViewableMime(m)) throw new Error(m + ' must be inline-viewable');
    });

    // Types a browser does NOT render. An inline disposition on these gives
    // the doctor a blank tab instead of a file — worse than the bug fixed.
    ['image/tiff', 'image/heic', 'application/dicom', 'application/zip',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/octet-stream', 'text/html', '', null, undefined].forEach((m) => {
      if (fa.isInlineViewableMime(m)) throw new Error(JSON.stringify(m) + ' must NOT be served inline');
    });

    // A content-type with parameters still matches on the bare type.
    if (!fa.isInlineViewableMime('application/pdf; charset=binary')) {
      throw new Error('a parameterised content-type must match on the bare type');
    }
    // Case and padding.
    if (!fa.isInlineViewableMime('  IMAGE/PNG ')) {
      throw new Error('the type comparison must be case- and whitespace-insensitive');
    }

    if (fa.mimeFromName('a/b/c.PDF') !== 'application/pdf') throw new Error('mimeFromName must be case-insensitive');
    if (fa.mimeFromName('orders/practice/44302945.png') !== 'image/png') throw new Error('mimeFromName must read an R2 key');
    if (fa.mimeFromName('no-extension') !== '') throw new Error('mimeFromName must return empty for an unknown name');
    if (fa.mimeFromName('') !== '') throw new Error('mimeFromName must tolerate empty input');
    if (fa.mimeFromName(null) !== '') throw new Error('mimeFromName must tolerate null');

    // TIFF/HEIC are typed (so the saved filename is right) but never inline.
    if (fa.mimeFromName('x.tiff') !== 'image/tiff') throw new Error('TIFF should still be typed, just not displayed');
    if (fa.isInlineViewableMime(fa.mimeFromName('x.tiff'))) throw new Error('a typed TIFF must still download');

    t.pass('inline set stays narrow: PDF and the five rasters only');
  } catch (e) {
    t.fail('inline set stays narrow: PDF and the five rasters only', e);
  }

  // ─── 6. The case page offers both controls ──────────────────────────────
  try {
    const view = read('src', 'views', 'portal_doctor_case.ejs');
    if (!/download=1/.test(view)) {
      throw new Error('the doctor case page must offer an explicit Download control alongside Open');
    }
    if (!/تحميل/.test(view)) {
      throw new Error('the Download control must be translated — the portal is bilingual');
    }
    t.pass('case page: Open and Download both offered, bilingually');
  } catch (e) {
    t.fail('case page: Open and Download both offered, bilingually', e);
  }
})();
