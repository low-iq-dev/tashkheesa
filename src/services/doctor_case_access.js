'use strict';

/**
 * Tashkheesa — how much of a case a doctor may see, before and after they accept.
 *
 * A4 (FIX PLAN 2026-09-15) — pre-acceptance data exposure.
 *
 * Before this module the doctor case page decided access from a STATUS BUCKET:
 * "is this case in a state some doctor could act on?". That question says
 * nothing about THIS doctor, so holding a case id was enough. Any of the
 * platform's doctors could open the pre-accept brief of any unassigned case —
 * in any specialty, paid or not, whatever state their own account was in — and
 * read the patient's referring question, medical history and current
 * medications. The repo's own comment at the bucket said so.
 *
 * Three levels, and the rule that picks between them:
 *
 *   FULL   — this doctor has ACCEPTED the case (or delivered it). Unchanged by
 *            this module: everything they could see before, they still see.
 *   OFFER  — the case is on offer to this doctor and they may take it. They get
 *            enough to decide and nothing the patient owns.
 *   DENIED — everything else, including every case whose status nobody has
 *            taught this code about.
 *
 * Entitlement to an OFFER is decided from the case and the doctor, never from
 * possession of the id, and all three conjuncts must hold:
 *
 *   1. the case is PAID (payment_status paid or captured);
 *   2. it is assigned to this doctor, or unassigned and open to their
 *      specialty;
 *   3. the doctor is eligible to take a new case.
 *
 * Neither half of "eligible" is redefined here:
 *
 *   * the ACCOUNT half is doctor_eligibility.doctorNewCaseBlockReason — the
 *     rule the launch-gates work established for the pool accept and the
 *     operator hand-pick. This module never reads an account flag itself, so
 *     there is exactly one answer to "may this doctor take a new case" and it
 *     cannot drift;
 *   * the SPECIALTY half mirrors routes/doctor.js specialtyMatchSql, the
 *     fail-closed predicate the four unassigned-pool queries already use: a
 *     blank specialty on EITHER side is FALSE, never a wildcard. A missing
 *     specialty is an unanswered question, not a match.
 *
 * Why acceptance and not `orders.doctor_id === me`, which is what four separate
 * surfaces used: case_lifecycle.assignDoctor writes orders.doctor_id at
 * ASSIGNMENT time, i.e. when the case is OFFERED. So `doctor_id === me` was
 * already true for a doctor who was still deciding whether to take the case,
 * and every surface that trusted it — the intelligence view, the
 * /api/cases/:id/intelligence JSON, the patient-records JSON and the prescribe
 * page — handed the patient's name, the AI extractions and the shared record
 * history to a doctor who had not accepted anything.
 *
 * A pause, a deactivation or a pending approval NEVER takes back a case the
 * doctor has already accepted: level FULL is decided before the account rule is
 * consulted at all, so a paused doctor still finishes the cases they hold
 * (services/login_gate.js makes the same promise at sign-in).
 */

const { doctorNewCaseBlockReason } = require('./doctor_eligibility');

// The canonical status buckets. routes/doctor.js re-exports these under its own
// ACCEPTED_STATUSES / UNACCEPTED_STATUSES names so the buckets and the access
// rule cannot disagree about what "accepted" means.
//
// UNACCEPTED: the doctor can still accept (INCLUDING assigned-to-them-but-not-
// yet-accepted — acceptance is when accepted_at is set).
// ACCEPTED: the doctor has accepted and the case is actively being worked.
//
// Theme 7 sub-issue D (2026-05-10): 'awaiting_files' is a transitional
// fallback. Migration 047 converts existing rows to 'REJECTED_FILES'; new code
// never writes the legacy value.
const CASE_ACCEPTED_STATUSES = Object.freeze([
  'in_review',
  'review',
  'awaiting_files',
  'rejected_files',
  'breached',
  'sla_breach'
]);

// Legacy/backward-compat: some flows may have written payment state into
// `orders.status` (e.g. 'PAID').
const CASE_UNACCEPTED_STATUSES = Object.freeze(['new', 'submitted', 'paid', 'assigned', 'accepted']);

const CASE_COMPLETED_STATUS = 'completed';

const CASE_ACCESS = Object.freeze({
  FULL: 'full',
  OFFER: 'offer',
  DENIED: 'denied'
});

// Refusal codes the doctor case page already knows how to render. This module
// never invents a new refusal — the fix plan says do not widen it.
const CASE_DENY_REASON = Object.freeze({
  NOT_AVAILABLE: 'case_not_available',
  ASSIGNED_TO_OTHER: 'assigned_to_other_doctor'
});

/**
 * Everything an unaccepted doctor may see on the case itself.
 *
 * Chosen from the fix plan's wording: enough to decide whether to take a
 * 48-hour clinical commitment, with no patient identity, no AI extractions and
 * no history. These are the facts a worklist has always shown at triage — what
 * the case is, which specialty and service, how urgent and by when, who the
 * patient is CLINICALLY (age and sex, which are scheduling facts, not identity)
 * and in what language the report is due.
 *
 * Deliberately NOT here: the patient's name, date of birth and contact details;
 * the referring question, medical history and current medications; the file
 * names and their urls; the AI image checks and the extracted lab values.
 */
const PRE_ACCEPT_ORDER_FIELDS = Object.freeze([
  'id',
  'status',
  'payment_status',
  'specialty_name',
  'specialty_name_ar',
  'service_name',
  'urgency_tier',
  'sla_hours',
  'patient_age',
  'patient_gender',
  'report_language',
  'created_at_human'
]);

/**
 * Columns stripped from any orders row handed to a doctor who has not accepted
 * it — the pre-accept LIST payloads as well as the case page. The lists spread
 * `SELECT o.*` into each row, so the queue and dashboard payloads carried the
 * patient's question, history and medications for every unaccepted case even
 * though no template printed them. A field withheld in a template is one edit
 * from being rendered; a field that is not in the payload is not.
 */
const WITHHELD_UNTIL_ACCEPT = Object.freeze([
  // the patient's own words
  'clinical_question', 'primary_concern', 'concern',
  'medical_history', 'history',
  'current_medications', 'medications',
  'notes',
  // The patient's identity. patient_email and patient_phone are join aliases
  // rather than orders columns — prescriptions and the video appointments
  // board both select them — and they are named here so that a row carrying
  // them is stripped wherever it passes through this module.
  'patient_name', 'patient_date_of_birth', 'date_of_birth',
  'patient_email', 'patient_phone',
  // anything a clinician has already written on the case
  'diagnosis_text', 'impression_text', 'recommendation_text',
  'diagnosis', 'impression', 'recommendations',
  // Links to the case's own artefacts. A pre-accept row must not carry a way
  // to REACH the patient's files or a finished report: redactPreAcceptFiles
  // strips the per-file urls, and these columns are the same thing under
  // another name. Found by listing the live orders columns (2026-09-16)
  // rather than by reading the payload — the case page builds a WHITELIST and
  // is safe either way, but the list payloads spread `SELECT o.*` and redact
  // by this blacklist, so a column nobody remembered to name still shipped.
  'case_files_url', 'report_url',
  // Operator free text about this case, which routinely names the patient.
  'reassignment_reason'
]);

/**
 * The keep-list for a pre-accept LIST row, and the reason this module no
 * longer decides by naming what to drop.
 *
 * Fix round 1 (spec review I3). Naming the columns to REMOVE is only ever as
 * good as the last person who remembered to extend the list at migration
 * time: the next migration that adds a free-text clinical column ships it to
 * every unaccepted doctor by default, and nobody finds out. This list inverts
 * that. A column that is not named here does not reach a pre-accept payload,
 * so a new column is withheld until somebody classifies it deliberately.
 *
 * It is the live `orders` columns as of 2026-09-16 — listed via the Supabase
 * MCP against information_schema, SELECT-only — minus WITHHELD_UNTIL_ACCEPT,
 * plus the join aliases and computed keys the four list queries and
 * enrichOrders actually produce. Everything that exists today therefore
 * survives exactly as before: this closes tomorrow's leak without changing
 * what any doctor screen renders now.
 *
 * The pricing columns are kept here and stripped downstream by
 * routes/doctor.js stripPricingFields, which is the single definition of
 * "doctors must not see pricing"; this list is about the PATIENT's data, and
 * two rules for one column is how they drift apart.
 */
const PRE_ACCEPT_LIST_FIELDS = Object.freeze([
  // identity and routing
  'id', 'patient_id', 'doctor_id', 'specialty_id', 'service_id', 'reference_id',
  'assignment_status', 'reassigned_to_doctor_id', 'reassigned_at', 'reassigned_count',
  // what the case is, and how urgent
  'status', 'language', 'urgency_flag', 'urgency_tier', 'tier', 'test_type', 'source', 'country',
  'sla_hours', 'sla_deadline', 'sla_24hr_selected', 'sla_24hr_price', 'sla_24hr_deadline',
  'acceptance_deadline_at', 'deadline_at', 'breached_at', 'sla_paused_at', 'sla_remaining_seconds',
  'pre_breach_notified', 'sla_reminder_sent', 'no_sla_refund_eligibility',
  // timestamps
  'created_at', 'updated_at', 'accepted_at', 'completed_at', 'paid_at', 'deleted_at', 'draft_step',
  // payment state — the doctor UI gates on it
  'payment_status', 'payment_method', 'payment_reference', 'payment_link',
  'paymob_intention_id', 'paymob_transaction_id', 'hmac_verified_at',
  // add-ons and files
  'uploads_locked', 'additional_files_requested', 'addons_json',
  'video_consultation_selected', 'video_consultation_price',
  'intelligence_status', 'broadcast_sent_at', 'broadcast_count',
  // pricing — stripped downstream by stripPricingFields, not here
  'price', 'doctor_fee', 'base_price', 'currency', 'total_price_with_addons',
  'referral_code', 'referral_discount', 'urgency_uplift_amount',
  'display_price', 'display_currency', 'locked_price', 'locked_currency', 'price_snapshot_json',
  // join aliases and computed keys the list payloads add on top of `o.*`
  'specialty_name', 'specialty_name_ar', 'service_name', 'doctor_name',
  'patient_age', 'patient_gender', 'report_language', 'created_at_human',
  'db_status', 'effectiveStatus', 'sla'
]);

/**
 * The patient's identity on a row that is NOT an orders row — an appointment
 * joined to the patient user, an analytics row, a prescription form. Those
 * surfaces need one question answered ("has this doctor accepted the case?")
 * and one thing removed; they do not want the orders keep-list applied to a
 * shape that is not an orders row.
 */
const PATIENT_IDENTITY_FIELDS = Object.freeze([
  'patient_name', 'patient_email', 'patient_phone',
  'patient_date_of_birth', 'patient_dob', 'date_of_birth',
  'name', 'email', 'phone'
]);

const WITHHELD_SET = new Set(WITHHELD_UNTIL_ACCEPT);
const PRE_ACCEPT_LIST_SET = new Set(PRE_ACCEPT_LIST_FIELDS);

function normId(value) {
  return value == null ? '' : String(value).trim();
}

function lower(value) {
  return String(value == null ? '' : value).toLowerCase();
}

/**
 * The JS form of routes/doctor.js specialtyMatchSql. A blank specialty on
 * EITHER side is FALSE: the case has no specialty to match, or the doctor has
 * none to match it with. Never a wildcard in either direction.
 */
function specialtyMatches(caseSpecialtyId, doctorSpecialtyId) {
  const caseSpec = normId(caseSpecialtyId);
  const doctorSpec = normId(doctorSpecialtyId);
  if (!caseSpec || !doctorSpec) return false;
  return caseSpec === doctorSpec;
}

/** The payment gate, in the one spelling the doctor routes already use. */
function isPaidForReview(order) {
  const status = lower(order && order.payment_status);
  return status === 'paid' || status === 'captured';
}

/**
 * Has THIS doctor accepted this case? The question every surface that renders
 * patient identity or AI extractions must ask, instead of "is doctor_id me",
 * which is true from assignment onward.
 */
function doctorHasAcceptedCase(order, doctorId) {
  if (!order) return false;
  const assigned = normId(order.doctor_id);
  const me = normId(doctorId);
  if (!assigned || !me || assigned !== me) return false;
  const status = lower(order.status);
  return CASE_ACCEPTED_STATUSES.indexOf(status) !== -1 || status === CASE_COMPLETED_STATUS;
}

/**
 * @param {object}      args.order      the orders row (status, payment_status, doctor_id, specialty_id)
 * @param {string}      args.doctorId   the requesting doctor
 * @param {object|null} args.doctorRow  the LIVE users row (specialty_id + the account flags).
 *                                      null — an unreadable or missing account — denies.
 * @returns {{level: string, reason: string|null, blockReason: string|null}}
 */
function doctorCaseAccess(args) {
  const opts = args || {};
  const order = opts.order;
  const doctorId = opts.doctorId;
  const doctorRow = opts.doctorRow;

  const deny = (reason, blockReason) => ({
    level: CASE_ACCESS.DENIED,
    reason: reason || CASE_DENY_REASON.NOT_AVAILABLE,
    blockReason: blockReason || null
  });

  if (!order) return deny(CASE_DENY_REASON.NOT_AVAILABLE);
  const me = normId(doctorId);
  if (!me) return deny(CASE_DENY_REASON.NOT_AVAILABLE);
  const assigned = normId(order.doctor_id);

  // 1. Already theirs. Decided FIRST and without the account rule, so no later
  //    pause or deactivation can strand a case the doctor is mid-way through.
  if (doctorHasAcceptedCase(order, me)) {
    return { level: CASE_ACCESS.FULL, reason: null, blockReason: null };
  }

  // 2. Somebody else holds it.
  if (assigned && assigned !== me) return deny(CASE_DENY_REASON.ASSIGNED_TO_OTHER);

  // 3. A status that is neither "on offer" nor "accepted" is nobody's to read —
  //    an abandoned case, a refunded one, or a status a future migration adds.
  if (CASE_UNACCEPTED_STATUSES.indexOf(lower(order.status)) === -1) {
    return deny(CASE_DENY_REASON.NOT_AVAILABLE);
  }

  // 4. Paid. An unpaid case is not work anyone has been asked to do.
  if (!isPaidForReview(order)) return deny(CASE_DENY_REASON.NOT_AVAILABLE);

  // 5. Offered to them: assigned to this doctor, or in the open pool for their
  //    specialty. A cross-specialty case ASSIGNED to them is a deliberate human
  //    routing decision and stays visible — the same scope the accept handler's
  //    specialty guardrail already draws.
  const offered = (assigned && assigned === me) ||
    (!assigned && specialtyMatches(order.specialty_id, doctorRow && doctorRow.specialty_id));
  if (!offered) return deny(CASE_DENY_REASON.NOT_AVAILABLE);

  // 6. Eligible to take it — the launch-gates rule, reused whole.
  const blockReason = doctorNewCaseBlockReason(doctorRow);
  if (blockReason) return deny(CASE_DENY_REASON.NOT_AVAILABLE, blockReason);

  return { level: CASE_ACCESS.OFFER, reason: null, blockReason: null };
}

/**
 * Strip everything the patient owns from an orders row bound for a pre-accept
 * payload — by SELECTING what may be kept, never by naming what to drop. A
 * column this module has never classified is withheld, which is what makes
 * the next migration safe by default rather than safe by memory.
 */
function redactPreAcceptOrderRow(order) {
  if (!order || typeof order !== 'object') return order;
  const clone = {};
  const keys = Object.keys(order);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (WITHHELD_SET.has(key)) continue;
    if (!PRE_ACCEPT_LIST_SET.has(key)) continue;
    clone[key] = order[key];
  }
  return clone;
}

/**
 * Remove the patient's identity from a row that is not an orders row: an
 * appointment joined to the patient user, an analytics row, a form payload.
 * The keys are DELETED rather than blanked — a field that is absent from the
 * payload cannot be printed by a template edit later.
 */
function redactPatientIdentity(row) {
  if (!row || typeof row !== 'object') return row;
  const clone = Object.assign({}, row);
  for (let i = 0; i < PATIENT_IDENTITY_FIELDS.length; i++) delete clone[PATIENT_IDENTITY_FIELDS[i]];
  return clone;
}

/**
 * The file extension, by the same rule the case view uses to draw its "2 × JPG"
 * inventory chips: established BEFORE any truncation, and only accepted when it
 * looks like an extension. Anything else has no kind at all — printing the
 * first four characters of a name is exactly how "Ahmed Hassan MRI" became
 * "AHME" on the one screen whose purpose is withholding the patient's identity.
 */
function preAcceptFileKind(name) {
  const raw = String(name == null ? '' : name);
  const dot = raw.lastIndexOf('.');
  const ext = (dot > 0 && dot < raw.length - 1) ? raw.slice(dot + 1) : '';
  return /^[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toLowerCase() : '';
}

/**
 * The pre-accept file inventory: how many files are waiting and of what kind,
 * and not one filename or url. Scans are routinely named after the patient, so
 * listing them would undo the identity gate the offer screen exists to enforce.
 * The count and the kind are what the doctor needs to judge the work.
 */
function redactPreAcceptFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map(function (file, index) {
    const kind = preAcceptFileKind(file && file.name);
    return {
      id: (file && file.id != null) ? file.id : ('pre-accept-' + index),
      name: kind ? ('file.' + kind) : 'file'
    };
  });
}

module.exports = {
  CASE_ACCEPTED_STATUSES,
  CASE_UNACCEPTED_STATUSES,
  CASE_COMPLETED_STATUS,
  CASE_ACCESS,
  CASE_DENY_REASON,
  PRE_ACCEPT_ORDER_FIELDS,
  PRE_ACCEPT_LIST_FIELDS,
  PATIENT_IDENTITY_FIELDS,
  WITHHELD_UNTIL_ACCEPT,
  specialtyMatches,
  isPaidForReview,
  doctorHasAcceptedCase,
  doctorCaseAccess,
  redactPreAcceptOrderRow,
  redactPatientIdentity,
  redactPreAcceptFiles
};
