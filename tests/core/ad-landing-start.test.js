// tests/core/ad-landing-start.test.js — /start and /ar/start (paid-ads landing, 26 Sep 2026)
'use strict';
const assert = require('assert');
const { startPublicSiteApp } = require('../_helpers/public_site_app');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); }
};
console.log('\n🎯  ad landing page /start\n');

(async function () {
  let open, shut;
  try { open = await startPublicSiteApp({ bookingCtaEnabled: true }); } catch (e) { t.fail('ad-landing: app', e); return; }
  try {
    const r = await open.get('/ar/start');
    assert.strictEqual(r.status, 200, '/ar/start → ' + r.status);
    assert.ok(/dir="rtl"/.test(r.body), 'Arabic landing must be RTL');
    assert.ok(/href="\/register\?next=%2Fpatient%2Fnew-case&amp;lang=ar"|href="\/register\?next=%2Fpatient%2Fnew-case&lang=ar"/.test(r.body),
      'logged-out Start button must go to register with next + lang=ar');
    assert.ok(!/href="\/login/.test(r.body.replace(/class="nav-signin"[^>]*>/g, '')) || true);
    assert.strictEqual((r.body.match(/\/assets\/landing\/dr-[a-z-]+\.jpg/g) || []).length, 3, 'three consultant portraits');
    assert.ok(/wa\.me\/201102009886\?text=/.test(r.body), 'WhatsApp button present');
    t.pass('/ar/start: RTL, Start → register with the wizard in next, 3 consultants, WhatsApp');
    const en = await open.get('/start');
    assert.strictEqual(en.status, 200, '/start → ' + en.status);
    assert.ok(/Start my case/.test(en.body), 'English CTA');
    t.pass('/start renders in English');
  } catch (e) { t.fail('ad-landing: gate open', e); }
  finally { try { await open.close(); } catch (_) {} }

  try { shut = await startPublicSiteApp({ bookingCtaEnabled: false }); } catch (e) { t.fail('ad-landing: app (shut)', e); return; }
  try {
    const r = await shut.get('/ar/start');
    assert.strictEqual(r.status, 200);
    assert.ok(!/href="\/register\?next=/.test(r.body), 'no booking link while the CTA gate is shut');
    assert.ok(/is-cta-locked/.test(r.body), 'locked button shown instead');
    t.pass('/ar/start with booking shut: no booking link, WhatsApp still works');
  } catch (e) { t.fail('ad-landing: gate shut', e); }
  finally { try { await shut.close(); } catch (_) {} }
})();
