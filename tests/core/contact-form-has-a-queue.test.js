'use strict';
// tests/core/contact-form-has-a-queue.test.js
//
// 2026-09-22
//
// POST /contact wrote every submission to error_logs with
// category='contact_form', level='info'. That is an error feed: no status, no
// owner, no way to mark something answered, and nobody reads it hunting for
// patients. 66 rows accumulated there between 23 Aug and 20 Sep.
//
// The cost was already paid once — a patient in Poland enquired on 30 July
// through the sibling /coming-soon form and waited eight weeks, because it
// landed somewhere with no queue behind it.
//
// These pin the two halves of the fix: a real destination with a status, and
// spam that is recorded rather than either let through or silently dropped.

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n📮 a real enquiry reaches a queue somebody works\n');

const root = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const routes = read('src/routes/static-pages.js');
const middleware = read('src/middleware.js');
const view = read('src/views/contact.ejs');
const handler = (() => {
  const from = routes.indexOf("router.post('/contact'");
  return routes.slice(from, routes.indexOf('router.', from + 30) + 4000);
})();

function check(name, fn) {
  try { const err = fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
}

// ── the destination ───────────────────────────────────────────────────────

check('a contact_submissions migration exists', () => {
  const f = fs.readdirSync(path.join(root, 'src/migrations'))
    .find((n) => /contact_submissions/.test(n));
  return f ? null : 'no migration creates the table';
});

check('the table carries a status, not just a row', () => {
  const f = fs.readdirSync(path.join(root, 'src/migrations')).find((n) => /contact_submissions/.test(n));
  const sql = read('src/migrations/' + f);
  for (const col of ['status', 'spam_reason', 'answered_at', 'answered_by']) {
    if (!new RegExp('\\b' + col + '\\b').test(sql)) return 'missing column: ' + col;
  }
  return null;
});

check('there is an index for "what has nobody answered"', () => {
  const f = fs.readdirSync(path.join(root, 'src/migrations')).find((n) => /contact_submissions/.test(n));
  const sql = read('src/migrations/' + f);
  return /WHERE status = 'new'/.test(sql) ? null : 'no partial index on open submissions';
});

check('the table has row-level security, like every other public-data table', () => {
  const f = fs.readdirSync(path.join(root, 'src/migrations')).find((n) => /contact_submissions/.test(n));
  return /ENABLE ROW LEVEL SECURITY/.test(read('src/migrations/' + f)) ? null : 'RLS not enabled';
});

check('the handler writes to contact_submissions', () => (
  /INSERT INTO contact_submissions/.test(handler) ? null : 'submissions still only reach error_logs'
));

check('the row is written before the mail attempt', () => {
  const ins = handler.indexOf('INSERT INTO contact_submissions');
  const mail = handler.indexOf('sendMail');
  if (ins === -1) return 'no insert';
  if (mail === -1) return 'no mail';
  return ins < mail ? null : 'mail is attempted before the enquiry is recorded';
});

check('a failed insert does not lose the enquiry', () => {
  const ins = handler.indexOf('INSERT INTO contact_submissions');
  const after = handler.slice(ins, ins + 900);
  return /catch/.test(after) ? null : 'the insert is unguarded — a DB blip would 500 on a patient';
});

// ── the spam half ─────────────────────────────────────────────────────────

check('/contact is rate limited', () => (
  /app\.use\('\/contact',\s*authLimiter\)/.test(middleware)
    ? null : 'no limiter — five identical posts in two seconds is what happened before'
));

check('the form carries a honeypot', () => (
  /name="company"/.test(view) ? null : 'no honeypot field'
));

check('the honeypot is hidden inline, not by a stylesheet class', () => (
  /left:-10000px/.test(view) ? null : 'hidden by CSS alone — a failed stylesheet exposes it'
));

// contactSpamReason() is defined just above the handler, so this looks at the
// whole file rather than the sliced handler body.
check('a submission from our own domain is treated as spam', () => (
  /own_domain/.test(routes) && /tashkheesa/.test(routes.slice(routes.indexOf('function contactSpamReason'), routes.indexOf('function contactSpamReason') + 400))
    ? null : 'nothing rejects sales@tashkheesa.com as a sender'
));

check('spam is STORED, not discarded — a false positive must be recoverable', () => {
  if (!/'spam'/.test(handler)) return 'no spam status is written';
  const ins = handler.indexOf('INSERT INTO contact_submissions');
  const guard = handler.indexOf('if (spamReason)');
  if (guard === -1) return 'no spam branch';
  return ins < guard ? null : 'the spam branch returns before the row is written — the sender is lost';
});

check('a spam submission is answered like a success, so a bot learns nothing', () => {
  const guard = handler.indexOf('if (spamReason)');
  const branch = handler.slice(guard, guard + 400);
  return /sent=1|ok: true/.test(branch) ? null : 'the spam path answers differently and is probeable';
});

check('spam does not trigger the notification email', () => {
  const guard = handler.indexOf('if (spamReason)');
  const mail = handler.indexOf('sendMail');
  return guard < mail ? null : 'spam still emails the team';
});
