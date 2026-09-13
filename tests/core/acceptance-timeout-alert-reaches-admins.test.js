// tests/core/acceptance-timeout-alert-reaches-admins.test.js
//
// Part B item 6 (2026-09-13) — acceptance-timeout admin alerts.
//
// workers/acceptance_watcher.js queued its "case auto-assigned after
// acceptance timeout" bell row to toUserId 'superadmin-1' — a demo-seed id
// that does not exist in production (checked read-only 2026-09-13). Every
// such alert was a row nobody could see. It now fans out through
// notifyAdmins (a bell row per active superadmin) AND pushOpsEvent (persists
// to the Command app's Activity feed and pages registered devices), matching
// the other worker alerts.
//
// Source-grep. Verified NEGATIVELY: restoring the 'superadmin-1' queue call
// fails the first two assertions.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n⏱️  Part B-6 — acceptance-timeout alerts reach real superadmins\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

const AW = code('src/workers/acceptance_watcher.js');

check("no live 'superadmin-1' recipient anywhere in src/ (comments stripped)", () => {
  const dirs = ['src'];
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name === 'locales.archived-2026-05') continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.isFile() && e.name.endsWith('.js') && /['"]superadmin-1['"]/.test(code(rel))) hits.push(rel);
    }
  })('src');
  if (hits.length) return 'still referenced in: ' + hits.join(', ');
});

check('acceptance_watcher fans the timeout alert out through notifyAdmins with the same template + dedupe key', () => {
  if (!/notifyAdmins\(\{[\s\S]{0,400}template:\s*'acceptance_timeout_auto_assigned_admin'/.test(AW)) return 'notifyAdmins call with the template not found';
  if (!/dedupeKey:\s*'auto_assign_admin:' \+ order\.id/.test(AW)) return 'dedupe key changed';
  if (!/require\('\.\.\/notify'\)[\s\S]{0,5}/.test(AW) || !/\{ queueNotification, notifyAdmins \}/.test(AW)) return 'notifyAdmins not imported from ../notify';
});

check('…and through pushOpsEvent so it PERSISTS to the Activity feed (deduped per case)', () => {
  const i = AW.indexOf("kind: 'acceptance_timeout_auto_assigned'");
  if (i < 0) return 'no pushOpsEvent kind for the timeout alert';
  const around = AW.slice(i - 200, i + 600);
  if (!/pushOpsEvent\(\{/.test(around)) return 'kind is not inside a pushOpsEvent call';
  if (!/dedupeKey:\s*String\(order\.id\)/.test(around)) return 'not deduped per case';
  if (!/orderId:\s*order\.id/.test(around)) return 'orderId not recorded on the log row';
});

check('both sends are awaited inside their own try/catch — a failed page cannot abort the assignment that already committed', () => {
  const i = AW.indexOf("template: 'acceptance_timeout_auto_assigned_admin'");
  const block = AW.slice(i - 400, i + 1200);
  if ((block.match(/try \{\s*await (notifyAdmins|pushOpsEvent)\(/g) || []).length !== 2) return 'expected two awaited, try-wrapped sends';
  if (!/context: 'acceptance_watcher\.notify_admins'/.test(block) || !/context: 'acceptance_watcher\.ops_push'/.test(block)) return 'failures are not logged to error_logs';
});
