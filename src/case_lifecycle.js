const { randomUUID } = require('crypto');
const { db } = require('./db');

const CASE_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  PAID: 'PAID',
  ASSIGNED: 'ASSIGNED',
  IN_REVIEW: 'IN_REVIEW',
  REJECTED_FILES: 'REJECTED_FILES',
  COMPLETED: 'COMPLETED',
  SLA_BREACH: 'SLA_BREACH',
  REASSIGNED: 'REASSIGNED'
});

const SLA_HOURS = Object.freeze({
  standard_72h: 72,
  priority_24h: 24
});

const STATUS_TRANSITIONS = Object.freeze({
  [CASE_STATUS.DRAFT]: [CASE_STATUS.SUBMITTED],
  [CASE_STATUS.SUBMITTED]: [CASE_STATUS.PAID],
  [CASE_STATUS.PAID]: [CASE_STATUS.ASSIGNED],
  [CASE_STATUS.ASSIGNED]: [
    CASE_STATUS.IN_REVIEW,
    CASE_STATUS.REJECTED_FILES,
    CASE_STATUS.REASSIGNED
  ],
  [CASE_STATUS.IN_REVIEW]: [CASE_STATUS.COMPLETED, CASE_STATUS.REJECTED_FILES],
  [CASE_STATUS.REJECTED_FILES]: [CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW],
  [CASE_STATUS.SLA_BREACH]: [CASE_STATUS.REASSIGNED],
  [CASE_STATUS.REASSIGNED]: [CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW]
});

function normalizeStatus(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  // Normalize common formats: "in_review", "IN REVIEW", "in-review" -> "IN_REVIEW"
  const cleaned = raw
    .replace(/\s+/g, '_')
    .replace(/-/g, '_')
    .toUpperCase();

  // If the normalized value is one of our known statuses, return it.
  if (Object.prototype.hasOwnProperty.call(CASE_STATUS, cleaned)) {
    return CASE_STATUS[cleaned];
  }

  // Support legacy values that might not match enum casing exactly.
  // (If cleaned isn't in CASE_STATUS, fall back to cleaned.)
  return cleaned;
}

function calculateDeadline(createdAtIso, slaType) {
  const baseHours = SLA_HOURS[slaType] || SLA_HOURS.standard_72h;
  const created = new Date(createdAtIso || Date.now());
  return new Date(created.getTime() + baseHours * 60 * 60 * 1000).toISOString();
}

function logCaseEvent(caseId, eventType, payload = null) {
  const stmt = db.prepare(
    `INSERT INTO case_events (id, case_id, event_type, event_payload, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const meta = payload ? JSON.stringify(payload) : null;
  stmt.run(randomUUID(), caseId, eventType, meta, new Date().toISOString());
}

function triggerNotification(caseId, type, payload) {
  logCaseEvent(caseId, `notification:${type}`, payload);
}

function getCase(caseId) {
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
}

function attachFileToCase(caseId, { filename, file_type, storage_path = null }) {
  db.prepare(
    `INSERT INTO case_files (id, case_id, filename, file_type, storage_path)
     VALUES (?, ?, ?, ?, ?)`
  ).run(randomUUID(), caseId, filename, file_type || 'unknown', storage_path);
  logCaseEvent(caseId, 'FILE_UPLOADED', { filename, file_type });
}

function updateCase(caseId, fields) {
  const updates = Object.keys(fields);
  if (!updates.length) return;
  const sets = updates.map((column) => `${column} = ?`).join(', ');
  const stmt = db.prepare(`UPDATE cases SET ${sets} WHERE id = ?`);
  stmt.run(...updates.map((key) => fields[key]), caseId);
}

function assertTransition(current, next) {
  const from = normalizeStatus(current);
  const to = normalizeStatus(next);

  if (from === to) return;
  if (!STATUS_TRANSITIONS[from]) {
    throw new Error(`No transitions defined from ${from}`);
  }
  if (!STATUS_TRANSITIONS[from].includes(to)) {
    throw new Error(`Cannot transition from ${from} to ${to}`);
  }
}

function transitionCase(caseId, nextStatus, data = {}) {
  const existing = getCase(caseId);
  if (!existing) {
    throw new Error('Case not found');
  }
  const currentStatus = normalizeStatus(existing.status);
  const desiredStatus = normalizeStatus(nextStatus);

  if (desiredStatus === CASE_STATUS.SLA_BREACH) {
    if (![CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW].includes(currentStatus)) {
      throw new Error('Only active review cases can escalate to SLA breach');
    }
  } else {
    assertTransition(currentStatus, desiredStatus);
  }
  const now = new Date().toISOString();
  const updates = { status: desiredStatus, updated_at: now, ...data };
  updateCase(caseId, updates);
  logCaseEvent(caseId, `status:${desiredStatus}`, { from: currentStatus });
  return getCase(caseId);
}

function createDraftCase({ language = 'en', urgency_flag = false, reason_for_review = '' }) {
  const caseId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cases (id, status, language, urgency_flag, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(caseId, CASE_STATUS.DRAFT, language, urgency_flag ? 1 : 0, now, now);
  db.prepare(
    `INSERT INTO case_context (case_id, reason_for_review, urgency_flag, language)
     VALUES (?, ?, ?, ?)`
  ).run(caseId, reason_for_review, urgency_flag ? 1 : 0, language);
  logCaseEvent(caseId, 'CASE_DRAFT_CREATED', { language, urgency_flag, reason_for_review });
  return caseId;
}

function submitCase(caseId) {
  const result = transitionCase(caseId, CASE_STATUS.SUBMITTED);
  logCaseEvent(caseId, 'CASE_SUBMITTED');
  return result;
}

function markCasePaid(caseId, slaType = 'standard_72h') {
  const existing = getCase(caseId);
  if (!existing) throw new Error('Case not found');
  const reference = existing.reference_code || `TSH-${randomUUID().split('-')[0].toUpperCase()}`;
  const deadline = calculateDeadline(existing.created_at, slaType);
  transitionCase(caseId, CASE_STATUS.PAID, {
    reference_code: reference,
    sla_type: slaType,
    sla_deadline: deadline,
    paid_at: new Date().toISOString()
  });
  logCaseEvent(caseId, 'PAYMENT_CONFIRMED', { sla_type: slaType });
  logCaseEvent(caseId, 'CASE_READY_FOR_ASSIGNMENT');
  triggerNotification(caseId, 'payment_confirmation', { sla_type: slaType });
  return getCase(caseId);
}

function markSlaBreach(caseId) {
  transitionCase(caseId, CASE_STATUS.SLA_BREACH, { breached_at: new Date().toISOString() });
  logCaseEvent(caseId, 'SLA_BREACHED');
  triggerNotification(caseId, 'sla_breach', {});
  return getCase(caseId);
}

function pauseSla(caseId, reason = 'rejected_files') {
  const existing = getCase(caseId);
  if (!existing || existing.sla_paused_at || !existing.sla_deadline) {
    return existing;
  }
  const now = new Date();
  const deadline = new Date(existing.sla_deadline);
  const remainingSeconds = Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000));
  updateCase(caseId, {
    sla_paused_at: now.toISOString(),
    sla_remaining_seconds: remainingSeconds,
    updated_at: now.toISOString()
  });
  logCaseEvent(caseId, 'SLA_PAUSED', { reason, remaining_seconds: remainingSeconds });
  return getCase(caseId);
}

function resumeSla(caseId, { reason = 'files_uploaded' } = {}) {
  const existing = getCase(caseId);
  if (!existing || !existing.sla_paused_at) {
    return existing;
  }
  const remaining = Number(existing.sla_remaining_seconds) || 0;
  const now = new Date();
  const deadline = new Date(now.getTime() + remaining * 1000).toISOString();
  updateCase(caseId, {
    sla_deadline: deadline,
    sla_paused_at: null,
    sla_remaining_seconds: null,
    updated_at: now.toISOString()
  });
  logCaseEvent(caseId, 'SLA_RESUMED', { reason, remaining_seconds: remaining });
  return getCase(caseId);
}

function getLatestAssignment(caseId) {
  return db
    .prepare(
      `SELECT *
       FROM doctor_assignments
       WHERE case_id = ?
       ORDER BY datetime(assigned_at) DESC
       LIMIT 1`
    )
    .get(caseId);
}

function finalizePreviousAssignment(caseId) {
  const existing = getLatestAssignment(caseId);
  if (existing && !existing.completed_at) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE doctor_assignments
       SET completed_at = ?
       WHERE id = ?`
    ).run(now, existing.id);
  }
  return existing;
}

function assignDoctor(caseId, doctorId, { replacedDoctorId = null } = {}) {
  finalizePreviousAssignment(caseId);
  transitionCase(caseId, CASE_STATUS.ASSIGNED);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO doctor_assignments (id, case_id, doctor_id, assigned_at, reassigned_from_doctor_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(randomUUID(), caseId, doctorId, now, replacedDoctorId);
  logCaseEvent(caseId, 'CASE_ASSIGNED', { doctorId, replacedDoctorId });
  return getCase(caseId);
}

function reassignCase(caseId, newDoctorId, { reason = 'auto' } = {}) {
  const existing = getCase(caseId);
  if (!existing) {
    throw new Error('Case not found');
  }
  const currentStatus = normalizeStatus(existing.status);
  if (![CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW, CASE_STATUS.SLA_BREACH].includes(currentStatus)) {
    throw new Error(`Cannot reassign case in status ${currentStatus}`);
  }
  const previousAssignment = getLatestAssignment(caseId);
  transitionCase(caseId, CASE_STATUS.REASSIGNED);
  logCaseEvent(caseId, 'CASE_REASSIGNED', {
    reason,
    from: previousAssignment ? previousAssignment.doctor_id : null,
    to: newDoctorId
  });
  if (!newDoctorId) {
    return getCase(caseId);
  }
  assignDoctor(caseId, newDoctorId, {
    replacedDoctorId: previousAssignment ? previousAssignment.doctor_id : null
  });
  return getCase(caseId);
}

function logNotification(caseId, template, payload) {
  triggerNotification(caseId, template, payload);
}

module.exports = {
  CASE_STATUS,
  SLA_HOURS,
  createDraftCase,
  submitCase,
  markCasePaid,
  attachFileToCase,
  getCase,
  logCaseEvent,
  logNotification,
  markSlaBreach,
  triggerNotification,
  assignDoctor,
  reassignCase,
  pauseSla,
  resumeSla
};
