// tests/core/seo-trailing-slash.test.js
//
// SEO 2026-09-18 (mop-up item 3) — /services/ and /ar/services/ answered 200,
// a duplicate URL for every public page in both languages. Guards:
//
//   * /services/ → 301 /services, /ar/services/ → 301 /ar/services — for a
//     spread of public pages, query string preserved
//   * the roots are the canonical slashed forms: / and /ar/ return 200 and do
//     NOT redirect (get this wrong and you build a redirect loop)
//   * uppercase stays handled (/Services 301s) — the earlier rule this one
//     sits next to

'use strict';

const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n➗ SEO — trailing-slash duplicates 301 to the canonical URL\n');

const ROOT = path.join(__dirname, '..', '..');
const helper = require(path.join(ROOT, 'tests', '_helpers', 'public_site_app'));

(async () => {
  const site = await helper.startPublicSiteApp({});

  try {
    const cases = [
      ['/services/', '/services'],
      ['/ar/services/', '/ar/services'],
      ['/specialties/', '/specialties'],
      ['/ar/faq/', '/ar/faq'],
      ['/about///', '/about'],
      ['/specialties/cardiology/', '/specialties/cardiology']
    ];
    for (const [from, to] of cases) {
      const r = await site.get(from);
      if (r.status !== 301) throw new Error(from + ' → ' + r.status + ' (expected 301)');
      if (r.location !== to) throw new Error(from + ' → Location ' + r.location + ' (expected ' + to + ')');
    }
    t.pass('trailing-slash forms 301 to the no-slash canonical, both languages');
  } catch (e) { t.fail('trailing slash 301', e); }

  try {
    const r = await site.get('/services/?utm_source=x&b=2');
    if (r.status !== 301 || r.location !== '/services?utm_source=x&b=2') {
      throw new Error(r.status + ' ' + r.location);
    }
    t.pass('the query string survives the redirect');
  } catch (e) { t.fail('query preserved', e); }

  try {
    for (const p of ['/', '/ar/']) {
      const r = await site.get(p);
      if (r.status !== 200) throw new Error(p + ' → ' + r.status + ' ' + (r.location || '') + ' (a redirect here is a loop)');
    }
    t.pass('the roots / and /ar/ return 200 and never redirect');
  } catch (e) { t.fail('roots do not redirect', e); }

  try {
    const r = await site.get('/ar');
    if (r.status !== 301 || r.location !== '/ar/') throw new Error('/ar → ' + r.status + ' ' + r.location);
    t.pass('/ar still 301s to /ar/ (one Arabic home address)');
  } catch (e) { t.fail('/ar → /ar/', e); }

  try {
    const r = await site.get('/Services');
    if (r.status !== 301 || r.location !== '/services') throw new Error('/Services → ' + r.status + ' ' + r.location);
    t.pass('/Services still 301s to /services (case rule untouched)');
  } catch (e) { t.fail('uppercase 301 untouched', e); }

  try {
    // A page rendered normally after the rule: no redirect on the canonical.
    for (const p of ['/services', '/ar/services']) {
      const r = await site.get(p);
      if (r.status !== 200) throw new Error(p + ' → ' + r.status + ' ' + (r.location || ''));
    }
    t.pass('the canonical no-slash URLs still return 200');
  } catch (e) { t.fail('canonical URLs 200', e); }

  await site.close();
})();
