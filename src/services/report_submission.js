/**
 * Report submission — the service behind POST /portal/doctor/case/:id/report.
 *
 * BATCH B (fix plan 2026-09-15, B4). The web handler
 * (handlePortalDoctorGenerateReport) was 390 lines that were neither
 * idempotent (a double submit wrote the records twice and re-notified the
 * patient) nor atomic (it could mark a case completed while a sibling write
 * failed), with its two money sites split across routes/doctor.js. This file
 * is the one submission path; the web route validates, calls, and renders.
 * The doctor app's Phase-1 POST /api/v1/doctor/cases/:id/submit calls the
 * same function — no req, no res, no rendering in here.
 *
 * The report is exactly three fields: findings (diagnosis), impression,
 * recommendations. Nothing else is required of the doctor; everything else
 * written here (PDF, exports row, events, earnings settle) derives from them.
 *
 * Shape of a submission:
 *
 *   1. Load + authorise (the assigned doctor only). An already-completed
 *      case returns { ok: true, alreadyCompleted: true } with NO side
 *      effects — the idempotent result a retry or double-click gets.
 *   2. Resolve the three fields, falling back to the stored draft
 *      (buildReportDraftFields), and persist them draft-shaped BEFORE
 *      anything that can fail — a doctor must never lose a written report
 *      to an R2 outage (AUDIT-2026-08-22 L4).
 *   3. Refuse an empty report (findings + impression are the clinically
 *      load-bearing sections; recommendations may legitimately be empty —
 *      AUDIT-2026-08-22 L2).
 *   4. Render the PDF to R2. On failure the case is still open and the text
 *      is saved; the doctor retries.
 *   5. Best-effort IN_REVIEW bookkeeping transition (AUDIT-P1-4).
 *   6. ONE TRANSACTION — the atomic core. A conditional completion UPDATE
 *      (`… WHERE id = $1 AND status <> completed` — losing a concurrent race
 *      means rowCount 0, and the loser walks away with alreadyCompleted and
 *      writes nothing else), then the report_exports row, the
 *      doctor_assignments close, the order_events completion event, and
 *      settleCaseEarningsOnCompletion on the SAME client. Either the report,
 *      the status change and the earnings settle all land, or none do.
 *      That conditional flip IS the idempotency key: whichever submission
 *      wins it owns every irreversible side effect, exactly once.
 *   7. Post-commit, best-effort: the CASE_COMPLETED case event, the
 *      medical-records copy, the prescription add-on settlement (its own
 *      idempotency via the addon_earnings unique index), and the patient
 *      notification — reached only by the winning submission, so the
 *      patient is notified exactly once.
 */

'use strict';

const { queryOne, queryAll, execute, withTransaction } = require('../pg');
const { logErrorToDb } = require('../logger');
const { logOrderEvent } = require('../audit');

// ── Schema probes ──────────────────────────────────────────────────────────
// (Moved verbatim from routes/doctor.js — the route imports them back, so
// there is exactly one copy.)

let _ordersColumnCache = null;
// AUDIT-2026-08-22 (L5): never cache a failed (or empty) probe — a cached []
// once let a case be marked COMPLETED with no report text and no report_url
// written at all. table_schema pinned like every migration guard.
async function getOrdersColumns() {
  if (_ordersColumnCache) return _ordersColumnCache;
  try {
    const cols = await queryAll(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders'"
    );
    const names = Array.isArray(cols) ? cols.map((c) => c.name) : [];
    if (!names.length) return [];
    _ordersColumnCache = names;
  } catch (e) {
    // THEME8-LINT-EXEMPT-HELPER: the probe failing means the DB is
    // unreachable, so an error_logs INSERT would fail too. Not cached, so the
    // next request re-probes.
    console.error('[schema-probe] orders column probe failed — NOT cached:', e && e.message ? e.message : e);
    return [];
  }
  return _ordersColumnCache;
}

async function pickFirstExistingOrderColumn(candidates) {
  const cols = await getOrdersColumns();
  for (const name of candidates) {
    if (cols.includes(name)) return name;
  }
  return null;
}

async function getDiagnosisColumnName() {
  // Keep this list tight to avoid SQL injection risk.
  return await pickFirstExistingOrderColumn([
    'diagnosis_text',
    'doctor_diagnosis',
    'diagnosis',
    'medical_opinion',
    'opinion_text'
  ]);
}

// `orders.impression_text` / `orders.recommendation_text` are the real
// columns (migration 001, re-asserted by 002) and what every reader uses.
// Legacy names kept as trailing fallbacks.
async function getImpressionColumnName() {
  return await pickFirstExistingOrderColumn([
    'impression_text',
    'impression',
    'doctor_impression'
  ]);
}

async function getRecommendationsColumnName() {
  return await pickFirstExistingOrderColumn([
    'recommendation_text',
    'recommendations',
    'doctor_recommendations'
  ]);
}

async function getReportUrlColumnName() {
  // Keep allow-list tight.
  return await pickFirstExistingOrderColumn([
    'report_url',
    'final_report_url',
    'final_report_link',
    'report_pdf_url'
  ]);
}

// AUDIT-2026-08-22 (L5) — a case must never be completed on an unresolved
// schema probe. Throwing keeps the doctor's text and lets them retry.
class ReportSchemaUnresolvedError extends Error {
  constructor(detail) {
    super('report columns could not be resolved: ' + detail);
    this.name = 'ReportSchemaUnresolvedError';
    this.code = 'REPORT_SCHEMA_UNRESOLVED';
  }
}

// ── Text helpers ───────────────────────────────────────────────────────────

// Findings / Impression / Recommendations are three separate report sections.
// When the dedicated columns exist, the diagnosis column holds findings ONLY;
// the combined blob survives purely as a fallback for schema snapshots
// without those columns.
function buildCombinedReportText(findings, impression, recommendations) {
  return [
    findings ? 'Findings:\n' + findings : '',
    impression ? 'Impression:\n' + impression : '',
    recommendations ? 'Recommendations:\n' + recommendations : ''
  ].filter(Boolean).join('\n\n');
}

function readDiagnosisFromOrder(order) {
  if (!order) return '';
  return (
    order.diagnosis_text ||
    order.doctor_diagnosis ||
    order.diagnosis ||
    order.medical_opinion ||
    order.opinion_text ||
    ''
  );
}

function parseCombinedNotesToFields(text) {
  const raw = (text || '').toString();
  const out = { findings: '', impression: '', recommendations: '' };
  if (!raw.trim()) return out;

  const s = raw.replace(/\r\n/g, '\n');

  const mFindings = s.match(/(?:^|\n)Findings:\n([\s\S]*?)(?=(?:\n\nImpression:\n|\n\nRecommendations:\n|$))/i);
  const mImpression = s.match(/(?:^|\n)Impression:\n([\s\S]*?)(?=(?:\n\nRecommendations:\n|$))/i);
  const mRecs = s.match(/(?:^|\n)Recommendations:\n([\s\S]*?)$/i);

  if (mFindings && mFindings[1]) out.findings = String(mFindings[1]).trim();
  if (mImpression && mImpression[1]) out.impression = String(mImpression[1]).trim();
  if (mRecs && mRecs[1]) out.recommendations = String(mRecs[1]).trim();

  // Fallback: if headings are missing, keep everything as findings.
  if (!out.findings && !out.impression && !out.recommendations) {
    out.findings = s.trim();
  }

  return out;
}

// Rehydrate the three report-editor boxes from the order row. Drafts saved
// before the impression/recommendation columns were wired up stored all three
// sections as one headed blob in diagnosis_text; split those back out. Only
// applied when BOTH dedicated columns are empty, so a doctor who legitimately
// types the word "Impression:" into findings is never re-parsed.
function buildReportDraftFields(order) {
  const impression = String((order && (order.impression_text || order.impression)) || '').trim();
  const recommendations = String(
    (order && (order.recommendation_text || order.recommendations || order.recommendation)) || ''
  ).trim();
  const diagnosis = String(readDiagnosisFromOrder(order) || '');

  if (!impression && !recommendations && /(^|\n)(Findings|Impression|Recommendations):\n/i.test(diagnosis)) {
    return parseCombinedNotesToFields(diagnosis);
  }

  return { findings: diagnosis.trim(), impression, recommendations };
}

// AUDIT-2026-08-22 (L2) — what "empty" means for a report section: nothing
// but whitespace, dashes and the em-dash placeholder the PDF itself prints.
function isReportSectionEmpty(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return true;
  return !t.replace(/[\s\-—–_.·•*]+/g, '');
}

// ── Demographics helpers (the PDF header) ──────────────────────────────────

// users.date_of_birth is TEXT; anything unparseable, future or absurd yields
// null and the header simply omits the age rather than printing "NaN".
function computeAgeFromDob(dob) {
  const raw = String(dob || '').trim();
  if (!raw) return null;
  const born = new Date(raw);
  if (isNaN(born.getTime())) return null;

  const now = new Date();
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - born.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < born.getUTCDate())) age -= 1;

  if (!Number.isFinite(age) || age < 0 || age > 120) return null;
  return age;
}

// users.gender is free text: map the values the product writes and pass
// anything else through; the em-dash is reserved for genuinely unknown.
function reportGenderLabel(raw) {
  const g = String(raw == null ? '' : raw).trim();
  if (!g) return '';
  const k = g.toLowerCase();
  if (k === 'male' || k === 'm') return 'Male';
  if (k === 'female' || k === 'f') return 'Female';
  if (k === 'other') return 'Other';
  if (k === 'prefer_not_to_say' || k === 'unspecified') return 'Not specified';
  return g;
}

function normalizeStatus(status) {
  return String(status || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

// Fix round 2026-09-21 (adversarial m-4): the completion flip's WHERE clause
// is THE idempotency key, so it must speak the whole status vocabulary, not
// just the literal 'completed'. These lists mirror
// case_lifecycle.DB_STATUS_VARIANTS: production has historically stored
// 'done'/'finished' for COMPLETED, and a terminal cancelled/refunded/expired
// case must not be completable from a stale doctor tab (the pre-Batch-B
// handler allowed exactly that).
const COMPLETED_DB_STATUSES = ['completed', 'done', 'finished'];
const CLOSED_DB_STATUSES = ['cancelled', 'canceled', 'cancel', 'refunded', 'expired_unpaid', 'expired'];
const NOT_SUBMITTABLE_DB_STATUSES = COMPLETED_DB_STATUSES.concat(CLOSED_DB_STATUSES);
const NOT_SUBMITTABLE_SQL_LIST = NOT_SUBMITTABLE_DB_STATUSES.map((s) => `'${s}'`).join(', ');

// ── The draft-shaped text write ────────────────────────────────────────────

// AUDIT-2026-08-22 (L4) — persist the doctor's written report BEFORE anything
// that can fail. A plain draft-shaped UPDATE: never touches `status`, so if a
// later step fails the case is still open, the editor still renders the text,
// and Submit is retryable.
//
// Fix round 2026-09-21 (adversarial m-5): guarded against terminal statuses.
// Without the guard, the LOSER of a double-submit race — or a stale tab
// holding older text — still overwrote the report columns on the
// now-COMPLETED order, so the patient's on-site report showed the stale text
// while the PDF held the winner's. Returns the affected row count; 0 means
// the case is no longer open and the caller must not proceed.
async function persistReportText({ orderId, diagnosisText, impressionText, recommendationsText }) {
  const diagnosisCol = await getDiagnosisColumnName();
  const impressionCol = await getImpressionColumnName();
  const recsCol = await getRecommendationsColumnName();

  if (!diagnosisCol) {
    throw new ReportSchemaUnresolvedError('no diagnosis column on orders');
  }

  const nowIso = new Date().toISOString();
  const orderCols = await getOrdersColumns();

  // Mirrors the draft-save path: findings own the diagnosis column when the
  // other two sections have columns of their own, otherwise the combined blob
  // is the only way not to drop them.
  const diagnosisValue = (impressionCol && recsCol)
    ? diagnosisText
    : buildCombinedReportText(
        String(diagnosisText || '').trim(),
        String(impressionText || '').trim(),
        String(recommendationsText || '').trim()
      );

  const sets = [];
  const params = [];
  let idx = 1;

  sets.push(`${diagnosisCol} = $${idx++}`);
  params.push(diagnosisValue || null);

  if (impressionCol) {
    sets.push(`${impressionCol} = $${idx++}`);
    params.push(impressionText || null);
  }
  if (recsCol) {
    sets.push(`${recsCol} = $${idx++}`);
    params.push(recommendationsText || null);
  }
  if (orderCols.includes('updated_at')) {
    sets.push(`updated_at = $${idx++}`);
    params.push(nowIso);
  }

  params.push(orderId);
  const res = await execute(
    `UPDATE orders SET ${sets.join(', ')}
      WHERE id = $${idx}
        AND LOWER(COALESCE(status, '')) NOT IN (${NOT_SUBMITTABLE_SQL_LIST})`,
    params
  );
  return (res && res.rowCount) || 0;
}

// ── The atomic completion write (inside submitDoctorReport's transaction) ──

// Builds and runs the CONDITIONAL completion UPDATE. Returns the completed
// row id, or null when a concurrent submission already completed the case —
// the caller must then write nothing else.
async function completeOrderInTxn(client, {
  orderId,
  doctorId,
  reportUrl,
  diagnosisText,
  impressionText,
  recommendationsText,
  completedStatusValue
}) {
  const nowIso = new Date().toISOString();
  const diagnosisCol = await getDiagnosisColumnName();
  const reportCol = await getReportUrlColumnName();

  // AUDIT-2026-08-22 (L5): refuse to complete a case whose report columns the
  // probe could not resolve — checked before a single write.
  const orderCols = await getOrdersColumns();
  if (!orderCols.length || !diagnosisCol || !reportCol) {
    throw new ReportSchemaUnresolvedError(
      `orders columns=${orderCols.length}, diagnosis=${diagnosisCol || 'none'}, report_url=${reportCol || 'none'}`
    );
  }
  const impressionCol = await getImpressionColumnName();
  const recsCol = await getRecommendationsColumnName();

  let paramIdx = 1;
  const sets = [];
  const params = [];

  const diagnosisValue = (impressionCol && recsCol)
    ? diagnosisText
    : buildCombinedReportText(
        String(diagnosisText || '').trim(),
        String(impressionText || '').trim(),
        String(recommendationsText || '').trim()
      );
  sets.push(`${diagnosisCol} = $${paramIdx++}`);
  params.push(diagnosisValue || null);

  if (impressionCol) {
    sets.push(`${impressionCol} = $${paramIdx++}`);
    params.push(impressionText || null);
  }
  if (recsCol) {
    sets.push(`${recsCol} = $${paramIdx++}`);
    params.push(recommendationsText || null);
  }
  sets.push(`${reportCol} = $${paramIdx++}`);
  params.push(reportUrl || null);

  // Keep the order attributable to the doctor who completed it.
  if (orderCols.includes('doctor_id') && doctorId) {
    sets.push(`doctor_id = COALESCE(doctor_id, $${paramIdx++})`);
    params.push(doctorId);
  }

  sets.push(`status = $${paramIdx++}`);
  params.push(completedStatusValue);
  if (orderCols.includes('completed_at')) {
    sets.push(`completed_at = COALESCE(completed_at, $${paramIdx++})`);
    params.push(nowIso);
  }
  if (orderCols.includes('updated_at')) {
    sets.push(`updated_at = $${paramIdx++}`);
    params.push(nowIso);
  }

  // THE IDEMPOTENCY GATE. Two racing submissions both pass the handler's
  // early completed-check; only one can win this row-level conditional flip.
  // The loser gets rowCount 0 and writes nothing else.
  //
  // Fix round 2026-09-21 (adversarial m-4 + M-2): the exclusion speaks the
  // whole COMPLETED/terminal vocabulary (a 'done' case must not be
  // re-completed and re-notify the patient; a cancelled/refunded case must
  // not be completable at all), and the flip re-checks doctor_id — the
  // handler's load-time authorisation, made atomic. A reassignment that
  // moved the case to another doctor between the load and this UPDATE makes
  // the flip lose instead of completing a case this doctor no longer holds.
  params.push(orderId);
  const orderIdIdx = paramIdx++;
  params.push(doctorId);
  const doctorIdIdx = paramIdx++;
  const res = await client.query(
    `UPDATE orders SET ${sets.join(', ')}
      WHERE id = $${orderIdIdx}
        AND doctor_id = $${doctorIdIdx}
        AND LOWER(COALESCE(status, '')) NOT IN (${NOT_SUBMITTABLE_SQL_LIST})
      RETURNING id`,
    params
  );
  return res && res.rowCount > 0 ? orderId : null;
}

// onComplete needs a doctor to credit; fall back to whoever the add-on itself
// recorded rather than inserting an addon_earnings row with a null doctor.
function rx_doctorFallback(addon) {
  try {
    const meta = addon && addon.metadata_json ? addon.metadata_json : null;
    const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta;
    return (parsed && (parsed.attached_by || parsed.requested_by_doctor)) || null;
  } catch (_) {
    return null;
  }
}

// ── The submission itself ──────────────────────────────────────────────────

/**
 * @returns one of:
 *   { ok: false, code: 'invalid_request' | 'not_found' | 'forbidden'
 *              | 'report_save_failed' | 'report_empty'
 *              | 'report_pdf_failed' | 'report_complete_failed' }
 *   { ok: true, alreadyCompleted: true }                 — idempotent result
 *   { ok: true, completed: true, reportUrl, earnings }   — the winning submit
 */
async function submitDoctorReport({
  orderId,
  doctorId,
  diagnosisText,
  impressionText,
  recommendationsText,
  via = 'doctor_portal_report'
} = {}) {
  if (!doctorId || !orderId) return { ok: false, code: 'invalid_request' };

  // 1. Load + authorise.
  const order = await queryOne('SELECT * FROM orders_active WHERE id = $1', [orderId]);
  if (!order) return { ok: false, code: 'not_found' };

  // A report may only be submitted by the doctor the case is assigned to.
  // Reject unassigned (null doctor_id) cases too, so the completion path can
  // never claim an unowned case via COALESCE(doctor_id, ...).
  if (String(order.doctor_id || '') !== String(doctorId)) {
    return { ok: false, code: 'forbidden' };
  }

  const statusNow = normalizeStatus(order.status);
  if (COMPLETED_DB_STATUSES.includes(statusNow)) {
    return { ok: true, alreadyCompleted: true };
  }
  // Fix round (adversarial m-4): a cancelled / refunded / expired case is not
  // submittable — the pre-Batch-B handler would happily complete it from a
  // stale doctor tab, settling a full pending fee on a cancelled case.
  if (CLOSED_DB_STATUSES.includes(statusNow)) {
    return { ok: false, code: 'case_not_open' };
  }

  // 2. Resolve the three fields with the stored-draft fallback — a browser
  // that dropped a textarea must not blank a saved section.
  const storedDraft = buildReportDraftFields(order);
  const findings = String(diagnosisText || '') || storedDraft.findings || '';
  const impression = String(impressionText || '') || storedDraft.impression || '';
  const recommendations = String(recommendationsText || '') || storedDraft.recommendations || '';

  // Persist the text draft-shaped BEFORE anything that can fail.
  try {
    const saved = await persistReportText({
      orderId,
      diagnosisText: findings,
      impressionText: impression,
      recommendationsText: recommendations
    });
    if (!saved) {
      // The case closed between the load above and this write (a concurrent
      // submit completed it, or an operator cancelled it). Nothing was
      // overwritten — classify from the current status and stop.
      const now = await queryOne('SELECT status FROM orders_active WHERE id = $1', [orderId]);
      const s = normalizeStatus(now && now.status);
      return COMPLETED_DB_STATUSES.includes(s)
        ? { ok: true, alreadyCompleted: true }
        : { ok: false, code: 'case_not_open' };
    }
  } catch (e) {
    logErrorToDb(e, { context: 'report_submission.persist_text', category: 'doctor_case', orderId, userId: doctorId });
    console.error('[report-submission] could not persist report text — refusing to continue', e && e.message);
    return { ok: false, code: 'report_save_failed', error: e };
  }

  // 3. Refuse an empty report. Findings and Impression are the clinically
  // load-bearing sections; Recommendations may legitimately be empty. The
  // text above is already saved, so the editor re-renders it.
  if (isReportSectionEmpty(findings) || isReportSectionEmpty(impression)) {
    return { ok: false, code: 'report_empty' };
  }

  // 4. Fetch related entities for a rich PDF (non-critical — proceed without).
  let patient = {};
  let doctor = {};
  let specialty = {};
  let annotations = [];
  try {
    // AUDIT-2026-08-22 (L7): date_of_birth and gender in the SELECT — the PDF
    // used to print a hardcoded "Age: — Gender: —".
    patient = (await queryOne('SELECT name, email, phone, date_of_birth, gender FROM users WHERE id = $1', [order.patient_id])) || {};
    doctor = (await queryOne('SELECT name, specialty_id FROM users WHERE id = $1', [doctorId])) || {};
    if (doctor.specialty_id) {
      specialty = (await queryOne('SELECT name FROM specialties WHERE id = $1', [doctor.specialty_id])) || {};
    }
    annotations = await queryAll(
      `SELECT ca.annotated_image_data, ca.annotations_count, u.name AS doctor_name
       FROM case_annotations ca
       LEFT JOIN users u ON u.id = ca.doctor_id
       WHERE ca.case_id = $1 AND ca.annotated_image_data IS NOT NULL AND ca.annotated_image_data != ''
       ORDER BY ca.updated_at ASC`,
      [orderId]
    );
  } catch (_) { /* non-critical — proceed without */ }

  const reportPatientAge = computeAgeFromDob(patient.date_of_birth);
  const reportPatientGender = reportGenderLabel(patient.gender);

  // Render the PDF (R2 upload). On failure: text is saved, case stays open.
  let reportUrl;
  try {
    const { generateMedicalReportPdf } = require('../report-generator');
    reportUrl = await generateMedicalReportPdf({
      caseId: orderId,
      doctorName: doctor.name || '',
      specialty: specialty.name || '',
      createdAt: order.created_at,
      // AUDIT-2026-08-22 (L2): the diagnosis_text fallback is the doctor's
      // own saved draft — never orders.notes (patient-written intake text).
      findings: findings || order.diagnosis_text || '',
      impression,
      recommendations,
      patient: {
        name: patient.name || '—',
        age: (reportPatientAge != null) ? String(reportPatientAge) : '—',
        gender: reportPatientGender || '—',
      },
      annotations,
    });
  } catch (e) {
    logErrorToDb(e, { context: 'report_submission.pdf_generate', category: 'doctor_case', orderId, userId: doctorId });
    console.error('[report-submission] PDF generation failed (text was saved)', e && e.message);
    return { ok: false, code: 'report_pdf_failed', error: e };
  }

  const caseLifecycle = require('../case_lifecycle');

  // 5. AUDIT-P1-4 — walk the case into IN_REVIEW before completing it, so a
  // doctor who never clicked Accept cannot jump ASSIGNED → COMPLETED with
  // accepted_at NULL. No-op when already IN_REVIEW. Best-effort: a doctor
  // must never lose a written report to a bookkeeping transition.
  try {
    const canon = caseLifecycle.CANON_STATUS || caseLifecycle.CASE_STATUS;
    if (normalizeStatus(order.status) !== 'in_review') {
      await caseLifecycle.transitionCase(orderId, canon.IN_REVIEW);
    }
  } catch (e) {
    logErrorToDb(e, { context: 'report_submission.in_review_transition', category: 'doctor_case', orderId });
    console.error('[report-submission] IN_REVIEW transition before completion failed:', e && e.message);
  }

  // The DB value for COMPLETED, via case_lifecycle's mapping when available.
  let completedStatusValue = 'completed';
  try {
    if (typeof caseLifecycle.toDbStatus === 'function') {
      completedStatusValue = caseLifecycle.toDbStatus('COMPLETED') || 'completed';
    }
  } catch (_) { /* keep the literal */ }

  // 6. THE ATOMIC CORE. Either the report record, the status change, the
  // assignment close, the completion event and the earnings settle ALL land,
  // or none do (AUDIT-2026-08-22 L5's schema guard throws before any write).
  const nowIso = new Date().toISOString();
  let txnResult;
  try {
    txnResult = await withTransaction(async (client) => {
      const won = await completeOrderInTxn(client, {
        orderId,
        doctorId,
        reportUrl,
        diagnosisText: findings,
        impressionText: impression,
        recommendationsText: recommendations,
        completedStatusValue
      });
      if (!won) {
        // The flip lost. Classify inside the transaction: a COMPLETED case is
        // the idempotent duplicate; a doctor mismatch means a reassignment
        // raced in; anything else (cancelled/refunded/'done'-variant) is a
        // case that is no longer open to this submission.
        // include-deleted-ok: classifying the row the flip just targeted —
        // a soft-deleted order must still classify, not read as missing.
        const nowRes = await client.query('SELECT status, doctor_id FROM orders WHERE id = $1', [orderId]);
        const nowRow = (nowRes && nowRes.rows && nowRes.rows[0]) || null;
        const s = normalizeStatus(nowRow && nowRow.status);
        if (COMPLETED_DB_STATUSES.includes(s)) return { alreadyCompleted: true };
        if (nowRow && String(nowRow.doctor_id || '') !== String(doctorId)) return { lostCase: true };
        return { caseNotOpen: true };
      }

      // AUDIT-P0-1 — the patient's Report tab gates on this row existing.
      // In the transaction: a completed case without its report record is
      // exactly the half-state this service exists to make impossible.
      await client.query(
        `INSERT INTO report_exports (id, case_id, file_path, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [require('crypto').randomUUID(), orderId, reportUrl, doctorId || null, nowIso]
      );

      // AUDIT-P1-4 / AUDIT-M1 — close the open assignment, or the timeout
      // sweep re-selects this completed case on every tick, forever.
      await client.query(
        `UPDATE doctor_assignments SET completed_at = $1
          WHERE case_id = $2 AND completed_at IS NULL`,
        [nowIso, orderId]
      );

      // The order_events completion record (audit/debug + the report-url
      // events fallback readers).
      await client.query(
        `INSERT INTO order_events (id, order_id, label, meta, at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          require('crypto').randomUUID(),
          orderId,
          'order_completed',
          JSON.stringify({ via, reportUrl: reportUrl || null, hasDiagnosis: !!(findings && String(findings).trim()) }),
          nowIso
        ]
      );

      // The money site, on the SAME client: settle the earnings amount at
      // completion (the row stays 'pending' — 'paid' is the month-end
      // payout's, see earnings_writer). If this throws, the completion above
      // rolls back with it: a case is never completed with its earnings in
      // an unknown state, and earnings never settle on an uncompleted case.
      const { settleCaseEarningsOnCompletion } = require('./earnings_writer');
      const earnings = await settleCaseEarningsOnCompletion(orderId, doctorId, { client });

      return { completed: true, earnings };
    });
  } catch (e) {
    logErrorToDb(e, { context: 'report_submission.complete_txn', category: 'doctor_case', orderId, userId: doctorId });
    console.error('[report-submission] completion transaction failed — nothing landed, case left open', e && e.message);
    return { ok: false, code: 'report_complete_failed', error: e };
  }

  if (txnResult && txnResult.alreadyCompleted) {
    // A concurrent submission won the flip. Its winner owns the side
    // effects; this caller reports the same idempotent success.
    return { ok: true, alreadyCompleted: true };
  }
  if (txnResult && txnResult.lostCase) {
    // A reassignment moved the case to another doctor mid-submission.
    return { ok: false, code: 'forbidden' };
  }
  if (txnResult && txnResult.caseNotOpen) {
    return { ok: false, code: 'case_not_open' };
  }

  // 7. Post-commit, best-effort — the completion is committed and stands
  // whatever happens below.

  try {
    await caseLifecycle.logCaseEvent(orderId, 'CASE_COMPLETED', { doctorId, via });
  } catch (e) {
    logErrorToDb(e, { context: 'report_submission.log_case_completed', category: 'lifecycle', orderId, userId: doctorId });
  }

  if (txnResult.earnings && (txnResult.earnings.updated || txnResult.earnings.inserted_legacy)) {
    try {
      logOrderEvent({
        orderId,
        label: txnResult.earnings.updated ? 'doctor_earnings_settled' : 'doctor_earnings_settled_legacy',
        meta: {
          earnings_id: txnResult.earnings.earningsId,
          earned_amount: txnResult.earnings.earnedAmount,
          status: txnResult.earnings.settledStatus
        },
        actorUserId: doctorId,
        actorRole: 'system'
      });
    } catch (_) {}
  }

  // Auto-save the report into the patient's medical records.
  try {
    if (order.patient_id) {
      let serviceName = '';
      try {
        const svc = order.service_id ? await queryOne('SELECT name FROM services WHERE id = $1', [order.service_id]) : null;
        serviceName = svc ? svc.name : '';
      } catch (_) {}
      await execute(
        `INSERT INTO medical_records (id, patient_id, record_type, title, description, file_url, order_id, doctor_id, is_shared_with_doctors, created_at)
         VALUES ($1, $2, 'case_report', $3, $4, $5, $6, $7, true, $8)
         ON CONFLICT DO NOTHING`,
        [
          require('crypto').randomUUID(),
          order.patient_id,
          'Case Report - ' + (serviceName || 'Medical Review'),
          'Auto-saved from completed case #' + String(orderId).slice(0, 8),
          reportUrl || null,
          orderId,
          doctorId,
          nowIso
        ]
      );
    }
  } catch (_) {}

  // AUDIT-2026-08-23 (C4) — settle the prescription add-on when the case
  // completes. Completion only settles what is genuinely finished: an add-on
  // still 'paid' stays 'paid' (writing a prescription AFTER the report is
  // explicitly supported), and it is logged so an operator can judge it.
  // addon_earnings has a UNIQUE index on order_addon_id, so this cannot
  // double-pay however many times completion runs.
  try {
    const rx = await queryOne(
      `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'prescription' LIMIT 1`,
      [orderId]
    );
    if (rx) {
      const rxStatus = String(rx.status || '').toLowerCase();
      const { getAddon } = require('./addons/registry');
      const svc = getAddon('prescription');
      if (svc && rxStatus === 'fulfilled') {
        try {
          await svc.onComplete({ order: { id: orderId }, addon: rx, doctorId: doctorId || rx_doctorFallback(rx) });
        } catch (payErr) {
          logErrorToDb(payErr, { context: 'report_submission.prescription_oncomplete', category: 'doctor_case', orderId });
        }
      } else if (rxStatus === 'paid') {
        try {
          logOrderEvent({
            orderId,
            label: 'Case completed with an unwritten paid prescription',
            meta: JSON.stringify({ addon: 'prescription', status: rxStatus }),
            actorUserId: doctorId,
            actorRole: 'doctor'
          });
        } catch (_) {}
      }
      // 'pending' / 'cancelled' / 'refunded' are terminal for settlement.
    }
  } catch (e) {
    logErrorToDb(e, { context: 'report_submission.prescription_settlement', category: 'doctor_case', orderId });
  }

  // Notify the patient — exactly once, because only the winning submission
  // reaches this line.
  if (order.patient_id) {
    try {
      const { queueMultiChannelNotification } = require('../notify');
      const notifDoctor = await queryOne('SELECT name FROM users WHERE id = $1', [doctorId]);
      const notifSpecialty = order.specialty_id
        ? await queryOne('SELECT name FROM specialties WHERE id = $1', [order.specialty_id])
        : null;
      queueMultiChannelNotification({
        orderId,
        toUserId: order.patient_id,
        channels: ['email', 'whatsapp', 'internal'],
        template: 'report_ready_patient',
        response: {
          caseReference: String(orderId).slice(0, 12).toUpperCase(),
          doctorName: notifDoctor ? notifDoctor.name : '',
          specialty: notifSpecialty ? notifSpecialty.name : '',
          reportUrl: `${process.env.APP_URL || 'https://tashkheesa.com'}/portal/case/${orderId}/report`,
        },
      });
    } catch (notifErr) {
      logErrorToDb(notifErr, { context: 'report_submission.patient_notify', category: 'doctor_case', orderId, userId: doctorId });
      console.error('[report-submission] notification failed', notifErr.message);
    }
  }

  return { ok: true, completed: true, reportUrl, earnings: txnResult.earnings || null };
}

module.exports = {
  submitDoctorReport,
  // Shared report/schema helpers — routes/doctor.js imports these so there is
  // exactly one copy of each.
  getOrdersColumns,
  pickFirstExistingOrderColumn,
  getDiagnosisColumnName,
  getImpressionColumnName,
  getRecommendationsColumnName,
  getReportUrlColumnName,
  buildCombinedReportText,
  buildReportDraftFields,
  readDiagnosisFromOrder,
  parseCombinedNotesToFields,
  isReportSectionEmpty,
  computeAgeFromDob,
  reportGenderLabel,
  persistReportText,
  ReportSchemaUnresolvedError
};
