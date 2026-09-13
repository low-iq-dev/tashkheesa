'use strict';
// tests/core/refund-policy-page.test.js
//
// 2026-09-13 (Part C6/C8). The public /refund-policy told patients refunds were
// "not returned to your original card" (there is no card payment), carried
// three video-consultation clauses while video is not offered, had no word on
// partial refunds or asking for the rest, and was dated February 2026. This
// renders the page in both languages with the video flag off and on and pins
// the facts that must hold.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n💸 /refund-policy says what is true (Part C6)\n');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');
['partials/header', 'partials/footer'].forEach((p) => {
  ejs.cache.set(path.join(VIEWS, p + '.ejs'), () => '');
});

let rc = 0;
function render(isAr, videoComingSoon) {
  const src = fs.readFileSync(path.join(VIEWS, 'refund_policy.ejs'), 'utf8');
  return ejs.render(src, {
    isAr, lang: isAr ? 'ar' : 'en', title: 'x', videoComingSoon,
    BUSINESS_INFO: { email: 'probe@tashkheesa.com', phone: '+20 110 200 9886' }
  }, { filename: path.join(VIEWS, '__refundpolicy_' + (++rc) + '.ejs'), cache: true });
}
// The policy text only: tags and EJS comments gone, so a class name such as
// "content-card" cannot satisfy or trip a wording check.
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function check(name, fn) {
  try { const err = fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); } catch (e) { t.fail(name, e); }
}

const VIDEO = /video|فيديو|مرئي/i;
const CARD = /\bcards?\b|بطاق/i;

for (const isAr of [false, true]) {
  const L = isAr ? 'ar' : 'en';
  const off = text(render(isAr, true));
  const on = text(render(isAr, false));

  check(`[${L}] video flag off: no video clause anywhere`, () => (VIDEO.test(off) ? 'mentions video: …' + off.match(new RegExp('.{0,60}' + VIDEO.source + '.{0,40}', 'i'))[0] + '…' : null));
  check(`[${L}] video flag on: the video clauses come back`, () => (VIDEO.test(on) ? null : 'no video section with the flag on'));
  check(`[${L}] no card wording (card payment is not offered)`, () => (CARD.test(off) || CARD.test(on) ? 'mentions a card' : null));
  check(`[${L}] InstaPay is named as the way refunds are paid`, () => (/InstaPay/.test(off) ? null : 'no "InstaPay"'));
  check(`[${L}] review in 1 business day, money in 3–5 business days`, () => {
    if (isAr) return /يوم عمل واحد/.test(off) && /3 إلى 5 أيام عمل/.test(off) ? null : 'timings missing';
    return /1 business day/.test(off) && /3–5 business days/.test(off) ? null : 'timings missing';
  });
  check(`[${L}] tiers: Urgent 4h, VIP 18h, Standard 48h — never Fast Track or 24–72h`, () => {
    if (/fast[\s-]?track|24\s*[–-]\s*72/i.test(off + on)) return 'retired tier wording present';
    const want = isAr ? [/العاجلة: 4 ساعات/, /VIP: 18 ساعة/, /القياسية: 48 ساعة/] : [/Urgent 4h/, /VIP 18h/, /Standard 48h/];
    const miss = want.filter((re) => !re.test(off));
    return miss.length ? 'missing ' + miss.join(', ') : null;
  });
  check(`[${L}] Standard has no surcharge, said plainly`, () => (
    (isAr ? /القياسية بلا رسوم استعجال/ : /Standard has no urgency surcharge/).test(off) ? null : 'no plain Standard sentence'));
  check(`[${L}] partial refunds and asking for the rest`, () => (
    (isAr ? /طلب المتبقي/ : /request the rest/).test(off) ? null : 'no remainder clause'));
  check(`[${L}] full refund before a consultant accepts`, () => (
    (isAr ? /قبل أن يقبل استشاري حالتك/ : /before a consultant accepts your case/i).test(off) ? null : 'no pre-accept full refund'));
  check(`[${L}] the 7-day quality review is kept`, () => ((isAr ? /خلال 7 أيام/ : /within 7 days/).test(off) ? null : 'no 7-day review'));
  check(`[${L}] "how to request" names the real button`, () => {
    // The CTA on the patient case page (src/views/patient_order.ejs, refund.cta_button).
    const order = fs.readFileSync(path.join(VIEWS, 'patient_order.ejs'), 'utf8');
    const m = order.match(/tt\('refund\.cta_button',\s*'([^']+)',\s*'([^']+)'\)/);
    if (!m) return 'patient_order.ejs has no refund.cta_button';
    const label = isAr ? m[2] : m[1];
    return off.includes(label) ? null : 'policy does not name the button "' + label + '"';
  });
  check(`[${L}] last-updated date is this revision`, () => ((isAr ? /آخر تحديث: 13 سبتمبر 2026/ : /Last updated: 13 September 2026/).test(off) ? null : 'stale date'));
}

check('route keeps URL + canonical, and its description names video only with the flag on', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'static-pages.js'), 'utf8');
  if (!/router\.get\('\/refund-policy'[\s\S]{0,400}canonical: '\/refund-policy'/.test(src)) return 'route or canonical changed';
  const { refundPolicyDescription } = require('../../src/routes/static-pages');
  for (const isAr of [false, true]) {
    if (VIDEO.test(refundPolicyDescription(isAr, false))) return 'description mentions video with the flag off';
    if (!VIDEO.test(refundPolicyDescription(isAr, true))) return 'description drops video with the flag on';
  }
  return null;
});
