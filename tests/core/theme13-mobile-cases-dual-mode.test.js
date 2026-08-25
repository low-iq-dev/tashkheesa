// tests/core/theme13-mobile-cases-dual-mode.test.js
//
// Theme 13 Sub-issue D — POST /api/v1/cases dual-mode contract.
//
// The mobile case-create handler must accept BOTH file shapes:
//   * Legacy: files: [{ uploadcareUuid, filename, mimeType, size }]
//   * New:    files: [{ fileId, filename, mimeType, size }]   (R2 key)
//
// Per the §8 Q2 commitment: the server INSERT must populate exactly one of
// (order_files.uploadcare_uuid, order_files.url) per row — never both, never
// neither. App-level guard enforces this since there's no DB constraint
// preventing it.
//
// Pure source-grep — no DB, no boot. Locks in the contract so a future
// refactor can't accidentally drop one of the two paths.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📁 Theme 13 — POST /api/v1/cases dual-mode contract\n');

const ROOT = path.join(__dirname, '..', '..');
const CASES = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'api', 'cases.js'), 'utf8');
// The image-quality worker's real home since the 2026-08-25 case-flow rebuild.
// Shared by POST /cases and POST /cases/draft/:id/submit.
const IMGQ = fs.readFileSync(path.join(ROOT, 'src', 'services', 'case_image_quality.js'), 'utf8');
const API_V1 = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'api_v1.js'), 'utf8');

function expect(cond, msg) { if (!cond) throw new Error(msg); }

// 1. New /api/v1/files route is mounted in api_v1.js.
try {
  expect(/require\(['"]\.\/api\/files['"]\)/.test(API_V1), 'api_v1.js must require ./api/files');
  expect(/router\.use\(['"]\/files['"]\s*,\s*filesRoutes\)/.test(API_V1), 'api_v1.js must mount filesRoutes at /files');
  // Mounted under the JWT-protected block, not the public auth block.
  const usePos  = API_V1.indexOf("router.use('/files', filesRoutes)");
  const jwtPos  = API_V1.indexOf('router.use(requireJWT)');
  const rolePos = API_V1.indexOf("router.use(requireRole('patient'))");
  expect(usePos > jwtPos,  '/files mount must come AFTER requireJWT (it ran at index ' + jwtPos + '; /files at ' + usePos + ')');
  expect(usePos > rolePos, '/files mount must come AFTER requireRole(patient)');
  t.pass('/api/v1/files is mounted under the JWT + patient-role gate');
} catch (e) { t.fail('files mount', e); }

// 2. cases.js POST handler destructures fileId alongside uploadcareUuid (per-file shape).
try {
  // The destructure happens inside the loop — look for both names appearing
  // in proximity to the per-file validation block.
  expect(/uploadcareUuid/.test(CASES), 'cases.js must reference uploadcareUuid');
  expect(/fileId/.test(CASES), 'cases.js must reference fileId (Sub-issue D new field)');
  expect(/files\[/.test(CASES), 'cases.js must include the per-file shape validation loop');
  t.pass('cases.js POST handler reads both uploadcareUuid (legacy) and fileId (new)');
} catch (e) { t.fail('dual destructure', e); }

// 3. Per-file validation enforces exactly-one-of-two (rejects both-set and neither-set).
try {
  expect(/cannot set both uploadcareUuid and fileId/.test(CASES), 'cases.js must reject both-set');
  expect(/must set uploadcareUuid \(legacy\) or fileId \(new R2 key\)/.test(CASES), 'cases.js must reject neither-set');
  expect(/INVALID_FILE/.test(CASES), 'cases.js must use INVALID_FILE error code');
  t.pass('per-file validation enforces exactly-one-of-two (uploadcareUuid XOR fileId)');
} catch (e) { t.fail('XOR validation', e); }

// 4. R2 key shape pinned to the orders/draft/<patient>/<file> prefix.
try {
  // Same regex used in src/routes/patient.js Sub-issue B handler (line 3306+).
  expect(/orders\\\/draft\\\/\[A-Za-z0-9_-\]\+\\\/\[A-Za-z0-9_\.-\]\+/.test(CASES), 'cases.js must validate fileId against the orders/draft/<id>/<file> regex');
  t.pass('fileId R2-key shape is pinned to orders/draft/<patient>/<file> (forbids path traversal)');
} catch (e) { t.fail('R2 key regex', e); }

// 5. Dual-column INSERT: order_files now writes both `url` (R2 key) and `uploadcare_uuid` (legacy UUID).
try {
  // The new INSERT lists url first, then uploadcare_uuid.
  expect(/INSERT INTO order_files \([^)]*\burl\b[^)]*\buploadcare_uuid\b/s.test(CASES),
    'cases.js INSERT must list both url and uploadcare_uuid columns');
  t.pass('INSERT writes to both order_files.url (R2 key path) and order_files.uploadcare_uuid (legacy CDN path)');
} catch (e) { t.fail('dual-column INSERT', e); }

// 6. AI worker (Sub-issue I bundled) signs an R2 URL when an R2 key is set.
//
// STALE-TEST FIX (2026-08-25, case-flow rebuild): these three assertions were
// pinned to cases.js by literal. The ~60-line worker they describe moved to
// services/case_image_quality.js so the new draft-submit path
// (POST /cases/draft/:id/submit) runs the SAME check instead of a second copy
// that drifts — which is the failure mode this whole test file exists to catch.
//
// The assertions' INTENT is unchanged and still load-bearing: an R2 key must
// get an awaited signed URL, and legacy Uploadcare rows must keep their CDN
// URL construction. Only the file being grepped changed. Re-greening this by
// dragging the worker back into cases.js would have meant keeping two copies
// of it, which is worse than the thing the test was written to prevent.
//
// It now asserts against the worker's real home AND that cases.js still calls
// it — so deleting the call site is still caught.
try {
  expect(/getSignedDownloadUrl/.test(IMGQ),
    'case_image_quality.js must import + use getSignedDownloadUrl for the AI worker');
  expect(/imageUrl\s*=\s*await\s+getSignedDownloadUrl/.test(IMGQ),
    'AI worker must await a signed URL for R2 keys');
  // Legacy CDN URL still constructed for uploadcare_uuid rows. The extraction
  // reads order_files column names (f.uploadcare_uuid) rather than the old
  // camelCase local (f.uploadcareUuid), because the draft path hands it rows
  // straight out of the table.
  expect(/https:\/\/ucarecdn\.com\/'\s*\+\s*f\.uploadcare_uuid/.test(IMGQ),
    'AI worker must keep the ucarecdn.com URL construction for legacy rows');
  expect(/scheduleImageQualityChecks\s*\(/.test(CASES),
    'cases.js must still invoke the shared image-quality worker after inserting files');
  t.pass('Sub-issue I bundled: AI worker branches on R2 key vs uploadcare_uuid + signs an R2 URL when needed (shared worker, called from cases.js)');
} catch (e) { t.fail('AI worker dual-source', e); }
