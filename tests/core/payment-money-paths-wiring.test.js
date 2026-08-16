'use strict';
// tests/core/payment-money-paths-wiring.test.js
//
// Launch-audit money-path wiring guards (B5 amount verification, F3 stale-link
// invalidation, B6 add-ons charged + fulfilled from persisted state). These are
// source-grep assertions that run without a DB in the default suite; the full
// behavioral coverage lives in tests/core/paymob-webhook.test.js (DB-gated) and
// tests/core/order-pricing-owed.test.js (pure unit).

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🔐 payment money-path wiring (B5 / F3 / B6)\n');

const ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

const payments = read('src/routes/payments.js');
const referrals = read('src/routes/referrals.js');
const orderFlow = read('src/routes/order_flow.js');
const patient = read('src/routes/patient.js');
const payEjs = read('src/views/patient_payment_required.ejs');

// ── B5: amount verification in the webhook ─────────────────────────────────
assert(/owedCentsForOrder\s*\(\s*order\s*\)/.test(payments),
  'callback computes owed via owedCentsForOrder(order)', 'no owedCentsForOrder(order) call');
assert(/Number\(\s*txnBody\.amount_cents\s*\)/.test(payments),
  'callback reads txnBody.amount_cents', 'amount_cents never read from the payload');
assert(/event_type,[\s\S]{0,120}'amount_mismatch'|'amount_mismatch'/.test(payments) &&
       /INSERT INTO payment_events[\s\S]*?'amount_mismatch'/.test(payments),
  "mismatch writes a payment_events row of type 'amount_mismatch'", 'no amount_mismatch payment_events insert');
assert(/notifyAdmins\s*\(\s*\{[\s\S]*?payment_amount_mismatch/.test(payments),
  'mismatch alerts admins via notifyAdmins', 'notifyAdmins not called on mismatch');
assert(/amount_mismatch:\s*true/.test(payments),
  'mismatch returns 200 with amount_mismatch:true (Paymob stops retrying, order stays unpaid)',
  'no `amount_mismatch: true` ack');

// Ordering: the amount check + its early return must come BEFORE the order is
// marked paid and before markCasePaid — otherwise a mismatch could still settle.
{
  const idxMismatch = payments.indexOf("amount_mismatch: true");
  const idxGuard = payments.search(/payment_status = 'paid'/);
  const idxMarkPaid = payments.search(/markCasePaid\(orderId\)/);
  assert(idxMismatch !== -1 && idxGuard !== -1 && idxMismatch < idxGuard && idxGuard < idxMarkPaid,
    'amount-mismatch early return precedes the paid-guard UPDATE and markCasePaid',
    'idxMismatch=' + idxMismatch + ' idxGuard=' + idxGuard + ' idxMarkPaid=' + idxMarkPaid);
}

// ── F3: every price mutation invalidates the intention/link ────────────────
function priceMutatingSetClauses(src) {
  // Capture each `UPDATE orders <SET...> WHERE` body and keep those that set price.
  const out = [];
  const re = /UPDATE\s+orders([\s\S]*?)WHERE/gi;
  let m;
  while ((m = re.exec(src))) {
    const body = m[1];
    if (/\bprice\s*=\s*\$?\d/.test(body) || /\bprice\s*=\s*\$/.test(body)) out.push(body);
  }
  return out;
}
// STALE-TEST FIX (2026-08-16): this asserted an EXACT per-file count —
// order_flow.js must have exactly 3 price-mutating UPDATEs. The legacy
// /order/* checkout funnel that owned those three was deleted, so the file now
// has 0 and the test failed even though the invariant it exists to protect was
// never violated. An exact count of a thing that is allowed to move is not an
// invariant; it is a snapshot.
//
// The real rule is: WHEREVER a price is mutated, the stale Paymob intention and
// payment link must be nulled in the same statement — otherwise a patient can
// pay yesterday's amount through a link that outlived its price. Discover the
// sites across the whole src/ tree instead of naming files, so a mutation added
// in a NEW file is covered too (the old form would have missed it entirely),
// and keep a floor so the scan cannot silently find nothing.
{
  const SRC_DIR = path.join(__dirname, '..', '..', 'src');
  function walk(dir, acc) {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, acc);
      else if (/\.js$/.test(name)) acc.push(full);
    }
    return acc;
  }

  const files = walk(SRC_DIR, []);
  const sites = [];
  for (const full of files) {
    const rel = path.relative(path.join(__dirname, '..', '..'), full);
    for (const body of priceMutatingSetClauses(fs.readFileSync(full, 'utf8'))) {
      sites.push({ rel: rel, body: body });
    }
  }

  assert(files.length >= 100,
    'price-mutation scan walked ' + files.length + ' src files (sanity floor)',
    'only walked ' + files.length + ' files — the walker is broken, so a pass here means nothing');

  assert(sites.length >= 1,
    'found ' + sites.length + ' price-mutating UPDATE(s) across src/',
    'found 0 price-mutating UPDATEs anywhere in src/ — either the regex broke or price mutation moved somewhere this test cannot see');

  const missing = sites.filter(function (s) {
    return !(/paymob_intention_id\s*=\s*NULL/i.test(s.body) && /payment_link\s*=\s*NULL/i.test(s.body));
  });
  assert(missing.length === 0,
    'every price-mutating UPDATE also nulls paymob_intention_id + payment_link (' + sites.length + ' checked)',
    missing.length + ' price mutation(s) leave the stale link live: ' +
      missing.map(function (s) { return s.rel; }).join(', '));
}

// ── B6: add-ons are charged (create-intention) ─────────────────────────────
assert(/const\s+amountCents\s*=\s*owedCentsForOrder\(\{[\s\S]*?addons_json:/.test(payments),
  'create-intention amount = owedCentsForOrder(base + persisted add-ons)',
  'intention amount is not computed from base + add-ons');
assert(/amountCents:\s*amountCents/.test(payments) && !/amountCents:\s*Math\.round\(amount\s*\*\s*100\)/.test(payments),
  'createIntention is called with the add-on-inclusive amountCents (not price-only)',
  'still charging Math.round(amount*100) (price only)');
assert(/UPDATE\s+orders[\s\S]{0,80}addons_json\s*=\s*\$1[\s\S]{0,120}video_consultation_selected/.test(payments),
  'create-intention persists the add-on selection (addons_json + video flag) before charging',
  'selection not persisted server-side before the intention');

// ── B6: add-ons fulfilled from persisted state, NOT dead query params ──────
assert(/const\s+selectedAddons\s*=\s*parseSelectedAddons\(order\)/.test(payments),
  'webhook derives the selection via parseSelectedAddons(order)', 'no parseSelectedAddons(order) in webhook');
assert(/if\s*\(\s*selectedAddons\.video_consultation\s*\)/.test(payments),
  'video fulfillment is gated on the persisted selection', 'video branch not gated on persisted selection');
assert(/if\s*\(\s*selectedAddons\.prescription\s*\)/.test(payments),
  'prescription fulfillment is gated on the persisted selection', 'prescription branch not gated on persisted selection');
assert(!/req\.query\?\.addon_video_consultation/.test(payments) && !/req\.query\?\.addon_prescription/.test(payments),
  'the dead addon_* query-param gates are gone from the webhook',
  'webhook still reads addon_* from req.query (never present on a server-to-server webhook)');

// ── B6: pay page routes add-on services through create-intention + sends them ─
assert(/serviceHasAddons/.test(patient) && /isInternalFallback\s*\|\|\s*serviceHasAddons/.test(patient),
  'pay route forces the create-intention button when the service has add-ons',
  'add-on services can still render the stale external checkout link');
assert(/body:\s*JSON\.stringify\(\{\s*orderId:\s*orderId,\s*addons:\s*addons\s*\}\)/.test(payEjs),
  'pay page posts the selected add-ons to create-intention', 'button no longer sends the add-on selection');

// ── B1: pay page defines hasSlaAddon (also covered by pay-page-renders) ────
assert(/const\s+hasSlaAddon\s*=/.test(payEjs),
  'pay page defines hasSlaAddon (no ReferenceError 500)', 'hasSlaAddon still undefined');

// ── Display === charge: referral discount not double-subtracted; add-on
//    prices actually read (selector). The server charges new_price + add-ons;
//    the pay page must show the SAME number. ──────────────────────────────
const payAddons = read('public/js/payment-addons.js');
assert(!/basePrice\s*=\s*data\.new_price/.test(payAddons),
  'referral apply does NOT reassign basePrice to the already-discounted new_price',
  'basePrice = data.new_price would subtract the discount twice → displayed total < charged total');
// Subtracted exactly once. Always-charge-EGP: the server returns discount_amount
// in EGP, so the LOCAL total subtracts `localDiscount` (the EGP→local equivalent;
// === referralDiscount for domestic) and the EGP disclosure subtracts
// referralDiscount directly. Still one subtraction on each lane, derived from the
// server's referralDiscount — no double-subtract.
assert(/total\s*-\s*localDiscount/.test(payAddons) && /localDiscount\s*=[^;]*referralDiscount/.test(payAddons),
  'the referral discount is subtracted exactly once (localDiscount derived from referralDiscount, EGP→local for intl)',
  'referral discount subtraction pattern changed');
assert(/egpTotal\s*-\s*referralDiscount/.test(payAddons),
  'the EGP disclosure is also reduced by the referral discount (no overstated ≈ EGP)',
  'referral EGP-disclosure reduction missing');
assert(/querySelector\('\.p-pay-cols'\)/.test(payAddons),
  'add-on prices are read from .p-pay-cols so the displayed total tracks add-ons',
  'selector still targets the non-existent .portal-grid → add-on prices read as 0, total never moves');
