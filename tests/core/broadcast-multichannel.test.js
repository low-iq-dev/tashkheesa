// tests/core/broadcast-multichannel.test.js
//
// A3 (AUDIT 2026-09-09) — the broadcast must reach doctors by more than
// WhatsApp. broadcast.js queued channel:'whatsapp' ONLY, filtered on
// notify_whatsapp; WhatsApp is not yet wired (OPENCLAW_* unset), so a new paid
// case was announced to NOBODY. This guards the multi-channel rework: email +
// in-app bell for every eligible doctor (paused + onboarding filtered), with
// WhatsApp additionally for those who have it, via a new bilingual template.
//
// Verified NEGATIVELY: removing the is_paused filter and the 'new_case_available'
// template each failed the matching assertion; restored.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n📣 A3 — broadcast reaches doctors on email + the in-app bell\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

// ── STRUCTURAL: broadcast.js eligibility + channels ─────────────────────────

const bc = code('src/notify/broadcast.js');

check('eligibility excludes paused + onboarding-incomplete doctors', () => {
  if (!/COALESCE\(u\.is_paused, false\) = false/.test(bc)) return 'broadcast does not filter is_paused (A5)';
  if (!/COALESCE\(u\.onboarding_complete, false\) = true/.test(bc)) return 'broadcast does not filter onboarding_complete';
});

check('eligibility no longer GATES on notify_whatsapp / phone', () => {
  // notify_whatsapp may still be SELECTed (for the per-doctor WhatsApp decision)
  // but must not appear as a WHERE gate that would exclude doctors from email.
  if (/COALESCE\(u\.notify_whatsapp, false\) = true/.test(bc)) return 'notify_whatsapp still gates broadcast eligibility';
  if (/AND u\.phone IS NOT NULL AND u\.phone != ''/.test(bc)) return 'phone still gates broadcast eligibility';
});

check('every eligible doctor is queued on email + the in-app bell', () => {
  if (!/queueMultiChannelNotification\(/.test(bc)) return 'does not use queueMultiChannelNotification';
  if (!/channels:\s*\['internal',\s*'email'\]/.test(bc)) return 'does not queue internal + email channels';
  if (!/template:\s*'new_case_available'/.test(bc)) return "does not use the 'new_case_available' template";
});

check('WhatsApp is sent ADDITIONALLY, gated per doctor', () => {
  if (!/hasWhatsApp/.test(bc)) return 'no per-doctor WhatsApp gate';
  if (!/notify_whatsapp/.test(bc)) return 'WhatsApp gate does not consult notify_whatsapp';
  if (!/channel:\s*'whatsapp'/.test(bc)) return 'WhatsApp send removed entirely (should stay additionally)';
});

// ── STRUCTURAL: the new template is registered across every channel ─────────

check('new_case_available has a bilingual title', () => {
  const titles = code('src/notify/notification_titles.js');
  // Match the whole line — the title strings contain `{caseReference}`, whose
  // braces would truncate a `\{[^}]*\}` object match short of `ar:`.
  const line = titles.split('\n').find((l) => /^\s*new_case_available:/.test(l));
  if (!line) return 'no title entry';
  if (!/\ben:/.test(line) || !/\bar:/.test(line)) return 'title missing en or ar';
});

check('new_case_available maps to an email hbs that exists in en + ar', () => {
  const worker = code('src/notification_worker.js');
  if (!/new_case_available:\s*'new-case-available'/.test(worker)) return 'no TEMPLATE_TO_EMAIL mapping';
  for (const lang of ['en', 'ar']) {
    if (!fs.existsSync(path.join(ROOT, 'src/templates/email', lang, 'new-case-available.hbs'))) {
      return 'missing hbs for ' + lang;
    }
  }
});

// ── BEHAVIORAL: the template renders in both languages ──────────────────────

check('getNotificationTitles interpolates the ref in both languages', () => {
  const { getNotificationTitles } = require('../../src/notify/notification_titles');
  const r = getNotificationTitles('new_case_available', { caseReference: 'ABC123' });
  if (!r.title_en || !/ABC123/.test(r.title_en)) return 'EN title missing/uninterpolated';
  if (!r.title_ar || !/ABC123/.test(r.title_ar)) return 'AR title missing/uninterpolated';
});

check('renderNotificationMessage returns distinct, non-fallback copy per language', () => {
  const { renderNotificationMessage } = require('../../src/notify');
  const en = renderNotificationMessage('new_case_available', { caseReference: 'ABC123' }, 'en');
  const ar = renderNotificationMessage('new_case_available', { caseReference: 'ABC123' }, 'ar');
  if (!en || !/accept/i.test(en)) return 'EN body missing or does not mention accepting';
  if (!ar || ar === en) return 'AR body missing or identical to EN (untranslated)';
  if (/available in your specialty/i.test(ar)) return 'AR body fell back to English copy';
});
