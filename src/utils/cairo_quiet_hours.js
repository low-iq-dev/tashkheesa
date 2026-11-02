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

module.exports = { isCairoQuietHours, cairoHour };
