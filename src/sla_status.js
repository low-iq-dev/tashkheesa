// Shared SLA status helper
const { db } = require('./db');

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

function enforceBreachIfNeeded(order, now = new Date()) {
  if (!order || !order.id) return null;
  if (order.status === 'completed' || order.status === 'breached') return null;
  if (!order.deadline_at) return null;

  const deadline = new Date(order.deadline_at);
  if (now > deadline) {
    const nowIso = now.toISOString();
    db.prepare(
      `UPDATE orders
       SET status = 'breached',
           breached_at = COALESCE(breached_at, ?),
           updated_at = ?
       WHERE id = ?`
    ).run(nowIso, nowIso, order.id);
    return 'breached';
  }
  return null;
}

module.exports = { computeSla, enforceBreachIfNeeded };
