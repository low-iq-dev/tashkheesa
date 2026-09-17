// tests/core/seo-how-it-works-redirect.test.js
//
// SEO 2026-09-18 (mop-up item 4) — /how-it-works was a 302 to /#how-it-works,
// an anchor that did not exist on the homepage. Guards:
//
//   * /how-it-works → 301 (permanent, not 302) → /#how-it-works
//   * /ar/how-it-works → 301 → /ar/#how-it-works
//   * the anchor is REAL: the rendered homepage carries id="how-it-works",
//     in both languages (same template)

'use strict';

const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n🧭 SEO — /how-it-works 301s to a real homepage anchor\n');

const ROOT = path.join(__dirname, '..', '..');
const helper = require(path.join(ROOT, 'tests', '_helpers', 'public_site_app'));

(async () => {
  const site = await helper.startPublicSiteApp({});

  try {
    const r = await site.get('/how-it-works');
    if (r.status !== 301) throw new Error('status ' + r.status + ' (a 302 leaks no signal to the target)');
    if (r.location !== '/#how-it-works') throw new Error('Location ' + r.location);
    t.pass('/how-it-works → 301 /#how-it-works');
  } catch (e) { t.fail('english redirect', e); }

  try {
    const r = await site.get('/ar/how-it-works');
    if (r.status !== 301) throw new Error('status ' + r.status);
    if (r.location !== '/ar/#how-it-works') throw new Error('Location ' + r.location + ' (an Arabic visitor must land on the Arabic homepage)');
    t.pass('/ar/how-it-works → 301 /ar/#how-it-works');
  } catch (e) { t.fail('arabic redirect', e); }

  try {
    for (const p of ['/', '/ar/']) {
      const r = await site.get(p);
      if (r.status !== 200) throw new Error(p + ' → ' + r.status);
      if (!/id="how-it-works"/.test(r.body)) throw new Error(p + ' has no id="how-it-works" — the redirect points at nothing');
    }
    t.pass('the homepage carries the id="how-it-works" anchor in both languages');
  } catch (e) { t.fail('anchor exists', e); }

  await site.close();
})();
