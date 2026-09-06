// tests/core/referral-csrf-and-unread.test.js
//
// Two bugs of the same shape: a client-side read of something that does not
// exist, wrapped in a handler that turned the failure into a plausible-looking
// zero. Guarded together because the guard is the same — assert the thing being
// read is actually produced.
//
// AUDIT-REFERRAL-CSRF-2026-09-06. public/js/payment-addons.js took its CSRF
// token from <meta name="csrf-token">. No view in this repo renders that tag,
// so the token was always ''. Under CSRF_MODE=enforce every referral redemption
// 403'd — referral codes could not be applied at all — and because the fetch
// sent no Accept header the 403 came back as text/plain, r.json() threw, and the
// patient was shown "Network error" for a perfectly good code.
//
// AUDIT-UNREAD-2026-09-06. The patient dashboard counted unread messages with
// `messages.case_id` and `messages.read_at`. Neither column exists (the real
// ones are conversation_id and is_read, with the case id on
// conversations.order_id), the statement raised "column case_id does not exist"
// on every render, and a bare `catch (_) {}` turned that into 0. Every other
// patient page passed the literal `unreadCount: 0` into the chrome. So the badge
// that tells a patient their consultant has replied was hardcoded off across the
// entire portal — in a product whose deliverable IS the doctor's reply.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
function expect(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\n🎟️  Referral CSRF + unread-message badge\n');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');

function walkViews(dir, out) {
  out = out || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkViews(p, out);
    else if (e.name.endsWith('.ejs')) out.push(p);
  }
  return out;
}

// ── 1. The referral fetch carries a token that a view actually renders ────
try {
  const JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'payment-addons.js'), 'utf8');
  const CODE = stripComments(JS);

  expect(!/meta\[name="csrf-token"\]/.test(CODE),
    'the token must not be read from a meta tag that no view renders — that was the bug, and ' +
    'the comment above the fix is allowed to say so, which is why this scans stripped code');
  expect(/data-csrf-token/.test(CODE),
    'the token must come from the page data element this script already reads');

  const PAY_VIEW = fs.readFileSync(path.join(VIEWS, 'patient_payment_required.ejs'), 'utf8');
  expect(/data-csrf-token="<%=/.test(PAY_VIEW),
    'patient_payment_required must actually render data-csrf-token — a client reading an ' +
    'attribute nobody writes is the same bug in a new place');
  expect(/data-csrf-token="<%=[^"]*csrfToken/.test(PAY_VIEW),
    'it must come from the csrfToken EJS local (res.locals, src/middleware/csrf.js) — the same ' +
    'source the Pay button on this very page uses');

  // Second half: without Accept, a CSRF rejection is text/plain and r.json()
  // throws, so a 403 is reported to the patient as "Network error".
  const refIdx = CODE.indexOf("/api/referral/apply");
  expect(refIdx !== -1, 'the referral fetch must exist');
  const fetchBlock = CODE.slice(refIdx, refIdx + 700);
  expect(/'Accept':\s*'application\/json'/.test(fetchBlock),
    "the referral fetch must send Accept: application/json — src/middleware/csrf.js only " +
    'answers with JSON when JSON was asked for, so without it every refusal reads as a ' +
    'network error');
  expect(/x-csrf-token/.test(fetchBlock), 'the token must be sent on the request');
  t.pass('referral POST carries a rendered CSRF token and asks for JSON errors');
} catch (e) { t.fail('referral CSRF', e); }

// ── 2. The unread count queries columns that exist ────────────────────────
try {
  const SVC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'patient_unread.js'), 'utf8');
  const CODE = stripComments(SVC);

  expect(!/messages[\s\S]{0,200}?\bcase_id\b/.test(CODE) || !/FROM messages[\s\S]{0,300}case_id/.test(CODE),
    'messages has no case_id column');
  expect(!/\bread_at\b/.test(CODE), 'messages has no read_at column');
  expect(/conversation_id/.test(CODE) && /is_read/.test(CODE),
    'the real columns are conversation_id and is_read');
  expect(/JOIN conversations/.test(CODE),
    'the case id lives on conversations.order_id — reaching it requires the join that was missing');
  expect(/IS DISTINCT FROM/.test(CODE),
    'a NULL sender_id (system message) must count as "not from the patient"; plain <> yields ' +
    'NULL and silently drops the row');
  expect(/COALESCE\(m\.is_read, false\)/.test(CODE),
    'is_read is nullable, and NULL means never read — not "unknown, so ignore"');

  const PATIENT = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient.js'), 'utf8'));
  expect(!/messages\s*\n?\s*WHERE case_id/.test(PATIENT) && !/read_at IS NULL/.test(PATIENT),
    'the broken query must be gone from routes/patient.js');
  expect(/countPatientUnreadMessagesForCase/.test(PATIENT),
    'the dashboard must use the shared helper');

  // The catch that hid it for the whole life of the feature.
  const dashIdx = PATIENT.indexOf('activeUnreadMessages = 0');
  expect(dashIdx !== -1, 'the dashboard unread block must exist');
  const block = PATIENT.slice(dashIdx, dashIdx + 900);
  expect(!/catch \(_\)/.test(block),
    'no silent catch here: a bare catch around this query is precisely what made a ' +
    'missing-column error look like "you have no unread messages" for months');
  expect(/logErrorToDb/.test(block),
    'a failure must be recorded');
  t.pass('unread count uses the real schema, joins conversations, and no longer hides its errors');
} catch (e) { t.fail('unread query', e); }

// ── 3. No patient view hardcodes the badge to zero ────────────────────────
try {
  const offenders = [];
  walkViews(VIEWS).forEach(function (f) {
    const src = fs.readFileSync(f, 'utf8');
    if (/unreadCount:\s*0\b/.test(src)) offenders.push(path.relative(VIEWS, f));
  });
  expect(offenders.length === 0,
    'these views hardcode the unread badge to zero, which is how the whole portal reported ' +
    '"no new messages" regardless of the truth: ' + offenders.join(', ') +
    '. Omit the local and let the chrome read res.locals.patientUnreadMessages');

  // And the chrome must actually have that fallback, or omitting the local is
  // just a quieter zero.
  ['sidebar', 'mobile-tabbar', 'head', 'foot'].forEach(function (p) {
    const src = fs.readFileSync(path.join(VIEWS, 'partials', 'patient', p + '.ejs'), 'utf8');
    expect(/patientUnreadMessages/.test(src),
      'partials/patient/' + p + ' must fall back to res.locals.patientUnreadMessages');
  });

  const SERVER = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8'));
  expect(/patientUnreadMessages\(\)/.test(SERVER),
    'the middleware that populates the count must be mounted, or the fallback resolves to ' +
    'undefined and every badge is silently zero again');
  const MW = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'middleware', 'patient_unread.js'), 'utf8'));
  expect(/logErrorToDb/.test(MW),
    'the middleware must log a failure rather than swallow it');
  t.pass('no view hardcodes zero; the chrome falls back to the middleware value, which is mounted');
} catch (e) { t.fail('hardcoded unreadCount', e); }
