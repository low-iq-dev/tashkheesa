// src/routes/api/cases_intake.js
// Public website intake endpoint — POST /api/cases/intake
// Anonymous (no auth). Upserts a patient user, creates an order, creates a cases SLA row.

const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../../db');
const { logErrorToDb } = require('../../logger');
const emailService = require('../../services/emailService');
const { coerceCountry } = require('../../launch-market');

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

// Oncology gets the tighter 24h SLA; everything else 48h (per #85
// launch-reality copy + #86 default alignment). The 'standard_72h'
// sla_type enum string is retained for backwards compatibility with
// historical case rows; renaming the enum is tracked separately.
function slaConfigForTestType(testType) {
  if (testType === 'oncology') {
    return { sla_type: 'priority_24h', sla_hours: 24 };
  }
  return { sla_type: 'standard_72h', sla_hours: 48 };
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
  // AUDIT-2026-08-22 (L8) — the form's `age` must NEVER reach date_of_birth.
  //
  // Both writes below used to push `age` into users.date_of_birth (a TEXT
  // column). Postgres stores the string as-is and every downstream reader
  // parses it as a date: "45" becomes the year 2045, computeAgeFromDob
  // (routes/doctor.js) returns -19, its `age < 0` guard drops it and the
  // doctor's report header shows nothing. Worse, the enrichment UPDATE is a
  // COALESCE(NULLIF(date_of_birth,''), $n) — it only fills BLANKS — so once
  // "45" is in there it permanently blocks the patient's real date of birth
  // from ever being written, on this and on every later case they file.
  //
  // A real ISO date is accepted if the caller sends one; the reported age is
  // kept only as a note on the account (see signupNotes below), never as a
  // date. There is no honest age column on users today — see the hand-off.
  const dobRaw = body.date_of_birth ? String(body.date_of_birth).trim() : '';
  const date_of_birth = /^\d{4}-\d{2}-\d{2}$/.test(dobRaw) && !Number.isNaN(Date.parse(dobRaw))
    ? dobRaw
    : null;
  const reportedAge = (() => {
    if (age == null) return null;
    const n = Number(age);
    return Number.isInteger(n) && n >= 0 && n <= 120 ? String(n) : null;
  })();
  const signupNotes = reportedAge
    ? `website_portal_intake; reported_age=${reportedAge}`
    : 'website_portal_intake';
  const country           = body.country ? coerceCountry(body.country) : null;
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
    //
    // SECURITY (anonymous superadmin takeover): this endpoint is
    // unauthenticated AND CSRF-exempt. The lookup below previously matched
    // ANY row — including admin/superadmin — so posting a staff email here
    // selected the staff row and the enrichment UPDATE wrote attacker-supplied
    // data onto it. `AND role = 'patient'` (mirrored in the UPDATE's WHERE, so
    // the row cannot change role between the two statements) confines this
    // endpoint to patient rows, which is the only kind of row it is allowed to
    // create in the else-branch below.
    let userId;
    const existing = await client.query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND role = 'patient' LIMIT 1",
      [email]
    );
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      // Best-effort enrichment: only fill blanks, don't overwrite existing data.
      //
      // SECURITY: `phone` is deliberately NOT in this SET list. phone is a
      // LOGIN IDENTIFIER — /login/otp/verify and /api/v1/auth/otp/verify both
      // resolve an account from it — so an unauthenticated form must never be
      // able to write it. Filling a blank phone on someone else's account is
      // enough to receive their OTP. The value is still captured on the
      // auto-create path below, where the row is brand new and the submitter
      // is the account's originator.
      await client.query(
        `UPDATE users
         SET name  = COALESCE(NULLIF(name, ''), $1),
             country = COALESCE(NULLIF(country, ''), $2),
             date_of_birth = COALESCE(NULLIF(date_of_birth, ''), $3)
         WHERE id = $4 AND role = 'patient'`,
        // AUDIT-2026-08-22 (L8): $3 is a validated ISO date or NULL — it used
        // to be the submitted AGE. COALESCE(NULLIF(...)) still only fills a
        // blank, which is correct for a real DOB from an anonymous form.
        [full_name, country, date_of_birth, userId]
      );
    } else {
      // AUDIT (2026-08-17, regression F9) — the `role = 'patient'` filter above
      // is a real security fix (it stops this anonymous, CSRF-exempt endpoint
      // writing attacker-supplied data onto a staff account), but it turned a
      // non-patient email into a hard 500 and a LOST LEAD: users.email is
      // UNIQUE (users_email_key, migration 001), so the INSERT below raised
      // 23505, the catch rolled the whole transaction back, and the submitter
      // saw "Something went wrong. Please try again." — forever, on every
      // retry, with no hint that the address is the problem.
      //
      // ON CONFLICT DO NOTHING + a RETURNING check distinguishes the two ways
      // the INSERT can fail to produce a row:
      //   * a concurrent request created the SAME patient between our SELECT
      //     and this INSERT — re-read and carry on, the lead is fine;
      //   * the address belongs to a NON-patient (doctor/admin/superadmin) —
      //     we must not attach a case to that account and we must not touch it,
      //     so answer 409 with an actionable message instead of a 500.
      //
      // Same class, second unique index: users_phone_unique_idx (migration 069,
      // UNIQUE WHERE phone IS NOT NULL). ON CONFLICT can only infer ONE index,
      // so a phone already held by another account would raise 23505 straight
      // past the email clause and land in the same rollback-and-500. phone is
      // pure enrichment on this endpoint (the case is keyed on email), so drop
      // it rather than lose the lead over it. Dropping is also the safer
      // outcome on its own terms — see the SECURITY note above: phone is a
      // login identifier and this form is anonymous.
      let insertPhone = phone;
      if (insertPhone) {
        const phoneTaken = await client.query(
          'SELECT 1 FROM users WHERE phone = $1 LIMIT 1',
          [insertPhone]
        );
        if (phoneTaken.rows.length) insertPhone = null;
      }

      userId = randomUUID();
      const ins = await client.query(
        `INSERT INTO users (id, email, name, phone, role, country, date_of_birth, signup_notes, is_active)
         VALUES ($1, $2, $3, $4, 'patient', $5, $6, $7, true)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        // AUDIT-2026-08-22 (L8): $6 is a validated ISO date or NULL (was the
        // submitted age). The reported age is carried in signup_notes ($7)
        // instead — free text this endpoint already owns and already writes, so
        // the lead detail is not thrown away while the date column stays clean.
        [userId, email, full_name, insertPhone, country, date_of_birth, signupNotes]
      );

      if (!ins.rows.length) {
        // The address is taken. Re-read WITHOUT the role filter to find out by
        // whom — this is a read only; nothing is written to the row either way.
        const owner = await client.query(
          'SELECT id, role FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
          [email]
        );
        const ownerRow = owner.rows[0];

        if (ownerRow && String(ownerRow.role) === 'patient') {
          // Raced with a concurrent intake/registration for the same patient.
          userId = ownerRow.id;
        } else {
          // A staff account owns this address (or the row is unreadable).
          // Roll back cleanly and tell the submitter something they can act on.
          // The 409/"already registered" shape matches what
          // /api/v1/auth/register already returns for a taken address, so this
          // reveals nothing new; and it is a far better outcome than a generic
          // 500 that makes the lead unrecoverable on every retry.
          await client.query('ROLLBACK');
          try {
            logErrorToDb(
              new Error('cases_intake: email belongs to a non-patient account'),
              {
                url: req.originalUrl,
                method: req.method,
                context: 'cases_intake_email_role_conflict',
                level: 'warn',
                // Lead-recovery breadcrumbs only. Deliberately NOT the clinical
                // question or the file URLs — this is a general error log, not
                // a clinical store.
                submitted_email: email,
                submitted_name: full_name,
                test_type,
                existing_role: ownerRow ? ownerRow.role : 'unknown'
              }
            );
          } catch (_) { /* best-effort */ }
          return res.status(409).json({
            error: 'This email address is already registered to an existing account. Please sign in and submit your case from your dashboard, or use a different email address.',
            code: 'EMAIL_ALREADY_REGISTERED',
          });
        }
      }
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
