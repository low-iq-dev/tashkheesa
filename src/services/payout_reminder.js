'use strict';

// services/payout_reminder.js — month-end doctor payout reminder (11 Oct 2026).
//
// Asked for on 6 Oct: one message from the Tashkheesa WhatsApp number shortly
// before month-end, ONLY when doctors are actually owed money, carrying the
// total and the number of doctors.
//
// WHEN. The reminder day is the first working day (Sunday to Thursday, the
// Egyptian working week) among the last WINDOW_DAYS calendar days of the Cairo
// month, from SEND_FROM_HOUR. If the portal was down that day it still goes
// out on any later day of the same month. Once per month: the claim is a row
// in funnel_daily_counts keyed on the month's first day (the same once-only
// pattern the daily digest uses, so no new table).
//
// WHAT COUNTS AS OWED. Only money a payout run can settle today — pending
// earnings for DELIVERED work (earnings_reader's owedSettleable). Accepted but
// undelivered work is shown as a separate line and never triggers a reminder
// on its own.
//
// DELIVERY. WhatsApp to the founder numbers plus a quiet Command push. They
// are independent. If BOTH fail the claim is released so the next tick retries
// (the WhatsApp gateway lives on the Mac mini, which is not always on).

const WINDOW_DAYS = 3;
const SEND_FROM_HOUR = 10;
const CLAIM_STEP = '__payout_reminder';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Cairo wall-clock parts of `now`. */
function cairoParts(now) {
  const d = now || new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hour12: false }).format(d)) % 24;
  const p = ymd.split('-').map(Number);
  return { year: p[0], month: p[1], day: p[2], hour: hour };
}

function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function weekdayOf(year, month, day) { return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); }
function isWorkingDay(year, month, day) { const w = weekdayOf(year, month, day); return w !== 5 && w !== 6; }

/** Day-of-month the reminder becomes due. Three consecutive days always hold a working day. */
function reminderDay(year, month) {
  const last = daysInMonth(year, month);
  for (let d = last - WINDOW_DAYS + 1; d <= last; d++) if (isWorkingDay(year, month, d)) return d;
  return last;
}

function isDue(p) { return p.day >= reminderDay(p.year, p.month) && p.hour >= SEND_FROM_HOUR; }

function monthKey(p) { return p.year + '-' + String(p.month).padStart(2, '0') + '-01'; }

/** Totals from earnings_reader.getOwedByDoctor rows. */
function summarise(rows) {
  let payable = 0; let inFlight = 0; let doctors = 0;
  for (const r of rows || []) {
    const s = Number(r && r.owedSettleableEgp) || 0;
    const f = Number(r && r.owedInFlightEgp) || 0;
    if (s > 0) { payable += s; doctors++; }
    if (f > 0) inFlight += f;
  }
  return { payableEgp: Math.round(payable * 100) / 100, inFlightEgp: Math.round(inFlight * 100) / 100, doctors: doctors };
}

function egp(n) { return 'EGP ' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

function monthEndLabel(p) {
  const last = daysInMonth(p.year, p.month);
  return WEEKDAYS[weekdayOf(p.year, p.month, last)] + ' ' + last + ' ' + MONTHS[p.month - 1];
}

/** Pure: the WhatsApp text. */
function formatReminder(s, p) {
  const left = daysInMonth(p.year, p.month) - p.day;
  const when = left <= 0 ? 'Month-end is today' : left === 1 ? 'Month-end is tomorrow' : 'Month-end is in ' + left + ' days';
  const lines = [
    'Doctor payouts — ' + when + ' (' + monthEndLabel(p) + ').',
    egp(s.payableEgp) + ' is ready to pay to ' + s.doctors + (s.doctors === 1 ? ' doctor.' : ' doctors.'),
  ];
  if (s.inFlightEgp > 0) lines.push(egp(s.inFlightEgp) + ' more is for cases not delivered yet — not payable now.');
  lines.push('Pay and mark as paid in Command → More → Payouts.');
  return lines.join('\n');
}

async function _claim(key) {
  const { queryOne } = require('../pg');
  const row = await queryOne(
    `INSERT INTO funnel_daily_counts (day, step, n, updated_at)
     VALUES ($1::date, $2, 1, NOW())
     ON CONFLICT (day, step) DO NOTHING
     RETURNING day`, [key, CLAIM_STEP]);
  return !!row;
}
async function _release(key) {
  const { execute } = require('../pg');
  await execute('DELETE FROM funnel_daily_counts WHERE day = $1::date AND step = $2', [key, CLAIM_STEP]);
}

/**
 * Send this month's reminder if it is due, money is owed and it has not gone
 * out yet. Never throws.
 */
async function runPayoutReminder(opts) {
  const o = opts || {};
  try {
    const p = cairoParts(o.now);
    if (!o.force && !isDue(p)) return { ok: true, skipped: 'not_due' };
    const reader = o.reader || require('./earnings_reader');
    const s = summarise(await reader.getOwedByDoctor({ limit: 500 }));
    if (!(s.payableEgp > 0)) return { ok: true, skipped: 'nothing_owed' };

    const key = monthKey(p);
    const claim = o.claim || _claim;
    const release = o.release || _release;
    if (!o.force && !(await claim(key))) return { ok: true, skipped: 'already_sent' };

    const text = formatReminder(s, p);
    let wa = { sent: 0, failed: 0 };
    try {
      const send = o.sendFounder || require('./founder_whatsapp').sendFounderWhatsApp;
      wa = (await send(text, { template: 'founder_payout_reminder', ref: 'payout:' + key })) || wa;
    } catch (e) { console.error('[payout-reminder] WhatsApp failed', e && e.message); }
    let push = { sent: false };
    try {
      const pushOps = o.pushOpsEvent || require('./ops_push').pushOpsEvent;
      push = (await pushOps({
        kind: 'payout_reminder',
        dedupeKey: key,
        title: 'Doctor payouts due',
        body: egp(s.payableEgp) + ' to ' + s.doctors + (s.doctors === 1 ? ' doctor' : ' doctors') + ' · month ends ' + monthEndLabel(p),
        data: { screen: 'payouts', month: key },
        defaultMode: 'quiet',
      })) || push;
    } catch (e) { console.error('[payout-reminder] push failed', e && e.message); }

    const delivered = (wa && wa.sent > 0) || !!(push && push.sent);
    if (!delivered && !o.force) {
      try { await release(key); } catch (e) { console.error('[payout-reminder] release failed', e && e.message); }
    }
    return { ok: true, month: key, delivered: delivered, whatsapp: wa, push: push, totals: s, text: text };
  } catch (e) {
    console.error('[payout-reminder] error', e && e.message);
    return { ok: false, error: String(e && e.message || e) };
  }
}

module.exports = {
  WINDOW_DAYS, SEND_FROM_HOUR, CLAIM_STEP,
  cairoParts, daysInMonth, isWorkingDay, reminderDay, isDue, monthKey,
  summarise, formatReminder, runPayoutReminder,
};
