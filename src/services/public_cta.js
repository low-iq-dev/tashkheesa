'use strict';

// ONE switch for "can a visitor start a case from the public site".
//
// Held OFF deliberately, at Ziad's instruction, until he says otherwise
// (2026-08-30). This is not a bug and not a styling accident: no card payment
// has ever settled through Paymob, so every public button that opens the
// booking wizard is rendered grey and inert rather than leading a patient into
// a funnel that cannot take their money.
//
// TO TURN BOOKING ON, no code change is needed — set the environment variable
// on Render and redeploy:
//
//     PUBLIC_BOOKING_CTA=on
//
// Anything other than "on" (unset, empty, "off", "false", "0") keeps it shut.
// The default is OFF on purpose: a missing or fat-fingered env var must fail
// CLOSED, because the failure mode of failing open is taking a patient's money
// for a case we cannot process.
//
// SCOPE — every public route into the wizard, so the site is consistent:
//   * the three "Start Your Case" buttons on the homepage
//   * every per-specialty and per-service CTA on /services
//   * the "Book a case" CTA on a specialty page
//
// NOT in scope, and still fully working: Sign In, patient registration, the
// doctor application, contact, and the patient portal itself. A signed-in
// patient or an admin testing the wizard directly is unaffected — this gates
// the marketing site's links, never the wizard's own routes.

function bookingCtaEnabled() {
  return String(process.env.PUBLIC_BOOKING_CTA || '').trim().toLowerCase() === 'on';
}

module.exports = { bookingCtaEnabled: bookingCtaEnabled };
