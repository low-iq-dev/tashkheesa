/**
 * Cairo-time helpers for the Urgent tier window check.
 *
 * Per docs/PAYOUT_AND_URGENCY_POLICY.md §2 + §3:
 *   - Urgent submissions are accepted 07:00–18:59 Cairo local time.
 *   - Outside that window, the patient must explicitly pick:
 *       (a) Wait until 7am — clock anchors at next 7am Cairo.
 *       (b) Downgrade to VIP — 1.3× / 18h SLA, processed immediately.
 *
 * Egypt reinstated DST in April 2023 (UTC+2 winter, UTC+3 roughly
 * Apr–Oct), so a fixed offset is wrong for half the year — this bug
 * sold Urgent at 7–8pm Cairo all summer. All Cairo wall-clock reads
 * now go through Intl with timeZone 'Africa/Cairo', which tracks the
 * IANA tz database. No I/O.
 */

'use strict';

const CAIRO_TZ = 'Africa/Cairo';

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

function isUrgentWindowOpen() {
  const h = _cairoParts().hour;
  return h >= 7 && h < 19;
}

// Returns the next 7:00 Cairo as a UTC Date. If currently before 7am
// Cairo, that's today's 7am Cairo; otherwise tomorrow's. The result is
// verified against the tz database, so it stays exact across the
// April/October DST transitions.
function nextSevenAmCairoUtc() {
  const now = _cairoParts();
  // First guess assumes UTC+3; the loop below corrects to the actual
  // offset (+2 or +3) in at most two steps.
  let target = new Date(Date.UTC(now.year, now.month - 1, now.day, 7 - 3, 0, 0, 0));
  if (now.hour >= 7) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  }
  for (let i = 0; i < 3; i++) {
    const h = _cairoParts(target).hour;
    if (h === 7) break;
    target = new Date(target.getTime() + (7 - h) * 60 * 60 * 1000);
  }
  return target;
}

module.exports = {
  isUrgentWindowOpen: isUrgentWindowOpen,
  nextSevenAmCairoUtc: nextSevenAmCairoUtc
};
