'use strict';

// Video consultation: coming soon.
//
// 2026-08-25 — Ziad's call. Deliberately mirrors services/prescriptions_flag.js
// (2026-08-24) rather than inventing a second mechanism, because the situation
// is the same shape and the two should be turned on the same way.
//
// The gate itself is NOT new: video_helpers.isVideoEnabled() has always
// required VIDEO_CONSULTATION_ENABLED=true AND all three Twilio credentials,
// and it defaults to off. What was missing is that only the CHECKOUT respected
// it. Everywhere else the feature looked live:
//
//   * the patient sidebar's "Appointments" entry linked straight through, with
//     no badge and no hint that nothing was behind it
//   * the doctor sidebar and header offered "Appointments" and "Set
//     Availability" the same way
//   * patient_appointments_list.ejs and doctor_appointments.ejs never read the
//     flag at all
//   * and until today video_appointment.ejs did not compile, so every one of
//     those links led to a 500 rather than to an empty page
//
// Nothing has ever been sold: 0 appointments, 0 video_calls, 0 orders with
// video_consultation_selected, 0 order_addons rows. So there is no live usage
// to preserve and no migration to run — only a label to apply honestly.
//
// The surfaces stay VISIBLE and labelled, matching the prescriptions decision:
// a patient who expects video should see that it is coming, not find a hole
// where the feature was.
//
// Set VIDEO_CONSULTATION_ENABLED=true in Render (with Twilio credentials) to go
// live. Anything else — unset, empty, 'false' — keeps the coming-soon state.
// Defaulting to ON would mean a missed env var silently ships an unaudited paid
// feature; defaulting to OFF means the worst case is a badge that outstays its
// welcome.

const { isVideoEnabled } = require('../video_helpers');

function videoEnabled() {
  try {
    return !!isVideoEnabled();
  } catch (_) {
    // A helper that cannot answer means we cannot promise the feature works.
    return false;
  }
}

function videoComingSoon() {
  return !videoEnabled();
}

module.exports = { videoEnabled, videoComingSoon };
