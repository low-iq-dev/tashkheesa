'use strict';
// Guard: the home market has exactly ONE price, and it is services.base_price.
//
// WHY THIS FILE EXISTS
//
// 2026-08-30. The catalogue and the checkout quoted different prices for the
// same service. /services, the specialty pages, the blogs, the FAQ and the
// schema.org priceRange all read services.base_price; the checkout priced
// through service_regional_prices, where 38 EG rows existed and every one of
// them disagreed. A patient shown "EGP 3,500" for a CT/MR Angiography Review
// would have reached the card form at 17,480.
//
// Two sources of truth for one number is the defect. The data was deactivated
// by migration 104; this holds the code side, so the split cannot come back by
// someone adding a regional lookup that forgets the home market — which is
// exactly how it arrived, one call site at a time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the intake pricer skips regional prices for the home market', () => {
  const src = read('src/services/case_intake_pricing.js');
  assert.match(src, /const HOME_MARKET\s*=\s*'EG'/,
    'case_intake_pricing.js must declare HOME_MARKET — it is the one place that ' +
    'names which market prices from base_price.');
  assert.match(src, /isHomeMarket\s*\?\s*null\s*:\s*await queryOne/,
    'priceCaseForMarket must skip the service_regional_prices lookup for the home ' +
    'market. Without that, an EG row silently overrides the advertised price ' +
    'and only the checkout sees it.');
});

test('no NEW code path prices the home market from service_regional_prices', () => {
  // Files that join service_regional_prices for a patient-facing price. Each is
  // safe only because it COALESCEs to base_price and the home market has no
  // active rows (migration 104). A new file appearing here is not automatically
  // wrong — but it must be looked at, because the failure is invisible: the
  // page and the checkout simply disagree, and nothing errors.
  const KNOWN = [
    'src/routes/patient.js',            // wizard: 4 joins, all COALESCE to base_price
    'src/services/case_intake_pricing.js',
    'src/services/addons/prescription_access.js',
    'src/services/addons/prescription.js',
    'src/routes/admin.js',              // the pricing ADMIN screen — reads by design
    'src/routes/superadmin.js',         // reporting only, never quotes a patient
    'src/routes/api/services.js',       // mobile catalogue + quote: COALESCEs to
                                        // base_price, and since 2026-08-30 takes
                                        // the country from the AUTHENTICATED user
                                        // rather than ?country=, so a client can
                                        // no longer choose its own price band
    'src/db.js'                         // seed
  ];
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      // A real query, not a mention in a comment.
      const code = src.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
      if (/service_regional_prices/.test(code)) found.push(rel);
    }
  };
  walk('src');
  const unexpected = found.filter((f) => !KNOWN.includes(f));
  assert.deepStrictEqual(unexpected, [],
    'These files query service_regional_prices and were not on the reviewed list.\n' +
    'For the HOME market that table must not decide a price — services.base_price is\n' +
    'what the whole public site advertises. Either COALESCE to base_price and skip\n' +
    'the home market, or add the file here with a note saying why it is safe:\n  ' +
    unexpected.join('\n  '));
});

test('every wizard join still falls back to base_price', () => {
  // The wizard reads regional prices in several places. Each must COALESCE, or
  // a service with no regional row prices at NULL and renders blank or free.
  const src = read('src/routes/patient.js');
  const joins = (src.match(/service_regional_prices\s+cp/g) || []).length;
  const coalesces = (src.match(/COALESCE\(cp\.tashkheesa_price,\s*sv\.base_price\)/g) || []).length;
  assert.ok(joins > 0, 'expected the wizard to join service_regional_prices');
  assert.strictEqual(coalesces, joins,
    'patient.js joins service_regional_prices ' + joins + ' time(s) but COALESCEs to ' +
    'base_price only ' + coalesces + '. A join without the fallback prices a service ' +
    'with no regional row at NULL.');
});
