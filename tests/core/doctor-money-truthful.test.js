// tests/core/doctor-money-truthful.test.js
//
// AUDIT-2026-09-06 (D3) — two doctor-facing money screens stated things that
// are not true.
//
//   * portal_doctor_earnings.ejs labelled a tile "Paid out" / "تم التحويل"
//     (literally "transferred"), showed a "Paid" pill per month, and footnoted
//     that pending amounts "move to Paid on the next monthly payout".
//     doctor_earnings.status flips to 'paid' inside
//     earnings_writer.markCaseEarningsPaid, which runs when the DOCTOR SUBMITS
//     THE REPORT. No transfer happens, and the platform keeps no settlement
//     ledger — src/routes/api/admin.js says so in as many words. The founder's
//     decision was to relabel, not to build a ledger; the arithmetic is
//     audited and untouched.
//
//   * /portal/doctor/analytics summed orders.price — the PATIENT's price — and
//     doctor_analytics.ejs rendered it as "My revenue" / "إيراداتي", a monthly
//     revenue chart and a per-case amount column. Every production service sets
//     doctor_fee at 20% of base, so the doctor was shown five times what they
//     will be paid. It also contradicted stripPricingFields(), which exists to
//     keep orders.price away from doctors entirely.
//
// Source-level, no DB. Both files are scanned with their comments removed, so
// the paragraphs above (and the ones in the source explaining the same thing)
// cannot satisfy or trip the assertions they describe.

'use strict';

const fs   = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💷 doctor-facing money screens say what is true (AUDIT-2026-09-06 D3)\n');

const ROOT      = path.join(__dirname, '..', '..');
const VIEWS     = path.join(ROOT, 'src', 'views');
const EARNINGS  = path.join(VIEWS, 'portal_doctor_earnings.ejs');
const DAN_VIEW  = path.join(VIEWS, 'doctor_analytics.ejs');
const ANALYTICS = path.join(ROOT, 'src', 'routes', 'analytics.js');

// EJS comments are `<%# ... %>`; stripComments only knows JS. Strip both, so
// the WHY-comments next to each fix are not what the greps below match.
function readTemplateCode(file) {
  return stripComments(fs.readFileSync(file, 'utf8').replace(/<%#[\s\S]*?%>/g, ''));
}

// ── 1. The earnings page never claims money has been transferred ────────────
try {
  const code = readTemplateCode(EARNINGS);

  const claims = [
    ['Paid out',            'the lifetime tile claimed a completed transfer'],
    ['تم التحويل',           'Arabic for "the transfer was made" — the strongest false claim on the page'],
    ['Pending payout',      'nothing is queued at a bank; these are undelivered cases'],
    ['بانتظار التحويل',      'Arabic "awaiting transfer" — same false claim'],
    ['قيد التحويل',          'Arabic "being transferred" — the monthly pill'],
    ['monthly payout',      'there is no monthly settlement run to move amounts to "Paid"'],
    ['التحويل الشهري',       'Arabic for the same non-existent monthly settlement run']
  ];
  const found = claims.filter(([needle]) => code.includes(needle));
  if (found.length) {
    throw new Error('the earnings page tells doctors their money has moved:\n    ' +
      found.map(([n, why]) => JSON.stringify(n) + ' — ' + why).join('\n    '));
  }

  // And it still has to say something in both languages — a page that simply
  // deleted the labels would pass the greps above and help nobody.
  if (!/tt\('Approved'/.test(code) || !code.includes('معتمدة')) {
    throw new Error('the corrected label must exist in EN and AR: an amount is APPROVED ' +
                    'when the report is delivered, not transferred');
  }
  if (!/it is not a transfer/.test(code) || !code.includes('وليس تحويلاً مالياً')) {
    throw new Error('the footnote must state, in both languages, that approval is not a ' +
                    'transfer and that transfers are arranged elsewhere');
  }
  t.pass('earnings page: no transfer claim survives, and the honest label exists in EN + AR');
} catch (e) { t.fail('earnings labels are truthful', e); }

// ── 2. The doctor analytics route reads the doctor's ledger, not the price ──
try {
  const src = stripComments(fs.readFileSync(ANALYTICS, 'utf8'));
  const start = src.indexOf("'/portal/doctor/analytics'");
  if (start < 0) throw new Error('the /portal/doctor/analytics handler is gone');
  const end = src.indexOf("'/api/analytics/export'", start);
  const handler = src.slice(start, end > start ? end : start + 12000);

  if (/SUM\(price\)/i.test(handler) || /\bo\.price\b/.test(handler) || /\bprice\b\s*,/.test(handler)) {
    throw new Error("the doctor analytics handler still reads orders.price. That is the " +
                    'PATIENT price — 5x the doctor fee on every service in the catalogue — ' +
                    'and stripPricingFields() exists specifically to keep it away from ' +
                    'doctors. Read doctor_earnings instead.');
  }
  if (!/FROM doctor_earnings/.test(handler)) {
    throw new Error("the doctor's own figures must come from doctor_earnings, the same " +
                    'ledger the Earnings page reads, so the two screens cannot disagree');
  }
  t.pass('/portal/doctor/analytics sums doctor_earnings, never orders.price');
} catch (e) { t.fail('doctor analytics reads the doctor ledger', e); }

// ── 3. …and the view does not label anything as the doctor's revenue ────────
try {
  const code = readTemplateCode(DAN_VIEW);

  if (/\bc\.price\b/.test(code) || /kpis\.totalRevenue/.test(code) || /charts\.monthlyRevenue/.test(code)) {
    throw new Error('doctor_analytics.ejs still renders a price/revenue field — the payload ' +
                    'no longer carries one, so this would print blanks even if it were ' +
                    'harmless, and it is not');
  }
  for (const label of ['إيراداتي', 'My revenue', 'Monthly revenue', 'الإيرادات الشهرية']) {
    if (code.includes(label)) {
      throw new Error('doctor_analytics.ejs still labels a figure ' + JSON.stringify(label) +
                      " — a doctor's takings are their fee, not the platform's revenue");
    }
  }
  if (!code.includes('أرباحي') || !/My earnings/.test(code)) {
    throw new Error('the corrected KPI label must be present in both languages');
  }
  t.pass('doctor_analytics.ejs shows the doctor\'s own earnings, in EN + AR');
} catch (e) { t.fail('doctor analytics view is honestly labelled', e); }

// ── 4. No doctor-facing view prints a patient price as the doctor's own ─────
//
// The class, not just the two instances: wherever a doctor-facing template
// does print a patient price (services catalogue, video appointments), it must
// say whose money it is.
try {
  const doctorViews = fs.readdirSync(VIEWS)
    .filter((f) => /^(portal_)?doctor_/.test(f) && f.endsWith('.ejs'))
    .map((f) => path.join(VIEWS, f));
  if (doctorViews.length < 5) {
    throw new Error('only ' + doctorViews.length + ' doctor views found — the scan is ' +
                    'probably broken, and a test that scans nothing passes for the wrong reason');
  }

  const offenders = [];
  for (const file of doctorViews) {
    const code = readTemplateCode(file);
    // A price rendered under a bare "Amount"/"المبلغ" header reads as the
    // reader's own money. Either label it (Patient pays / يدفع المريض) or
    // render the doctor's fee.
    if (/\.price\b/.test(code) && (/'Amount'/.test(code) || code.includes('المبلغ'))) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  if (offenders.length) {
    throw new Error('a patient price is rendered under an unattributed "Amount" header, on a ' +
                    "page a doctor reads as their own money:\n    " + offenders.join('\n    '));
  }
  t.pass('no doctor-facing view prints a patient price under an unattributed amount column');
} catch (e) { t.fail('patient prices are attributed', e); }
