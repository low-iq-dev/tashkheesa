// tests/core/services-hero-and-taps.test.js
//
// 11 Oct 2026: paid traffic lands on /services. Its hero "Start Your Case"
// button opened /start — a second landing page — so a visitor needed two taps
// to reach sign-up, and nothing on the page recorded what visitors tapped.
// The hero button now goes straight to sign-up (or the case form when signed
// in) and taps on the page are counted for the funnel digest.
'use strict';
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); }
};
console.log('\n👆  services page: hero goes to sign-up, taps are counted\n');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');
const LIVE = { id: 'live_svc', name: 'Live Service', description: 'y', base_price: 900, sla_hours: 48, specialty_name: 'Cardiology', coming_soon: false, is_bookable: true };

function render(user, langParam, ctaShut) {
  return ejs.render(fs.readFileSync(path.join(VIEWS, 'services.ejs'), 'utf8'), {
    services: [LIVE], featuredServices: [LIVE],
    specialtyNames: ['Cardiology'], specialtyNameArMap: {},
    specialtyLiveMap: { Cardiology: true },
    catalogue: { bookable: 1, total: 1, liveSpecialties: 1, totalSpecialties: 1, minPrice: 900, maxPrice: 900 },
    bookingCtaEnabled: !ctaShut, isAr: false, user: user, langParam: langParam,
    tt: (k, en) => en, formatMoney: (n) => 'EGP ' + n,
    cspNonce: '', BUSINESS_INFO: {}, title: '', description: '', canonical: '/services',
    lang: 'en', currentUrl: '/services', showNav: true
  }, { views: [VIEWS], filename: path.join(VIEWS, 'services.ejs') });
}
function heroStart(html) {
  const m = html.match(/<a href="([^"]*)" data-funnel="services_cta" style="display:inline-block;background:#0B6B5F;/);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

try {
  const h = heroStart(render(null, 'lang=ar'));
  if (!h) throw new Error('hero Start button not found');
  if (h.indexOf('/register?next=') !== 0) throw new Error('logged-out hero must start at /register?next=, got ' + h);
  const u = new URL(h, 'https://x.test');
  if (u.searchParams.get('next') !== '/patient/new-case') throw new Error('next should be the case form, got ' + u.searchParams.get('next'));
  if (u.searchParams.get('lang') !== 'ar') throw new Error('lang not carried: ' + h);
  if (/\/start(["?]|$)/.test(h)) throw new Error('hero still points at the /start landing page');
  t.pass('logged out: hero Start goes straight to sign-up with the case form as next');
} catch (e) { t.fail('services hero: logged out', e); }

try {
  const h = heroStart(render({ id: 'u1', role: 'patient' }, 'lang=ar'));
  if (h !== '/patient/new-case?lang=ar') throw new Error('logged-in hero must open the case form, got ' + h);
  const bare = heroStart(render({ id: 'u1', role: 'patient' }, ''));
  if (bare !== '/patient/new-case') throw new Error('no language given: expected /patient/new-case, got ' + bare);
  t.pass('logged in: hero Start opens the case form');
} catch (e) { t.fail('services hero: logged in', e); }

try {
  for (const user of [null, { id: 'u1', role: 'patient' }]) {
    const h = heroStart(render(user, 'lang=ar', true));
    if (h !== '/start') throw new Error('with booking shut the hero must stay on /start, got ' + h);
  }
  t.pass('booking gate shut: hero Start does not open sign-up or the case form');
} catch (e) { t.fail('services hero: gate shut', e); }

try {
  const html = render(null, 'lang=ar');
  const tags = (html.match(/data-funnel="[a-z_]+"/g) || []).map((s) => s.slice(13, -1));
  for (const want of ['services_cta', 'services_card', 'services_help']) {
    if (tags.indexOf(want) === -1) throw new Error('no element tagged ' + want);
  }
  if (!/class="service-card" data-funnel="services_card"/.test(html)) throw new Error('service cards are not tagged');
  if (!/querySelectorAll\('\[data-funnel\]'\)/.test(html)) throw new Error('tap listener missing from the page script');
  t.pass('taps: hero, cards and help link are tagged and a listener reports them');
} catch (e) { t.fail('services taps: markup', e); }

try {
  const routes = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'static-pages.js'), 'utf8');
  for (const s of ['services_cta', 'services_card', 'services_help']) {
    if (routes.indexOf("step === '" + s + "'") === -1) throw new Error('/f/e does not accept ' + s);
  }
  const fd = require('../../src/services/funnel_digest');
  const txt = fd.formatDigest({ day: '2026-10-11', services_view: 90, services_cta: 7, services_card: 12, services_help: 1, register_view: 9, signups: 2 }, null);
  if (!/Services page taps: Start 7 · service cards 12 · help 1/.test(txt)) throw new Error('digest line missing: ' + txt);
  const empty = fd.formatDigest({ day: '2026-10-11' }, null);
  if (!/Services page taps: Start 0 · service cards 0 · help 0/.test(empty)) throw new Error('digest must show zeros, not blanks');
  t.pass('digest: the beacon accepts the three steps and the daily message shows them');
} catch (e) { t.fail('services taps: beacon + digest', e); }
