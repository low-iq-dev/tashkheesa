// tests/core/doctor-portal-footer.test.js
//
// 2026-09-13 (mobile B6). The ~800px public marketing footer (Services /
// Policies / For doctors / Contact) rendered at the bottom of every doctor
// portal page, on every width. A signed-in consultant inside the portal frame
// now gets a two-line portal footer; public pages and the patient/admin frames
// are unchanged. Renders partials/footer.ejs directly with EJS.
'use strict';

const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🦶 doctor portal footer (mobile B6)\n');

const FOOTER = path.join(__dirname, '..', '..', 'src', 'views', 'partials', 'footer.ejs');

function render(locals) {
  return ejs.renderFile(FOOTER, Object.assign({ isAr: false }, locals), { async: false });
}

async function check(name, locals, expectPublic, expectPortal) {
  try {
    const html = await render(locals);
    const hasPublic = /class="site-footer"/.test(html);
    const hasPortal = /class="portal-footer"/.test(html);
    if (hasPublic !== expectPublic) throw new Error('public footer ' + (hasPublic ? 'rendered' : 'missing'));
    if (hasPortal !== expectPortal) throw new Error('portal footer ' + (hasPortal ? 'rendered' : 'missing'));
    t.pass(name);
  } catch (e) { t.fail(name, e); }
}

module.exports = (async function run() {
  await check('doctor inside the portal frame → portal footer, no public footer',
    { portalFrame: true, user: { role: 'doctor' } }, false, true);
  // The profile route renders with `user:` = a DB row with no role, which
  // shadows the session user. The URL is the second signal.
  await check('doctor profile page (user local has no role) → portal footer via currentUrl',
    { portalFrame: true, user: { name: 'Dr X' }, currentUrl: '/portal/doctor/profile' }, false, true);
  await check('patient portal frame under /portal/patient → public footer unchanged',
    { portalFrame: true, user: { name: 'P' }, currentUrl: '/portal/patient/orders' }, true, false);
  await check('doctor portal page with showFooter:false (messages) → neither',
    { portalFrame: true, user: { role: 'doctor' }, showFooter: false }, false, false);
  await check('doctor on a PUBLIC page (no portal frame) → public footer kept',
    { portalFrame: false, user: { role: 'doctor' } }, true, false);
  await check('patient portal frame → public footer unchanged',
    { portalFrame: true, user: { role: 'patient' } }, true, false);
  await check('superadmin portal frame → public footer unchanged',
    { portalFrame: true, user: { role: 'superadmin' } }, true, false);
  await check('anonymous public page → public footer',
    {}, true, false);
})().catch((e) => t.fail('harness crashed', e));
