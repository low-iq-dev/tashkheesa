/**
 * Profile API Routes — /api/v1/profile/*
 *
 * Manages patient profile, push tokens, password change, and GDPR deletion.
 */

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { coerceCountry } = require('../../launch-market');
// Every other writer of users.phone goes through this validator (web /register,
// the onboarding wizard, api/v1/auth register + otp/verify). This route did not,
// so the app's own profile screen was the one path that could write a
// non-E.164 — or entirely junk — phone. That matters beyond formatting: phone is
// a LOGIN IDENTIFIER for both OTP paths, and WhatsApp/SMS dispatch matches on an
// exact E.164 string.
const { validatePhoneE164 } = require('../../validators/phone');
// Lazy-load express-validator — top-level require takes ~120s and starves DB pool on boot.
let _ev;
function ev() { if (!_ev) _ev = require('express-validator'); return _ev; }
function body(...a) { return ev().body(...a); }
function validationResult(...a) { return ev().validationResult(...a); }

module.exports = function (db, { safeGet, safeRun }) {

  // ─── GET /profile ────────────────────────────────────────

  router.get('/', async (req, res) => {
    const user = await safeGet('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.fail('User not found', 404);

    return res.ok({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      country: user.country,
      lang: user.lang || 'en',
      role: user.role,
      createdAt: user.created_at,
    });
  });

  // ─── PATCH /profile ──────────────────────────────────────

  router.patch('/', [
    body('name').optional().trim().notEmpty(),
    // AUDIT-APP-C6 — email was not accepted here, and phone+OTP signup creates
    // accounts with name and email NULL. Paymob's _validatePatient requires
    // both, so checkout threw PATIENT_PROFILE_INCOMPLETE and the payment screen
    // rendered a dead end with no way to supply them. An OTP user was
    // permanently unable to pay for anything.
    body('email').optional().trim().isEmail().withMessage('Enter a valid email address').normalizeEmail(),
    body('phone').optional().trim(),
    body('country').optional().trim(),
    body('lang').optional().isIn(['en', 'ar']),
  ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.fail(errors.array()[0].msg, 422);
    }

    // Validate + normalise the phone BEFORE building the UPDATE, and persist the
    // normalised E.164 string (not the raw input) so this route stores exactly
    // what the OTP login lookups search for.
    let normalizedPhone = null;
    if (req.body.phone) {
      const phoneCheck = validatePhoneE164(req.body.phone, req.body.lang === 'ar' ? 'ar' : 'en');
      if (!phoneCheck.ok) {
        return res.fail(phoneCheck.error, 422, 'PHONE_INVALID');
      }
      normalizedPhone = phoneCheck.normalized;
    }

    // users.email is UNIQUE (migration 001). Writing a taken address raised a
    // raw constraint violation, which surfaced as a 500 on the one screen an
    // OTP-created account must use before it can pay. Pre-check and return the
    // same 409/EMAIL_EXISTS shape /api/v1/auth/register uses.
    if (req.body.email) {
      const taken = await safeGet(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2',
        [req.body.email, req.user.id]
      );
      if (taken) {
        return res.fail('An account with this email already exists.', 409, 'EMAIL_EXISTS');
      }
    }

    // AUDIT (2026-08-17, regression F10) — the email pre-check landed without
    // its phone twin. users.phone carries users_phone_unique_idx (migration
    // 069: UNIQUE WHERE phone IS NOT NULL), so writing a number another account
    // already holds still raised a raw 23505 → 500, on the SAME screen the
    // email check was added to rescue. An OTP-created account fixing up its
    // profile before checkout hits both fields in one form; guarding one of
    // them just moves the dead end one field to the right.
    //
    // Matched on the NORMALISED value, because that is what the UPDATE below
    // writes and therefore what the index will actually see. The index is on
    // the exact stored string, so an exact `=` is the right comparison — the
    // legacy non-E.164 rows migration 069 left alone are outside it either way.
    if (normalizedPhone) {
      const phoneTaken = await safeGet(
        'SELECT id FROM users WHERE phone = $1 AND id <> $2',
        [normalizedPhone, req.user.id]
      );
      if (phoneTaken) {
        return res.fail('An account with this phone number already exists.', 409, 'PHONE_EXISTS');
      }
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (req.body.name) { updates.push(`name = $${paramIndex++}`); values.push(req.body.name); }
    if (req.body.email) { updates.push(`email = $${paramIndex++}`); values.push(req.body.email); }
    if (normalizedPhone) { updates.push(`phone = $${paramIndex++}`); values.push(normalizedPhone); }
    // AUDIT-APP-H10: country_code moves with country. Pricing reads country_code
    // on the web session path and country on the API path; letting them drift
    // meant a patient who switched market saw one price list in the app and a
    // different one in the portal.
    if (req.body.country) {
      const iso = coerceCountry(req.body.country);
      updates.push(`country = $${paramIndex++}`); values.push(iso);
      updates.push(`country_code = $${paramIndex++}`); values.push(iso);
    }
    if (req.body.lang) { updates.push(`lang = $${paramIndex++}`); values.push(req.body.lang); }

    if (updates.length === 0) {
      return res.fail('No fields to update', 400);
    }

    values.push(req.user.id);
    await safeRun(`UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`, values);

    const updated = await safeGet('SELECT * FROM users WHERE id = $1', [req.user.id]);
    return res.ok({
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      country: updated.country,
      lang: updated.lang,
    });
  });

  // ─── POST /profile/push-token ────────────────────────────
  // Register Expo push token for notifications

  router.post('/push-token', [
    body('token').trim().notEmpty(),
  ], async (req, res) => {
    const { token } = req.body;

    // Validate Expo push token format
    if (!token.startsWith('ExponentPushToken[') && !token.startsWith('ExpoPushToken[')) {
      return res.fail('Invalid push token format', 400);
    }

    await safeRun('UPDATE users SET push_token = $1 WHERE id = $2', [token, req.user.id]);
    return res.ok({ message: 'Push token registered' });
  });

  // ─── DELETE /profile/push-token ──────────────────────────

  router.delete('/push-token', async (req, res) => {
    await safeRun('UPDATE users SET push_token = NULL WHERE id = $1', [req.user.id]);
    return res.ok({ message: 'Push token removed' });
  });

  // ─── PATCH /profile/password ─────────────────────────────

  router.patch('/password', [
    body('currentPassword').notEmpty(),
    body('newPassword').isLength({ min: 8 }),
  ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.fail(errors.array()[0].msg, 422);
    }

    const user = await safeGet('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.fail('User not found', 404);

    const valid = await bcrypt.compare(req.body.currentPassword, user.password_hash);
    if (!valid) {
      return res.fail('Current password is incorrect', 401, 'WRONG_PASSWORD');
    }

    const hashed = await bcrypt.hash(req.body.newPassword, 10);
    await safeRun('UPDATE users SET password_hash = $1 WHERE id = $2', [hashed, req.user.id]);

    return res.ok({ message: 'Password updated successfully' });
  });

  // ─── GET /profile/export ─────────────────────────────────
  // PDPL portability. privacy.ejs §5 promises "a portable copy of your data";
  // until now the only export in the codebase was superadmin-only and carried
  // no PII at all. Safe as a GET: this API is bearer-token authenticated, so
  // there is no ambient cookie for another origin to ride.

  router.get('/export', async (req, res) => {
    try {
      const { buildPatientExport } = require('../../services/patient_data_export');
      const payload = await buildPatientExport(req.user.id);
      if (!payload) return res.fail('User not found', 404);
      res.set('Cache-Control', 'no-store, private');
      return res.ok(payload);
    } catch (err) {
      console.error('[profile/export] failed:', err && err.message);
      return res.fail('Could not build your export. Please try again.', 500, 'EXPORT_FAILED');
    }
  });

  // ─── DELETE /profile/account ─────────────────────────────
  // PDPL Article 2(e) erasure.
  //
  // WHAT THIS USED TO DO, AND WHY IT HAD TO CHANGE. The previous handler
  // looped eight tables with `safeRun` — a bare pool.query, so every statement
  // autocommitted independently — caught every error as "table might not
  // exist", and returned "Account and all data permanently deleted." whether
  // or not it had. It required NO credential of any kind: possession of a JWT
  // was sufficient to destroy someone's medical history. It missed
  // medical_records, appointments, video_calls, order_events and six other
  // tables, left every uploaded file orphaned in R2, and its DELETE FROM
  // orders CASCADEd through refunds and order_addons into addon_earnings —
  // taking the financial records the privacy policy promises to keep, and the
  // doctor's earnings rows, with it.
  //
  // The work now lives in services/account_deletion.js, in one transaction.
  //
  // BREAKING CHANGE FOR THE APP. This route now demands re-authentication. An
  // app build that calls it with an empty body gets 401 REAUTH_REQUIRED and
  // NOTHING IS DELETED — the failure mode is a button that does not work, not
  // a medical history erased by a stolen token. The app should collect the
  // password (or a Twilio Verify code, for phone-signup accounts) and send it
  // here; until it does, /patient/delete-account on the web covers the right.

  router.delete('/account', async (req, res) => {
    const userId = req.user.id;
    try {
      const row = await safeGet('SELECT password_hash, phone, role FROM users WHERE id = $1', [userId]);
      if (!row) return res.fail('User not found', 404);
      if (String(row.role || '').toLowerCase() !== 'patient') {
        return res.fail('Only patient accounts can be deleted here.', 403, 'ROLE_NOT_ERASABLE');
      }

      const password = String((req.body && req.body.password) || '');
      const otp = String((req.body && req.body.otp) || '').trim();

      if (row.password_hash) {
        if (!password) {
          return res.fail('Please confirm your password to delete your account.', 401, 'REAUTH_REQUIRED');
        }
        const valid = await bcrypt.compare(password, row.password_hash);
        if (!valid) return res.fail('Current password is incorrect', 401, 'WRONG_PASSWORD');
      } else {
        // Phone-signup account: the verification code is their login factor,
        // so it is also their deletion factor.
        if (!otp) {
          return res.fail('Please confirm the code we sent you to delete your account.', 401, 'REAUTH_REQUIRED');
        }
        if (!/^\d{6}$/.test(otp) || !row.phone) {
          return res.fail('That code is not valid.', 401, 'WRONG_CODE');
        }
        const { verifyOtpCode } = require('../../services/twilio_verify');
        const result = await verifyOtpCode(String(row.phone).trim(), otp);
        if (!result || !result.valid) {
          return res.fail('That code is not valid or has expired.', 401, 'WRONG_CODE');
        }
      }

      const { deleteAccount, purgeStorageKeys } = require('../../services/account_deletion');
      const outcome = await deleteAccount(userId);

      // After commit, never inside it: an R2 timeout must not roll back a
      // durable erasure, and a rolled-back erasure must not have already
      // destroyed the files.
      purgeStorageKeys(outcome.storageKeys, { userId: userId }).catch(() => {});

      return res.ok({
        message: 'Your account has been deleted. An anonymous record of each payment and refund is kept for accounting, with your name removed.',
      });
    } catch (err) {
      console.error('[profile/delete-account] failed:', err && err.message);
      if (err && err.code === 'ROLE_NOT_ERASABLE') {
        return res.fail('Only patient accounts can be deleted here.', 403, 'ROLE_NOT_ERASABLE');
      }
      if (err && err.code === 'NOT_FOUND') return res.fail('User not found', 404);
      // Say nothing was deleted only because nothing was: the whole operation
      // is one transaction, so a throw means a rollback.
      return res.fail('Something went wrong and nothing was deleted. Please try again.', 500, 'DELETE_FAILED');
    }
  });

  return router;
};
