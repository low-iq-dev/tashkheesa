// Shared SLA status helper.
// Theme 7 sub-issue B (2026-05-10): the previous module-level requires
// (`./pg.execute`, `./services/sla_breach.issueBreachRefundSafe`,
// `./logger.logErrorToDb`) were only used by enforceBreachIfNeeded, which
// is now a no-op. Imports removed to make the deprecation surface obvious.

function computeSla(order, now = new Date()) {
  const result = {
    effectiveStatus: order.status || 'new',
    sla: {
      isBreached: false,
      isAccepted: false,
      isNew: false,
      minutesRemaining: null,
      minutesOverdue: null
    }
  };

  const status = (order.status || '').toLowerCase();
  const deadline = order.deadline_at ? new Date(order.deadline_at) : null;
  const completed = order.completed_at ? new Date(order.completed_at) : null;

  if (status === 'completed' || completed) {
    result.effectiveStatus = 'completed';
    return result;
  }

  if (deadline) {
    const diffMs = deadline.getTime() - now.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMs < 0) {
      result.effectiveStatus = 'breached';
      result.sla.isBreached = true;
      result.sla.minutesOverdue = Math.abs(diffMin);
    } else {
      result.effectiveStatus = status || 'accepted';
      result.sla.isAccepted = status === 'accepted' || status === 'in_review' || status === 'in-review';
      result.sla.minutesRemaining = diffMin;
    }
    return result;
  }

  // No deadline yet
  if (!order.accepted_at || status === 'new') {
    result.effectiveStatus = 'new';
    result.sla.isNew = true;
  }

  return result;
}

// REMOVED — Theme 7 sub-issue B (deprecated 2026-05-10, deleted 2026-08-16).
//
// `enforceBreachIfNeeded(order, now)` used to live here. It was an emergency
// hot-path patch: it fired on every dashboard render across 7 call sites and
// wrote `status='breached'` raw plus the refund hook. It produced a
// non-canonical end state (no canonical case_events row, no reassignCase
// partial-pay accounting), raced with the legitimate sweeps, and scaled with
// page-render volume rather than with breach volume.
//
// It was reduced to a `return null;` no-op in May, with the call sites left in
// place for one release so nothing crashed, and scheduled for deletion after 30
// days of stable canonical-worker behaviour. That window has long passed, so
// both the no-op and its five remaining vestigial call sites (routes/admin.js
// ×2, routes/doctor.js ×1, routes/patient.js ×2 — superadmin.js's two were
// already dropped in the Phase 2 dashboard perf rework) are now gone. Reading
// `enforceBreachIfNeeded(order)` at the top of a page handler strongly implied
// breaches were enforced on page load; they were not, and had not been for
// three months.
//
// Breach detection + state mutation lives exclusively in
// case_sla_worker.runCaseSlaSweep (canonical worker, every 5 minutes).
// markSlaBreach (called by the worker) fires issueBreachRefundSafe and the
// patient bell. See docs/audits/THEME_07_STATE_MACHINE_FIX_PLAN.md § sub-issue B.

module.exports = { computeSla };
