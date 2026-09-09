// tests/core/session-revocation.test.js
//
// A4 (AUDIT 2026-09-09) — a deactivated or rejected doctor must lose access NOW,
// not when their 7-day cookie / 15-minute access token expires.
//
// b6d6f89 gated login + refresh but left live cookies and in-flight access
// tokens untouched. This adds a per-instance, FAIL-OPEN revocation cache
// (users.tokens_valid_after, migration 106) checked in requireJWT and the
// cookie-session attachUser, plus a per-request doctor status check.
//
// UNIT: the pure staleness predicate — a token minted before the cut is stale;
//   one minted after is not; every uncertain input fails OPEN (not revoked).
// STRUCTURAL: the cut is stamped on deactivate / reject / every password write
//   but NOT on pause; the three enforcement points consult the cache; the
//   migration exists.
//
// The behavioural end (a real 401 for a pre-cut token) needs the column, which
// the intentionally-unmigrated local DB lacks — so it is a structural guard,
// exactly as the migration-dependent pieces here require. Verified NEGATIVELY:
// flipping the predicate's comparison, and removing tokens_valid_after from a
// write site, each failed the matching assertion; restored.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🔒 A4 — deactivation revokes live sessions now, not at cookie expiry\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

const rev = require('../../src/services/access_revocation');

// ── UNIT: the pure staleness predicate ──────────────────────────────────────

const CUT = Date.parse('2026-09-09T12:00:00Z');
const before = Math.floor((CUT - 60_000) / 1000); // minted 1 min BEFORE the cut
const after = Math.floor((CUT + 60_000) / 1000);  // minted 1 min AFTER the cut

check('a token minted BEFORE the cut is stale', () => {
  if (rev._isStaleRow({ tva_ms: CUT }, before) !== true) return 'pre-cut token not flagged stale';
});
check('a token minted AFTER the cut is NOT stale', () => {
  if (rev._isStaleRow({ tva_ms: CUT }, after) !== false) return 'post-cut token wrongly flagged';
});
check('a token minted in the SAME second as the cut is NOT stale (fresh-cookie safety)', () => {
  // The reset flow stamps tokens_valid_after then re-issues a cookie in the same
  // request — its iat must survive. Second-granularity comparison guarantees it.
  if (rev._isStaleRow({ tva_ms: CUT }, Math.floor(CUT / 1000)) !== false) {
    return 'a token from the cut second was revoked — reset would log the user out';
  }
});
check('fail-open: no cut → never stale', () => {
  if (rev._isStaleRow({ tva_ms: null }, before) !== false) return 'a row with no cut was flagged';
  if (rev._isStaleRow(null, before) !== false) return 'a null row (cache miss) was flagged';
});
check('fail-open: a missing/garbage iat is never stale', () => {
  if (rev._isStaleRow({ tva_ms: CUT }, undefined) !== false) return 'undefined iat flagged';
  if (rev._isStaleRow({ tva_ms: CUT }, NaN) !== false) return 'NaN iat flagged';
});
check('doctorBlockReason fails open for an unknown id (cache miss)', () => {
  if (rev.doctorBlockReason('nobody-here') !== null) return 'a cache miss did not return null';
});

// ── STRUCTURAL: the migration + enforcement wiring ──────────────────────────

check('migration 106 adds users.tokens_valid_after', () => {
  const dir = path.join(ROOT, 'src/migrations');
  const mig = fs.readdirSync(dir).find((f) => /tokens_valid_after/.test(f));
  if (!mig) return 'no migration file';
  const sql = fs.readFileSync(path.join(dir, mig), 'utf8');
  if (!/ADD COLUMN IF NOT EXISTS tokens_valid_after/.test(sql)) return 'migration does not add the column';
});

check('requireJWT refuses a pre-cut token', () => {
  const src = code('src/middleware/requireJWT.js');
  if (!/isTokenStale\(decoded\.id,\s*decoded\.iat\)/.test(src)) return 'requireJWT does not compare iat against the cut';
  if (!/TOKEN_REVOKED/.test(src)) return 'requireJWT does not 401 a revoked token';
});

check('cookie-session attachUser drops a pre-cut token', () => {
  const src = code('src/auth.js');
  if (!/isTokenStale\(payload\.id,\s*payload\.iat\)/.test(src)) return 'attachUser does not compare iat against the cut';
});

check('doctor requireRole blocks a deactivated/rejected doctor via login_gate', () => {
  const src = code('src/middleware.js');
  if (!/doctorBlockReason\(req\.user\.id\)/.test(src)) return 'requireRole does not check doctorBlockReason';
  if (!/clearCookie/.test(src)) return 'requireRole does not clear the session cookie on block';
  // And doctorBlockReason must delegate to login_gate so pause stays non-blocking.
  const rsrc = code('src/services/access_revocation.js');
  if (!/loginBlockReason/.test(rsrc)) return 'doctorBlockReason does not delegate to login_gate';
});

// ── STRUCTURAL: the cut is stamped everywhere it must be, and NOWHERE it must not ──

const WRITE_SITES = [
  ['deactivate (superadmin)', 'src/routes/superadmin.js', /is_active = false, refresh_token = NULL, tokens_valid_after = NOW\(\)/],
  ['reject (superadmin)', 'src/routes/superadmin.js', /refresh_token = NULL,\s*tokens_valid_after = NOW\(\),\s*rejection_reason/],
  ['reject (service)', 'src/services/admin_doctor_reject.js', /refresh_token = NULL,\s*tokens_valid_after = NOW\(\),\s*rejection_reason/],
  ['password (api/auth)', 'src/routes/api/auth.js', /password_hash = \$1, tokens_valid_after = NOW\(\)/],
  ['password (routes/auth reset+set)', 'src/routes/auth.js', /password_hash = \$1,\s*tokens_valid_after = NOW\(\)/],
  ['password (api/profile)', 'src/routes/api/profile.js', /password_hash = \$1, tokens_valid_after = NOW\(\)/],
];
for (const [label, rel, re] of WRITE_SITES) {
  check('stamps the cut on: ' + label, () => {
    if (!re.test(code(rel))) return 'tokens_valid_after not set at this write site';
  });
}

check('PAUSE does NOT revoke sessions (pause is routing-only)', () => {
  const src = code('src/routes/superadmin.js');
  const pauseLine = src.split('\n').find((l) => /action === 'pause'/.test(l) && /UPDATE users/.test(l));
  if (!pauseLine) return 'could not locate the pause UPDATE';
  if (/tokens_valid_after/.test(pauseLine)) return 'pause wrongly stamps tokens_valid_after — it must not lock the doctor out';
});
