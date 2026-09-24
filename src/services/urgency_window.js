/**
 * Cairo-time helpers for the Urgent tier window check.
 *
 * Per docs/PAYOUT_AND_URGENCY_POLICY.md §2 + §3:
 *   - Urgent submissions are accepted 07:00–18:59 Cairo local time.
 *   - Outside that window, the patient must explicitly pick:
 *       (a) Wait until 7am — clock anchors at next 7am Cairo.
 *       (b) Downgrade to VIP — 1.3× / 18h SLA, processed immediately.
 *
 * Egypt reinstated DST in April 2023 (UTC+2 winter, ~UTC+3 Apr–Oct), so a
 * fixed offset is wrong for half the year — the old fixed +2h math sold
 * Urgent at 7–8pm Cairo all summer and anchored the next-7am SLA an hour
 * late. All Cairo wall-clock reads now go through Intl with timeZone
 * 'Africa/Cairo', which tracks the IANA tz database. No I/O.
 *
 * Both exports accept an optional `now` (a Date) for deterministic tests;
 * production callers pass nothing and get the real current time.
 */

'use strict';

const CAIRO_TZ = 'Africa/Cairo';

// The Urgent window, Cairo wall-clock hours: [START, END). THE source of truth —
// isUrgentWindowOpen below gates on it and urgentWindowNote renders the
// patient-facing sentence from it, so the rule and its wording cannot drift.
const URGENT_WINDOW_START_HOUR = 7;
const URGENT_WINDOW_END_HOUR = 19;

// Cairo wall-clock parts for a given instant (defaults to now).
function _cairoParts(date) {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CAIRO_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false
  }).formatToParts(d);
  const get = function (type) {
    const p = parts.find(function (x) { return x.type === type; });
    return Number(p && p.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24 // some ICU builds emit "24" for midnight
  };
}

function isUrgentWindowOpen(now) {
  const h = _cairoParts(now).hour;
  return h >= URGENT_WINDOW_START_HOUR && h < URGENT_WINDOW_END_HOUR;
}

// Returns the next 7:00 Cairo as a UTC Date. If currently before 7am
// Cairo, that's today's 7am Cairo; otherwise tomorrow's. The result is
// verified against the tz database, so it stays exact across the
// April/October DST transitions.
function nextSevenAmCairoUtc(now) {
  const cur = _cairoParts(now);
  // First guess assumes UTC+3; the loop below corrects to the actual
  // offset (+2 or +3) in at most two steps.
  let target = new Date(Date.UTC(cur.year, cur.month - 1, cur.day, 7 - 3, 0, 0, 0));
  if (cur.hour >= 7) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  }
  for (let i = 0; i < 3; i++) {
    const h = _cairoParts(target).hour;
    if (h === 7) break;
    target = new Date(target.getTime() + (7 - h) * 60 * 60 * 1000);
  }
  return target;
}

// "7:00 AM" / "7:00 صباحاً" for a whole Cairo hour.
function _clock(hour, lang) {
  const h12 = (hour % 12) || 12;
  if (lang === 'ar') return h12 + ':00 ' + (hour < 12 ? 'صباحاً' : 'مساءً');
  return h12 + ':00 ' + (hour < 12 ? 'AM' : 'PM');
}

/**
 * The Urgent off-hours rule in one sentence, for every place a patient picks
 * or pays for a tier (services page, wizard tier picker, pay page, FAQ,
 * contact). Launch eve 2026-09-24: until now only /ar/delivery-policy said
 * what happens to an Urgent case paid at night.
 *
 * "Payment is confirmed", not "you pay": case_lifecycle.markCasePaid anchors
 * the clock (next 07:00 Cairo + 4h) at the moment the case is MARKED paid,
 * and with manual InstaPay / bank transfer that is when a human confirms the
 * transfer, not when the patient sent it.
 *
 * @param {'en'|'ar'} lang
 * @returns {string} plain text, no HTML
 */
function urgentWindowNote(lang) {
  const start = URGENT_WINDOW_START_HOUR;
  const end = URGENT_WINDOW_END_HOUR;
  if (String(lang || '').toLowerCase() === 'ar') {
    return 'الخدمة العاجلة (4 ساعات) متاحة من ' + _clock(start, 'ar') + ' حتى ' + _clock(end, 'ar') +
      ' بتوقيت القاهرة، والحالة العاجلة التي يُؤكَّد دفعها خارج هذه المواعيد تبدأ ساعاتها الأربع من الساعة ' +
      _clock(start, 'ar') + '.';
  }
  return 'Urgent (4 hours) runs ' + _clock(start, 'en') + ' – ' + _clock(end, 'en') +
    ' Cairo time; an Urgent case whose payment is confirmed outside those hours starts its 4 hours at ' +
    _clock(start, 'en') + '.';
}

module.exports = {
  URGENT_WINDOW_START_HOUR: URGENT_WINDOW_START_HOUR,
  URGENT_WINDOW_END_HOUR: URGENT_WINDOW_END_HOUR,
  isUrgentWindowOpen: isUrgentWindowOpen,
  nextSevenAmCairoUtc: nextSevenAmCairoUtc,
  urgentWindowNote: urgentWindowNote
};
