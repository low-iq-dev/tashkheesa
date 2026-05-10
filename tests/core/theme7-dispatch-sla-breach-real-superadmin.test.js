// tests/core/theme7-dispatch-sla-breach-real-superadmin.test.js
//
// Theme 7 sub-issue B regression guard.
//
// Asserts that notify.dispatchSlaBreach queries active superadmins
// instead of the hardcoded `'superadmin-1'` placeholder. The original
// code at notify.js:441 sent the WhatsApp breach alert to a user-id
// that does not exist in production — every breach silently failed
// to escalate.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📡 Theme 7 sub-B — dispatchSlaBreach queries real superadmins (source check)\n');

const NOTIFY = path.join(__dirname, '..', '..', 'src', 'notify.js');
const src = fs.readFileSync(NOTIFY, 'utf8');

// Slice the dispatchSlaBreach body.
const start = src.indexOf('async function dispatchSlaBreach(');
if (start < 0) {
  t.fail('locate dispatchSlaBreach', new Error('dispatchSlaBreach not found in notify.js'));
} else {
  const after = src.slice(start);
  const nextFn = after.search(/\nasync function /);
  const body = nextFn > 0 ? after.slice(0, nextFn) : after;

  // 1. The hardcoded `'superadmin-1'` literal is no longer used as a
  //    runtime recipient. Permitted in commentary explaining the bug
  //    that was fixed; not permitted as `toUserId:` or as a SQL
  //    parameter literal.
  try {
    if (/toUserId:\s*['"]superadmin-1['"]/.test(body)) {
      throw new Error("dispatchSlaBreach still uses 'superadmin-1' as toUserId");
    }
    if (/queueNotification\([\s\S]{0,200}['"]superadmin-1['"]/i.test(body)) {
      throw new Error("dispatchSlaBreach still passes 'superadmin-1' to queueNotification");
    }
    t.pass("dispatchSlaBreach no longer routes WhatsApp to hardcoded 'superadmin-1' user");
  } catch (e) { t.fail('no-hardcoded-recipient', e); }

  // 2. Query for active superadmins is present.
  try {
    if (!/SELECT id FROM users WHERE role = 'superadmin'[\s\S]{0,80}is_active/i.test(body)) {
      throw new Error("dispatchSlaBreach does not SELECT active superadmins from users");
    }
    t.pass("dispatchSlaBreach queries `users WHERE role='superadmin' AND is_active`");
  } catch (e) { t.fail('queries-active-superadmins', e); }

  // 3. Per-recipient dedupe pattern (matches sendSlaReminder).
  try {
    if (!/dedupe_key\s*=\s*\$1\s*[\s\S]{0,40}AND channel\s*=\s*\$2[\s\S]{0,40}AND to_user_id\s*=\s*\$3/i.test(body)) {
      throw new Error("dispatchSlaBreach does not perform per-recipient dedupe (dedupe_key + channel + to_user_id)");
    }
    t.pass("dispatchSlaBreach uses per-recipient dedupe (dedupe_key + channel + to_user_id)");
  } catch (e) { t.fail('per-recipient-dedupe', e); }

  // 4. Loop over recipients, queue per-recipient WhatsApp.
  try {
    if (!/for\s*\(\s*const\s+r\s+of\s+recipients\s*\)/.test(body)) {
      throw new Error("dispatchSlaBreach does not iterate over the recipients array");
    }
    if (!/toUserId:\s*r\.id/.test(body)) {
      throw new Error("dispatchSlaBreach does not pass r.id as toUserId per iteration");
    }
    if (!/channel:\s*['"]whatsapp['"]/.test(body)) {
      throw new Error("dispatchSlaBreach no longer fires the whatsapp channel");
    }
    if (!/template:\s*['"]sla_breach['"]/.test(body)) {
      throw new Error("dispatchSlaBreach no longer uses the sla_breach template");
    }
    t.pass('dispatchSlaBreach iterates real superadmins + fires WhatsApp template `sla_breach` per recipient');
  } catch (e) { t.fail('per-recipient-fan-out', e); }

  // 5. Empty-recipients early-exit.
  try {
    if (!/recipients\.length\s*===\s*0/.test(body)) {
      throw new Error("dispatchSlaBreach does not early-exit on zero recipients");
    }
    t.pass('dispatchSlaBreach early-exits on zero active superadmins');
  } catch (e) { t.fail('zero-recipients-guard', e); }
}
