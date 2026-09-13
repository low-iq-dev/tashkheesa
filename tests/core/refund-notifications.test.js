'use strict';
// tests/core/refund-notifications.test.js
//
// 2026-09-13 (Part C3). What the patient is told about a refund, on every
// channel, in both languages:
//   - approved / denied / paid each carry the amount and its currency;
//   - paid also carries the last four digits of the InstaPay number it went to;
//   - they go to the CASE'S PATIENT — refunds.requested_by is the operator on
//     an operator refund and 'system' on a breach refund, and the web used to
//     notify that;
//   - paid is awaited and a failure warns the operator, like the other three.
// Existing pins stay where they are: silent-failures-part-b (e) for the warning,
// theme7b-* for the routes, bilingual-email-template-parity for en/ar fields.

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n💸 refund notifications carry the money and reach the patient (Part C3)\n');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function check(name, fn) {
  try { const err = fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); } catch (e) { t.fail(name, e); }
}

const PAYLOADS = {
  patient_refund_approved: { case_id: 'ord-1', caseReference: 'ORD-1', approvedAmount: '1200.00', amount: '1200.00', currency: 'EGP' },
  patient_refund_denied: { case_id: 'ord-1', caseReference: 'ORD-1', denialReason: 'Report already written', requestedAmount: '1600.00', amount: '1600.00', currency: 'EGP' },
  patient_refund_paid: { case_id: 'ord-1', caseReference: 'ORD-1', amount: '1800.00', currency: 'EGP', instapayReference: 'IPX-1', instapayLast4: '0002' }
};
const AMOUNT = { patient_refund_approved: /1,?200/, patient_refund_denied: /1,?600/, patient_refund_paid: /1,?800/ };

// ── in-app bell ──────────────────────────────────────────────────────────
const { renderNotificationMessage } = require(path.join(ROOT, 'src', 'notify.js'));
for (const [tpl, payload] of Object.entries(PAYLOADS)) {
  for (const lang of ['en', 'ar']) {
    check(`in-app [${lang}] ${tpl}: amount + currency${tpl.endsWith('paid') ? ' + last 4 digits' : ''}`, () => {
      const body = String(renderNotificationMessage(tpl, payload, lang) || '');
      if (!AMOUNT[tpl].test(body)) return 'no amount: ' + body;
      if (!/EGP/.test(body)) return 'no currency: ' + body;
      if (tpl.endsWith('paid') && !/0002/.test(body)) return 'no last 4 digits: ' + body;
      if (/\+2010|01000000002/.test(body)) return 'full number leaked';
      return null;
    });
  }
}

// ── WhatsApp (OpenClaw, the production transport) ────────────────────────
const { getOpenClawBody } = require(path.join(ROOT, 'src', 'notify', 'openclawTemplates.js'));
for (const [tpl, payload] of Object.entries(PAYLOADS)) {
  for (const lang of ['en', 'ar']) {
    check(`WhatsApp [${lang}] ${tpl}: amount + currency${tpl.endsWith('paid') ? ' + last 4 digits' : ''}`, () => {
      const out = getOpenClawBody(tpl, lang, payload, { orderId: 'ord-1' });
      const body = String((out && (out.body || out.text)) || out || '');
      if (!AMOUNT[tpl].test(body)) return 'no amount: ' + body;
      if (!(lang === 'ar' ? /جنيه/ : /EGP/).test(body)) return 'no currency: ' + body;
      if (tpl.endsWith('paid') && !/0002/.test(body)) return 'no last 4 digits: ' + body;
      if (tpl.endsWith('denied') && !/Report already written/.test(body)) return 'denial reason dropped: ' + body;
      if (/undefined|null/.test(body)) return 'placeholder leaked: ' + body;
      return null;
    });
  }
}

// ── email ────────────────────────────────────────────────────────────────
let Handlebars = null;
try { Handlebars = require('handlebars'); } catch (_) { Handlebars = null; }
const EMAIL = { patient_refund_denied: 'patient-refund-denied', patient_refund_paid: 'patient-refund-paid', patient_refund_approved: 'patient-refund-approved' };
for (const [tpl, file] of Object.entries(EMAIL)) {
  for (const lang of ['en', 'ar']) {
    const name = `email [${lang}] ${file}: amount${tpl.endsWith('paid') ? ' + last 4 digits' : ''}`;
    if (!Handlebars) { t.skip(name, 'handlebars not installed'); continue; }
    check(name, () => {
      const src = read(`src/templates/email/${lang}/${file}.hbs`);
      const html = Handlebars.compile(src)(Object.assign({ patientName: 'Mona' }, PAYLOADS[tpl]));
      const text = html.replace(/<[^>]+>/g, ' ');
      if (!/1200\.00|1600\.00|1800\.00/.test(text)) return 'no amount';
      if (!(lang === 'ar' ? /جنيه/ : /EGP/).test(text)) return 'no currency';
      if (tpl.endsWith('paid') && !(lang === 'ar' ? /المنتهي بـ 0002/ : /ending 0002/).test(text)) return 'no last 4 digits';
      return null;
    });
  }
}

// ── routing: the case's patient, awaited, WhatsApp alongside ─────────────
const SA = read('src/routes/superadmin.js');
function routeBody(src, needle) {
  const i = src.indexOf(needle);
  if (i < 0) return '';
  return src.slice(i, src.indexOf('\nrouter.', i + 50));
}
for (const [route, tpl] of [['/superadmin/refunds/:id/approve', 'patient_refund_approved'], ['/superadmin/refunds/:id/deny', 'patient_refund_denied'], ['/superadmin/refunds/:id/mark-paid', 'patient_refund_paid']]) {
  check(`web ${route}: tells the case's patient (not refunds.requested_by), awaited, with WhatsApp`, () => {
    const body = routeBody(SA, "router.post('" + route + "'");
    if (!body) return 'route not found';
    const i = body.indexOf("template: '" + tpl + "'");
    if (i < 0) return 'template not found';
    const call = body.slice(Math.max(0, i - 500), i + 100);
    if (!/toUserId:\s*patientId/.test(call)) return 'recipient is not the case patient';
    if (!/await refundPatientId\(refund\.order_id\)/.test(body)) return 'patient not resolved from the order';
    if (!/const r = await queueMultiChannelNotification\(/.test(call)) return 'not awaited';
    if (!/channels:\s*\['internal', 'email', 'whatsapp'\]/.test(call)) return 'no WhatsApp channel';
    return null;
  });
}
check('refundPatientId reads orders_active.patient_id', () => (
  /async function refundPatientId\(orderId\)[\s\S]{0,200}SELECT patient_id FROM orders_active WHERE id = \$1/.test(SA) ? null : 'helper missing or reads another column'));

check('the patient refund-request confirmation stays email + in-app (OpenClaw has no text for it)', () => {
  const { OPENCLAW_TEMPLATES } = require(path.join(ROOT, 'src', 'notify', 'openclawTemplates.js'));
  if (OPENCLAW_TEMPLATES.patient_refund_requested) return 'a WhatsApp text now exists — the request confirmation can add the channel';
  for (const tpl of ['patient_refund_approved', 'patient_refund_denied', 'patient_refund_paid', 'patient_refund_opened_by_operator']) {
    if (!OPENCLAW_TEMPLATES[tpl]) return 'WhatsApp is queued for ' + tpl + ' but OpenClaw has no text for it';
  }
  return null;
});
