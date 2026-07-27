// tests/core/notify-admins-inserts-rows.test.js
//
// Launch-audit finding B2 regression guard — notifyAdmins() must actually
// enqueue notification rows for admin recipients.
//
// The bug: src/notify.js imported only `{ queryOne, execute }` from ./pg,
// but notifyAdmins() calls `queryAll(...)` to look up superadmins. Every
// call threw a ReferenceError, which its try/catch swallowed and returned
// []. Net effect: SLA pre-breach alerts, breach WhatsApp escalation, and
// stale-video-slot alerts NEVER reached any admin — silent at launch.
//
// Two-stage verification (same "no real DB, no server boot" shape as
// theme8-notification-dropped.test.js):
//   STAGE A — source-grep: notify.js destructures queryAll from require('./pg').
//   STAGE B — behavioral: spawn an isolated subprocess with a mocked pg,
//             call notifyAdmins for 2 fake superadmins, and assert it
//             INSERTs one notifications row per admin. If queryAll is ever
//             dropped from the import again, notifyAdmins throws internally,
//             returns [], inserts nothing, and STAGE B fails loudly.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭\xEF\xB8\x8F\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📣 B2 — notifyAdmins() enqueues a notifications row per admin\n');

function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

const projectRoot = path.join(__dirname, '..', '..');

// ─────────────────────────────────────────────────────────────────────────
// STAGE A — source-grep: queryAll is imported from ./pg.
// ─────────────────────────────────────────────────────────────────────────
let notifySrc = '';
try { notifySrc = fs.readFileSync(path.join(projectRoot, 'src', 'notify.js'), 'utf8'); }
catch (e) { t.fail(fileTag + ': read notify.js', e); }

assert(
  /const\s*\{[^}]*\bqueryAll\b[^}]*\}\s*=\s*require\(\s*['"]\.\/pg['"]\s*\)/.test(notifySrc),
  "notify.js destructures queryAll from require('./pg')",
  "queryAll not imported from ./pg — notifyAdmins would throw ReferenceError and silently return []"
);

// ─────────────────────────────────────────────────────────────────────────
// STAGE B — behavioral: mocked pg in an isolated subprocess.
// ─────────────────────────────────────────────────────────────────────────
const subprocessScript = `
'use strict';
(async function () {
  const path = require('path');
  const projectRoot = ${JSON.stringify(projectRoot)};

  // Mock pg BEFORE requiring notify so notify's destructure picks up the mocks.
  const pgModule = require(path.join(projectRoot, 'src', 'pg'));
  const inserts = [];
  pgModule.queryAll = async function (sql) {
    // notifyAdmins' active-superadmin lookup.
    if (/FROM\\s+users\\s+WHERE\\s+role\\s*=\\s*'superadmin'/i.test(sql)) {
      return [{ id: 'admin_1' }, { id: 'admin_2' }];
    }
    return [];
  };
  pgModule.queryOne = async function () { return null; };   // no dedupe hit
  pgModule.execute  = async function (sql, params) {
    if (/INSERT\\s+INTO\\s+notifications/i.test(sql)) {
      inserts.push({ params: params });
    }
    return { rowCount: 1 };
  };

  const notify = require(path.join(projectRoot, 'src', 'notify'));

  const results = await notify.notifyAdmins({
    template: 'sla_breach',
    payload: { case_id: 'case_test_1', status: 'breached' },
    dedupeKey: 'sla:breach:case_test_1',
    orderId: 'case_test_1',
    channel: 'internal'
  });
  await new Promise(function (r) { setImmediate(r); });

  // INSERT column order: (id, order_id, to_user_id, ...) → to_user_id is params[2].
  const recipients = inserts.map(function (i) { return i.params && i.params[2]; });
  process.stdout.write('NOTIFY_ADMINS_RESULT=' + JSON.stringify({
    insertCount: inserts.length,
    recipients: recipients,
    resultCount: Array.isArray(results) ? results.length : -1
  }) + '\\n');
})().catch(function (err) {
  process.stderr.write('SUBPROC_ERROR: ' + (err && err.stack || err) + '\\n');
  process.exit(2);
});
`;

let subprocOut = '';
let subprocErr = null;
try {
  subprocOut = execFileSync(process.execPath, ['-e', subprocessScript], {
    encoding: 'utf8',
    timeout: 15000,
    env: Object.assign({}, process.env, { PG_SSL: 'false' })
  });
} catch (e) {
  subprocErr = e;
}

if (subprocErr) {
  t.fail(fileTag + ': subprocess exited with error',
    new Error('stderr: ' + ((subprocErr.stderr && subprocErr.stderr.toString()) || subprocErr.message)));
} else {
  const marker = 'NOTIFY_ADMINS_RESULT=';
  const idx = subprocOut.indexOf(marker);
  if (idx === -1) {
    t.fail(fileTag + ': subprocess did not emit NOTIFY_ADMINS_RESULT line',
      new Error('stdout was: ' + subprocOut.slice(0, 500)));
  } else {
    const jsonLine = subprocOut.slice(idx + marker.length).split('\n')[0];
    let res = null;
    try { res = JSON.parse(jsonLine); }
    catch (e) { t.fail(fileTag + ': malformed subprocess JSON', new Error('line=' + jsonLine.slice(0, 200))); }
    if (res) {
      assert(res.insertCount === 2,
        "notifyAdmins INSERTs one notifications row per admin (2 admins → 2 rows)",
        "insertCount=" + res.insertCount + " (0 ⇒ queryAll import regression: notifyAdmins threw and returned [])");
      assert(res.recipients.indexOf('admin_1') !== -1 && res.recipients.indexOf('admin_2') !== -1,
        "each admin is the to_user_id of its enqueued row",
        "recipients=" + JSON.stringify(res.recipients));
      assert(res.resultCount === 2,
        "notifyAdmins returns a per-recipient result array (not the [] error path)",
        "resultCount=" + res.resultCount);
    }
  }
}
