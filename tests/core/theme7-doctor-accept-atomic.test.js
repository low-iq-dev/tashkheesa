// tests/core/theme7-doctor-accept-atomic.test.js
//
// Theme 7 sub-issue A: atomicity check.
//
// Asserts that the doctor accept transition runs inside a single
// withTransaction(async (client) => …) block, with `client` threaded
// through the canonical helpers per the Theme 5 pattern. A regression
// here (e.g., someone moves transitionCase outside the txn or reintroduces
// a raw `UPDATE orders` inside) would leave us with the same partial-state
// risk the prior raw-UPDATE shape had.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n⚛️  Theme 7 sub-A — doctor accept atomicity (source check)\n');

const SRC = path.join(__dirname, '..', '..', 'src', 'routes', 'doctor.js');
const src = fs.readFileSync(SRC, 'utf8');

const startIdx = src.indexOf("router.post('/portal/doctor/case/:caseId/accept'");
if (startIdx < 0) {
  t.fail('locate accept handler', new Error('accept route not found'));
} else {
  const after = src.slice(startIdx);
  const nextRouter = after.indexOf('\nrouter.');
  const body = nextRouter > 0 ? after.slice(0, nextRouter) : after;

  // Carve out the withTransaction block. Simple bracket-walker — the
  // route body is small enough for this to be reliable.
  const wtxStart = body.search(/withTransaction\(\s*async\s*\(\s*client\s*\)\s*=>\s*\{/);
  if (wtxStart < 0) {
    t.fail('locate withTransaction', new Error('withTransaction(async (client) => {…}) not found in accept handler'));
  } else {
    let depth = 0;
    let endIdx = -1;
    let started = false;
    for (let i = wtxStart; i < body.length; i++) {
      const c = body[i];
      if (c === '{') { depth++; started = true; }
      else if (c === '}') {
        depth--;
        if (started && depth === 0) { endIdx = i + 1; break; }
      }
    }
    const wtxBody = endIdx > 0 ? body.slice(wtxStart, endIdx) : '';

    // 1. transitionCase is inside the txn block, threaded with `client`.
    try {
      if (!/caseLifecycle\.transitionCase\([\s\S]*?,\s*client\s*\)/.test(wtxBody)) {
        throw new Error('transitionCase not invoked inside withTransaction with `client` threading');
      }
      t.pass('transitionCase runs inside withTransaction with `client` threading');
    } catch (e) { t.fail('transitionCase-in-txn', e); }

    // 2. getCase(orderId, client) is the txn-side fresh read.
    try {
      if (!/caseLifecycle\.getCase\(\s*orderId,\s*client\s*\)/.test(wtxBody)) {
        throw new Error('withTransaction body does not call getCase(orderId, client) for the fresh-state re-fetch');
      }
      t.pass('withTransaction body re-fetches via caseLifecycle.getCase(orderId, client)');
    } catch (e) { t.fail('getCase-in-txn', e); }

    // 3. Ownership re-check inside the txn (TOCTOU defense).
    try {
      if (!/freshDoctorId\s*&&\s*freshDoctorId\s*!==\s*doctorId/.test(wtxBody)) {
        throw new Error('withTransaction body missing ownership re-check (freshDoctorId !== doctorId)');
      }
      t.pass('ownership re-check inside the txn (freshDoctorId !== doctorId)');
    } catch (e) { t.fail('ownership-recheck', e); }

    // 4. No raw `await execute(` and no raw `client.query(`UPDATE orders`)`
    //    inside the txn — every write must go through transitionCase.
    try {
      if (/\bawait\s+execute\(/.test(wtxBody)) {
        throw new Error('withTransaction body still contains `await execute(...)` — must use transitionCase');
      }
      if (/client\.query\(\s*`?\s*UPDATE\s+orders/i.test(wtxBody)) {
        throw new Error('withTransaction body still contains raw `UPDATE orders` via client.query — must use transitionCase');
      }
      t.pass('withTransaction body has no raw UPDATE orders writes');
    } catch (e) { t.fail('no-raw-writes-in-txn', e); }

    // 5. The accepted result is captured (acceptedCase = await withTransaction(...))
    //    so the post-txn code can guard on success/failure.
    try {
      if (!/acceptedCase\s*=\s*await\s+withTransaction\(/.test(body)) {
        throw new Error('accept handler does not assign withTransaction result to acceptedCase for post-txn guard');
      }
      if (!/if\s*\(\s*!acceptedCase\s*\)/.test(body)) {
        throw new Error('accept handler does not guard `if (!acceptedCase)` after the txn (race / lost-update path)');
      }
      t.pass('accept handler captures withTransaction result and guards on !acceptedCase');
    } catch (e) { t.fail('post-txn-guard', e); }
  }

  // 6. withTransaction is imported in the route file.
  try {
    const importLineRe = /const\s*\{[^}]*\bwithTransaction\b[^}]*\}\s*=\s*require\(['"]\.\.\/pg['"]\)/;
    if (!importLineRe.test(src)) {
      throw new Error('routes/doctor.js does not import withTransaction from ../pg');
    }
    t.pass('routes/doctor.js imports withTransaction from ../pg');
  } catch (e) { t.fail('import-withTransaction', e); }
}
