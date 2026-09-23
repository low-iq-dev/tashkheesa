// tests/core/final-audit-draft-attach.test.js
//
// Final-audit batch (2026-09-23) — POST /api/v1/cases/draft/:id/files.
//   U-6  the MAX_FILES count check and the insert were separate autocommitted
//        statements; the app's parallel attach fan-out could overshoot 15 and
//        then be refused at submit. Now: one transaction that locks the draft
//        row FOR UPDATE, THEN counts, THEN inserts.
//   U-7  mobile inserts never wrote order_files.label, so the doctor saw
//        /files/<uuid> and downloads saved as <uuid>.heic. label = filename.
// Source pins (the route needs a real Postgres to exercise the lock).

'use strict';

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n📎 final audit — draft attach is race-safe and labelled (U-6, U-7)\n');

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const ROOT = path.join(__dirname, '..', '..');
const DRAFT = stripComments(fs.readFileSync(path.join(ROOT, 'src/routes/api/cases_draft.js'), 'utf8'));
const CASES = stripComments(fs.readFileSync(path.join(ROOT, 'src/routes/api/cases.js'), 'utf8'));

function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
}

const start = DRAFT.indexOf("router.post('/:id/files'");
const end = DRAFT.indexOf('router.', start + 10);
const ATTACH = DRAFT.slice(start, end);

check('U-6: attach runs in withTransaction, locking the draft row before counting and inserting', () => {
  if (start < 0) return 'attach route not found';
  if (!/withTransaction\(/.test(ATTACH)) return 'attach is not transactional';
  const lock = ATTACH.search(/FROM orders_active[\s\S]{0,200}FOR UPDATE/);
  const count = ATTACH.search(/SELECT COUNT\(\*\) AS c FROM order_files/);
  const insert = ATTACH.search(/INSERT INTO order_files/);
  if (lock < 0) return 'no FOR UPDATE lock on the draft row';
  if (!(lock < count && count < insert)) return 'order must be lock → count → insert';
  if (/await queryOne\(\s*'SELECT COUNT/.test(ATTACH)) return 'an unlocked pool-level count is still present';
  if (!/client\.query\(\s*`INSERT INTO order_files/.test(ATTACH)) return 'insert does not run on the transaction client';
  if (!/'TOO_MANY_FILES'/.test(ATTACH)) return 'TOO_MANY_FILES answer lost';
  return null;
});

check('U-7: the draft attach and POST /cases both write label = filename', () => {
  const m = /INSERT INTO order_files\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/.exec(ATTACH);
  if (!m) return 'draft insert not found';
  const cols = m[1].split(',').map((x) => x.trim());
  const vals = m[2].split(',').map((x) => x.trim());
  if (vals[cols.indexOf('label')] !== vals[cols.indexOf('filename')]) return 'draft insert: label is not bound to the filename parameter';
  const c = /INSERT INTO order_files \(([^)]*)\)\s*VALUES \(([^)]*)\)/.exec(CASES);
  if (!c) return 'POST /cases insert not found';
  const cc = c[1].split(',').map((x) => x.trim());
  const cv = c[2].split(',').map((x) => x.trim());
  if (cc.indexOf('label') < 0 || cv[cc.indexOf('label')] !== cv[cc.indexOf('filename')]) return 'POST /cases insert: label is not the filename';
  return null;
});
