// tests/core/public-cta-new-visitor-register.test.js
//
// 26 Sep 2026: with booking open, a new visitor from an ad tapped a service and
// landed on a SIGN-IN form. They have no account, so that is a dead end (the
// "Create account" link was small, at the bottom). Every public booking link
// now sends logged-out visitors to /register with the wizard URL — service
// included — encoded whole in `next`. Logged-in patients still go straight in.
'use strict';
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); }
};
console.log('\n🆕  public booking links send new visitors to register\n');

const VIEWS = path.join(__dirname, '..', '..', 'src', 'views');
const LIVE = { id: 'live_svc', name: 'Live Service', description: 'y', base_price: 900, sla_hours: 48, specialty_name: 'Obstetrics & Gynecology', coming_soon: false, is_bookable: true };

function render(user, langParam) {
  return ejs.render(fs.readFileSync(path.join(VIEWS, 'services.ejs'), 'utf8'), {
    services: [LIVE], featuredServices: [LIVE],
    specialtyNames: ['Obstetrics & Gynecology'], specialtyNameArMap: {},
    specialtyLiveMap: { 'Obstetrics & Gynecology': true },
    catalogue: { bookable: 1, total: 1, liveSpecialties: 1, totalSpecialties: 1, minPrice: 900, maxPrice: 900 },
    bookingCtaEnabled: true, isAr: false, user: user, langParam: langParam,
    tt: (k, en) => en, formatMoney: (n) => 'EGP ' + n,
    cspNonce: '', BUSINESS_INFO: {}, title: '', description: '', canonical: '/services',
    lang: 'en', currentUrl: '/services', showNav: true
  }, { views: [VIEWS], filename: path.join(VIEWS, 'services.ejs') });
}
const hrefs = (html) => (html.match(/href="[^"]*"/g) || []).map((h) => h.slice(6, -1).replace(/&amp;/g, '&'));

try {
  const all = hrefs(render(null, 'lang=ar'));
  const svc = all.filter((h) => /service_id/.test(h));
  if (!svc.length) throw new Error('no service booking link rendered');
  for (const h of svc) {
    if (h.indexOf('/register?next=') !== 0) throw new Error('logged-out service link must start at /register?next=, got ' + h);
    const u = new URL(h, 'https://x.test');
    if (u.searchParams.get('next') !== '/patient/new-case?service_id=live_svc') throw new Error('next lost the service: ' + u.searchParams.get('next'));
    if (u.searchParams.get('lang') !== 'ar') throw new Error('lang not carried: ' + h);
  }
  if (all.some((h) => h.indexOf('/login?next=') === 0)) throw new Error('a booking link still points at /login');
  const spec = all.filter((h) => /specialty/.test(h));
  for (const h of spec) {
    const next = new URL(h, 'https://x.test').searchParams.get('next');
    if (next !== '/patient/new-case?specialty=' + encodeURIComponent('Obstetrics & Gynecology')) throw new Error('"&" in a specialty name split next: ' + next);
  }
  t.pass('logged out: every booking link goes to /register with the service intact in next');
} catch (e) { t.fail('public-cta: logged-out links', e); }

try {
  const svc = hrefs(render({ id: 'u1', role: 'patient' }, 'lang=ar')).filter((h) => /service_id/.test(h));
  if (!svc.length || svc.some((h) => h.indexOf('/patient/new-case?service_id=live_svc') !== 0)) throw new Error('logged-in link must go straight to the wizard: ' + svc.join(' '));
  t.pass('logged in: booking links go straight into the wizard');
} catch (e) { t.fail('public-cta: logged-in links', e); }

try {
  const sa = fs.readFileSync(path.join(VIEWS, 'partials', 'service_assistant.ejs'), 'utf8');
  if (/split\("\?"\)\[0\]/.test(sa)) throw new Error('service_assistant still drops `next` by splitting submitUrl on "?"');
  if (!/'\/register\?next=' \+ encodeURIComponent\(target\)/.test(sa)) throw new Error('service_assistant must build /register?next=<encoded wizard url>');
  t.pass('assistant bubble: recommendation link keeps the service through register');
} catch (e) { t.fail('public-cta: service assistant', e); }
