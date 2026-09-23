// tests/lint/privacy-policy-processors.test.js
//
// P-8 (2026-09-23) — the privacy policy named Uploadcare as the CURRENT upload
// processor (false since the R2 migration) and omitted the hosting provider
// and the push-delivery chain. Pins, in BOTH language blocks: Render hosting,
// Cloudflare R2 + network, Expo push via APNs / FCM, and Uploadcare only as
// the processor of legacy (pre-migration) files.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🔏 P-8 — privacy policy names the processors actually in use\n');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'views', 'privacy.ejs'), 'utf8');
const split = SRC.indexOf('Last updated:');
const AR = SRC.slice(0, split);
const EN = SRC.slice(split);

function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
}

for (const [lang, block] of [['en', EN], ['ar', AR]]) {
  check(lang + ': names Render, Cloudflare R2, Expo, APNs and Firebase Cloud Messaging', () => {
    const missing = ['Render', 'Cloudflare R2', 'Expo', 'APNs', 'Firebase Cloud Messaging'].filter((w) => !block.includes(w));
    return missing.length ? 'missing: ' + missing.join(', ') : null;
  });
}
check('en: Uploadcare appears only as the processor of legacy, pre-migration files', () => {
  if (/uploads are processed via Uploadcare/i.test(EN)) return 'still describes Uploadcare as the current upload processor';
  const s = EN.slice(EN.indexOf('Uploadcare') - 120, EN.indexOf('Uploadcare') + 40);
  return /before our move/.test(s) ? null : 'the Uploadcare mention is not framed as legacy';
});
check('ar: Uploadcare appears only as the processor of legacy, pre-migration files', () => {
  if (/تُعالَج عمليات رفع الملفات الطبية عبر Uploadcare/.test(AR)) return 'still describes Uploadcare as the current upload processor';
  return /قبل انتقالنا[^.]*Uploadcare/.test(AR) ? null : 'the Uploadcare mention is not framed as legacy';
});
