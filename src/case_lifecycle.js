// ---------------------------------------------------------------------------
// HARD PAYMENT GATE: block all lifecycle transitions before payment
// ---------------------------------------------------------------------------
function assertPaidGate(existingCase, nextStatus) {
  if (existingCase.payment_due_at && !existingCase.paid_at) {
    const dueMs = new Date(existingCase.payment_due_at).getTime();
    if (Number.isFinite(dueMs) && Date.now() > dueMs) {
      throw new Error('Payment window expired');
    }
  }
  const current = normalizeStatus(existingCase.status);
  const desired = normalizeStatus(nextStatus);

  // Allowed statuses before payment
  const PRE_PAYMENT = [CASE_STATUS.DRAFT, CASE_STATUS.SUBMITTED];

  // If not paid yet, block everything except staying pre-payment
  if (!existingCase.paid_at && current !== CASE_STATUS.PAID) {
    if (PRE_PAYMENT.includes(desired)) return;

    throw new Error(
      `Payment required before transitioning case ${existingCase.id} from ${current} to ${desired}`
    );
  }
}

const { randomUUID } = require('crypto');
const { db } = require('./db');

// Prefer the live table name used by the app (`orders`). Keep backward-compat with older `cases` table.
const CASE_TABLE = (() => {
  try {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('orders','cases') ORDER BY CASE name WHEN 'orders' THEN 0 ELSE 1 END LIMIT 1"
      )
      .get();
    return row && row.name ? row.name : 'orders';
  } catch (e) {
    return 'orders';
  }
})();


function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// PAYMENT CONFIRMATION (single source of truth)
//
// Goal: tighten payment→SLA boundary. If the schema includes `payment_status`,
// require it to be 'paid' (case-insensitive). Otherwise fall back to `paid_at`.
// ---------------------------------------------------------------------------
function hasColumn(tableName, columnName) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return rows.some((r) => String(r && r.name) === String(columnName));
  } catch {
    return false;
  }
}

const HAS_PAYMENT_STATUS_COLUMN = hasColumn(CASE_TABLE, 'payment_status');
const HAS_SLA_PAUSED_AT_COLUMN = hasColumn(CASE_TABLE, 'sla_paused_at');
const HAS_SLA_REMAINING_SECONDS_COLUMN = hasColumn(CASE_TABLE, 'sla_remaining_seconds');
const HAS_ASSIGNED_AT_COLUMN = hasColumn(CASE_TABLE, 'assigned_at');

function isPaymentConfirmed(orderRow) {
  if (!orderRow) return false;
  if (!orderRow.paid_at) return false;

  // If we have a payment_status column, enforce it.
  if (HAS_PAYMENT_STATUS_COLUMN) {
    const ps = String(orderRow.payment_status || '').trim().toLowerCase();
    if (ps === 'paid') return true;

    // Backward-compat: allow legacy rows where status itself was set to 'paid'
    // (but only if paid_at exists).
    const st = String(orderRow.status || '').trim().toLowerCase();
    if (!ps && st === 'paid') return true;

    return false;
  }

  // No payment_status column available → paid_at is the only signal.
  return true;
}


function hasSlaBreachAlert(caseId) {
  try {
    return Boolean(
      db.prepare(`
        SELECT 1
        FROM notifications
        WHERE channel = 'whatsapp'
          AND template = 'sla_breach'
          AND json_extract(response, '$.case_id') = ?
        LIMIT 1
      `).get(caseId)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Automated SLA Reminder Support (WhatsApp + Email) with Dedupe + Guardrails
// ---------------------------------------------------------------------------
function hasNotificationByDedupeKey(dedupeKey) {
  if (!dedupeKey) return false;
  try {
    return Boolean(
      db.prepare(
        `SELECT 1 FROM notifications WHERE dedupe_key = ? LIMIT 1`
      ).get(dedupeKey)
    );
  } catch {
    return false;
  }
}

function safeUserId(value) {
  const v = String(value || '').trim();
  return v.length ? v : null;
}

function getPatientUserIdFromOrder(orderRow) {
  // Be defensive across schemas.
  return (
    safeUserId(orderRow && (orderRow.patient_user_id || orderRow.patient_id || orderRow.user_id || orderRow.to_user_id))
  );
}

function getDoctorUserIdFromOrder(orderRow) {
  return safeUserId(orderRow && orderRow.doctor_id);
}

function secondsUntilDeadline(orderRow) {
  const deadline = orderRow && orderRow.deadline_at;
  if (!deadline) return null;

  const deadlineMs = new Date(deadline).getTime();
  if (!Number.isFinite(deadlineMs)) return null;

  const nowMs = Date.now();
  return Math.floor((deadlineMs - nowMs) / 1000);
}

function isActiveForSlaReminders(canonStatus) {
  return [
    CASE_STATUS.IN_REVIEW,
    CASE_STATUS.REJECTED_FILES,
    CASE_STATUS.SLA_BREACH
  ].includes(canonStatus);
}

function deadlineFromAcceptance(orderRow) {
  const accepted = orderRow && orderRow.accepted_at;
  const hours = Number(orderRow && orderRow.sla_hours) || 0;
  if (!accepted || !hours) return null;

  const acceptedMs = new Date(accepted).getTime();
  if (!Number.isFinite(acceptedMs)) return null;

  return new Date(acceptedMs + hours * 60 * 60 * 1000).toISOString();
}

function shouldUpdateDeadline(existingDeadline, expectedDeadline, { toleranceSeconds = 120 } = {}) {
  if (!expectedDeadline) return false;
  if (!existingDeadline) return true;

  const a = new Date(existingDeadline).getTime();
  const b = new Date(expectedDeadline).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;

  return Math.abs(a - b) > toleranceSeconds * 1000;
}

function queueSlaReminder({ caseId, level, toUserId, channel, role, secondsRemaining }) {
  const userId = safeUserId(toUserId);
  if (!userId) return { ok: false, skipped: 'missing_toUserId' };

  const dedupeKey = `sla:${level}:${channel}:${role}:${caseId}:${userId}`;
  if (hasNotificationByDedupeKey(dedupeKey)) {
    return { ok: true, deduped: true };
  }

  // Best-effort: queueNotification returns {ok:false} on failure (do not throw).
  try {
    const { queueNotification } = require('./notify');
    return queueNotification({
      channel,
      toUserId: userId,
      template: `sla_reminder_${level}`,
      dedupeKey,
      dedupe_key: dedupeKey,
      response: {
        case_id: caseId,
        role,
        level,
        seconds_remaining: secondsRemaining
      }
    });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function dispatchSlaReminders(caseIdOrRow, opts = {}) {
  const force = Boolean(opts.force);
  const orderRow = (caseIdOrRow && typeof caseIdOrRow === 'object') ? caseIdOrRow : getCase(caseIdOrRow);
  if (!orderRow) return { ok: false, skipped: 'missing_case' };

  const caseId = orderRow.id;
  const canonStatus = normalizeStatus(orderRow.status);

  // Guardrails
  if (!isPaymentConfirmed(orderRow)) return { ok: false, skipped: 'unpaid' };

  if (isTerminalStatus(canonStatus)) return { ok: true, skipped: 'terminal' };
  if (!isActiveForSlaReminders(canonStatus)) return { ok: true, skipped: 'not_active' };

  // 🔒 SLA starts at acceptance (accepted_at). Ensure deadline_at matches accepted_at + sla_hours.
  if ([CASE_STATUS.IN_REVIEW, CASE_STATUS.SLA_BREACH].includes(canonStatus) && orderRow.sla_hours) {
    const expected = deadlineFromAcceptance(orderRow);
    if (shouldUpdateDeadline(orderRow.deadline_at, expected)) {
      try {
        updateCase(orderRow.id, { deadline_at: expected });
        orderRow.deadline_at = expected;
      } catch (e) {
        return { ok: false, skipped: 'deadline_backfill_failed' };
      }
    }
  }

  const secondsRemaining = secondsUntilDeadline(orderRow);
  if (secondsRemaining == null) return { ok: false, skipped: 'missing_deadline' };

  // If a case was previously marked as breached under the old model,
  // but the acceptance-based deadline is still in the future, un-breach it.
  if (!force && canonStatus === CASE_STATUS.SLA_BREACH && secondsRemaining > 0) {
    try {
      transitionCase(caseId, CASE_STATUS.IN_REVIEW);
    } catch (e) {
      // best-effort
    }
  }

  // Do not send reminders after deadline unless forced (breach flow handles escalation).
  if (!force && secondsRemaining <= 0) return { ok: true, skipped: 'past_deadline' };

  // Thresholds: send once when remaining time drops below these windows.
  // Keep it simple and stable: 24h, 6h, 1h.
  const thresholds = [
    { level: '24h', seconds: 24 * 60 * 60 },
    { level: '6h', seconds: 6 * 60 * 60 },
    { level: '1h', seconds: 60 * 60 }
  ];

  const toDoctorId = getDoctorUserIdFromOrder(orderRow);
  const toPatientId = getPatientUserIdFromOrder(orderRow);

  const sent = [];
  for (const t of thresholds) {
    if (secondsRemaining <= t.seconds) {
      // Doctor
      if (toDoctorId) {
        sent.push(queueSlaReminder({
          caseId,
          level: t.level,
          toUserId: toDoctorId,
          channel: 'whatsapp',
          role: 'doctor',
          secondsRemaining
        }));
        sent.push(queueSlaReminder({
          caseId,
          level: t.level,
          toUserId: toDoctorId,
          channel: 'email',
          role: 'doctor',
          secondsRemaining
        }));
      }

      // Patient
      if (toPatientId) {
        sent.push(queueSlaReminder({
          caseId,
          level: t.level,
          toUserId: toPatientId,
          channel: 'whatsapp',
          role: 'patient',
          secondsRemaining
        }));
        sent.push(queueSlaReminder({
          caseId,
          level: t.level,
          toUserId: toPatientId,
          channel: 'email',
          role: 'patient',
          secondsRemaining
        }));
      }
    }
  }

  return { ok: true, caseId, secondsRemaining, sentCount: sent.length };
}

function runSlaReminderSweep({ limit = 200 } = {}) {
  // Periodic sweep entrypoint (wire this from server.js or a cron-like job).
  // Only targets paid, non-terminal cases with a deadline.
  try {
    const paymentClause = HAS_PAYMENT_STATUS_COLUMN
      ? " AND (LOWER(COALESCE(payment_status,'')) = 'paid')"
      : '';

    const rows = db.prepare(
      `SELECT *
       FROM ${CASE_TABLE}
       WHERE paid_at IS NOT NULL${paymentClause}
         AND status NOT IN ('COMPLETED','CANCELLED')
         AND (
           deadline_at IS NOT NULL
           OR LOWER(COALESCE(status,'')) IN ('in_review','rejected_files','sla_breach','breached','delayed','overdue')
         )
       ORDER BY datetime(COALESCE(deadline_at, accepted_at, created_at)) ASC
       LIMIT ?`
    ).all(limit);

    let processed = 0;
    for (const r of rows) {
      dispatchSlaReminders(r);
      processed++;
    }
    return { ok: true, processed };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Automated Unpaid Case Reminder Support (WhatsApp + Email) with Dedupe
// ---------------------------------------------------------------------------
function secondsSinceCreated(orderRow) {
  const createdAt = orderRow && orderRow.created_at;
  if (!createdAt) return null;
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) return null;
  return Math.floor((Date.now() - createdMs) / 1000);
}

function isUnpaidReminderEligible(orderRow) {
  if (!orderRow) return false;
  const canonStatus = normalizeStatus(orderRow.status);

  if (orderRow.completed_at) return false;
  if (isTerminalStatus(canonStatus)) return false;
  if (canonStatus === 'EXPIRED') return false;

  if (HAS_PAYMENT_STATUS_COLUMN) {
    const ps = String(orderRow.payment_status || '').trim().toLowerCase();
    if (ps === 'paid') return false;
  } else if (orderRow.paid_at) {
    return false;
  }

  return true;
}

function getPaymentUrlFromOrder(orderRow) {
  return (orderRow && (orderRow.payment_link || orderRow.payment_url)) || null;
}

function queuePaymentReminder({ caseId, level, toUserId, channel, paymentUrl, elapsedSeconds }) {
  const userId = safeUserId(toUserId);
  if (!userId) return { ok: false, skipped: 'missing_toUserId' };

  const dedupeKey = `payment_reminder:${level}:${channel}:${caseId}:${userId}`;
  if (hasNotificationByDedupeKey(dedupeKey)) {
    return { ok: true, deduped: true };
  }

  try {
    const { queueNotification, buildPaymentReminderPayload } = require('./notify');
    return queueNotification({
      channel,
      toUserId: userId,
      template: `payment_reminder_${level}`,
      dedupeKey,
      dedupe_key: dedupeKey,
      response: {
        ...buildPaymentReminderPayload({ caseId, paymentUrl }),
        elapsed_seconds: elapsedSeconds,
        level
      }
    });
  } catch (e) {
    console.error('[unpaid-reminder] queue failed', e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}


function dispatchUnpaidCaseReminders(caseIdOrRow, opts = {}) {
  const force = Boolean(opts.force);
  const limit = Number(opts.limit || 200);

  if (!caseIdOrRow) {
    try {
      const paymentClause = HAS_PAYMENT_STATUS_COLUMN
        ? " AND (LOWER(COALESCE(payment_status,'')) != 'paid')"
        : ' AND paid_at IS NULL';

      const terminalStatuses = [
        ...dbStatusValuesFor(CASE_STATUS.COMPLETED),
        ...dbStatusValuesFor(CASE_STATUS.CANCELLED),
        'expired',
        'EXPIRED'
      ];
      const placeholders = terminalStatuses.map(() => '?').join(', ');

      const rows = db.prepare(
        `SELECT *
         FROM ${CASE_TABLE}
         WHERE created_at IS NOT NULL${paymentClause}
           AND COALESCE(status, '') NOT IN (${placeholders})
         ORDER BY datetime(created_at) ASC
         LIMIT ?`
      ).all(...terminalStatuses, limit);

      let sentCount = 0;
      const skipped = [];

      for (const r of rows) {
        const res = dispatchUnpaidCaseReminders(r, { force });
        if (res && typeof res.sentCount === 'number') {
          sentCount += res.sentCount;
        }
        if (res && res.skipped) {
          skipped.push({ caseId: r.id, reason: res.skipped });
        }
      }

      return { ok: true, sentCount, skipped };
    } catch (e) {
      console.error('[unpaid-reminder] sweep failed', e);
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  const orderRow =
    caseIdOrRow && typeof caseIdOrRow === 'object'
      ? caseIdOrRow
      : getCase(caseIdOrRow);
  if (!orderRow) return { ok: false, sentCount: 0, skipped: 'missing_case' };

  const caseId = orderRow.id;
  if (!isUnpaidReminderEligible(orderRow)) {
    return { ok: true, sentCount: 0, skipped: 'not_eligible' };
  }

  const elapsedSeconds = secondsSinceCreated(orderRow);
  if (elapsedSeconds == null) {
    return { ok: true, sentCount: 0, skipped: 'missing_created_at' };
  }
  // HARD STOP: expire unpaid cases after 24h
  if (!force && elapsedSeconds >= 24 * 60 * 60) {
    db.prepare(`
      UPDATE ${CASE_TABLE}
      SET status = 'expired_unpaid'
      WHERE id = ?
        AND (payment_status IS NULL OR payment_status != 'paid')
        AND status NOT IN ('completed','expired_unpaid')
    `).run(orderRow.id);

    return { ok: true, sentCount: 0, skipped: 'expired_unpaid' };
  }

  const toPatientId = getPatientUserIdFromOrder(orderRow);
  if (!toPatientId) {
    return { ok: true, sentCount: 0, skipped: 'missing_patient' };
  }

  const paymentUrl = getPaymentUrlFromOrder(orderRow);

  const thresholds = [
    { level: '30m', seconds: 30 * 60 },
    { level: '6h', seconds: 6 * 60 * 60 },
    { level: '24h', seconds: 24 * 60 * 60 }
  ];

  const sent = [];
  for (const t of thresholds) {
    if (force || elapsedSeconds >= t.seconds) {
      sent.push(queuePaymentReminder({
        caseId,
        level: t.level,
        toUserId: toPatientId,
        channel: 'whatsapp',
        paymentUrl,
        elapsedSeconds
      }));
      sent.push(queuePaymentReminder({
        caseId,
        level: t.level,
        toUserId: toPatientId,
        channel: 'email',
        paymentUrl,
        elapsedSeconds
      }));
    }
  }

  if (!sent.length) {
    return { ok: true, sentCount: 0, skipped: 'not_due' };
  }

  return { ok: true, sentCount: sent.length, skipped: null };
}


const CASE_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  PAID: 'PAID',
  ASSIGNED: 'ASSIGNED',
  IN_REVIEW: 'IN_REVIEW',
  REJECTED_FILES: 'REJECTED_FILES',
  COMPLETED: 'COMPLETED',
  SLA_BREACH: 'SLA_BREACH',
  // Compatibility: some parts of the app historically used these names
  BREACHED_SLA: 'BREACHED_SLA',
  DELAYED: 'DELAYED',
  REASSIGNED: 'REASSIGNED',
  CANCELLED: 'CANCELLED'
});

// Legacy / UI-facing status aliases -> canonical CASE_STATUS
// This prevents old values like "new", "accepted", "breached" from leaking into templates.
const STATUS_ALIASES = Object.freeze({
  NEW: CASE_STATUS.SUBMITTED,
  PENDING: CASE_STATUS.SUBMITTED,

  // Some parts of the app historically used ACCEPTED to mean the case is assigned/active
  ACCEPTED: CASE_STATUS.ASSIGNED,

  // Common variations
  IN_PROGRESS: CASE_STATUS.IN_REVIEW,
  INREVIEW: CASE_STATUS.IN_REVIEW,

  // Files requested / rejected files synonyms
  FILES_REQUESTED: CASE_STATUS.REJECTED_FILES,
  FILE_REQUESTED: CASE_STATUS.REJECTED_FILES,
  MORE_INFO_NEEDED: CASE_STATUS.REJECTED_FILES,

  // Breach synonyms
  BREACHED: CASE_STATUS.SLA_BREACH,
  SLA_BREACHED: CASE_STATUS.SLA_BREACH,
  BREACHED_SLA: CASE_STATUS.SLA_BREACH,
  SLA_BREACH: CASE_STATUS.SLA_BREACH,
  DELAYED: CASE_STATUS.SLA_BREACH,
  OVERDUE: CASE_STATUS.SLA_BREACH,

  // Completion synonyms
  DONE: CASE_STATUS.COMPLETED,
  FINISHED: CASE_STATUS.COMPLETED,

  // Cancelled synonyms
  CANCELLED: CASE_STATUS.CANCELLED,
  CANCELED: CASE_STATUS.CANCELLED,
  CANCEL: CASE_STATUS.CANCELLED
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
  [CASE_STATUS.SLA_BREACH]: [CASE_STATUS.REASSIGNED, CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW],
  [CASE_STATUS.REASSIGNED]: [CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW],
  [CASE_STATUS.CANCELLED]: []
});

// -----------------------------------------------------------------------------
// Status → UI mapping (single source of truth)
//
// Goal: prevent raw/internal status strings leaking into the UI and provide
// consistent titles/descriptions per role (patient/doctor/admin/superadmin).
// -----------------------------------------------------------------------------

const UI_BADGE = Object.freeze({
  neutral: 'neutral',
  info: 'info',
  warning: 'warning',
  success: 'success',
  danger: 'danger'
});

const CASE_STATUS_UI = Object.freeze({
  [CASE_STATUS.DRAFT]: {
    patient: {
      title: { en: 'Draft started', ar: 'تم بدء طلب جديد' },
      description: { en: 'Complete your details and upload files to proceed.', ar: 'أكمل بياناتك وارفع الملفات للمتابعة.' },
      badge: UI_BADGE.neutral,
      visible: false
    },
    doctor: {
      title: { en: 'Not available', ar: 'غير متاح' },
      description: { en: 'This case is not yet submitted.', ar: 'هذه الحالة لم تُرسل بعد.' },
      badge: UI_BADGE.neutral,
      visible: false
    },
    admin: {
      title: { en: 'Draft', ar: 'مسودة' },
      description: { en: 'Patient has not submitted the case yet.', ar: 'المريض لم يرسل الحالة بعد.' },
      badge: UI_BADGE.neutral,
      visible: true
    }
  },

  [CASE_STATUS.SUBMITTED]: {
    patient: {
      title: { en: 'Case received', ar: 'تم استلام الحالة' },
      description: { en: 'We are preparing your case for specialist assignment.', ar: 'نقوم بتجهيز حالتك لتعيين الطبيب المختص.' },
      badge: UI_BADGE.info,
      visible: true
    },
    doctor: {
      title: { en: 'Pending activation', ar: 'قيد التفعيل' },
      description: { en: 'Case is not yet ready for assignment.', ar: 'الحالة ليست جاهزة للتعيين بعد.' },
      badge: UI_BADGE.neutral,
      visible: false
    },
    admin: {
      title: { en: 'Submitted', ar: 'تم الإرسال' },
      description: { en: 'Awaiting operational triage (assignment, checks).', ar: 'بانتظار المعالجة التشغيلية (التعيين، المراجعة).' },
      badge: UI_BADGE.info,
      visible: true
    }
  },

  [CASE_STATUS.PAID]: {
    patient: {
      title: { en: 'Case confirmed', ar: 'تم تأكيد الحالة' },
      description: { en: 'Your case is confirmed and will be assigned shortly.', ar: 'تم تأكيد حالتك وسيتم تعيين الطبيب قريباً.' },
      badge: UI_BADGE.info,
      visible: true
    },
    doctor: {
      title: { en: 'Ready for assignment', ar: 'جاهزة للتعيين' },
      description: { en: 'Case is eligible to be assigned to a doctor.', ar: 'الحالة مؤهلة لتعيين طبيب.' },
      badge: UI_BADGE.info,
      visible: false
    },
    admin: {
      title: { en: 'Confirmed', ar: 'مؤكدة' },
      description: { en: 'Ready to assign to a doctor.', ar: 'جاهزة لتعيين طبيب.' },
      badge: UI_BADGE.info,
      visible: true
    }
  },

  [CASE_STATUS.ASSIGNED]: {
    patient: {
      title: { en: 'Specialist assigned', ar: 'تم تعيين الطبيب المختص' },
      description: { en: 'A specialist has been assigned and will begin review.', ar: 'تم تعيين طبيب مختص وسيبدأ المراجعة.' },
      badge: UI_BADGE.info,
      visible: true
    },
    doctor: {
      title: { en: 'Assigned', ar: 'تم التعيين' },
      description: { en: 'Accept the case to view details and begin work.', ar: 'اقبل الحالة لعرض التفاصيل وبدء العمل.' },
      badge: UI_BADGE.info,
      visible: true
    },
    admin: {
      title: { en: 'Assigned', ar: 'تم التعيين' },
      description: { en: 'Assigned to a doctor; awaiting acceptance/review.', ar: 'تم تعيينها لطبيب وبانتظار القبول/المراجعة.' },
      badge: UI_BADGE.info,
      visible: true
    }
  },

  [CASE_STATUS.IN_REVIEW]: {
    patient: {
      title: { en: 'In review', ar: 'قيد المراجعة' },
      description: { en: 'Your specialist is reviewing your files and clinical question.', ar: 'يقوم الطبيب المختص بمراجعة ملفاتك وسؤالك الطبي.' },
      badge: UI_BADGE.info,
      visible: true
    },
    doctor: {
      title: { en: 'In review', ar: 'قيد المراجعة' },
      description: { en: 'You can draft notes and generate the report when ready.', ar: 'يمكنك كتابة الملاحظات وإنشاء التقرير عند الجاهزية.' },
      badge: UI_BADGE.info,
      visible: true
    },
    admin: {
      title: { en: 'In review', ar: 'قيد المراجعة' },
      description: { en: 'Doctor is actively working on the case.', ar: 'الطبيب يعمل على الحالة حالياً.' },
      badge: UI_BADGE.info,
      visible: true
    }
  },

  [CASE_STATUS.REJECTED_FILES]: {
    patient: {
      title: { en: 'More information needed', ar: 'نحتاج معلومات إضافية' },
      description: { en: 'Please upload the requested files so the review can continue.', ar: 'يرجى رفع الملفات المطلوبة حتى نكمل المراجعة.' },
      badge: UI_BADGE.warning,
      visible: true,
      actionRequired: true
    },
    doctor: {
      title: { en: 'Waiting for patient files', ar: 'بانتظار ملفات المريض' },
      description: { en: 'Review is paused until the patient uploads requested files.', ar: 'تم إيقاف المراجعة حتى يرفع المريض الملفات المطلوبة.' },
      badge: UI_BADGE.warning,
      visible: true
    },
    admin: {
      title: { en: 'Files requested', ar: 'تم طلب ملفات' },
      description: { en: 'Pending patient re-upload (and/or approval workflow).', ar: 'بانتظار إعادة رفع الملفات (و/أو الموافقة).' },
      badge: UI_BADGE.warning,
      visible: true
    }
  },

  // UI-only status used by the admin approval workflow for additional-files requests.
  // This is NOT a canonical CASE_STATUS stored in `cases.status`.
  ['AWAITING_FILES']: {
    patient: {
      title: { en: 'More information needed', ar: 'نحتاج معلومات إضافية' },
      description: { en: 'Please upload the requested files so the review can continue.', ar: 'يرجى رفع الملفات المطلوبة حتى نكمل المراجعة.' },
      badge: UI_BADGE.warning,
      visible: true,
      actionRequired: true
    },
    doctor: {
      title: { en: 'Waiting for patient files', ar: 'بانتظار ملفات المريض' },
      description: { en: 'Review is paused until the patient uploads the requested files.', ar: 'تم إيقاف المراجعة حتى يرفع المريض الملفات المطلوبة.' },
      badge: UI_BADGE.warning,
      visible: true
    },
    admin: {
      title: { en: 'Awaiting patient files', ar: 'بانتظار ملفات المريض' },
      description: { en: 'Approved request; waiting for the patient to re-upload files.', ar: 'تمت الموافقة على الطلب وبانتظار إعادة رفع الملفات من المريض.' },
      badge: UI_BADGE.warning,
      visible: true
    }
  },

  [CASE_STATUS.COMPLETED]: {
    patient: {
      title: { en: 'Report ready', ar: 'التقرير جاهز' },
      description: { en: 'Your specialist report is ready to view and download.', ar: 'تقرير الطبيب المختص جاهز للعرض والتنزيل.' },
      badge: UI_BADGE.success,
      visible: true,
      terminal: true
    },
    doctor: {
      title: { en: 'Completed', ar: 'مكتملة' },
      description: { en: 'Report submitted. Edits are locked unless unlocked by admin.', ar: 'تم إرسال التقرير. التعديلات مقفلة إلا إذا فتحها الأدمن.' },
      badge: UI_BADGE.success,
      visible: true,
      terminal: true
    },
    admin: {
      title: { en: 'Completed', ar: 'مكتملة' },
      description: { en: 'Report delivered to patient.', ar: 'تم تسليم التقرير للمريض.' },
      badge: UI_BADGE.success,
      visible: true,
      terminal: true
    }
  },

  [CASE_STATUS.SLA_BREACH]: {
    patient: {
      title: { en: 'Delayed', ar: 'تأخير' },
      description: { en: 'Your case is being escalated to ensure completion.', ar: 'يتم تصعيد حالتك لضمان إتمامها.' },
      badge: UI_BADGE.danger,
      visible: true
    },
    doctor: {
      title: { en: 'SLA breach', ar: 'تجاوز وقت التنفيذ' },
      description: { en: 'This case is escalated and may be reassigned.', ar: 'تم تصعيد الحالة وقد يتم إعادة تعيينها.' },
      badge: UI_BADGE.danger,
      visible: true
    },
    admin: {
      title: { en: 'SLA breach', ar: 'تجاوز وقت التنفيذ' },
      description: { en: 'Escalate or reassign immediately.', ar: 'صعّد أو أعد التعيين فوراً.' },
      badge: UI_BADGE.danger,
      visible: true
    }
  },

  [CASE_STATUS.REASSIGNED]: {
    patient: {
      title: { en: 'Reassigning specialist', ar: 'إعادة تعيين الطبيب' },
      description: { en: 'We are assigning a different specialist to keep things moving.', ar: 'نقوم بتعيين طبيب آخر لضمان سرعة التنفيذ.' },
      badge: UI_BADGE.warning,
      visible: true
    },
    doctor: {
      title: { en: 'Reassigned', ar: 'تمت إعادة التعيين' },
      description: { en: 'Case is being moved to another specialist.', ar: 'يتم نقل الحالة لطبيب آخر.' },
      badge: UI_BADGE.warning,
      visible: true
    },
    admin: {
      title: { en: 'Reassigned', ar: 'تمت إعادة التعيين' },
      description: { en: 'Awaiting new assignment/acceptance.', ar: 'بانتظار التعيين/القبول الجديد.' },
      badge: UI_BADGE.warning,
      visible: true
    }
  },

  [CASE_STATUS.CANCELLED]: {
    patient: {
      title: { en: 'Cancelled', ar: 'تم الإلغاء' },
      description: { en: 'This case has been cancelled.', ar: 'تم إلغاء هذه الحالة.' },
      badge: UI_BADGE.neutral,
      visible: true,
      terminal: true
    },
    doctor: {
      title: { en: 'Cancelled', ar: 'تم الإلغاء' },
      description: { en: 'This case was cancelled and is no longer active.', ar: 'تم إلغاء هذه الحالة ولم تعد نشطة.' },
      badge: UI_BADGE.neutral,
      visible: true,
      terminal: true
    },
    admin: {
      title: { en: 'Cancelled', ar: 'تم الإلغاء' },
      description: { en: 'Case cancelled. No further actions required.', ar: 'تم إلغاء الحالة. لا توجد إجراءات مطلوبة.' },
      badge: UI_BADGE.neutral,
      visible: true,
      terminal: true
    }
  }
});

function pickLang(obj, lang) {
  if (!obj) return '';
  if (obj[lang]) return obj[lang];
  return obj.en || Object.values(obj)[0] || '';
}

function normalizeRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'superadmin') return 'admin';
  if (r === 'administrator') return 'admin';
  return r || 'patient';
}

function getStatusUi(status, { role = 'patient', lang = 'en' } = {}) {
  const s = normalizeStatus(status);
  const r = normalizeRole(role);
  const meta = CASE_STATUS_UI[s] || null;
  const fallback = {
    title: { en: s, ar: s },
    description: { en: '', ar: '' },
    badge: UI_BADGE.neutral,
    visible: true
  };
  const roleMeta = (meta && (meta[r] || meta.patient)) || fallback;
  return {
    status: s,
    badge: roleMeta.badge || UI_BADGE.neutral,
    visible: roleMeta.visible !== false,
    terminal: Boolean(roleMeta.terminal),
    actionRequired: Boolean(roleMeta.actionRequired),
    title: pickLang(roleMeta.title, lang),
    description: pickLang(roleMeta.description, lang)
  };
}

function isVisibleToPatient(status) {
  const ui = getStatusUi(status, { role: 'patient', lang: 'en' });
  return ui.visible !== false;
}

function normalizeStatus(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  // Normalize common formats: "in_review", "IN REVIEW", "in-review" -> "IN_REVIEW"
  const cleaned = raw
    .replace(/\s+/g, '_')
    .replace(/-/g, '_')
    .toUpperCase();

  // Map legacy/alias values to the canonical enum
  if (Object.prototype.hasOwnProperty.call(STATUS_ALIASES, cleaned)) {
    return STATUS_ALIASES[cleaned];
  }
  // If the normalized value is one of our known statuses, return it.
  if (Object.prototype.hasOwnProperty.call(CASE_STATUS, cleaned)) {
    return CASE_STATUS[cleaned];
  }

  // Support legacy values that might not match enum casing exactly.
  // (If cleaned isn't in CASE_STATUS, fall back to cleaned.)
  return cleaned;
}

// -----------------------------------------------------------------------------
// DB status helpers
//
// Historically, some routes/templates used lowercase or alternate strings.
// These helpers provide a single source of truth for:
// - converting DB/raw values -> canonical CASE_STATUS
// - providing DB WHERE-IN lists that match both canonical + legacy values
// -----------------------------------------------------------------------------

const DB_STATUS = Object.freeze({
  [CASE_STATUS.DRAFT]: CASE_STATUS.DRAFT,
  [CASE_STATUS.SUBMITTED]: CASE_STATUS.SUBMITTED,
  [CASE_STATUS.PAID]: CASE_STATUS.PAID,
  [CASE_STATUS.ASSIGNED]: CASE_STATUS.ASSIGNED,
  [CASE_STATUS.IN_REVIEW]: CASE_STATUS.IN_REVIEW,
  [CASE_STATUS.REJECTED_FILES]: CASE_STATUS.REJECTED_FILES,
  [CASE_STATUS.COMPLETED]: CASE_STATUS.COMPLETED,
  [CASE_STATUS.SLA_BREACH]: CASE_STATUS.SLA_BREACH,
  [CASE_STATUS.REASSIGNED]: CASE_STATUS.REASSIGNED,
  [CASE_STATUS.CANCELLED]: CASE_STATUS.CANCELLED
});

// Canonical -> list of DB values seen historically (for SQL WHERE IN)
const DB_STATUS_VARIANTS = Object.freeze({
  [CASE_STATUS.DRAFT]: [CASE_STATUS.DRAFT, 'draft', 'DRAFT'],
  [CASE_STATUS.SUBMITTED]: [CASE_STATUS.SUBMITTED, 'submitted', 'SUBMITTED', 'new', 'NEW', 'pending', 'PENDING'],
  [CASE_STATUS.PAID]: [CASE_STATUS.PAID, 'paid', 'PAID'],
  [CASE_STATUS.ASSIGNED]: [CASE_STATUS.ASSIGNED, 'assigned', 'ASSIGNED', 'accepted', 'ACCEPTED'],
  [CASE_STATUS.IN_REVIEW]: [CASE_STATUS.IN_REVIEW, 'in_review', 'IN_REVIEW', 'review', 'REVIEW', 'inreview', 'INREVIEW'],
  [CASE_STATUS.REJECTED_FILES]: [CASE_STATUS.REJECTED_FILES, 'rejected_files', 'REJECTED_FILES', 'files_requested', 'FILES_REQUESTED', 'file_requested', 'FILE_REQUESTED', 'more_info_needed', 'MORE_INFO_NEEDED'],
  [CASE_STATUS.COMPLETED]: [CASE_STATUS.COMPLETED, 'completed', 'COMPLETED', 'done', 'DONE', 'finished', 'FINISHED'],
  [CASE_STATUS.SLA_BREACH]: [CASE_STATUS.SLA_BREACH, 'sla_breach', 'SLA_BREACH', 'breached', 'BREACHED', 'breached_sla', 'BREACHED_SLA', 'sla_breached', 'SLA_BREACHED', 'delayed', 'DELAYED', 'overdue', 'OVERDUE'],
  [CASE_STATUS.REASSIGNED]: [CASE_STATUS.REASSIGNED, 'reassigned', 'REASSIGNED'],
  [CASE_STATUS.CANCELLED]: [CASE_STATUS.CANCELLED, 'cancelled', 'CANCELLED', 'canceled', 'CANCELED', 'cancel', 'CANCEL']
});

function toCanonStatus(dbValue) {
  return normalizeStatus(dbValue);
}

function toDbStatus(canonKey) {
  const k = normalizeStatus(canonKey);
  return DB_STATUS[k] || null;
}

function dbStatusValuesFor(canonKey) {
  const k = normalizeStatus(canonKey);
  return DB_STATUS_VARIANTS[k] || [k];
}

function isUnacceptedStatus(dbValue) {
  // "Unaccepted" in the doctor workflow means the case is assigned to a doctor
  // but not yet accepted/started (i.e., still in ASSIGNED state).
  return toCanonStatus(dbValue) === CASE_STATUS.ASSIGNED;
}

function calculateDeadline(paidAtIso, slaType) {
  const baseHours = SLA_HOURS[slaType] || SLA_HOURS.standard_72h;
  if (!paidAtIso) {
    throw new Error('Cannot calculate SLA deadline without paid_at');
  }
  const paidAt = new Date(paidAtIso);
  return new Date(paidAt.getTime() + baseHours * 60 * 60 * 1000).toISOString();
}

function logCaseEvent(caseId, eventType, payload = null) {
  try {
    const stmt = db.prepare(
      `INSERT INTO case_events (id, case_id, event_type, event_payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    const meta = payload ? JSON.stringify(payload) : null;
    stmt.run(randomUUID(), caseId, eventType, meta, nowIso());
  } catch (e) {
    // Optional table in some environments; do not crash core flows.
  }
}

function triggerNotification(caseId, type, payload) {
  logCaseEvent(caseId, `notification:${type}`, payload);
}

function getCase(caseIdOrParams) {
  const caseId =
    caseIdOrParams && typeof caseIdOrParams === 'object'
      ? (caseIdOrParams.caseId || caseIdOrParams.orderId || caseIdOrParams.id)
      : caseIdOrParams;

  if (!caseId) return null;
  return db.prepare(`SELECT * FROM ${CASE_TABLE} WHERE id = ?`).get(caseId);
}

function attachFileToCase(caseId, { filename, file_type, storage_path = null }) {
  try {
    db.prepare(
      `INSERT INTO case_files (id, case_id, filename, file_type, storage_path)
       VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID(), caseId, filename, file_type || 'unknown', storage_path);
    logCaseEvent(caseId, 'FILE_UPLOADED', { filename, file_type });
  } catch (e) {
    // Optional table in some environments; do not crash core flows.
  }
}
// -----------------------------------------------------------------------------
// HARD GUARD: prevent non-canonical statuses from ever being written to the DB
// -----------------------------------------------------------------------------

function assertCanonicalDbStatus(value) {
  const canon = normalizeStatus(value);
  // Reject empty/unknown statuses explicitly and self-document
  if (!canon) {
    throw new Error('Attempted to write empty/invalid case status to DB');
  }
  if (!Object.values(CASE_STATUS).includes(canon)) {
    throw new Error(
      `Attempted to write non-canonical case status to DB: "${value}"`
    );
  }
  return canon;
}
function updateCase(caseId, fields) {
  const updates = Object.keys(fields);
  if (!updates.length) return;

  // 🔒 Enforce canonical DB status and require caseId for status updates
  if (Object.prototype.hasOwnProperty.call(fields, 'status')) {
    if (!caseId) {
      throw new Error('Missing caseId for status update');
    }
    // Normalize and validate status, and force DB value to canonical string
    fields.status = assertCanonicalDbStatus(fields.status);
  }

  const sets = updates.map((column) => `${column} = ?`).join(', ');
  const stmt = db.prepare(`UPDATE ${CASE_TABLE} SET ${sets} WHERE id = ?`);
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
  assertPaidGate(existing, nextStatus);
  const currentStatus = normalizeStatus(existing.status);
  let desiredStatus = normalizeStatus(nextStatus);
  // Validate and canonicalize status before any further checks (fail fast)
  desiredStatus = assertCanonicalDbStatus(desiredStatus);
  // 🔒 HARD INVARIANT: PAID cases must always have SLA hours
  if (desiredStatus === CASE_STATUS.PAID) {
    const hasSla =
      Object.prototype.hasOwnProperty.call(data, 'sla_hours') &&
      Number(data.sla_hours) > 0;

    if (!hasSla) {
      throw new Error(
        'Invariant violation: cannot transition to PAID without sla_hours'
      );
    }
  }

  if (desiredStatus === CASE_STATUS.SLA_BREACH) {
    if (![CASE_STATUS.IN_REVIEW].includes(currentStatus)) {
      throw new Error('Only active review cases can escalate to SLA breach');
    }
  } else {
    assertTransition(currentStatus, desiredStatus);
  }

  const now = nowIso();

  // Ensure acceptance timestamp exists when entering IN_REVIEW.
  // SLA starts at acceptance (accepted_at), so we must never enter IN_REVIEW without it.
  if (desiredStatus === CASE_STATUS.IN_REVIEW) {
    const hasAcceptedField = Object.prototype.hasOwnProperty.call(data, 'accepted_at');
    if (!hasAcceptedField && !existing.accepted_at) {
      data.accepted_at = now;
    }
  }

  if (desiredStatus === CASE_STATUS.IN_REVIEW) {
    const hasDeadlineField = Object.prototype.hasOwnProperty.call(data, 'deadline_at');
    const currentDeadline = hasDeadlineField ? data.deadline_at : existing.deadline_at;

    // SLA starts at acceptance. Ensure deadline_at matches accepted_at + sla_hours.
    if (existing.sla_hours) {
      const acceptedAt =
        (Object.prototype.hasOwnProperty.call(data, 'accepted_at') && data.accepted_at) ||
        existing.accepted_at ||
        now;

      // SLA starts at acceptance. Deadline = accepted_at + sla_hours (hours).
      const acceptedMs = new Date(acceptedAt).getTime();
      const expectedDeadline = Number.isFinite(acceptedMs)
        ? new Date(acceptedMs + Number(existing.sla_hours) * 60 * 60 * 1000).toISOString()
        : null;
      if (!expectedDeadline) {
        throw new Error('Cannot compute deadline_at from accepted_at');
      }
      if (shouldUpdateDeadline(currentDeadline, expectedDeadline)) {
        data.deadline_at = expectedDeadline;
      }
    }
    // Close any open doctor_assignments rows once the case is accepted/in review.
    closeOpenDoctorAssignments(caseId);
  }

  const updates = {
    status: desiredStatus,
    updated_at: now,
    ...data
  };

  updateCase(caseId, updates);
  logCaseEvent(caseId, `status:${updates.status}`, { from: currentStatus });
  return getCase(caseId);
}
// ---------------------------------------------------------------------------
// Helper: isTerminalStatus -- returns true if status is terminal (completed/cancelled)
function isTerminalStatus(status) {
  const s = normalizeStatus(status);
  const ui = CASE_STATUS_UI[s];
  const meta = ui && ui.admin;
  return Boolean(meta && meta.terminal);
}

function createDraftCase({ language = 'en', urgency_flag = false, reason_for_review = '' }) {

  const caseId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ${CASE_TABLE}(id, status, language, urgency_flag, created_at, updated_at)
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
  try {
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    if (!result.payment_due_at) {
      updateCase(caseId, { payment_due_at: dueAt });
    }
  } catch (e) {}
  logCaseEvent(caseId, 'CASE_SUBMITTED');
  return result;
}

function markCasePaid(caseId, slaType = 'standard_72h') {
  const existing = getCase(caseId);
  if (!existing) throw new Error('Case not found');

  // Compute SLA hours using the real `orders` columns.
  const slaHours = SLA_HOURS[slaType] || SLA_HOURS.standard_72h;
  const paidAt = existing.paid_at || nowIso();
  // IMPORTANT: payment processor/webhook should set payment_status='paid'.
  // Here we only lock lifecycle fields and paid_at (if not already set).
  transitionCase(caseId, CASE_STATUS.PAID, {
    sla_hours: slaHours,
    paid_at: paidAt,
    // SLA starts at acceptance; do not carry a pre-accept deadline.
    deadline_at: null
  });

  // Cancel / invalidate any queued unpaid payment reminders once payment is confirmed
  try {
    db.prepare(
      `UPDATE notifications
       SET cancelled_at = COALESCE(cancelled_at, ?)
       WHERE template LIKE 'payment_reminder_%'
         AND json_extract(response, '$.case_id') = ?`
    ).run(nowIso(), caseId);
  } catch (e) {
    // best-effort; do not block payment flow
  }

  logCaseEvent(caseId, 'PAYMENT_CONFIRMED', { sla_type: slaType, sla_hours: slaHours });
  logCaseEvent(caseId, 'CASE_READY_FOR_ASSIGNMENT');
  triggerNotification(caseId, 'payment_confirmation', { sla_type: slaType, sla_hours: slaHours });

  // Best-effort: queue reminder notifications (deduped) for patient + doctor.
  // These will only send once the case has an active status + deadline.
  try {
    dispatchSlaReminders(caseId);
  } catch (e) {
    // do not block payment flow
  }

  return getCase(caseId);
}

function markSlaBreach(caseId) {
  const existing = getCase(caseId);
  if (!existing) throw new Error('Case not found');

  const currentStatus = normalizeStatus(existing.status);

  // SLA model: deadline is based on accepted_at. If accepted_at exists and the
  // acceptance-based deadline is not yet passed, do NOT breach.
  try {
    const expected = deadlineFromAcceptance(existing);
    if (expected) {
      const expectedMs = new Date(expected).getTime();
      if (Number.isFinite(expectedMs) && Date.now() < expectedMs) {
        return existing;
      }
    }
  } catch (e) {
    // best-effort; fall through to existing logic
  }

  // Do not breach unpaid or terminal cases
  if (!isPaymentConfirmed(existing)) {
    throw new Error('Cannot mark SLA breach on unpaid case');
  }
  if (isTerminalStatus(currentStatus)) {
    return existing;
  }

  // Idempotency: do not re-breach
  if (currentStatus === CASE_STATUS.SLA_BREACH) {
    return existing;
  }

  transitionCase(caseId, CASE_STATUS.SLA_BREACH, {
    breached_at: nowIso()
  });

    // 🔁 Auto-reassign on SLA breach
  const previousDoctorId = existing.doctor_id || null;
  const nextDoctorId = pickNextAvailableDoctor({ excludeDoctorId: previousDoctorId });

  if (nextDoctorId) {
    reassignCase(caseId, nextDoctorId, { reason: 'sla_breach_auto' });
    logCaseEvent(caseId, 'AUTO_REASSIGNED_ON_SLA_BREACH', {
      from: previousDoctorId,
      to: nextDoctorId
    });
  }

  logCaseEvent(caseId, 'SLA_BREACHED');

  // WhatsApp SLA breach alerts — dedupe-safe
  try {
    const { dispatchSlaBreach, sendSlaReminder } = require('./notify');

    // 1) Escalation to superadmin (single-fire via dedupe_key)
    dispatchSlaBreach(caseId);

    // 2) Notify assigned doctor (single-fire via dedupe_key)
    if (existing.doctor_id) {
      sendSlaReminder({
        order: { id: caseId, doctor_id: existing.doctor_id },
        level: 'breach'
      });
    }
  } catch (e) {
    // Notifications are best-effort; do not block lifecycle
  }

  return getCase(caseId);
}

function pauseSla(caseId, reason = 'rejected_files') {
  const existing = getCase(caseId);
  if (!existing) return existing;

  // Schema guard: some environments don't have pause columns yet.
  if (!HAS_SLA_PAUSED_AT_COLUMN || !HAS_SLA_REMAINING_SECONDS_COLUMN) {
    try {
      logCaseEvent(caseId, 'SLA_PAUSE_SKIPPED', { reason: 'columns_missing' });
    } catch (e) {}
    return existing;
  }

  if (existing.sla_paused_at) return existing;
  if (!existing.deadline_at) return existing;

  const now = new Date();
  const deadline = new Date(existing.deadline_at);
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
  if (!existing) return existing;

  // Schema guard: some environments don't have pause columns yet.
  if (!HAS_SLA_PAUSED_AT_COLUMN || !HAS_SLA_REMAINING_SECONDS_COLUMN) {
    try {
      logCaseEvent(caseId, 'SLA_RESUME_SKIPPED', { reason: 'columns_missing' });
    } catch (e) {}
    return existing;
  }

  if (!existing.sla_paused_at) return existing;

  const remaining = Number(existing.sla_remaining_seconds) || 0;
  const now = new Date();
  const deadline = new Date(now.getTime() + remaining * 1000).toISOString();

  updateCase(caseId, {
    deadline_at: deadline,
    sla_paused_at: null,
    sla_remaining_seconds: null,
    updated_at: now.toISOString()
  });

  logCaseEvent(caseId, 'SLA_RESUMED', { reason, remaining_seconds: remaining });
  return getCase(caseId);
}

function markOrderRejectedFiles(caseId, doctorId, reason = '', opts = {}) {
  // Backward/forward compatibility: allow calling with a single object payload
  // (e.g., markOrderRejectedFiles({ caseId, doctorId, reason, opts })).
  if (caseId && typeof caseId === 'object') {
    const payload = caseId;
    const extractedCaseId = payload.caseId || payload.orderId || payload.id;
    const extractedDoctorId = payload.doctorId || payload.requested_by || null;
    const extractedReason = typeof payload.reason === 'string' ? payload.reason : '';
    const extractedOpts = payload.opts || payload.options || {};

    caseId = extractedCaseId;
    doctorId = extractedDoctorId;
    reason = extractedReason;
    opts = extractedOpts;
  }

  opts = opts || {};

  const options = {
    requireAdminApproval: true,
    ...opts
  };

  const existing = getCase(caseId);
  if (!existing) {
    throw new Error('Case not found');
  }

  const currentStatus = normalizeStatus(existing.status);
  if (![CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW].includes(currentStatus)) {
    throw new Error(`Cannot request additional files in status ${currentStatus}`);
  }

  // Transition into REJECTED_FILES so the system understands the case is blocked waiting for files.
  // IMPORTANT: We only log an admin/superadmin approval-required event here. Patient notification happens AFTER approval.
  transitionCase(caseId, CASE_STATUS.REJECTED_FILES, {
    rejected_files_at: new Date().toISOString()
  });

  pauseSla(caseId, 'rejected_files');

  logCaseEvent(caseId, 'FILES_REQUESTED', {
    requested_by: doctorId || null,
    reason: reason || '',
    require_admin_approval: options.requireAdminApproval,
    approved: false
  });

  // Notify admins/superadmins only (no patient notification at this stage).
  triggerNotification(caseId, 'admin_files_request', {
    requested_by: doctorId || null,
    reason: reason || '',
    case_id: caseId
  });

  return getCase(caseId);
}


function getLatestAssignment(caseId) {
  try {
    return db
      .prepare(
        `SELECT *
         FROM doctor_assignments
         WHERE case_id = ?
         ORDER BY datetime(assigned_at) DESC
         LIMIT 1`
      )
      .get(caseId);
  } catch (e) {
    // doctor_assignments table may not exist
    return null;
  }
}

function closeOpenDoctorAssignments(caseId) {
  if (!caseId) return;
  try {
    const now = nowIso();
    db.prepare(
      `UPDATE doctor_assignments
       SET completed_at = COALESCE(completed_at, ?)
       WHERE case_id = ?
         AND completed_at IS NULL`
    ).run(now, caseId);
  } catch (e) {
    // doctor_assignments table may not exist in some environments
  }
}

function expireStaleAssignments() {
  try {
    const now = nowIso();
    const rows = db.prepare(
      `SELECT id, case_id, doctor_id
       FROM doctor_assignments
       WHERE completed_at IS NULL
         AND accept_by_at IS NOT NULL
         AND datetime(accept_by_at) < datetime(?)`
    ).all(now);

    for (const r of rows) {
      try {
        // finalize the expired assignment
        db.prepare(
          `UPDATE doctor_assignments
           SET completed_at = ?
           WHERE id = ?`
        ).run(now, r.id);

        logCaseEvent(r.case_id, 'DOCTOR_ACCEPT_TIMEOUT', {
          doctor_id: r.doctor_id
        });

        // auto-pick next available doctor
        const nextDoctorId = pickNextAvailableDoctor({
          excludeDoctorId: r.doctor_id
        });

        if (nextDoctorId) {
          reassignCase(r.case_id, nextDoctorId, {
            reason: 'accept_timeout'
          });
        }
      } catch (e) {
        // best-effort per row
      }
    }
  } catch (e) {
    // sweep failure should never crash app
  }
}

function pickNextAvailableDoctor({ excludeDoctorId = null } = {}) {
  try {
    const row = db.prepare(`
      SELECT u.id
      FROM users u
      LEFT JOIN orders o
        ON o.doctor_id = u.id
       AND LOWER(COALESCE(o.status,'')) IN ('assigned','in_review','rejected_files','sla_breach')
      WHERE u.role = 'doctor'
      ${excludeDoctorId ? 'AND u.id != ?' : ''}
      GROUP BY u.id
      HAVING COUNT(o.id) < 4
      ORDER BY RANDOM()
      LIMIT 1
    `).get(...(excludeDoctorId ? [excludeDoctorId] : []));
    return row ? row.id : null;
  } catch {
    return null;
  }
}

function finalizePreviousAssignment(caseId) {
  const existing = getLatestAssignment(caseId);
  if (!existing) return null;
  if (!existing.completed_at) {
    try {
      const now = nowIso();
      db.prepare(
        `UPDATE doctor_assignments
         SET completed_at = ?
         WHERE id = ?`
      ).run(now, existing.id);
    } catch (e) {
      // doctor_assignments table may not exist
    }
  }
  return existing;
}

function assignDoctor(caseId, doctorId, { replacedDoctorId = null } = {}) {
  const existing = getCase(caseId);
  if (!existing) {
    throw new Error('Case not found');
  }

  // HARD PAYMENT GATE: never allow assignment unless payment is confirmed.
  if (!isPaymentConfirmed(existing)) {
    throw new Error('Cannot assign doctor unless payment is confirmed');
  }

  const currentStatus = normalizeStatus(existing.status);
  // Allow assignment from PAID (first assignment) and from REASSIGNED (auto/manual reassignment flow).
  if (![CASE_STATUS.PAID, CASE_STATUS.REASSIGNED].includes(currentStatus)) {
    throw new Error(
      `Cannot assign doctor unless case is PAID or REASSIGNED (current: ${currentStatus})`
    );
  }

  finalizePreviousAssignment(caseId);
  const assignUpdates = { doctor_id: doctorId };
  if (HAS_ASSIGNED_AT_COLUMN) {
    assignUpdates.assigned_at = nowIso();
  }
  transitionCase(caseId, CASE_STATUS.ASSIGNED, assignUpdates);
  const now = nowIso();

  // Doctor must accept within N hours after assignment; keep this consistent with case_sla_worker.
  const DOCTOR_RESPONSE_TIMEOUT_HOURS = Number(process.env.DOCTOR_RESPONSE_TIMEOUT_HOURS || 24);
  const ACCEPT_WINDOW_MINUTES = Math.max(1, Math.floor(DOCTOR_RESPONSE_TIMEOUT_HOURS * 60));

  const acceptByAt = new Date(
    Date.now() + ACCEPT_WINDOW_MINUTES * 60 * 1000
  ).toISOString();
  try {
    db.prepare(
      `INSERT INTO doctor_assignments (
  id,
  case_id,
  doctor_id,
  assigned_at,
  accept_by_at,
  reassigned_from_doctor_id
)
VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      caseId,
      doctorId,
      now,
      acceptByAt,
      replacedDoctorId
    );
  } catch (e) {
    // doctor_assignments table may not exist
  }
  logCaseEvent(caseId, 'CASE_ASSIGNED', { doctorId, replacedDoctorId });
  return getCase(caseId);
}

function reassignCase(caseId, newDoctorId, { reason = 'auto' } = {}) {
  const existing = getCase(caseId);
  if (!existing) {
    throw new Error('Case not found');
  }
  const currentStatus = normalizeStatus(existing.status);
  if (![CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW, CASE_STATUS.SLA_BREACH, CASE_STATUS.REASSIGNED].includes(currentStatus)) {
    throw new Error(`Cannot reassign case in status ${currentStatus}`);
  }

  const previousAssignment = getLatestAssignment(caseId);
  // Close the current assignment window (if any) when we are reassigning.
  finalizePreviousAssignment(caseId);

  // If we are already in REASSIGNED, don't re-transition; just continue the flow.
  if (currentStatus !== CASE_STATUS.REASSIGNED) {
    transitionCase(caseId, CASE_STATUS.REASSIGNED);
  }
  logCaseEvent(caseId, 'CASE_REASSIGNED', {
    reason,
    from: previousAssignment ? previousAssignment.doctor_id : null,
    to: newDoctorId
  });
  if (!newDoctorId) {
    // No alternate doctor available: unassign so it leaves doctor dashboards and awaits admin action.
    try {
      updateCase(caseId, { doctor_id: null, updated_at: nowIso() });
    } catch (e) {}
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

function sweepExpiredDoctorAccepts() {
  // This function expires doctor assignments whose accept_by_at is in the past.
  // It finalizes the expired assignment, logs the timeout, and auto-reassigns if possible.
  try {
    const now = nowIso();
    const rows = db.prepare(
      `SELECT id, case_id, doctor_id
       FROM doctor_assignments
       WHERE completed_at IS NULL
         AND accept_by_at IS NOT NULL
         AND datetime(accept_by_at) < datetime(?)`
    ).all(now);

    let processed = 0;
    for (const r of rows) {
      try {
        // finalize the expired assignment
        db.prepare(
          `UPDATE doctor_assignments
           SET completed_at = ?
           WHERE id = ?`
        ).run(now, r.id);

        logCaseEvent(r.case_id, 'DOCTOR_ACCEPT_TIMEOUT', {
          doctor_id: r.doctor_id
        });

        // auto-pick next available doctor
        const nextDoctorId = pickNextAvailableDoctor({
          excludeDoctorId: r.doctor_id
        });

        if (nextDoctorId) {
          reassignCase(r.case_id, nextDoctorId, {
            reason: 'accept_timeout'
          });
        }
        processed++;
      } catch (e) {
        // best-effort per row
      }
    }
    return { ok: true, processed };
  } catch (e) {
    // sweep failure should never crash app
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  sweepExpiredDoctorAccepts,
  pickNextAvailableDoctor,
  transitionCase,
  CASE_STATUS,
  CANON_STATUS: CASE_STATUS,
  SLA_HOURS,
  STATUS_TRANSITIONS,
  CASE_STATUS_UI,
  getStatusUi,
  isVisibleToPatient,
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
  resumeSla,
  markOrderRejectedFiles,
  dispatchSlaReminders,
  runSlaReminderSweep,
  dispatchUnpaidCaseReminders,
  DB_STATUS,
  toCanonStatus,
  toDbStatus,
  dbStatusValuesFor,
  isUnacceptedStatus,
  isTerminalStatus,
  expireStaleAssignments
};
