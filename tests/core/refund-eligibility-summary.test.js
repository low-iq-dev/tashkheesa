'use strict';
// tests/core/refund-eligibility-summary.test.js
//
// 2026-09-13 (Part C1/C8). The patient refund form now says what can be
// refunded and why, and the operator queue, the operator create form and the
// Command API say the same thing — all from services/refund_summary.js. This
// pins what that helper says for the four states the brief names, and that the
// form renders exactly the helper's sentence (not a second copy of the policy).
// The browser-level check against a real database (same four states, both
// languages, 390px) is in scripts/mobile-shots.js.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n💸 refund eligibility summary — helper and form agree (Part C1/C8)\n');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');
const { describeRefund } = require('../../src/services/refund_summary');

function check(name, fn) {
  try { const err = fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); } catch (e) { t.fail(name, e); }
}

const STATES = {
  'pre-accept': {
    facts: { verdict: { eligible: true, reason: 'pre_doctor_accept', autoApprove: true }, ceilingEgp: 2400, alreadyRefundedEgp: 0, tier: 'vip', upliftEgp: 800 },
    kind: 'full', canRequest: true, amount: 2400,
    en: [/^Full refund: EGP 2,400\./], ar: [/^استرداد كامل: 2,400 جنيه\./]
  },
  'post-accept Standard': {
    facts: { verdict: { eligible: true, reason: 'post_in_review_review_required', autoApprove: false }, ceilingEgp: 1600, alreadyRefundedEgp: 0, tier: 'standard', upliftEgp: 0 },
    kind: 'review', canRequest: true, amount: 1600,
    en: [/Up to EGP 1,600, after review/, /Standard has no urgency surcharge/], ar: [/حتى 1,600 جنيه بعد المراجعة/, /القياسية بلا رسوم استعجال/]
  },
  'SLA-breached VIP': {
    facts: { verdict: { eligible: false, reason: 'already_refunded_via_breach', autoApprove: false }, ceilingEgp: 2400, alreadyRefundedEgp: 800, tier: 'vip', upliftEgp: 800, breachRefund: { amount: 800, status: 'paid' } },
    kind: 'surcharge_only', canRequest: false, amount: 800,
    en: [/VIP urgency surcharge of EGP 800 was refunded/, /Nothing more can be requested/], ar: [/رسوم الاستعجال \(VIP\) بقيمة 800 جنيه/, /لا يمكن طلب مبلغ آخر/]
  },
  'after a partial refund': {
    facts: { verdict: { eligible: true, reason: 'post_in_review_review_required', autoApprove: false }, ceilingEgp: 2400, alreadyRefundedEgp: 600, tier: 'vip', upliftEgp: 800 },
    kind: 'remainder', canRequest: true, amount: 1800,
    en: [/Up to EGP 1,800 — the rest of what you paid\. EGP 600 has already been refunded/], ar: [/حتى 1,800 جنيه — المتبقي مما دفعته\. تم ردّ 600 جنيه/]
  }
};

for (const [label, s] of Object.entries(STATES)) {
  const out = describeRefund(s.facts);
  check(`helper: ${label} → ${s.kind}, ${s.amount} EGP, ${s.canRequest ? 'can' : 'cannot'} request`, () => {
    if (out.kind !== s.kind) return 'kind ' + out.kind;
    if (out.amountEgp !== s.amount) return 'amount ' + out.amountEgp;
    if (out.canRequest !== s.canRequest) return 'canRequest ' + out.canRequest;
    for (const re of s.en) if (!re.test(out.text.en)) return 'en text: ' + out.text.en;
    for (const re of s.ar) if (!re.test(out.text.ar)) return 'ar text: ' + out.text.ar;
    if (/fast[\s-]?track|24\s*[–-]\s*72/i.test(out.text.en + out.text.ar)) return 'retired tier wording';
    if (/[٠-٩]/.test(out.text.ar)) return 'Arabic-Indic digits in money';
    return null;
  });
}

check('helper: nothing refundable states say why (delivered, fully refunded, unpaid)', () => {
  const cases = [['case_completed', /report has been delivered/], ['not_paid', /no payment was taken/]];
  for (const [reason, re] of cases) {
    const o = describeRefund({ verdict: { eligible: false, reason, autoApprove: false }, ceilingEgp: 1600, alreadyRefundedEgp: 0 });
    if (o.kind !== 'nothing' || o.canRequest || !re.test(o.text.en)) return reason + ': ' + JSON.stringify(o);
  }
  const full = describeRefund({ verdict: { eligible: true, reason: 'post_in_review_review_required', autoApprove: false }, ceilingEgp: 1600, alreadyRefundedEgp: 1600 });
  if (full.kind !== 'nothing' || !/everything you paid on this case has been refunded/.test(full.text.en)) return 'fully refunded: ' + JSON.stringify(full);
  return null;
});

// ── the form renders the helper's sentence ─────────────────────────────
['partials/patient/head', 'partials/patient/foot', 'partials/patient/icon'].forEach((p) => {
  ejs.cache.set(path.join(VIEWS, p + '.ejs'), () => '');
});
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;');
let rc = 0;
function renderForm(summary, isAr) {
  const src = fs.readFileSync(path.join(VIEWS, 'patient_refund_request.ejs'), 'utf8');
  return ejs.render(src, {
    isAr, lang: isAr ? 'ar' : 'en', user: {}, cspNonce: 'n',
    tt: (k, en, ar) => (isAr ? ar : en), csrfField: () => '',
    order: { id: 'o1', reference_id: 'TSH-TEST01' },
    eligibility: { eligible: summary.canRequest }, summary,
    requestedAmount: summary.remainingEgp, instapayDefault: '+201012345678',
    formError: '', formValues: {}
  }, { filename: path.join(VIEWS, '__refundform_' + (++rc) + '.ejs'), cache: true });
}

for (const [label, s] of Object.entries(STATES)) {
  const summary = describeRefund(s.facts);
  for (const isAr of [false, true]) {
    const L = isAr ? 'ar' : 'en';
    check(`form [${L}] ${label}: shows the helper's sentence, kind and submit state`, () => {
      const html = renderForm(summary, isAr);
      const m = html.match(/<p id="refund-eligibility"[^>]*data-kind="([^"]+)"[^>]*>([\s\S]*?)<\/p>/);
      if (!m) return 'no [data-refund-eligibility] paragraph';
      if (m[1] !== s.kind) return 'data-kind ' + m[1];
      if (m[2] !== esc(summary.text[L])) return 'form text differs from helper:\n    form:   ' + m[2] + '\n    helper: ' + summary.text[L];
      const btn = html.match(/<button[^>]*data-refund-submit[^>]*>/);
      if (!btn) return 'no submit button';
      const disabled = /\sdisabled[\s>]/.test(btn[0]);
      if (disabled === s.canRequest) return 'submit disabled=' + disabled;
      if (!s.canRequest && !/aria-describedby="refund-eligibility"/.test(btn[0])) return 'disabled submit does not point at the explanation';
      if (s.canRequest && !/name="instapay_handle"[^>]*value="\+201012345678"/.test(html)) return 'InstaPay number not prefilled';
      if (s.canRequest && !/name="reason"[^>]*maxlength="500"/.test(html)) return 'reason not capped at 500';
      if (!/data-refund-policy-summary/.test(html) || (html.match(/<li>/g) || []).length < 3) return 'no three-line policy summary';
      return null;
    });
  }
}

check('POST validates the InstaPay number as E.164 and stores it normalised', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient.js'), 'utf8');
  const start = src.indexOf("router.post('/portal/patient/orders/:id/request-refund'");
  const body = src.slice(start, src.indexOf('\nrouter.', start + 50));
  if (!/validatePhoneE164\(instapayRaw/.test(body)) return 'no E.164 validation';
  if (!/instapay_invalid/.test(body)) return 'no instapay_invalid error';
  if (!/\[refundId, orderId, requestedAmount, reasonRaw, instapayNumber,/.test(body)) return 'raw input stored instead of the normalised number';
  return null;
});

check('case page loads every refund on the order, not only patient requests', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient.js'), 'utf8');
  const start = src.indexOf("router.get('/portal/patient/orders/:id', requireRole('patient')");
  const body = src.slice(start, src.indexOf('\nrouter.', start + 50));
  const q = body.match(/SELECT(?:(?!SELECT)[\s\S])*?FROM refunds[\s\S]*?LIMIT \d+/);
  if (!q) return 'no refunds query in the case route';
  if (/reason\s*=\s*'patient_request'/.test(q[0])) return 'still filtered to patient_request';
  if (!/paid_to_number/.test(q[0])) return 'does not read the number paid to';
  return null;
});
