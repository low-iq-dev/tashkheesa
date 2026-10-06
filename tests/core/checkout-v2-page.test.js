'use strict';
// tests/core/checkout-v2-page.test.js
//
// 2026-10-06 — views/patient_pay_v2.ejs, the redesigned checkout.
//
// The page owns no payment logic, so what can go wrong is the page offering a
// way to pay that is not on, hiding the one that is, or showing a figure that
// is not the order's. These render the view for each combination and pin that.

const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};
const tag = 'checkout-v2-page';
console.log('\n🧾 checkout v2 page\n');

const VIEWS = path.join(__dirname, '../../src/views');
const SRC = fs.readFileSync(path.join(VIEWS, 'patient_pay_v2.ejs'), 'utf8');
['partials/patient/head', 'partials/patient/topbar', 'partials/patient/whats-happening-card',
 'partials/patient/foot', 'partials/urgent-window-note'].forEach(function (p) {
  ejs.cache.set(path.join(VIEWS, p + '.ejs'), function () { return '[' + p + ']'; });
});

let n = 0;
function render(over) {
  const locals = Object.assign({
    isAr: false, lang: 'en', user: { id: 'u1', name: 'Test Patient' },
    order: { id: 'order-abc12345', reference_id: 'TSH-2026-000016', service_name: '12-Lead ECG Interpretation',
      specialty_name: 'Cardiology', price: 600, currency: 'EGP', urgency_tier: 'standard',
      referral_code: 'TASH50', referral_discount: 600 },
    csrfField: function () { return '<input type="hidden" name="_csrf" value="tok">'; },
    csrfToken: 'tok', cspNonce: 'n1', error: null, paymentFailed: false,
    cardEnabled: true, manualPayment: null
  }, over || {});
  return ejs.render(SRC, locals, { filename: path.join(VIEWS, '__v2test_' + (++n) + '.ejs'), cache: false });
}
function mp(over) {
  return Object.assign({
    instapay: { handle: null, link: null },
    bank: { bankName: 'CIB', accountName: 'MEDTECH', accountNumber: '100071592752', iban: null },
    relationshipNote: 'Parent company note.', confirmNote: 'We confirm transfers during working hours.',
    amount: 600, currency: 'EGP', reference: 'TSH-2026-000016', claim: null, flash: null, errorCode: null, formValues: null
  }, over || {});
}
function check(name, fn) { try { fn(); t.pass(tag + ': ' + name); } catch (e) { t.fail(tag + ': ' + name, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

check('card + transfer: two tiles, both panels, card first', function () {
  const h = render({ manualPayment: mp() });
  assert(/data-pv-tile="card"/.test(h) && /data-pv-tile="transfer"/.test(h), 'tiles missing');
  assert(/id="pv-card"/.test(h) && /id="transfer"/.test(h), 'a panel is missing');
  assert(/data-start="card"/.test(h), 'should start on card');
  assert(/pv-paybtn" data-paymob-create-intention data-order-id="order-abc12345"/.test(h), 'card button contract missing');
});

check('transfer only (what real patients see before card go-live): no tiles, no card button', function () {
  const h = render({ cardEnabled: false, manualPayment: mp() });
  assert(!/data-pv-tile=/.test(h), 'tiles shown with one method');
  assert(!/pv-paybtn" data-paymob-create-intention/.test(h) && !/id="pv-card"/.test(h), 'card offered while off');
  assert(/id="transfer"/.test(h) && /data-start="transfer"/.test(h), 'transfer panel missing');
});

check('card only: no tiles, no transfer form', function () {
  const h = render({ cardEnabled: true, manualPayment: null });
  assert(!/data-pv-tile=/.test(h) && !/transfer-claim/.test(h), 'transfer shown while off');
  assert(/pv-paybtn" data-paymob-create-intention/.test(h), 'card button missing');
});

check('the transfer form posts what the route reads', function () {
  const h = render({ manualPayment: mp() });
  assert(/action="\/portal\/patient\/pay\/order-abc12345\/transfer-claim"/.test(h), 'form action');
  assert(/name="_csrf"/.test(h) && /name="reference"/.test(h) && /name="sender_name"/.test(h) && /name="method"/.test(h), 'a field the route reads is missing');
  assert(/100071592752/.test(h) && /TSH-2026-000016/.test(h) && />600</.test(h), 'bank details, reference or amount missing');
});

check('a pending or rejected transfer claim lands on the transfer option', function () {
  const p = render({ manualPayment: mp({ claim: { status: 'pending', method: 'instapay', reference: 'InstaPay 17:35', submittedAt: null } }) });
  assert(/data-start="transfer"/.test(p) && /InstaPay 17:35/.test(p), 'pending claim not shown first');
  const r = render({ manualPayment: mp({ claim: { status: 'rejected', method: 'bank', reference: 'x', rejectionReason: 'Amount did not match' } }) });
  assert(/data-start="transfer"/.test(r) && /Amount did not match/.test(r), 'rejection reason not shown');
});

check('figures come from the order: fee, discount line, total, button amount', function () {
  const h = render({ manualPayment: mp() });
  assert(/1,200/.test(h) && /TASH50/.test(h) && /50% off/.test(h) && /−600/.test(h), 'fee/discount lines wrong');
  assert(/Pay 600 EGP securely/.test(h), 'button does not carry the amount owed');
  const plain = render({ order: { id: 'o2', service_name: 'X', price: 1200, currency: 'EGP', urgency_tier: 'vip' }, manualPayment: mp({ amount: 1200 }) });
  assert(!/% off/.test(plain) && /id="pv_code_btn"/.test(plain), 'no-discount order should offer the code box and no discount line');
  assert(/Pay 1,200 EGP securely/.test(plain) && /18 hours/.test(plain), 'amount / VIP turnaround wrong');
});

check('international order: local price shown, EGP charge stated wherever money moves', function () {
  // Quoted 80 USD, charged 3,200 EGP, with a 50% code already applied (fee was 6,400 EGP = 160 USD).
  const h = render({
    order: { id: 'o-intl', service_name: 'X', price: 3200, currency: 'EGP', display_price: 80, display_currency: 'USD',
      urgency_tier: 'standard', referral_code: 'TASH50', referral_discount: 3200 },
    price: 80, currency: 'USD', manualPayment: mp({ amount: 3200 })
  });
  assert(/>80<\/span>/.test(h) && /USD/.test(h), 'local total not shown');
  assert(/160 USD/.test(h) && /−80 USD/.test(h), 'local fee/discount lines do not add up to the local total');
  assert(/data-pv-egp-note/.test(h) && /3,200 EGP/.test(h), 'the EGP amount actually charged is not stated');
  assert(/Pay 3,200 EGP securely/.test(h), 'the pay button must carry the amount actually charged');
  assert(/Transfers are in Egyptian pounds/.test(h), 'transfer option must say it is EGP-only');
  const dom = render({ manualPayment: mp() });
  assert(!/data-pv-egp-note/.test(dom) && !/Transfers are in Egyptian pounds/.test(dom), 'domestic order shows international notes');
});

check('urgent-hours note only on an Urgent case', function () {
  const note = function () { return 'URGENT-HOURS-RULE'; };
  assert(!/URGENT-HOURS-RULE/.test(render({ manualPayment: mp(), urgentWindowNote: note })), 'shown on a Standard case');
  const u = render({ order: { id: 'o3', service_name: 'X', price: 2400, currency: 'EGP', urgency_tier: 'urgent' }, manualPayment: mp(), urgentWindowNote: note });
  assert(/URGENT-HOURS-RULE/.test(u) && /4 hours/.test(u), 'missing on an Urgent case');
});

check('Arabic renders, with the Shifa name written the brand way', function () {
  const h = render({ isAr: true, lang: 'ar', manualPayment: mp() });
  assert(/اختار طريقة الدفع/.test(h) && /إنستاباي أو تحويل بنكي/.test(h), 'Arabic copy missing');
  assert(!/الشفاء/.test(SRC), 'the hospital is «شفا», never «الشفاء»');
});

check('route: v2 is used only for the cases it was built for', function () {
  const r = fs.readFileSync(path.join(__dirname, '../../src/routes/patient.js'), 'utf8');
  const i = r.indexOf("res.render('patient_pay_v2'");
  assert(i !== -1, 'route never renders the v2 view');
  const guard = r.slice(r.lastIndexOf('if (hasWayToPay', i), i);
  assert(/!serviceHasAddons/.test(guard) && /isInternalFallback/.test(guard),
    'v2 must not take add-on or external-link orders');
  assert(i < r.indexOf("res.render('patient_payment_required', Object.assign({}, payRenderCommon, {\n      paymentLink: null"), 'v2 branch must come before the old render');
});
