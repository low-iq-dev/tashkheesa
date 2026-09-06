// tests/core/pay-requires-payable-status.test.js
//
// AUDIT-PAY-DRAFT-2026-09-06 — a DRAFT must not be able to reach payment.
//
// GET /portal/patient/pay/:id and POST /payments/paymob/create-intention both
// filtered on patient_id and `payment_status <> 'paid'` and never looked at
// `status`. So a DRAFT — a case still inside the wizard, with no submitted files
// and no locked price — was payable in three clicks from /patient/cases, whose
// rows all linked to /portal/patient/orders/:id, which forwards anything unpaid
// to the pay page.
//
// What made it money-losing rather than merely odd: the webhook commits
// payment_status='paid' FIRST and only then calls markCasePaid, whose
// DRAFT -> PAID throws against STATUS_TRANSITIONS[DRAFT] = [SUBMITTED]. That
// throw is caught and logged as an idempotent skip. Money captured, case never
// assigned, no SLA, empty dashboard, no alert.
//
// Payability is asked of the state machine, not of a second hand-written list,
// so it cannot drift from what transitionCase will allow after the charge.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
function expect(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\n💳 Payment gate — only a payable status reaches checkout\n');

const ROOT = path.join(__dirname, '..', '..');
const cl = require('../../src/case_lifecycle');

// ── 1. isPayableStatus agrees with the state machine, per status ───────────
try {
  expect(typeof cl.isPayableStatus === 'function',
    'case_lifecycle must export isPayableStatus');

  expect(cl.isPayableStatus('DRAFT') === false,
    'THE BUG: a DRAFT must never be payable — markCasePaid throws on DRAFT -> PAID, ' +
    'but only after the money has already been taken');
  expect(cl.isPayableStatus('draft') === false,
    "lowercase 'draft' must be refused too — orders.status holds both cases");

  expect(cl.isPayableStatus('SUBMITTED') === true,
    'SUBMITTED is the normal payable state');
  expect(cl.isPayableStatus('EXPIRED_UNPAID') === true,
    'a late payment must still revive an expired case (EXPIRED_UNPAID -> PAID is permitted)');
  expect(cl.isPayableStatus('PENDING_REVIEW') === true,
    'ops-triaged website intake can be paid once priced');

  ['PAID', 'ASSIGNED', 'IN_REVIEW', 'REJECTED_FILES', 'SLA_BREACH', 'REASSIGNED',
   'COMPLETED', 'CANCELLED', 'REFUNDED'].forEach(function (s) {
    expect(cl.isPayableStatus(s) === false, s + ' must not be payable');
  });
  expect(cl.isPayableStatus('') === false && cl.isPayableStatus(null) === false,
    'a missing status must fail closed');

  // The whole point of deriving it: the answer here is the answer transitionCase
  // gives. If someone edits STATUS_TRANSITIONS, both move together.
  Object.keys(cl.CASE_STATUS).forEach(function (k) {
    const s = cl.CASE_STATUS[k];
    const allowed = cl.STATUS_TRANSITIONS[s] || [];
    expect(cl.isPayableStatus(s) === (allowed.indexOf(cl.CASE_STATUS.PAID) !== -1),
      s + ': isPayableStatus must be exactly "PAID is a permitted next state"');
  });
  t.pass('isPayableStatus is derived from STATUS_TRANSITIONS and refuses DRAFT in both spellings');
} catch (e) { t.fail('isPayableStatus', e); }

// ── 2. The pay page refuses, and sends a draft back to the wizard ─────────
try {
  const PATIENT = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient.js'), 'utf8'));
  const start = PATIENT.indexOf("router.get('/portal/patient/pay/:id'");
  expect(start !== -1, 'GET /portal/patient/pay/:id must exist');
  const handler = PATIENT.slice(start, start + 4000);

  expect(/o\.status/.test(handler),
    'the pay page must SELECT status — it used to fetch payment_status and nothing else');
  expect(/isPayableStatus\s*\(/.test(handler),
    'the pay page must refuse a non-payable status');
  expect(/\/patient\/new-case\?resume=/.test(handler),
    'a draft must be sent back into the wizard, which resumes at the step the patient stopped ' +
    'on — not bounced to a dashboard that shows nothing about it');
  t.pass('the pay page refuses a non-payable case and returns a draft to the wizard');
} catch (e) { t.fail('pay page guard', e); }

// ── 3. The server endpoint refuses independently ──────────────────────────
// The route guard is a redirect; this is a JSON POST any client can call
// directly with an order id it owns, so it needs its own gate.
try {
  const PAYMENTS = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'routes', 'payments.js'), 'utf8'));
  const start = PAYMENTS.indexOf("router.post('/paymob/create-intention'");
  expect(start !== -1, 'POST /paymob/create-intention must exist');
  const handler = PAYMENTS.slice(start, start + 4000);

  expect(/SELECT id, patient_id, status,/.test(handler),
    'create-intention must SELECT status');
  expect(/isPayableStatus\s*\(/.test(handler),
    'create-intention must refuse a non-payable status before minting an intention');
  expect(/case_not_submitted/.test(handler),
    'the refusal must carry a specific error code the pay page can act on');

  const payableIdx = handler.indexOf('isPayableStatus');
  const intentionIdx = handler.search(/createIntention|paymobService\./);
  expect(intentionIdx === -1 || payableIdx < intentionIdx,
    'the status check must come BEFORE any call to Paymob — a refusal after the intention ' +
    'exists is a checkout link for a case that cannot be paid');
  t.pass('create-intention SELECTs status, refuses case_not_submitted, and does so before Paymob');
} catch (e) { t.fail('create-intention guard', e); }

// ── 4. The dead end from the cases list is closed ─────────────────────────
try {
  const CASES_VIEW = fs.readFileSync(path.join(ROOT, 'src', 'views', 'patient_cases.ejs'), 'utf8');
  expect(/new-case\?resume=/.test(CASES_VIEW),
    'a DRAFT row must link to the wizard. Every row used to link to the case page, which ' +
    'forwards anything unpaid to the pay page — so a step-1 draft rendered "EGP 0" with a live ' +
    'Pay button that 400s invalid_amount and offers no way back');

  const PATIENT = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient.js'), 'utf8'));
  const start = PATIENT.indexOf("router.get('/portal/patient/orders/:id'");
  expect(start !== -1, 'GET /portal/patient/orders/:id must exist');
  const handler = PATIENT.slice(start, start + 6000);
  const preIdx = handler.indexOf("payment_status !== 'paid'");
  expect(preIdx !== -1, 'the pre-payment redirect must still exist');
  expect(/\/patient\/new-case\?resume=/.test(handler.slice(preIdx, preIdx + 500)),
    'the pre-payment redirect must divert a DRAFT to the wizard rather than to the pay page');

  const PAY_VIEW = fs.readFileSync(path.join(ROOT, 'src', 'views', 'patient_payment_required.ejs'), 'utf8');
  expect(/case_not_submitted/.test(PAY_VIEW),
    'the Pay button must handle case_not_submitted rather than showing the generic failure');
  t.pass('draft rows link to the wizard; the order page and Pay button both divert a draft there');
} catch (e) { t.fail('cases-list dead end', e); }
