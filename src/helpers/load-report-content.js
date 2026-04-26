/**
 * loadReportContentForPatient — the SOLE access path for patient-facing
 * report-text columns (diagnosis_text, impression_text, recommendation_text).
 *
 * Both the V2 case-detail Report tab (routes/patient.js) and the
 * /portal/case/:caseId/report fallback viewer (routes/reports.js) route
 * through this helper so the privacy invariant (Fix 1) is auditable from a
 * single grep: any other code path that selects these columns is a bug.
 *
 * Returns null on failure or when orderId is missing.
 */
const { queryOne } = require('../pg');

async function loadReportContentForPatient(orderId) {
  if (!orderId) return null;
  try {
    return await queryOne(
      `SELECT
         o.id,
         o.reference_code,
         o.diagnosis_text,
         o.impression_text,
         o.recommendation_text,
         o.completed_at,
         o.specialty_id,
         o.service_id,
         o.doctor_id,
         o.clinical_question,
         d.name AS doctor_name,
         d.email AS doctor_email,
         s.name AS specialty_name
       FROM orders o
       LEFT JOIN users d ON d.id = o.doctor_id
       LEFT JOIN specialties s ON s.id = o.specialty_id
       WHERE o.id = $1`,
      [orderId]
    );
  } catch (_) {
    return null;
  }
}

module.exports = { loadReportContentForPatient };
