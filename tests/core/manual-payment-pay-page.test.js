'use strict';
// tests/core/manual-payment-pay-page.test.js
//
// Manual payment path (InstaPay / bank transfer), web pay page.
//
// 1. BYTE-IDENTICAL AT DEFAULTS. With CARD_PAYMENT_ENABLED at its default (on)
//    and MANUAL_PAYMENT_ENABLED at its default (off), the route passes
//    { cardEnabled: true, manualPayment: null } and the page must render
//    exactly what the live view (commit e064d06, frozen in
//    tests/fixtures/patient_payment_required.e064d06.ejs) renders — across the
//    simple flow, the add-on flow, the external-link flow, an international
//    order, Arabic, and the declined-card banner.
// 2. The transfer block renders below the card button when enabled, alone
//    (no Paymob button, no card-only add-on picker) when the card is disabled,
//    and switches to "we are checking it" / "could not match" by claim state.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');
function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

console.log('\n🏦 manual payment — web pay page (flag-off byte-identical + transfer block)\n');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');
const NEW_SRC = fs.readFileSync(path.join(VIEWS, 'patient_payment_required.ejs'), 'utf8');
const OLD_SRC = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'patient_payment_required.e064d06.ejs'), 'utf8');

// Stub the chrome partials (same approach as pay-page-renders.test.js). The
// manual-payment partial is NOT stubbed — it is part of what is under test.
['partials/patient/head', 'partials/patient/topbar', 'partials/patient/whats-happening-card',
 'partials/patient/need-help-card', 'partials/patient/foot'].forEach(function (p) {
  ejs.cache.set(path.join(VIEWS, p + '.ejs'), function (d) { return '[' + p + ']'; });
});

let rc = 0;
function render(src, locals) {
  return ejs.render(src, locals, { filename: path.join(VIEWS, '__mptest_' + (++rc) + '.ejs'), cache: false });
}

function baseLocals(over) {
  return Object.assign({
    isAr: false,
    lang: 'en',
    user: { id: 'u1', name: 'Test Patient' },
    order: { id: 'order-abc12345', service_name: 'Cardiology Review', specialty_name: 'Cardiology', price: 1600, currency: 'EGP', display_price: null, display_currency: null },
    tt: function (k, en, ar) { return this && this.isAr ? ar : en; },
    csrfField: function () { return '<input type="hidden" name="_csrf" value="tok">'; },
    csrfToken: 'tok',
    price: 1600,
    currency: 'EGP',
    egpChargePrice: 1600,
    videoConsultationPriceEgp: 0,
    sla24hrPriceEgp: 100,
    prescriptionPriceEgp: 0,
    videoPriceCurrency: 'EGP',
    prescriptionPriceCurrency: 'EGP',
    videoConsultationPrice: 0,
    sla24hrPrice: 100,
    prescriptionPrice: 0,
    videoEnabled: false,
    serviceDetails: {},
    error: null,
    paymentFailed: false,
    paymentUrl: null,
    paymentLink: null,
    cspNonce: 'n1'
  }, over || {});
}

const SCENARIOS = {
  'simple flow': {},
  'add-on flow': { videoConsultationPrice: 200, videoConsultationPriceEgp: 200, prescriptionPrice: 300, prescriptionPriceEgp: 300, videoEnabled: true },
  'external payment link': { paymentUrl: 'https://accept.paymob.com/unifiedcheckout/x', paymentLink: '/portal/patient/pay/order-abc12345' },
  'international order': { order: { id: 'order-intl', price: 3200, base_price: 1600, display_price: 40, display_currency: 'USD', currency: 'EGP' }, price: 80, currency: 'USD', egpChargePrice: 3200 },
  'arabic': { isAr: true, lang: 'ar' },
  'declined-card banner + error': { paymentFailed: true, error: 'Payment is required before accessing this case.' }
};

// ── 1. Byte-identical at defaults ──────────────────────────────────────────
for (const [name, over] of Object.entries(SCENARIOS)) {
  let oldHtml, newHtml, newHtmlBare, err = null;
  try {
    const l = baseLocals(over);
    l.tt = function (k, en, ar) { return l.isAr ? ar : en; };
    oldHtml = render(OLD_SRC, l);
    // Exactly what routes/patient.js passes at the defaults...
    newHtml = render(NEW_SRC, Object.assign({}, l, { cardEnabled: true, manualPayment: null }));
    // ...and with the new locals absent altogether.
    newHtmlBare = render(NEW_SRC, l);
  } catch (e) { err = e; }
  assert(!err, 'renders (' + name + ')', err && err.message);
  if (err) continue;
  let firstDiff = -1;
  for (let i = 0; i < Math.max(oldHtml.length, newHtml.length); i++) { if (oldHtml[i] !== newHtml[i]) { firstDiff = i; break; } }
  assert(oldHtml === newHtml, 'defaults render byte-identical to e064d06 (' + name + ')',
    'first difference at char ' + firstDiff + ': old=' + JSON.stringify(oldHtml.slice(firstDiff - 40, firstDiff + 60)) +
    ' new=' + JSON.stringify(newHtml.slice(firstDiff - 40, firstDiff + 60)));
  assert(oldHtml === newHtmlBare, 'byte-identical with the new locals absent (' + name + ')');
}

// ── 2. Transfer block ──────────────────────────────────────────────────────
function mp(over) {
  return Object.assign({
    instapay: { handle: 'tashkheesa@instapay', link: 'https://ipn.eg/S/tashkheesa/instapay/abc' },
    bank: { bankName: 'CIB', accountName: 'Tashkheesa LLC', accountNumber: '0000000000000', iban: 'EG00000000000000000000000000' },
    relationshipNote: 'This account belongs to our founder.',
    confirmNote: 'We confirm transfers during working hours. Your case starts as soon as we confirm.',
    amount: 1600,
    currency: 'EGP',
    reference: 'TSH-2026-000417',
    claim: null,
    flash: null,
    errorCode: null,
    formValues: null
  }, over || {});
}
function renderWith(over, localsOver) {
  const l = baseLocals(localsOver);
  l.tt = function (k, en, ar) { return l.isAr ? ar : en; };
  return render(NEW_SRC, Object.assign(l, over));
}

try {
  const html = renderWith({ cardEnabled: true, manualPayment: mp() });
  assert(/Pay securely with Paymob/.test(html), 'card on + manual on: Paymob button still rendered');
  assert(/Prefer to pay by transfer\?/.test(html), 'card on + manual on: heading "Prefer to pay by transfer?"');
  assert(html.indexOf('Pay securely with Paymob') < html.indexOf('Prefer to pay by transfer?'), 'transfer block sits BELOW the card button');
  assert(/1,600/.test(html) && /TSH-2026-000417/.test(html), 'amount and order reference shown');
  assert(/tashkheesa@instapay/.test(html) && /ipn\.eg/.test(html), 'InstaPay handle and link shown');
  assert(/Tashkheesa LLC/.test(html) && /EG00000000000000000000000000/.test(html), 'bank details shown');
  assert(/This account belongs to our founder\./.test(html), 'relationship note shown');
  assert(/We confirm transfers during working hours/.test(html), 'honest confirm note shown');
  assert(/does not mark your case as paid/.test(html), 'says plainly that a claim is not payment');
  assert(/data-mp-copy="TSH-2026-000417"/.test(html) && /data-mp-copy="1600"/.test(html), 'copy buttons for reference and amount');
  assert(/action="\/portal\/patient\/pay\/order-abc12345\/transfer-claim"/.test(html) && /name="_csrf"/.test(html), 'claim form posts to the claim route with CSRF');
  assert(/<script nonce="n1">/.test(html), 'copy script carries the CSP nonce');
} catch (e) { t.fail(fileTag + ': card on + manual on', e); }

try {
  const html = renderWith({ cardEnabled: false, manualPayment: mp() },
    { videoConsultationPrice: 200, videoConsultationPriceEgp: 200, videoEnabled: true });
  assert(!/Paymob/.test(html), 'card off: no Paymob button anywhere');
  assert(!/<button[^>]*\n?\s*[^>]*data-paymob-create-intention/.test(html) && !/data-paymob-create-intention\s+data-order-id/.test(html), 'card off: no create-intention button');
  assert(!/id="addon_video_consultation"/.test(html), 'card off: card-only add-on picker hidden');
  assert(/Pay by InstaPay or bank transfer/.test(html), 'card off: heading "Pay by InstaPay or bank transfer"');
  assert(!/only added when you pay by card/.test(html), 'card off: no card add-on caveat');
} catch (e) { t.fail(fileTag + ': card off', e); }

try {
  const html = renderWith({ cardEnabled: true, manualPayment: mp() },
    { videoConsultationPrice: 200, videoConsultationPriceEgp: 200, videoEnabled: true });
  assert(/only added when you pay by card/.test(html), 'card on + add-ons offered: caveat that ticked extras are card-only');
} catch (e) { t.fail(fileTag + ': add-on caveat', e); }

try {
  const html = renderWith({ cardEnabled: false, manualPayment: mp() }, { isAr: true, lang: 'ar' });
  assert(/ادفع بإنستاباي أو تحويل بنكي/.test(html), 'Arabic heading (card off)');
  const html2 = renderWith({ cardEnabled: true, manualPayment: mp() }, { isAr: true, lang: 'ar' });
  assert(/تفضّل الدفع بالتحويل؟/.test(html2), 'Arabic heading (card on)');
} catch (e) { t.fail(fileTag + ': arabic', e); }

try {
  const pending = mp({ claim: { id: 'pc-1', status: 'pending', method: 'instapay', reference: 'IPN12345', senderName: null, submittedAt: '2026-09-24T10:00:00.000Z', rejectionReason: null } });
  const html = renderWith({ cardEnabled: true, manualPayment: pending });
  assert(/We have your transfer reference and are checking it\./.test(html), 'pending claim: "we are checking it" message');
  assert(/IPN12345/.test(html), 'pending claim: shows the submitted reference');
  assert(/<details/.test(html) && /Sent the wrong reference\? Update it/.test(html), 'pending claim: the form is tucked behind a correction disclosure, not shown as the main action');
  assert(!/Already sent it\? Tell us/.test(html), 'pending claim: no fresh "tell us" prompt');
} catch (e) { t.fail(fileTag + ': pending', e); }

try {
  const rejected = mp({ claim: { id: 'pc-1', status: 'rejected', method: 'bank', reference: 'BNK999', senderName: 'A', submittedAt: '2026-09-24T10:00:00.000Z', rejectionReason: 'No transfer with that reference arrived.' } });
  const html = renderWith({ cardEnabled: true, manualPayment: rejected });
  assert(/We could not match your last transfer\./.test(html), 'rejected claim: says it could not be matched');
  assert(/No transfer with that reference arrived\./.test(html), 'rejected claim: shows the reason');
  assert(/Already sent it\? Tell us/.test(html) && /transfer-claim/.test(html) && !/<details/.test(html), 'rejected claim: form shown again, openly');
} catch (e) { t.fail(fileTag + ': rejected', e); }

try {
  const html = renderWith({ cardEnabled: true, manualPayment: mp({ instapay: null }) });
  assert(!/InstaPay address/.test(html) && /value="bank"/.test(html) && !/type="radio"/.test(html),
    'bank-only config: no InstaPay section, method fixed to bank');
  const html2 = renderWith({ cardEnabled: true, manualPayment: mp({ errorCode: 'reference_invalid' }) });
  assert(/Please enter the transfer reference/.test(html2), 'validation error rendered');
  const html3 = renderWith({ cardEnabled: true, manualPayment: mp({ flash: 'submitted' }) });
  assert(/Thank you — we have your transfer reference\./.test(html3), 'submitted flash rendered');
} catch (e) { t.fail(fileTag + ': variants', e); }
