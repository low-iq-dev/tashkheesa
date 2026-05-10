// DEPRECATED — Theme 7 sub-issue B (2026-05-10).
//
// runSlaSweep used to scan for SLA pre-breach (60-min superadmin alert) and
// breach mutation, plus a raw doctor-id swap reassignment. All three paths
// produced a non-canonical end state (status='breached' lowercase, no
// canonical case_events row, no reassignCase partial-pay accounting).
//
// All three paths are now in case_sla_worker.runCaseSlaSweep:
//   - Pre-breach: fetchPreBreachCandidates + handlePreBreach
//     (fires order_sla_prebreach to active superadmins +
//      sla_reminder_doctor to the assigned doctor)
//   - Breach + reassign: handleBreach → markSlaBreach (canonical) →
//     reassignCase (canonical with partial-pay accounting)
//
// Kept callable so server.js:212's
//   var { runSlaSweep: runWatcherSweep } = require('./sla_watcher');
// import + the boot-time `runWatcherSweep(new Date())` call do not crash.
// Scheduled for deletion in a follow-up PR after 30 days of stable
// canonical-worker behaviour.
//
// See docs/audits/THEME_07_STATE_MACHINE_FIX_PLAN.md § sub-issue B.

'use strict';

async function runSlaSweep(_now) {
  return;
}

module.exports = { runSlaSweep };
