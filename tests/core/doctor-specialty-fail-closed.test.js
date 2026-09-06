// tests/core/doctor-specialty-fail-closed.test.js
//
// AUDIT-2026-09-06 (D2) — a doctor could assign themselves any specialty, or
// none, and be served cases accordingly.
//
// Three separate holes lined up:
//
//   * POST /portal/doctor/profile wrote users.specialty_id straight off the
//     request body with no check that the id names a real specialty, and
//     accepted the form's blank option as NULL;
//   * every unassigned-pool query filtered with `($1 = '' OR o.specialty_id =
//     $2)` — a filter that DISABLES ITSELF when the value is missing, so a
//     doctor with no specialty was served every unassigned paid case on the
//     platform rather than none;
//   * POST /portal/doctor/case/:id/accept had no specialty check at all, so
//     the queue was the only thing standing between a doctor and a case in a
//     field they do not practise.
//
// And src/auth.js:33 states that a route mutating users.specialty_id MUST call
// refreshSessionCookie — the profile route did not, so the queue kept filtering
// on the OLD specialty for up to the 7-day JWT lifetime.
//
// Pure source analysis: no DB, no boot. The fail-closed predicate builder is
// lifted out of the real file and EXECUTED, so this tests behaviour rather
// than the shape of a string.

'use strict';

const fs   = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🩺 doctor specialty filtering is fail-closed (AUDIT-2026-09-06 D2)\n');

const ROOT   = path.join(__dirname, '..', '..');
const SRC    = path.join(ROOT, 'src');
const ROUTE  = path.join(SRC, 'routes', 'doctor.js');

function walkJs(dir, out) {
  out = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') walkJs(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ── 1. No specialty filter anywhere may short-circuit to "match everything" ─
try {
  const offenders = [];
  for (const file of walkJs(SRC)) {
    // Comments stripped so the paragraph explaining why this shape is banned
    // does not read as the shape itself — see tests/_helpers/strip-comments.js.
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // The shape: an equality-to-empty-string escape hatch on the same
      // predicate as a specialty column. Matches both the literal `$1 = ''`
      // form and the interpolated `${pSpecId1} = ''` form the builders use.
      if (/=\s*''\s+OR\b/i.test(line) && /specialty_id/i.test(line)) {
        offenders.push(path.relative(ROOT, file) + ':' + (i + 1) + '  ' + line.trim());
      }
    });
  }
  if (offenders.length) {
    throw new Error('a specialty filter still disables itself when the specialty is ' +
                    'missing. A missing specialty is an unanswered question, not a ' +
                    'wildcard — the predicate must be FALSE:\n    ' + offenders.join('\n    '));
  }
  t.pass('no `= \'\' OR ... specialty_id` short-circuit survives anywhere in src/');
} catch (e) { t.fail('no specialty short-circuit', e); }

// ── 2. The predicate builder itself is fail-closed, and binds nothing when
//       there is nothing to bind (an unreferenced bind parameter is a
//       Postgres error, so the FALSE branch must not reserve one) ───────────
try {
  const src = stripComments(fs.readFileSync(ROUTE, 'utf8'));
  const m = src.match(/function\s+specialtyMatchSql\s*\([\s\S]*?\n\}/);
  if (!m) throw new Error('specialtyMatchSql is gone — the pool queries have no shared, ' +
                          'testable place where the fail-closed decision is made');

  // eslint-disable-next-line no-eval
  const specialtyMatchSql = eval('(' + m[0] + ')');

  let bindCalls = 0;
  const bind = (v) => { bindCalls++; return '$' + bindCalls; };

  for (const empty of ['', null, undefined, '   ']) {
    bindCalls = 0;
    const sql = specialtyMatchSql(empty, 'o.specialty_id', bind);
    if (sql !== 'FALSE') {
      throw new Error('a doctor with no specialty (' + JSON.stringify(empty) + ') produced ' +
                      JSON.stringify(sql) + ' — it must be FALSE, i.e. an empty pool, ' +
                      'never an unfiltered one');
    }
    if (bindCalls !== 0) {
      throw new Error('the FALSE branch bound a parameter the statement never references — ' +
                      'Postgres rejects that bind message and the whole queue 500s');
    }
  }

  bindCalls = 0;
  const matched = specialtyMatchSql('spec-cardio', 'o.specialty_id', bind);
  if (matched !== 'o.specialty_id = $1' || bindCalls !== 1) {
    throw new Error('a real specialty must still filter normally, binding exactly once; got ' +
                    JSON.stringify(matched) + ' with ' + bindCalls + ' bind(s)');
  }
  t.pass('specialtyMatchSql: empty specialty → FALSE and no bind; real specialty → equality');
} catch (e) { t.fail('specialtyMatchSql is fail-closed', e); }

// ── 3. Every pool query actually uses it ────────────────────────────────────
try {
  const src = stripComments(fs.readFileSync(ROUTE, 'utf8'));
  const builders = (src.match(/specialtyMatchSql\(doctorSpecialtyId/g) || []).length;
  const usages   = (src.match(/AND \$\{specClause\}/g) || []).length;
  if (builders < 4 || usages < 4) {
    throw new Error('expected all four unassigned-pool queries (two counts, two listings) ' +
                    'to build and use the fail-closed clause; found ' + builders +
                    ' builder(s) and ' + usages + ' usage(s)');
  }
  t.pass('all four unassigned-pool queries route their specialty filter through the helper');
} catch (e) { t.fail('pool queries use the helper', e); }

// ── 4. The profile route validates the id it writes, and re-signs the token ─
try {
  const src = stripComments(fs.readFileSync(ROUTE, 'utf8'));
  const start = src.indexOf("router.post('/portal/doctor/profile'");
  if (start < 0) throw new Error('POST /portal/doctor/profile not found');
  // Bounded to this handler so a validation elsewhere cannot satisfy the test.
  const handler = src.slice(start, start + 14000);

  if (!/SELECT id FROM specialties WHERE id = \$1/.test(handler)) {
    throw new Error('specialty_id is written without ever checking that it names a row in ' +
                    '`specialties` — the field is a plain <select> and the body is ' +
                    'whatever the doctor posts');
  }
  if (!/if\s*\(\s*!specialtyId\s*\)\s*\{[\s\S]{0,200}?fieldErrors\.specialty_id/.test(handler)) {
    throw new Error('the blank option must be rejected: a NULL specialty is what the pool ' +
                    'filter used to read as "no filter"');
  }
  if (!/refreshSessionCookie\(/.test(handler)) {
    throw new Error('src/auth.js:33 — a route mutating users.specialty_id MUST call ' +
                    'refreshSessionCookie, or the queue keeps filtering on the specialty ' +
                    'baked into the old JWT for up to seven days');
  }
  t.pass('profile update validates specialty_id against the table and re-signs the session');
} catch (e) { t.fail('profile specialty is validated', e); }

// ── 5. Accept authorises on specialty itself ────────────────────────────────
try {
  const src = stripComments(fs.readFileSync(ROUTE, 'utf8'));
  const start = src.indexOf("router.post('/portal/doctor/case/:caseId/accept'");
  if (start < 0) throw new Error('POST /portal/doctor/case/:caseId/accept not found');
  const handler = src.slice(start, start + 9000);

  if (!/orderSpecialtyId/.test(handler) || !/msg=specialty/.test(handler)) {
    throw new Error('accept still performs no specialty check. Authorisation has to sit on ' +
                    'the action, not only on the queue that lists it — a typed URL was ' +
                    'enough to take a case in another field');
  }
  if (!/SELECT specialty_id FROM users WHERE id = \$1/.test(handler)) {
    throw new Error("accept must read the doctor's specialty from the users row: req.user's " +
                    'copy comes from a JWT that can be up to seven days stale');
  }
  t.pass('accept refuses a case outside the doctor\'s specialty, checked against the DB');
} catch (e) { t.fail('accept checks specialty', e); }
