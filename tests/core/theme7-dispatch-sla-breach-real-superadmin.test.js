// tests/core/theme7-dispatch-sla-breach-real-superadmin.test.js
//
// Theme 7 sub-issue B regression guard.
//
// Asserts that notify.dispatchSlaBreach queries active superadmins
// instead of the hardcoded `'superadmin-1'` placeholder. The original
// code at notify.js:441 sent the WhatsApp breach alert to a user-id
// that does not exist in production — every breach silently failed
// to escalate.
//
// Theme 7b Phase 1 (2026-05-10) refactored dispatchSlaBreach to
// delegate to the shared `notifyAdmins` helper. The semantic
// guarantees (no hardcoded recipient, real-superadmin SELECT, per-
// recipient WhatsApp fan-out) are preserved — but the assertions
// now look at TWO functions in notify.js (dispatchSlaBreach +
// notifyAdmins) instead of one.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📡 Theme 7 sub-B — dispatchSlaBreach queries real superadmins (post-7b refactor)\n');

const NOTIFY = path.join(__dirname, '..', '..', 'src', 'notify.js');
const src = fs.readFileSync(NOTIFY, 'utf8');

function sliceFn(text, name) {
  const start = text.indexOf('async function ' + name + '(');
  if (start < 0) return null;
  const after = text.slice(start);
  const nextFn = after.search(/\n(?:async )?function /);
  return nextFn > 0 ? after.slice(0, nextFn) : after;
}

const dispatchBody = sliceFn(src, 'dispatchSlaBreach');
const notifyAdminsBody = sliceFn(src, 'notifyAdmins');

if (!dispatchBody) {
  t.fail('locate dispatchSlaBreach', new Error('dispatchSlaBreach not found in notify.js'));
} else if (!notifyAdminsBody) {
  t.fail('locate notifyAdmins', new Error('notifyAdmins not found in notify.js (Theme 7b Phase 1 should have introduced it)'));
} else {

  // ── 1. dispatchSlaBreach has no hardcoded 'superadmin-1' recipient ──
  try {
    if (/toUserId:\s*['"]superadmin-1['"]/.test(dispatchBody)) {
      throw new Error("dispatchSlaBreach still uses 'superadmin-1' as toUserId");
    }
    if (/queueNotification\([\s\S]{0,200}['"]superadmin-1['"]/i.test(dispatchBody)) {
      throw new Error("dispatchSlaBreach still passes 'superadmin-1' to queueNotification");
    }
    t.pass("dispatchSlaBreach no longer routes WhatsApp to hardcoded 'superadmin-1' user");
  } catch (e) { t.fail('no-hardcoded-recipient', e); }

  // ── 2. dispatchSlaBreach delegates to notifyAdmins ──
  try {
    if (!/notifyAdmins\s*\(/.test(dispatchBody)) {
      throw new Error('dispatchSlaBreach does not call notifyAdmins(...) — Theme 7b refactor incomplete');
    }
    if (!/channel\s*:\s*['"]whatsapp['"]/.test(dispatchBody)) {
      throw new Error('dispatchSlaBreach must pass channel: \'whatsapp\' to notifyAdmins');
    }
    if (!/template\s*:\s*['"]sla_breach['"]/.test(dispatchBody)) {
      throw new Error('dispatchSlaBreach must pass template: \'sla_breach\' to notifyAdmins');
    }
    t.pass('dispatchSlaBreach delegates to notifyAdmins(channel=whatsapp, template=sla_breach)');
  } catch (e) { t.fail('delegates-to-notifyAdmins', e); }

  // ── 3. notifyAdmins SELECTs active superadmins ──
  try {
    if (!/SELECT id FROM users WHERE role = 'superadmin'[\s\S]{0,80}is_active/i.test(notifyAdminsBody)) {
      throw new Error("notifyAdmins does not SELECT active superadmins from users");
    }
    t.pass("notifyAdmins queries `users WHERE role='superadmin' AND is_active`");
  } catch (e) { t.fail('queries-active-superadmins', e); }

  // ── 4. notifyAdmins iterates recipients + queues per-recipient ──
  try {
    if (!/for\s*\(\s*const\s+r\s+of\s+recipients\s*\)/.test(notifyAdminsBody)) {
      throw new Error('notifyAdmins does not iterate over the recipients array');
    }
    if (!/toUserId:\s*r\.id/.test(notifyAdminsBody)) {
      throw new Error('notifyAdmins does not pass r.id as toUserId per iteration');
    }
    if (!/dedupe_key:\s*`\$\{dedupeKey\}:\$\{r\.id\}`/.test(notifyAdminsBody)) {
      throw new Error('notifyAdmins does not use per-recipient dedupe key suffix `${dedupeKey}:${r.id}` — uniqueness on (dedupe_key, channel, to_user_id) would not hold');
    }
    t.pass('notifyAdmins iterates recipients + per-recipient dedupe key suffix');
  } catch (e) { t.fail('per-recipient-fan-out', e); }

  // ── 5. notifyAdmins early-exits on zero recipients ──
  try {
    if (!/recipients\.length\s*===\s*0/.test(notifyAdminsBody)) {
      throw new Error("notifyAdmins does not early-exit on zero recipients");
    }
    t.pass('notifyAdmins early-exits on zero active superadmins');
  } catch (e) { t.fail('zero-recipients-guard', e); }
}
