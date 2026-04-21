// src/routes/api/cases_intake.js
// Public website intake endpoint — POST /api/cases/intake
// Anonymous (no auth). Upserts a patient user, creates an order, creates a cases SLA row.

const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../../db');
const { logErrorToDb } = require('../../logger');
const emailService = require('../../services/emailService');

const router = express.Router();
router.use(express.json());

const ALLOWED_TEST_TYPES = ['ct_mri', 'oncology', 'cardiology', 'lab_pathology', 'other'];

const TEST_TYPE_TO_SPECIALTY = {
  ct_mri:        'radiology',
  oncology:      'oncology',
  cardiology:    'cardiology',
  lab_pathology: 'lab_pathology',
  other:         null,
};

// Oncology gets the tighter 24h SLA; everything else 72h.
function slaConfigForTestType(testType) {
  if (testType === 'oncology') {
    return { sla_type: 'priority_24h', sla_hours: 24 };
  }
  return { sla_type: 'standard_72h', sla_hours: 72 };
}

function badEmail(email) {
  return !email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim());
}

router.post('/intake', async (req, res) => {
  const body = req.body || {};
  const full_name         = String(body.full_name || '').trim();
  const email             = String(body.email || '').trim().toLowerCase();
  const phone             = body.phone ? String(body.phone).trim() : null;
  const age               = body.age != null && String(body.age).trim() !== '' ? String(body.age).trim() : null;
  const country           = body.country ? String(body.country).trim() : null;
  const test_type         = String(body.test_type || '').trim();
  const clinical_question = body.clinical_question ? String(body.clinical_question).trim() : null;
  const case_files_url    = body.case_files ? String(body.case_files).trim() : null;

  // Validation
  if (!full_name)           return res.status(400).json({ error: 'full_name is required' });
  if (badEmail(email))      return res.status(400).json({ error: 'Valid email is required' });
  if (!test_type)           return res.status(400).json({ error: 'test_type is required' });
  if (!ALLOWED_TEST_TYPES.includes(test_type)) {
    return res.status(400).json({ error: 'test_type must be one of: ' + ALLOWED_TEST_TYPES.join(', ') });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Upsert user by email (case-insensitive)
    let userId;
    const existing = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email]
    );
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      // Best-effort enrichment: only fill blanks, don't overwrite existing data.
      await client.query(
        `UPDATE users
         SET name  = COALESCE(NULLIF(name, ''), $1),
             phone = COALESCE(NULLIF(phone, ''), $2),
             country = COALESCE(NULLIF(country, ''), $3),
             date_of_birth = COALESCE(NULLIF(date_of_birth, ''), $4)
         WHERE id = $5`,
        [full_name, phone, country, age, userId]
      );
    } else {
      userId = randomUUID();
      await client.query(
        `INSERT INTO users (id, email, name, phone, role, country, date_of_birth, signup_notes, is_active)
         VALUES ($1, $2, $3, $4, 'patient', $5, $6, 'website_portal_intake', true)`,
        [userId, email, full_name, phone, country, age]
      );
    }

    // 2) Insert the order
    const orderId   = randomUUID();
    const specId    = TEST_TYPE_TO_SPECIALTY[test_type] || null;
    const slaCfg    = slaConfigForTestType(test_type);
    await client.query(
      `INSERT INTO orders (
         id, patient_id, specialty_id, status, language,
         clinical_question, case_files_url, test_type, source,
         sla_hours, urgency_flag, payment_status
       )
       VALUES ($1, $2, $3, 'pending_review', 'en',
               $4, $5, $6, 'website_portal',
               $7, false, 'unpaid')`,
      [orderId, userId, specId, clinical_question, case_files_url, test_type, slaCfg.sla_hours]
    );

    // 3) Generate reference ID via sequence (idempotent CREATE)
    await client.query('CREATE SEQUENCE IF NOT EXISTS website_intake_seq START 1');
    const seqRow = await client.query("SELECT nextval('website_intake_seq')::bigint AS n");
    const seqN   = seqRow.rows[0].n;
    const year   = new Date().getUTCFullYear();
    const reference_id = 'TSH-' + year + '-' + String(seqN).padStart(6, '0');

    // 4) Insert cases row for SLA tracking (id reuses orderId — no FK column on cases)
    const slaDeadline = new Date(Date.now() + slaCfg.sla_hours * 60 * 60 * 1000).toISOString();
    await client.query(
      `INSERT INTO cases (id, reference_code, status, sla_type, sla_deadline, language, urgency_flag)
       VALUES ($1, $2, 'pending_review', $3, $4, 'en', false)`,
      [orderId, reference_id, slaCfg.sla_type, slaDeadline]
    );

    await client.query('COMMIT');

    // Phase 4: send the "case received" email to the patient. Fire-and-forget
    // — a failed email must NEVER cause the API to report failure for a case
    // that was successfully created.
    try {
      await emailService.notifyCaseReceived({ email: email, name: full_name }, reference_id);
    } catch (err) {
      console.error('[EMAIL] notifyCaseReceived failed:', err && err.message);
    }

    return res.status(200).json({
      success: true,
      reference_id,
      message: 'Case received. You will be contacted within 24 hours.',
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    try { logErrorToDb(err, { url: req.originalUrl, method: req.method, context: 'cases_intake' }); } catch (_) {}
    console.error('[cases_intake] failed:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

module.exports = router;
