// tests/core/loop-sweep-2026-10-06.test.js — the public-site fixes from the 6 Oct loop sweep.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { startPublicSiteApp } = require('../_helpers/public_site_app');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); }
};
console.log('\n🧹  loop sweep 6 Oct — public site\n');
const view = (f) => fs.readFileSync(path.join(__dirname, '../../src/views', f), 'utf8');

(async function () {
  let open, shut;
  try { open = await startPublicSiteApp({ bookingCtaEnabled: true }); } catch (e) { t.fail('loop-sweep: app', e); return; }
  try {
    const cs = await open.get('/coming-soon?utm_source=instagram&utm_medium=bio');
    assert.strictEqual(cs.status, 302, '/coming-soon → ' + cs.status);
    assert.strictEqual(cs.location, '/ar/start?utm_source=instagram&utm_medium=bio');
    t.pass('booking open: /coming-soon forwards to the landing page and keeps the UTM tags');

    const faq = await open.get('/ar/faq');
    assert.ok(!/1,600 EGP|5,500/.test(faq.body), 'FAQ still quotes the retired price range');
    assert.ok(/750 EGP/.test(faq.body) && /3,500 EGP/.test(faq.body), 'FAQ lacks the live price range');
    assert.ok(!/Fawry|Meeza/.test(faq.body), 'FAQ still lists payment methods we do not take');
    assert.ok(/data-nav-start/.test(faq.body) && /href="\/ar\/start"/.test(faq.body), 'inner-page header has no Start button');
    t.pass('FAQ: live prices and payment methods; inner pages carry a Start button');

    const home = await open.get('/ar/');
    assert.ok(!/مراجعة تشخيصية|إرشاد للعلاج/.test(home.body), 'homepage still claims diagnostic review / treatment guidance');
    assert.ok(/مش للطوارئ/.test(home.body), 'homepage lacks the not-for-emergencies line');
    const homeEn = await open.get('/');
    assert.ok(!/diagnostic reviews|treatment guidance/.test(homeEn.body), 'EN homepage still claims diagnosis / treatment');
    assert.ok(/Not for emergencies/.test(homeEn.body));
    t.pass('homepage: second-opinion wording only, plus the emergency line');

    const svc = await open.get('/ar/services');
    assert.ok(!/على إيميلك/.test(svc.body), 'services page still promises the report by email');
    assert.ok(/href="\/ar\/start"/.test(svc.body) && /href="\/ar\/wa"/.test(svc.body), 'services hero lacks Start + WhatsApp');
    t.pass('services: Start + WhatsApp at the top, no "by email"');

    const start = await open.get('/ar/start');
    assert.ok(/مش للطوارئ/.test(start.body) && /بالبطاقة/.test(start.body), 'landing page lacks the emergency line or card payment');
    t.pass('/ar/start: emergency line and card payment named');
  } catch (e) { t.fail('loop-sweep: gate open', e); }
  finally { try { await open.close(); } catch (_) {} }

  try { shut = await startPublicSiteApp({ bookingCtaEnabled: false }); } catch (e) { t.fail('loop-sweep: app (shut)', e); return; }
  try {
    const cs = await shut.get('/coming-soon');
    assert.strictEqual(cs.status, 200, 'with booking shut the pre-launch page must still render (the wizard gate redirects here)');
    t.pass('booking shut: /coming-soon still renders');
  } catch (e) { t.fail('loop-sweep: gate shut', e); }
  finally { try { await shut.close(); } catch (_) {} }

  try {
    const login = view('login.ejs');
    assert.ok(/const __emailFirst = !!err;/.test(login), 'login default-tab switch missing');
    assert.ok(/id="tab-phone"/.test(login) && /data-panel="email"[^>]*<%= __emailFirst \? '' : ' hidden' %>/.test(login), 'email panel must be hidden unless an email error is shown');
    t.pass('login: phone tab is the default; email tab only after an email sign-in error');
    const q = fs.readFileSync(path.join(__dirname, '../../src/routes/superadmin.js'), 'utf8');
    assert.ok(/assignment_status = 'manual_queue'\s+AND LOWER\(COALESCE\(o\.status, ''\)\) NOT IN \('draft', 'expired_unpaid', 'cancelled', 'refunded'\)/.test(q), 'manual queue list still shows un-actionable rows');
    t.pass('manual queue: drafts, expired, cancelled and refunded cases are not listed');
  } catch (e) { t.fail('loop-sweep: source pins', e); }
})();
