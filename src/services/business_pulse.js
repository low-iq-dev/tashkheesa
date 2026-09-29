'use strict';

// services/business_pulse.js
//
// 29 Sep 2026 — the pushes that say the business is WORKING.
//
// Every Command push until today was a failure alarm: a breach, a stuck case, a
// dead worker. Nothing told the founder when a patient signed up, reached
// checkout, paid, or received their report — so the app that is meant to be the
// pulse of the business only ever reported its fever.
//
// WHY A SWEEP AND NOT A CALL AT EACH SITE. Every one of these events has several
// doors: users are created by POST /register, by both OTP paths and by the app;
// orders become paid through Paymob, InstaPay verification, superadmin mark-paid
// and the admin route. Adding a producer to each door is five edits to money and
// auth code for a notification, and the sixth door added next month would be
// forgotten. Every door, though, stamps the same columns — users.created_at,
// orders.paid_at, orders.completed_at — so one read of those columns catches all
// of them, and touches none of them.
//
// DEDUPE. pushOpsEvent claims each (kind, row id) atomically in ops_push_log
// with a week-long cooldown (services/ops_push.js), so overlapping sweeps, two
// instances, or a restart mid-window cannot announce the same row twice.
//
// EXCLUDED: practice/demo cases, and staff accounts (@tashkheesa.com /
// @shifaegypt.com — the same filter the funnel digest uses). A rehearsal must
// not look like revenue.

const { queryAll } = require('../pg');
const { pushOpsEvent } = require('./ops_push');

const LOOKBACK_MINUTES = 30;
const STAFF_EMAIL_SQL = "COALESCE(u.email,'') !~* '@(tashkheesa\\.com|shifaegypt\\.com)$'";
const REAL_ORDER_SQL =
  "COALESCE(o.is_practice,false) = false " +
  "AND COALESCE(o.source,'') NOT IN ('practice_seed','demo_appreview') " +
  "AND o.deleted_at IS NULL";

function egp(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? 'EGP ' + Math.round(v).toLocaleString('en-US') : '';
}
function first(name) {
  const s = String(name || '').trim();
  return s ? s.split(/\s+/)[0] : 'A patient';
}
function tierLabel(o) {
  const t = String(o.urgency_tier || o.tier || '').toLowerCase();
  if (t.indexOf('urgent') !== -1) return 'Urgent 4h';
  if (t.indexOf('vip') !== -1) return 'VIP 18h';
  return 'Standard 48h';
}

async function _signups() {
  const rows = await queryAll(
    `SELECT u.id, u.name, u.country_code
       FROM users u
      WHERE u.role = 'patient'
        AND u.created_at > NOW() - INTERVAL '${LOOKBACK_MINUTES} minutes'
        AND ${STAFF_EMAIL_SQL}
      ORDER BY u.created_at`);
  let n = 0;
  for (const u of rows || []) {
    const r = await pushOpsEvent({
      kind: 'patient_signup',
      dedupeKey: u.id,
      title: 'New signup' + (u.country_code ? ' — ' + u.country_code : ''),
      body: first(u.name) + ' just created an account.',
      data: { screen: 'patients', userId: u.id },
    });
    if (r && r.sent) n++;
  }
  return n;
}

async function _submitted() {
  const rows = await queryAll(
    `SELECT o.id, o.price, o.reference_id, o.urgency_tier, o.tier, s.name AS service, u.name AS patient
       FROM orders o
       JOIN users u ON u.id = o.patient_id
       LEFT JOIN services s ON s.id = o.service_id
      WHERE LOWER(o.status) = 'submitted'
        AND COALESCE(o.payment_status,'unpaid') <> 'paid'
        AND o.updated_at > NOW() - INTERVAL '${LOOKBACK_MINUTES} minutes'
        AND ${REAL_ORDER_SQL} AND ${STAFF_EMAIL_SQL}`);
  let n = 0;
  for (const o of rows || []) {
    const r = await pushOpsEvent({
      kind: 'case_submitted',
      dedupeKey: o.id,
      title: 'At checkout' + (egp(o.price) ? ' — ' + egp(o.price) : ''),
      body: first(o.patient) + ' submitted ' + (o.service || 'a case') + ' and has not paid yet.',
      data: { orderId: o.id },
      orderId: o.id,
    });
    if (r && r.sent) n++;
  }
  return n;
}

async function _paid() {
  const rows = await queryAll(
    `SELECT o.id, o.price, o.urgency_tier, o.tier, o.payment_method, s.name AS service, u.name AS patient
       FROM orders o
       JOIN users u ON u.id = o.patient_id
       LEFT JOIN services s ON s.id = o.service_id
      WHERE o.paid_at > NOW() - INTERVAL '${LOOKBACK_MINUTES} minutes'
        AND o.payment_status = 'paid'
        AND ${REAL_ORDER_SQL} AND ${STAFF_EMAIL_SQL}`);
  let n = 0;
  for (const o of rows || []) {
    const r = await pushOpsEvent({
      kind: 'case_paid',
      dedupeKey: o.id,
      title: 'Paid' + (egp(o.price) ? ' — ' + egp(o.price) : ''),
      body: first(o.patient) + ' · ' + (o.service || 'case') + ' · ' + tierLabel(o) + '. In the queue now.',
      data: { orderId: o.id },
      orderId: o.id,
    });
    if (r && r.sent) n++;
  }
  return n;
}

async function _delivered() {
  const rows = await queryAll(
    `SELECT o.id, o.completed_at, o.deadline_at, s.name AS service, u.name AS patient, d.name AS doctor
       FROM orders o
       JOIN users u ON u.id = o.patient_id
       LEFT JOIN users d ON d.id = o.doctor_id
       LEFT JOIN services s ON s.id = o.service_id
      WHERE o.completed_at > NOW() - INTERVAL '${LOOKBACK_MINUTES} minutes'
        AND ${REAL_ORDER_SQL} AND ${STAFF_EMAIL_SQL}`);
  let n = 0;
  for (const o of rows || []) {
    let timing = '';
    if (o.deadline_at && o.completed_at) {
      const lateH = (new Date(o.completed_at) - new Date(o.deadline_at)) / 36e5;
      timing = lateH > 0 ? ' ' + Math.ceil(lateH) + 'h late.' : ' On time.';
    }
    const r = await pushOpsEvent({
      kind: 'report_delivered',
      dedupeKey: o.id,
      title: 'Report delivered',
      body: (o.doctor ? o.doctor + ' → ' : '') + first(o.patient) + ', ' + (o.service || 'case') + '.' + timing,
      data: { orderId: o.id },
      orderId: o.id,
    });
    if (r && r.sent) n++;
  }
  return n;
}

async function _enquiries() {
  const rows = await queryAll(
    `SELECT id, name, subject, message
       FROM contact_submissions
      WHERE status = 'new'
        AND created_at > NOW() - INTERVAL '${LOOKBACK_MINUTES} minutes'`);
  let n = 0;
  for (const c of rows || []) {
    const msg = String(c.message || '').replace(/\s+/g, ' ').trim();
    const r = await pushOpsEvent({
      kind: 'contact_enquiry',
      dedupeKey: c.id,
      title: 'New enquiry' + (c.subject ? ' — ' + String(c.subject).slice(0, 40) : ''),
      body: (c.name || 'Someone') + ': ' + (msg.length > 110 ? msg.slice(0, 107) + '…' : msg),
      data: { contactId: c.id },
    });
    if (r && r.sent) n++;
  }
  return n;
}

/**
 * One sweep. Never throws; each event type is isolated so one bad query does
 * not silence the others.
 * @returns {Promise<Object>} counts sent per kind
 */
async function runBusinessPulse() {
  const out = {};
  const steps = [['patient_signup', _signups], ['case_submitted', _submitted],
                 ['case_paid', _paid], ['report_delivered', _delivered],
                 ['contact_enquiry', _enquiries]];
  for (const [k, fn] of steps) {
    try { out[k] = await fn(); } catch (err) {
      out[k] = 'error';
      try { require('../logger').logErrorToDb(err, { context: 'business_pulse.' + k, category: 'push' }); } catch (_) {}
    }
  }
  return out;
}

module.exports = { runBusinessPulse, LOOKBACK_MINUTES };
