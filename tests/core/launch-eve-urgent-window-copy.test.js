'use strict';
// tests/core/launch-eve-urgent-window-copy.test.js
//
// 2026-09-24 (launch eve, T1). An Urgent case whose payment is confirmed
// outside 07:00–19:00 Cairo starts its 4 hours at 07:00
// (case_lifecycle.markCasePaid). Only /ar/delivery-policy said so. The rule is
// now one sentence, EN + AR, built from the window constants in
// services/urgency_window.js and rendered wherever a patient picks a tier.

const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n⏰ the Urgent off-hours rule is said where patients buy\n');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const uw = require('../../src/services/urgency_window');

function check(name, fn) {
  return Promise.resolve().then(fn).then(() => t.pass(name), (e) => t.fail(name, e));
}

(async () => {
  await check('the window constants drive the gate (07:00 open, 19:00 closed, Cairo)', () => {
    if (uw.URGENT_WINDOW_START_HOUR !== 7 || uw.URGENT_WINDOW_END_HOUR !== 19) throw new Error('constants changed');
    // 2026-09-24 is summer time (UTC+3): 04:00Z = 07:00 Cairo, 15:59Z = 18:59, 16:00Z = 19:00.
    if (!uw.isUrgentWindowOpen(new Date('2026-09-24T04:00:00Z'))) throw new Error('07:00 should be open');
    if (!uw.isUrgentWindowOpen(new Date('2026-09-24T15:59:00Z'))) throw new Error('18:59 should be open');
    if (uw.isUrgentWindowOpen(new Date('2026-09-24T16:00:00Z'))) throw new Error('19:00 should be closed');
  });

  await check('EN sentence states the window and the 07:00 start', () => {
    const s = uw.urgentWindowNote('en');
    for (const bit of ['7:00 AM', '7:00 PM', 'Cairo', '4 hours', 'starts its 4 hours at 7:00 AM']) {
      if (!s.includes(bit)) throw new Error('missing "' + bit + '" in: ' + s);
    }
    if (/fast.?track|24h|72h/i.test(s)) throw new Error('retired wording');
  });

  await check('AR sentence is the Egyptian-dialect wording, exactly', () => {
    const want = 'لو دفعت حالة عاجلة بعد 7 بالليل أو قبل 7 الصبح، الـ4 ساعات بتبدأ من 7 الصبح اللي بعدها.';
    if (uw.urgentWindowNote('ar') !== want) throw new Error('got: ' + uw.urgentWindowNote('ar'));
  });

  await check('the partial renders the sentence in the page language', async () => {
    const file = path.join(ROOT, 'src/views/partials/urgent-window-note.ejs');
    const en = await ejs.renderFile(file, { lang: 'en', urgentWindowNote: uw.urgentWindowNote });
    const ar = await ejs.renderFile(file, { lang: 'ar', urgentWindowNote: uw.urgentWindowNote });
    if (!en.includes(uw.urgentWindowNote('en'))) throw new Error('EN not rendered');
    if (!ar.includes(uw.urgentWindowNote('ar'))) throw new Error('AR not rendered');
  });

  await check('server.js exposes urgentWindowNote on app.locals', () => {
    if (!/app\.locals\.urgentWindowNote\s*=\s*require\('\.\/services\/urgency_window'\)\.urgentWindowNote/.test(read('src/server.js'))) {
      throw new Error('app.locals.urgentWindowNote not wired');
    }
  });

  await check('services page tier intro includes the note (both languages via page lang)', () => {
    if (!/include\('partials\/urgent-window-note'/.test(read('src/views/services.ejs'))) throw new Error('services.ejs');
  });

  await check('wizard tier picker includes the note', () => {
    if (!/include\('partials\/urgent-window-note'/.test(read('src/views/patient_new_case.ejs'))) throw new Error('patient_new_case.ejs');
  });

  await check('FAQ tier answer carries the sentence in EN and AR', () => {
    const src = read('src/views/faq.ejs');
    if (!src.includes("__uwnP('en')") || !src.includes("__uwnP('ar')")) throw new Error('faq.ejs q4');
  });

  await check('contact hours: uploads 24/7, Urgent served in its window — no bare "متاح 24/7"', () => {
    const sp = read('src/routes/static-pages.js');
    if (!/businessHours_ar: 'رفع الحالات متاح 24\/7\. ' \+ urgentWindowNote\('ar'\)/.test(sp)) throw new Error('static-pages AR hours');
    if (!/businessHours: 'Case uploads are open 24\/7\. ' \+ urgentWindowNote\('en'\)/.test(sp)) throw new Error('static-pages EN hours');
    for (const rel of ['src/views/contact.ejs', 'src/views/delivery_policy.ejs', 'src/routes/static-pages.js']) {
      if (/'متاح 24\/7/.test(read(rel))) throw new Error(rel + ' still says "متاح 24/7" for everything');
    }
  });

  await check('doctor services email names the 18h tier VIP, not fast track', () => {
    for (const rel of ['src/templates/email/en/doctor-confirm-services.hbs', 'src/templates/email/ar/doctor-confirm-services.hbs']) {
      const src = read(rel);
      if (/fast track \(18|سريع \(١٨/.test(src)) throw new Error(rel);
    }
  });
})();
