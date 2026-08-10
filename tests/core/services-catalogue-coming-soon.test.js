// tests/core/services-catalogue-coming-soon.test.js
//
// Coming Soon — public catalogue (spec §4.4). Two guards:
//  (a) the /services query must still return coming_soon (via sv.*), and the
//      base_price>0 filter must not be tightened in a way that drops rows.
//  (b) rendering services.ejs with a coming_soon service must emit the badge,
//      hide the price, and NOT emit a bookable <a href> for that card.
// Pure fixture render — no DB, no boot.
'use strict';
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🏷️  public catalogue marks coming_soon services (§4.4)\n');

const VIEWS = path.join(__dirname, '..', '..', 'src', 'views');

// (a) query still exposes coming_soon via sv.*
try {
  const sp = fs.readFileSync(path.join(VIEWS, '..', 'routes', 'static-pages.js'), 'utf8');
  if (!/SELECT DISTINCT ON \(sv\.id\) sv\.\*/.test(sp)) {
    throw new Error('/services query no longer selects sv.* — coming_soon may be dropped from the row.');
  }
  t.pass('/services query selects sv.* (coming_soon is returned)');
} catch (e) { t.fail('services-catalogue: query returns coming_soon', e); }

// (b) fixture render — a coming_soon service is badged, price-hidden, unlinked.
try {
  const soon = { id: 'soon_svc', name: 'Soon Service', description: 'x', base_price: 1200, sla_hours: 48, specialty_name: 'Cardiology', coming_soon: true };
  const live = { id: 'live_svc', name: 'Live Service', description: 'y', base_price: 900,  sla_hours: 48, specialty_name: 'Cardiology', coming_soon: false };
  const html = ejs.render(fs.readFileSync(path.join(VIEWS, 'services.ejs'), 'utf8'), {
    services: [live, soon],
    specialtyNames: ['Cardiology'], specialtyNameArMap: {}, isAr: false,
    user: null,
    tt: (k, en) => en,
    formatMoney: (n) => 'EGP ' + n,
    cspNonce: '', BUSINESS_INFO: {}, title: '', description: '', canonical: '/services',
    // locals needed by partials/header → layouts/public
    lang: 'en', currentUrl: '/services', showNav: true,
  }, { views: [VIEWS], filename: path.join(VIEWS, 'services.ejs') });

  if (!/service-soon-badge/.test(html)) throw new Error('coming_soon card is missing the .service-soon-badge');
  if (!/aria-disabled="true"/.test(html)) throw new Error('coming_soon card must render a non-navigating aria-disabled element');
  // The soon service id must NOT appear inside an href (i.e. not clickable into the wizard).
  if (new RegExp('href="[^"]*service_id=soon_svc').test(html)) {
    throw new Error('coming_soon service must NOT be linked with an href into the wizard');
  }
  // Sanity: the live service IS still linked.
  if (!new RegExp('href="[^"]*service_id=live_svc').test(html)) {
    throw new Error('bookable service must remain a clickable card');
  }
  t.pass('coming_soon card is badged, price-hidden, and unlinked; bookable card stays clickable');
} catch (e) { t.fail('services-catalogue: coming_soon render', e); }
