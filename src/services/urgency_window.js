/**
 * Cairo-time helpers for the Urgent tier window check.
 *
 * Per docs/PAYOUT_AND_URGENCY_POLICY.md §2 + §3:
 *   - Urgent submissions are accepted 07:00–18:59 Cairo local time.
 *   - Outside that window, the patient must explicitly pick:
 *       (a) Wait until 7am — clock anchors at next 7am Cairo.
 *       (b) Downgrade to VIP — 1.3× / 18h SLA, processed immediately.
 *
 * Cairo is UTC+2 year-round (no DST since 2014), so the math is a
 * fixed +2h offset.  No I/O.
 */

'use strict';

function _cairoNow() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000);
}

function isUrgentWindowOpen() {
  const h = _cairoNow().getUTCHours();
  return h >= 7 && h < 19;
}

// Returns the next 7:00 Cairo as a UTC Date.  If currently before
// 7am Cairo, that's today's 7am Cairo; otherwise tomorrow's.
function nextSevenAmCairoUtc() {
  const c = _cairoNow();
  // Build today's 7am Cairo as UTC: 7am Cairo = 5am UTC.
  const target = new Date(Date.UTC(
    c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate(), 7 - 2, 0, 0, 0
  ));
  // c.getUTCHours() is the Cairo hour (we shifted +2h above).
  if (c.getUTCHours() >= 7) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target;
}

module.exports = {
  isUrgentWindowOpen: isUrgentWindowOpen,
  nextSevenAmCairoUtc: nextSevenAmCairoUtc
};
