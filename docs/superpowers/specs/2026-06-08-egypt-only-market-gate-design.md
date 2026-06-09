# Design — Egypt-only launch market gate (P0-7)

- **Date:** 2026-06-08
- **Status:** Approved approach (full gate, Tier 1 + Tier 2); diff below awaiting review before apply.
- **Branch:** `fix/egypt-only-launch-gate` off `main` (5784852), worktree `/Users/ziadelwahsh/tash-egypt-gate`.
- **Scope:** Make all non-Egypt markets unreachable at checkout. Reversible, data-preserving — NO pricing edits, NO deletes.

## 1. Live state (verified via roq)
`service_regional_prices` active rows: EG 76 (0 negative), AE 92 (59 negative), GB 92 (91 negative), US 92 (91 negative), SA 0 active (95 pending). **241 non-EG active rows have `doctor_commission > tashkheesa_price`.** `orders` stores `country`+`currency`; all 25 orders are EGP. Re-enabling a market = widen one `Set` (no data change).

## 2. Mechanism — one shared module (single source of truth + marker)

**New file `src/launch-market.js`:**
```js
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// LAUNCH MARKET GATE — Egypt only.
//
// ⚠️ KNOWN-BROKEN PRICING: 241 active service_regional_prices rows for GB/US/AE
// have doctor_commission > tashkheesa_price — we would COLLECT LESS THAN WE PAY
// THE DOCTOR. SA has no active priced rows. These markets are DEFERRED, NOT
// cancelled: their pricing data is PRESERVED but made unreachable at checkout.
//
// DO NOT widen LAUNCH_MARKETS to re-enable a market until those rows are
// repriced (collect >= doctor fee). Widening this Set is the ONLY switch needed
// to re-enable a market end-to-end — every gate in the app reads from here.
// See docs/superpowers/specs/2026-06-08-egypt-only-market-gate-design.md.
// ─────────────────────────────────────────────────────────────────────────────
const LAUNCH_MARKETS = new Set(['EG']); // DEFERRED: SA, AE, GB, US, KW, QA, BH, OM

function isLaunchMarket(code) {
  return LAUNCH_MARKETS.has(String(code || '').trim().toUpperCase());
}

// Returns the code if it is a launch market, else falls back to 'EG'.
function coerceCountry(code) {
  const u = String(code || '').trim().toUpperCase();
  return LAUNCH_MARKETS.has(u) ? u : 'EG';
}

module.exports = { LAUNCH_MARKETS, isLaunchMarket, coerceCountry };
```

## 3. Proposed diff (every enforcement site)

### TIER 1 — closes every patient-reachable non-EG price

**`src/routes/patient.js`** — add require (near the other top requires, ~L786):
```diff
+const { coerceCountry, isLaunchMarket } = require('../launch-market');
```
Clamp the master resolver (L843-859) — widening LAUNCH_MARKETS re-enables without touching this:
```diff
 function getUserCountryCode(req) {
+  // LAUNCH GATE (src/launch-market.js): pricing country clamped to a launch
+  // market (EG today). Re-enable a market by widening LAUNCH_MARKETS.
   try {
     const fromUser = normalizeCountryCode(req && req.user && (req.user.country_code || req.user.country));
-    if (fromUser) return fromUser;
+    if (fromUser) return coerceCountry(fromUser);
     const headerCountry = normalizeCountryCode(req && req.headers && (req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country']));
-    if (headerCountry) return headerCountry;
+    if (headerCountry) return coerceCountry(headerCountry);
     const ip = getRequestIp(req);
     const fromGeo = normalizeCountryCode(lookupCountryFromIp(ip));
-    if (fromGeo) return fromGeo;
+    if (fromGeo) return coerceCountry(fromGeo);
     return 'EG';
   } catch (_) { return 'EG'; }
 }
```
Profile gate (L180):
```diff
-    const countryCode = ['EG', 'SA', 'AE', 'GB', 'US'].includes(req.body.country_code) ? req.body.country_code : null;
+    const countryCode = isLaunchMarket(req.body.country_code) ? String(req.body.country_code).trim().toUpperCase() : null;
```

**`src/routes/api/cases.js`** — add require (top): `const { coerceCountry } = require('../../launch-market');`
```diff
@@ regional price lookup (L235-236)
-      "SELECT tashkheesa_price, currency FROM service_regional_prices WHERE service_id = $1 AND country_code = $2 AND COALESCE(status, 'active') = 'active'",
-      [serviceId, country]
+      "SELECT tashkheesa_price, currency FROM service_regional_prices WHERE service_id = $1 AND country_code = $2 AND COALESCE(status, 'active') = 'active'",
+      [serviceId, coerceCountry(country)]
@@ INSERT orders params (L266-269)
-      clinicalQuestion, medicalHistory || null, country,
+      clinicalQuestion, medicalHistory || null, coerceCountry(country),
```

**`src/routes/api/services.js`** — add require (top): `const { coerceCountry } = require('../../launch-market');`
```diff
@@ GET /services (L52)
-    const params = [country || 'EG'];
+    const params = [coerceCountry(country)];
@@ GET /services/:id/price (L93-97)  — also fixes the latent rp.status alias bug
-      WHERE service_id = $1 AND country_code = $2 AND COALESCE(rp.status, 'active') = 'active'
-    `, [serviceId, country || 'EG']);
+      WHERE service_id = $1 AND country_code = $2 AND COALESCE(status, 'active') = 'active'
+    `, [serviceId, coerceCountry(country)]);
```

### TIER 2 — write surfaces, re-enable lever, second resolver

**`src/routes/auth.js`** (web register) — add require: `const { isLaunchMarket } = require('../launch-market');`
```diff
@@ register country validation (L603)
-  if (!ALLOWED_COUNTRY_CODES.has(normalizedCountry)) {
+  if (!isLaunchMarket(normalizedCountry)) {   // LAUNCH GATE: EG-only at launch
```
*(ALLOWED_COUNTRY_CODES Set left in place — now a "known-country" reference only; gate is via isLaunchMarket.)*

**`src/routes/api/auth.js`** (mobile register) — add require: `const { coerceCountry } = require('../../launch-market');`
```diff
@@ INSERT users params (L73)
-      `, [userId, name, email, normalizedPhone, hashedPassword, country, lang || 'en']);
+      `, [userId, name, email, normalizedPhone, hashedPassword, coerceCountry(country), lang || 'en']);
```

**`src/routes/api/profile.js`** (mobile profile patch) — add require: `const { coerceCountry } = require('../../launch-market');`
```diff
@@ L54
-    if (req.body.country) { updates.push(`country = $${paramIndex++}`); values.push(req.body.country); }
+    if (req.body.country) { updates.push(`country = $${paramIndex++}`); values.push(coerceCountry(req.body.country)); }
```

**`src/routes/api/cases_intake.js`** (website intake) — add require: `const { coerceCountry } = require('../../launch-market');`
```diff
@@ L45
-  const country           = body.country ? String(body.country).trim() : null;
+  const country           = body.country ? coerceCountry(body.country) : null;
```

**`src/routes/admin.js`** (bulk-activate — the re-enable lever) — add require: `const { isLaunchMarket } = require('../launch-market');`
```diff
@@ POST /admin/pricing/bulk-activate (after L2583)
   var countryCode = String(req.body.country || 'EG').trim().toUpperCase();
+  if (!isLaunchMarket(countryCode)) {  // LAUNCH GATE: cannot activate a deferred market's pricing
+    return res.status(403).json({ ok: false, error: 'Non-launch market disabled — see src/launch-market.js' });
+  }
```

**`src/routes/superadmin.js`** (bulk-activate) — add require: `const { isLaunchMarket } = require('../launch-market');`
```diff
@@ POST /superadmin/pricing/bulk-activate (after L746)
   const countryCode = String(req.body.country || 'EG').trim().toUpperCase();
+  if (!isLaunchMarket(countryCode)) {
+    return res.status(403).json({ ok: false, error: 'Non-launch market disabled — see src/launch-market.js' });
+  }
```

**`src/geo.js`** (second header→country resolver) — add require: `const { coerceCountry } = require('./launch-market');`
```diff
 function detectCountry(req) {
-  var cfCountry = req.headers && req.headers['cf-ipcountry'];
-  if (cfCountry) return cfCountry.toUpperCase();
-  var vercelCountry = req.headers && req.headers['x-vercel-ip-country'];
-  if (vercelCountry) return vercelCountry.toUpperCase();
-  var xCountry = req.headers && req.headers['x-country'];
-  if (xCountry) return xCountry.toUpperCase();
-  if (req.user && req.user.country) return req.user.country.toUpperCase();
-  return 'EG';
+  // LAUNCH GATE (src/launch-market.js): detection clamped to a launch market.
+  var raw = (req.headers && (req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country']))
+         || (req.user && req.user.country) || 'EG';
+  return coerceCountry(raw);
 }
```

## 4. Deliberate deviations from the raw bypass-hunter list (with reasons)
- **Admin/superadmin pricing-GRID `validCountries` arrays (admin.js:2446, superadmin.js:626) LEFT OPEN.** These are read/edit views; admins MUST be able to view and reprice the 241 non-EG rows. Restricting them to EG would block the very repricing the marker demands. Patient-unreachability is already guaranteed by Tier 1; the **bulk-activate guard** is the real "can't enable a market" control.
- **`country_options.ejs` dropdown NOT trimmed in this PR.** It's a ~200-option shared partial; doctor-signup country/licensing may use it, so trimming risks breaking doctor onboarding. The server gate is authoritative (non-EG is rejected/coerced). Trimming the patient-facing dropdown is a safe cosmetic follow-up once we confirm the doctor-signup path uses a separate source.
- **`admin.js:1879` default `'AE'` → `'EG'`** (services grid default) — included as a 1-token cosmetic fix (harmless, avoids defaulting an admin view to a deferred market). *(Will include unless you'd rather leave admin defaults untouched.)*

## 5. Coverage — why this is airtight for patients
Two families, both gated: (a) **portal** — all 8 `service_regional_prices` joins read `getUserCountryCode()`, now clamped → EG. (b) **mobile** — `api/cases.js` (intake price lock) + `api/services.js` (catalog + price-by-id, incl. the alias-bug fix) clamped → EG. Write surfaces (register/profile/intake, web+mobile) coerce stored country. The two non-patient bypasses (`bulk-activate`, `geo.js`) are closed. With every read clamped to EG, the 241 negative-margin rows are unreachable regardless of status.

## 6. Marker (durable, both forms)
- **Code:** the `⚠️ KNOWN-BROKEN` block on `LAUNCH_MARKETS` (single source of truth) + one-line `// LAUNCH GATE` pointers at each site (esp. `api/services.js` price-by-id so a future alias fix can't re-open it, and the two bulk-activate guards).
- **Memory:** a `project` memory recording the gate location + the 241-row reprice precondition.

## 7. Dry-run plan (on approval)
- Unit: `coerceCountry('GB')==='EG'`, `coerceCountry('EG')==='EG'`, `isLaunchMarket('AE')===false`.
- `node --check` every touched file.
- Against a clone: confirm a `country='GB'` order intake (api/cases.js path, simulated) resolves the EG price, and `api/services.js:/:id/price` no longer throws and returns the EG price.
- Static: grep that no remaining `service_regional_prices ... country_code = $` site reads an unclamped country.

## 8. Reversibility / rollback
Every change is a value-substitution or guard through one module. **Re-enable a market = add its code to `LAUNCH_MARKETS`** (one line) — and reprice its rows first. No schema change, no data deleted. Rollback = revert the branch (nothing is destructive).

## 9. Could not verify
Whether the edge proxy (Render/Cloudflare) strips client `cf-ipcountry`/`x-vercel-ip-country`/`x-country`. If it does not, those headers are spoofable — which is exactly why the gate clamps the resolver output rather than trusting the profile. The clamp makes it moot, but worth confirming at the edge.
