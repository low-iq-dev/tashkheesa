'use strict';

// src/services/recovery_checks.js — the patient-recovery checks on the System
// screen (2 Nov 2026). Appended to services/system_checks.js INTERNAL, so they
// run every 5 minutes with the others and push on a status change like any
// other check. Kept in their own file so the registry's own list is untouched.
//
//   notifications.sms      the SMS fallback (Part B): sent / skipped by reason /
//                          failed in 24 h. Warns when a fallback could not go
//                          out because SMS is not configured or a cap was hit —
//                          a patient WhatsApp could not reach got nothing.
//   cases.draft_nudges     draft-resume nudges (Part A): sent today, drafts
//                          resumed today, converted (submitted within 72 h of a
//                          nudge) today.
//   growth.coverage_leads  "we don't open this specialty yet" leads (Part C):
//                          waiting, per wanted specialty.
//
// Every table timestamp below is read the way the column is declared:
// notifications.at is timestamp WITHOUT time zone holding UTC digits; the two
// new tables are timestamptz.

const CAIRO_MIDNIGHT_UTC = "((date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'UTC')";
const CAIRO_MIDNIGHT_TZ = "(date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo')";

function pg() { return require('../pg'); }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

/** notifications.sms — pure classification, exported for tests. */
function classifySms(rows) {
  const by = { sent: 0, failed: 0, skipped: 0 };
  const skips = {};
  (rows || []).forEach((r) => {
    const n = Number(r.n) || 0;
    if (r.status === 'sent') by.sent += n;
    else if (r.status === 'failed') by.failed += n;
    else if (r.status === 'skipped') { by.skipped += n; skips[r.reason || 'other'] = (skips[r.reason || 'other'] || 0) + n; }
  });
  const unreached = (skips.sms_unconfigured || 0) + (skips.sms_cap || 0) + (skips.sms_patient_cap || 0);
  const status = by.failed > 0 || unreached > 0 ? 'warn' : 'ok';
  const parts = [];
  if (by.sent) parts.push(plural(by.sent, 'SMS', 'SMS') + ' sent');
  if (by.failed) parts.push(by.failed + ' failed');
  if (skips.sms_unconfigured) parts.push(skips.sms_unconfigured + ' not sent: SMS not configured');
  if (skips.sms_cap) parts.push(skips.sms_cap + ' over the daily cap');
  if (skips.sms_patient_cap) parts.push(skips.sms_patient_cap + ' over the per-patient cap');
  const summary = parts.length ? parts.join(', ') + ' in 24h' : 'No SMS fallback needed in 24 hours';
  return { status, summary, detail: { sent: by.sent, failed: by.failed, skipped: skips } };
}

async function notificationsSms() {
  const rows = await pg().queryAll(
    "SELECT status, CASE WHEN status = 'skipped' THEN COALESCE(response::json->>'skipped', 'other') END AS reason, COUNT(*)::int AS n " +
    "  FROM notifications WHERE channel = 'sms' AND at > (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours' " +
    ' GROUP BY 1, 2', []);
  const c = classifySms(rows);
  return { check_key: 'notifications.sms', area: 'notifications', status: c.status, summary: c.summary, detail: c.detail };
}

async function casesDraftNudges() {
  const r = await pg().queryOne(
    "SELECT (SELECT COUNT(*)::int FROM notifications WHERE channel = 'internal' AND template LIKE 'draft\\_resume\\_%' AND at >= " + CAIRO_MIDNIGHT_UTC + ') AS sent, ' +
    '       (SELECT COUNT(*)::int FROM draft_resume_tokens WHERE last_opened_at >= ' + CAIRO_MIDNIGHT_TZ + ') AS resumed, ' +
    '       (SELECT COUNT(*)::int FROM draft_resume_tokens WHERE converted_at >= ' + CAIRO_MIDNIGHT_TZ + ') AS converted', []);
  const sent = (r && r.sent) || 0, resumed = (r && r.resumed) || 0, converted = (r && r.converted) || 0;
  return {
    check_key: 'cases.draft_nudges', area: 'cases', status: 'ok',
    summary: plural(sent, 'draft nudge') + ' sent today · ' + resumed + ' resumed · ' + converted + ' submitted after a nudge',
    detail: { sent_today: sent, resumed_today: resumed, converted_today: converted },
  };
}

async function growthCoverageLeads() {
  const rows = (await pg().queryAll(
    "SELECT COALESCE(sp.name, cl.wanted_specialty_id, 'not listed') AS specialty, COUNT(*)::int AS n " +
    '  FROM coverage_leads cl LEFT JOIN specialties sp ON sp.id = cl.wanted_specialty_id ' +
    ' WHERE cl.notified_at IS NULL AND cl.converted_order_id IS NULL GROUP BY 1 ORDER BY 2 DESC, 1', [])) || [];
  const total = rows.reduce((a, r) => a + r.n, 0);
  const per = {}; rows.forEach((r) => { per[r.specialty] = r.n; });
  return {
    check_key: 'growth.coverage_leads', area: 'growth', status: 'ok',
    summary: total === 0 ? 'No patient is waiting for a specialty we do not open yet'
      : plural(total, 'patient') + ' waiting for a specialty we do not open: ' + rows.slice(0, 4).map((r) => r.specialty + ' ' + r.n).join(', '),
    detail: { total, per_specialty: per },
  };
}

const CHECKS = Object.freeze([notificationsSms, casesDraftNudges, growthCoverageLeads]);

module.exports = { CHECKS, classifySms, notificationsSms, casesDraftNudges, growthCoverageLeads };
