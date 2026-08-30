// tests/core/services-catalogue-coming-soon.test.js
//
// Coming Soon — public catalogue (spec §4.4), updated 2026-08-30.
//
// WHAT CHANGED, AND WHY THIS TEST GOT STRICTER RATHER THAN LOOSER
//
// The page used to show only bookable services and used `coming_soon` as the
// one test for "can this be bought". Both of those are now wrong:
//
//   * The page lists the WHOLE catalogue — 183 services, not 55 — so 128 cards
//     on it are unbuyable and must be unmistakably marked.
//   * `coming_soon` was never the whole rule. A service can be perfectly fine
//     in itself and still unorderable because its SPECIALTY is hidden, which is
//     true of most of those 128. The row now carries `is_bookable`, computed by
//     serviceBookableClause — the same expression the wizard gates on.
//   * Booking is additionally held shut site-wide (services/public_cta.js), so
//     even a bookable card must not link while the gate is closed.
//
// The old version of this file asserted "a non-coming_soon service IS linked",
// which is now false by design. Rather than delete that assertion, it is split:
// linked when the gate is OPEN, badged-or-inert when it is SHUT. The dangerous
// direction — something unbuyable rendered as clickable — is asserted in both
// states, because that is the failure that costs a patient their upload.
'use strict';
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🏷️  public catalogue marks unbookable services (§4.4)\n');

const VIEWS = path.join(__dirname, '..', '..', 'src', 'views');

// (a) The query must still return the whole row AND the shared bookability rule.
try {
  const sp = fs.readFileSync(path.join(VIEWS, '..', 'routes', 'static-pages.js'), 'utf8');
  if (!/SELECT DISTINCT ON \(sv\.id\) sv\.\*/.test(sp)) {
    throw new Error('/services query no longer selects sv.* — coming_soon may be dropped from the row.');
  }
  if (!/serviceBookableClause\('sv'\)[\s\S]{0,40}AS is_bookable/.test(sp)) {
    throw new Error(
      '/services must select serviceBookableClause() AS is_bookable. Without it every card ' +
      'falls back to unbookable, or (worse, if the view is changed to compensate) the page ' +
      'starts deciding bookability with its own rule instead of the wizard\'s.');
  }
  t.pass('/services returns sv.* and is_bookable from the shared rule');
} catch (e) { t.fail('services-catalogue: query shape', e); }

// (b) + (c) Fixture render in BOTH gate states.
const SOON = { id: 'soon_svc', name: 'Soon Service', description: 'x', base_price: 1200, sla_hours: 48, specialty_name: 'Cardiology', coming_soon: true,  is_bookable: false };
// The case the old rule could not see: nothing wrong with the service itself,
// but its specialty is hidden, so it is not orderable.
const HIDDEN_SPEC = { id: 'hidden_spec_svc', name: 'Hidden Spec Service', description: 'z', base_price: 1500, sla_hours: 48, specialty_name: 'Cardiology', coming_soon: false, is_bookable: false };
const LIVE = { id: 'live_svc', name: 'Live Service', description: 'y', base_price: 900, sla_hours: 48, specialty_name: 'Cardiology', coming_soon: false, is_bookable: true };

function render(ctaOn) {
  return ejs.render(fs.readFileSync(path.join(VIEWS, 'services.ejs'), 'utf8'), {
    services: [LIVE, SOON, HIDDEN_SPEC],
    specialtyNames: ['Cardiology'],
    specialtyNameArMap: {},
    specialtyLiveMap: { Cardiology: true },
    catalogue: { bookable: 1, total: 3, liveSpecialties: 1, totalSpecialties: 1, minPrice: 900, maxPrice: 1500 },
    bookingCtaEnabled: ctaOn,
    isAr: false,
    user: null,
    tt: (k, en) => en,
    formatMoney: (n) => 'EGP ' + n,
    cspNonce: '', BUSINESS_INFO: {}, title: '', description: '', canonical: '/services',
    lang: 'en', currentUrl: '/services', showNav: true
  }, { views: [VIEWS], filename: path.join(VIEWS, 'services.ejs') });
}

const linked = (html, id) => new RegExp('href="[^"]*service_id=' + id).test(html);

// ── Gate OPEN: bookable links, unbookable does not. ──────────────────
try {
  const html = render(true);
  if (!/service-soon-badge/.test(html)) throw new Error('no .service-soon-badge rendered for the unbookable cards');
  if (linked(html, 'soon_svc'))        throw new Error('a coming_soon service must never be linked into the wizard');
  if (linked(html, 'hidden_spec_svc')) throw new Error('a service under a hidden specialty must never be linked into the wizard');
  if (!linked(html, 'live_svc'))       throw new Error('with the CTA gate OPEN, a bookable service must be a clickable card');
  t.pass('gate open: bookable card links, unbookable cards are badged and inert');
} catch (e) { t.fail('services-catalogue: render with CTA open', e); }

// ── Gate SHUT: nothing links, and the bookable card keeps its price. ─
try {
  const html = render(false);
  if (linked(html, 'live_svc'))        throw new Error('with the CTA gate SHUT, no service may link into the wizard');
  if (linked(html, 'soon_svc'))        throw new Error('a coming_soon service must never be linked into the wizard');
  if (linked(html, 'hidden_spec_svc')) throw new Error('a service under a hidden specialty must never be linked into the wizard');
  if (/href="[^"]*\/patient\/new-case/.test(html) || /href="[^"]*\/login\?next=/.test(html)) {
    throw new Error('with the CTA gate SHUT, no CTA may link to the wizard or its login bounce');
  }
  // A held-back CTA must not also hide the price: the price is true, and the
  // page is still the pricing page.
  if (!/900/.test(html)) throw new Error('a bookable service must still show its price while the CTA is shut');
  t.pass('gate shut: nothing links into the wizard, prices still shown');
} catch (e) { t.fail('services-catalogue: render with CTA shut', e); }
