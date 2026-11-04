'use strict';

// src/utils/cairo_quiet_hours.js — "is it night in Cairo?" for patient-facing
// sends (2 Nov 2026, patient recovery Part A).
//
// The signup nudges (services/signup_nudges.js) carry their own 22:00–09:00
// copy of this; it is left as it is, so their behaviour does not move. The
// draft-resume nudges use 22:00–08:00. One helper, the window as parameters:
// a send due inside it waits for the first sweep after it closes.

function cairoHour(now) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hour12: false }).format(now || new Date());
  return Number(h) % 24;
}

/**
 * @param {Date} [now]
 * @param {{startHour?: number, endHour?: number}} [win] quiet from startHour
 *   (inclusive) to endHour (exclusive), Cairo local time. Default 22 → 8.
 */
function isCairoQuietHours(now, win) {
  const start = win && Number.isFinite(win.startHour) ? win.startHour : 22;
  const end = win && Number.isFinite(win.endHour) ? win.endHour : 8;
  const h = cairoHour(now);
  return start > end ? (h >= start || h < end) : (h >= start && h < end);
}

// Cairo's offset from UTC at `d`, in minutes (+120 in winter, +180 in summer).
function cairoOffsetMinutes(d) {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/**
 * The next time the Cairo clock reads `hour`:00 — today's if it is earlier than
 * that now, tomorrow's otherwise. Daylight saving is handled: the offset is
 * read at the target, not at `now` (Egypt changes clocks at night).
 * @returns {Date}
 */
function nextCairoTime(now, hour) {
  const n = now || new Date();
  const off = cairoOffsetMinutes(n);
  const local = new Date(n.getTime() + off * 60000); // Cairo wall clock, read with UTC getters
  let target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, 0, 0);
  if (local.getUTCHours() >= hour) target += 24 * 3600e3;
  let utc = target - off * 60000;
  const offAtTarget = cairoOffsetMinutes(new Date(utc));
  if (offAtTarget !== off) utc = target - offAtTarget * 60000;
  return new Date(utc);
}

module.exports = { isCairoQuietHours, cairoHour, nextCairoTime, cairoOffsetMinutes };
