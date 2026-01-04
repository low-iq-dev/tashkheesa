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
  [CASE_STATUS.SUBMITTED]: [CASE_STATUS.PAID, CASE_STATUS.ASSIGNED],
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

function getCase(caseIdOrParams) {
  const caseId =
    caseIdOrParams && typeof caseIdOrParams === 'object'
      ? (caseIdOrParams.caseId || caseIdOrParams.orderId || caseIdOrParams.id)
      : caseIdOrParams;

  if (!caseId) return null;
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
  DB_STATUS,
  toCanonStatus,
  toDbStatus,
  dbStatusValuesFor,
  isUnacceptedStatus
};
