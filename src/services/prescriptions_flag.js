'use strict';

// Prescriptions: coming soon.
//
// 2026-08-24 — Ziad's call. The prescription add-on works end to end in code
// (purchase → fulfil → earnings, plus the doctor-request → ops-release path
// added on 23 Aug), but three things are unresolved and none of them should be
// discovered by a real patient during launch week:
//
//   1. `service_regional_prices` has no `addon_prescription` row in ANY of the
//      nine currencies, so the checkout prices it at 0 and the option never
//      renders. It literally cannot be bought self-serve today.
//   2. `POST /admin/orders/:id/mark-paid` — with Paymob refusing live
//      credentials, the ONLY payment path in use — never runs the add-on block
//      the webhook runs, so a prescription bought at checkout would stay locked
//      to the doctor forever.
//   3. Nothing has ever been sold (order_addons is empty), so no part of the
//      lifecycle has run against real money.
//
// So the surfaces stay VISIBLE — a doctor or patient who expects prescriptions
// should see that they are coming, not find a hole where the feature was — but
// they are labelled and inert. This is deliberately a single switch rather than
// thirteen scattered edits, so turning it on later is one env var and one
// deploy, and nobody has to go hunting for a pill they forgot to remove.
//
// Set PRESCRIPTIONS_ENABLED=true in Render to go live. Anything else — unset,
// empty, 'false' — keeps the coming-soon state. Defaulting to ON would mean a
// missed env var silently ships an unaudited money feature; defaulting to OFF
// means the worst case is a pill that outstays its welcome.

function prescriptionsEnabled() {
  return String(process.env.PRESCRIPTIONS_ENABLED || '').trim().toLowerCase() === 'true';
}

function prescriptionsComingSoon() {
  return !prescriptionsEnabled();
}

module.exports = { prescriptionsEnabled, prescriptionsComingSoon };
