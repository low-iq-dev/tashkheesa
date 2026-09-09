// tests/core/reassigned-doctor-loses-conversation.test.js
//
// A6 (AUDIT 2026-09-09) — a reassigned doctor must lose the conversation.
// case_lifecycle.reassignCase never touched conversations, and messaging.js
// keyed membership on conversations.doctor_id alone — so the OUTGOING doctor
// kept reading new messages and downloading their attachments (the attachment
// file_url rides in the message list) after the case moved to someone else.
//
// The fix makes every membership read require the doctor to be the case's
// CURRENT orders_active.doctor_id: the per-conversation gate getConversationForUser
// (which protects the message view, poll, send, mark-read AND the attachment
// file_url), both sidebar list queries, and the total-unread counter.
//
// Source-grep (the change is a SQL predicate; the repo's local DB is unmigrated
// so a live-DB assertion would skip). Verified NEGATIVELY: reverting
// getConversationForUser to the doctor-alone membership fails the gate check.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n💬 A6 — a reassigned doctor loses the conversation\n');

const ROOT = path.join(__dirname, '..', '..');
const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/routes/messaging.js'), 'utf8'));
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

// Carve out getConversationForUser.
const gStart = src.indexOf('async function getConversationForUser');
const gBody = gStart >= 0 ? src.slice(gStart, src.indexOf('\n}', gStart) + 2) : '';

check('getConversationForUser joins orders_active and requires the CURRENT doctor', () => {
  if (!gBody) return 'getConversationForUser not found';
  if (!/orders_active o ON o\.id = c\.order_id/.test(gBody)) return 'no orders_active join';
  if (!/c\.doctor_id = \$3 AND o\.doctor_id = \$3/.test(gBody)) {
    return 'the doctor branch does not require o.doctor_id = the requesting doctor';
  }
});

check('the old doctor-alone membership is gone from the gate', () => {
  // The exact pre-fix predicate must not survive anywhere in the gate.
  if (/FROM conversations WHERE id = \$1 AND \(patient_id = \$2 OR doctor_id = \$3\)/.test(gBody)) {
    return 'getConversationForUser still grants access on conversations.doctor_id alone';
  }
});

check('both sidebar list queries require the current doctor', () => {
  const matches = src.match(/o\.doctor_id = c\.doctor_id/g) || [];
  // two sidebar lists + total-unread = at least 3 occurrences.
  if (matches.length < 3) return 'expected the current-doctor predicate in both sidebars + total-unread, found ' + matches.length;
  if (/WHERE \(c\.patient_id = \$2 OR c\.doctor_id = \$3\)\s*\n\s*ORDER BY/.test(src)) {
    return 'a sidebar list still lists on conversations.doctor_id alone';
  }
});

check('total-unread does not count a reassigned doctor\'s old conversation', () => {
  const uStart = src.indexOf('total-unread');
  const uBody = uStart >= 0 ? src.slice(uStart, uStart + 700) : '';
  if (!/LEFT JOIN orders_active o ON o\.id = c\.order_id/.test(uBody)) return 'total-unread does not join orders_active';
  if (!/c\.doctor_id = \$2 AND o\.doctor_id = c\.doctor_id/.test(uBody)) return 'total-unread still counts on doctor_id alone';
});
