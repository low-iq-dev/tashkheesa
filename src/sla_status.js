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

// DEPRECATED — Theme 7 sub-issue B (2026-05-10).
//
// This helper was an emergency hot-path patch: it fired on every dashboard
// render in 7 call sites (routes/admin.js:989,1278; routes/doctor.js:2916;
// routes/patient.js:1020,2524; routes/superadmin.js:1142,1284) and wrote
// `status='breached'` raw plus the refund hook. It produced a non-canonical
// end state (no canonical case_events row, no reassignCase partial-pay
// accounting), raced with the legitimate sweeps, and scaled with page-render
// volume rather than with breach volume.
//
// Breach detection + state mutation now lives exclusively in
// case_sla_worker.runCaseSlaSweep (canonical worker, every 5 minutes).
// markSlaBreach (called by the worker) fires issueBreachRefundSafe and
// the patient bell that this helper used to skip.
//
// Kept callable so the 7 inline call sites do not crash. Scheduled for
// deletion in a follow-up PR after 30 days of stable canonical-worker
// behaviour. See docs/audits/THEME_07_STATE_MACHINE_FIX_PLAN.md § sub-issue B.
async function enforceBreachIfNeeded(_order, _now) {
  return null;
}

module.exports = { computeSla, enforceBreachIfNeeded };
