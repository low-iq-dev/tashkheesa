/**
 * Doctor Auth API Routes — /api/v1/doctor/auth/*
 *
 * C2 (Batch C, fix plan 2026-09-15) — doctors stop signing in through the
 * patient door. POST /api/v1/auth/otp/verify used to accept doctors, mint a
 * 30-DAY refresh token, skip every doctor account-state answer, and — worst —
 * auto-create a PATIENT account when the phone matched nothing. This router
 * is the doctors' own door:
 *
 *   * refresh lifetime is 12 HOURS (generateDoctorTokens — the Command app's
 *     tier, not the patient 30d): a doctor session carries other people's
 *     medical records;
 *   * the full account-state check the web portal runs, with each state its
 *     own answer — the app has (auth)/pending and (auth)/setup screens
 *     waiting for exactly these codes:
 *       ACCOUNT_PENDING_APPROVAL  pending_approval = true
 *       ACCOUNT_REJECTED          rejected (is_active false + rejection_reason)
 *       ACCOUNT_INACTIVE          deactivated
 *     (is_paused is DELIBERATELY not a gate — services/login_gate.js says
 *     why: a paused doctor must still sign in to finish assigned cases);
 *   * NO account creation, ever: an unknown phone is told to apply
 *     (NOT_A_DOCTOR), not enrolled. Every non-doctor phone — unknown,
 *     patient, staff — gets the SAME answer, so the response cannot be used
 *     to fingerprint which numbers exist or whose they are;
 *   * per-device sessions (C1): sign-in opens a user_sessions row, refresh
 *     rotates inside it, sign-out revokes that device only.
 *
 * The per-phone OTP limiters are intentionally duplicated from
 * routes/api/auth.js (same shape, separate counters), matching the
 * "kept local so the surfaces stay independent" precedent there.
 */

const router = require('express').Router();
const { randomInt } = require('crypto');
const { logErrorToDb } = require('../../logger');
const { normalizePhone, findUserByPhone } = require('../../validators/phone_identity');
const {
  generateDoctorTokens,
  verifyRefreshToken,
  requireJWT,
} = require('../../middleware/requireJWT');
const { verifyOtpCode } = require('../../services/twilio_verify');

// Lazy-load express-validator — same boot-time reasoning as api/auth.js.
let _ev;
function ev() { if (!_ev) _ev = require('express-validator'); return _ev; }
function body(...a) { return ev().body(...a); }
function validationResult(...a) { return ev().validationResult(...a); }

// ── per-phone OTP rate limits (mirrors api/auth.js AUDIT-P0-8) ────────────
const { rateLimit: _otpRateLimit } = require('express-rate-limit');

function otpPhoneScope(req, _res, next) {
  const cc = String((req.body && req.body.countryCode) || '').replace(/[^0-9+]/g, '');
  const ph = String((req.body && req.body.phone) || '').replace(/[^0-9]/g, '');
  req.otpPhone = { key: (cc + ph) || ('ip:' + (req.ip || 'unknown')) };
  next();
}
const otpPhoneKey = (req) => (req.otpPhone && req.otpPhone.key) || 'unknown';
const otpRlMsg = { success: false, error: 'Too many attempts. Try again later.', code: 'RATE_LIMITED' };

const otpSendCooldown = _otpRateLimit({
  windowMs: 60 * 1000, max: 1, validate: false,
  standardHeaders: false, legacyHeaders: false,
  keyGenerator: otpPhoneKey,
  message: { success: false, error: 'Please wait a minute before requesting another code.', code: 'OTP_COOLDOWN' },
});
const otpSendCap = _otpRateLimit({
  windowMs: 15 * 60 * 1000, max: 3, validate: false,
  standardHeaders: false, legacyHeaders: false,
  keyGenerator: otpPhoneKey, message: otpRlMsg,
});
const otpVerifyCap = _otpRateLimit({
  windowMs: 15 * 60 * 1000, max: 5, validate: false,
  standardHeaders: false, legacyHeaders: false,
  keyGenerator: otpPhoneKey, message: otpRlMsg,
});

module.exports = function (db, { safeGet, safeAll, safeRun, sendOtpViaTwilio }) {
  const sessions = require('../../services/user_sessions')({ safeGet, safeAll, safeRun });

  function deviceInfo(req) {
    const b = req.body || {};
    return {
      deviceId: b.deviceId ? String(b.deviceId).slice(0, 128) : null,
      deviceName: b.deviceName ? String(b.deviceName).slice(0, 128) : null,
    };
  }

  /**
   * The doctor account-state answers, each its own code. Strict comparisons
   * against the blocking value, same NULL semantics as login_gate.js (a NULL
   * is_active is an ACTIVE legacy row, matching COALESCE(is_active, true) in
   * the routing SQL). Returns null when sign-in is allowed.
   */
  function doctorStateAnswer(user) {
    if (user.pending_approval === true) {
      return {
        status: 403, code: 'ACCOUNT_PENDING_APPROVAL',
        message: 'Your application is still being reviewed. We will notify you when your account is approved.',
      };
    }
    if (user.is_active === false && user.rejection_reason) {
      return {
        status: 403, code: 'ACCOUNT_REJECTED',
        message: 'Your application was not approved. Contact support if you believe this is a mistake.',
      };
    }
    if (user.is_active === false) {
      return {
        status: 403, code: 'ACCOUNT_INACTIVE',
        message: 'This account is not active. Please contact support.',
      };
    }
    return null;
  }

  // ─── POST /otp/request ───────────────────────────────────
  // Sends to any well-formed phone (like the patient door): the doctor
  // lookup happens at VERIFY, where the caller has proven control of the
  // number — refusing to send here would leak which numbers are doctors,
  // and would leave an unknown applicant with no path to the "apply" answer.
  router.post(
    '/otp/request',
    otpPhoneScope, otpSendCooldown, otpSendCap,
    [body('phone').trim().notEmpty(), body('countryCode').trim().notEmpty()],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.fail(errors.array()[0].msg, 422, 'VALIDATION_ERROR');
      }
      const { phone, countryCode } = req.body;
      const fullPhone = `${countryCode}${phone}`.replace(/\s/g, '');

      const otp = String(randomInt(100000, 1000000)).padStart(6, '0');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      // Same AUDIT-P0-8 rule as the patient door: the local fallback code is
      // stored ONLY when Twilio Verify is not configured (dev/self-delivery),
      // so there is never more than one simultaneously-valid code per phone.
      const useTwilioVerify = !!(process.env.TWILIO_VERIFY_SERVICE_SID && process.env.TWILIO_ACCOUNT_SID);
      if (!useTwilioVerify) {
        await safeRun(`
          INSERT INTO otp_codes (phone, code, expires_at, created_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3, created_at = NOW()
        `, [fullPhone, otp, expiresAt]);
      }

      let sendResult = null;
      try {
        if (sendOtpViaTwilio) {
          sendResult = await sendOtpViaTwilio(fullPhone, `Your Tashkheesa verification code is: ${otp}`);
        }
      } catch (err) {
        console.error('[doctor-otp] Failed to send:', err.message);
      }

      const wasStub = !sendOtpViaTwilio || (sendResult && sendResult.stub);
      return res.ok({
        message: wasStub
          ? 'OTP generated. SMS delivery is not configured in this environment — contact support or check the otp_codes table in dev.'
          : 'OTP sent to your phone.'
      });
    }
  );

  // ─── POST /otp/verify ────────────────────────────────────
  router.post(
    '/otp/verify',
    otpPhoneScope, otpVerifyCap,
    [
      body('phone').trim().notEmpty(),
      body('countryCode').trim().notEmpty(),
      body('otp').trim().isLength({ min: 6, max: 6 }),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.fail('Invalid verification code.', 422, 'VALIDATION_ERROR');
      }

      const { phone, countryCode, otp } = req.body;
      const fullPhone = `${countryCode}${phone}`.replace(/\s/g, '');

      // Same two-source OTP check as the patient door: Twilio Verify when
      // configured, otp_codes fallback otherwise.
      const useTwilioVerify = !!(process.env.TWILIO_VERIFY_SERVICE_SID && process.env.TWILIO_ACCOUNT_SID);
      let codeValid = false;
      if (useTwilioVerify) {
        const result = await verifyOtpCode(fullPhone, otp);
        codeValid = result.valid;
      }
      if (!codeValid) {
        const record = await safeGet(
          'SELECT * FROM otp_codes WHERE phone = $1 AND code = $2 AND expires_at > NOW()',
          [fullPhone, otp]
        );
        if (record) {
          codeValid = true;
          await safeRun('DELETE FROM otp_codes WHERE phone = $1', [fullPhone]);
        }
      }
      if (!codeValid) {
        return res.fail('Invalid or expired OTP.', 401, 'INVALID_OTP');
      }
      if (useTwilioVerify) {
        await safeRun('DELETE FROM otp_codes WHERE phone = $1', [fullPhone]);
      }

      const phoneCheck = normalizePhone(phone, countryCode, 'en');
      if (!phoneCheck.ok) {
        return res.fail(phoneCheck.error, 422, 'PHONE_INVALID');
      }
      const normalizedPhone = phoneCheck.normalized;

      // DOCTOR rows only. Same resolver as the patient door (exact, legacy
      // spelling, verified 9-digit suffix — see api/auth.js for the history),
      // but role-gated to 'doctor': a patient's or staff member's number
      // resolves to NOTHING here and falls into the one generic
      // NOT_A_DOCTOR answer below.
      const resolution = await findUserByPhone(
        safeAll, normalizedPhone, fullPhone, ['doctor'], countryCode
      );
      let user = resolution.user;

      if (resolution.ambiguous) {
        logErrorToDb(new Error('Doctor OTP phone matched multiple accounts'), {
          context: 'api.doctor_auth.otp_verify.ambiguous_phone',
          category: 'auth',
          matchedBy: resolution.matchedBy,
        });
        return res.fail(
          'We found more than one account for this number. Please contact support.',
          409,
          'PHONE_AMBIGUOUS'
        );
      }

      if (!user) {
        // NO ACCOUNT CREATION — the C2 rule. An unknown phone is told to
        // apply. One answer for every non-doctor number (unknown, patient,
        // staff): proving control of a phone earns you nothing about whose
        // it is.
        return res.fail(
          'This number is not registered as a consultant. To join Tashkheesa, apply at tashkheesa.com/apply.',
          403,
          'NOT_A_DOCTOR'
        );
      }

      // Heal a legacy phone spelling — same allowlist and same caveats as the
      // patient door (the resolver has already proven the two spellings are
      // the same telephone number).
      const healable = ['exact', 'legacy_raw', 'suffix_verified'].includes(resolution.matchedBy);
      if (user && healable && user.phone !== normalizedPhone) {
        try {
          await safeRun('UPDATE users SET phone = $1 WHERE id = $2', [normalizedPhone, user.id]);
          user.phone = normalizedPhone;
        } catch (e) {
          logErrorToDb(e, {
            context: 'api.doctor_auth.otp_verify.phone_heal_failed',
            category: 'auth',
            userId: user.id,
          });
        }
      }

      // The full account-state check, each state its own answer.
      const blocked = doctorStateAnswer(user);
      if (blocked) {
        return res.fail(blocked.message, blocked.status, blocked.code);
      }

      // C1 — this device gets its own session row; 12h refresh lifetime.
      const sessionId = sessions.newSessionId();
      const tokens = generateDoctorTokens(user, sessionId);
      const { deviceId, deviceName } = deviceInfo(req);
      await sessions.createSession({
        id: sessionId,
        userId: user.id,
        refreshToken: tokens.refreshToken,
        client: 'doctor_app',
        deviceId,
        deviceName,
      });

      return res.ok({
        user: sanitizeDoctor(user),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    }
  );

  // ─── POST /refresh ───────────────────────────────────────
  // Same envelope and REFRESH_REVOKED contract as the patient endpoint: a
  // blocked account is reported as a dead session, never as its state — the
  // state answers belong to sign-in, where the caller has just proven the
  // phone; a refresh token proves only that a device once signed in.
  router.post('/refresh', async (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) {
      return res.fail('Refresh token required', 401, 'NO_REFRESH_TOKEN');
    }
    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded) {
      return res.fail('Invalid refresh token', 401, 'INVALID_REFRESH');
    }

    const session = await sessions.findLiveByToken(refreshToken);
    if (!session || String(session.user_id) !== String(decoded.id)) {
      // No legacy-column fallback here: no doctor token minted before this
      // router existed is one it should honour — pre-C2 doctor tokens came
      // through the patient door and die with it.
      return res.fail('Refresh token revoked', 401, 'REFRESH_REVOKED');
    }
    const user = await safeGet('SELECT * FROM users WHERE id = $1', [session.user_id]);
    if (!user || String(user.role || '').toLowerCase() !== 'doctor') {
      await sessions.revokeById(session.id);
      return res.fail('Refresh token revoked', 401, 'REFRESH_REVOKED');
    }

    // Honour the revocation stamp on refresh tokens (password change,
    // deactivate — tokens_valid_after). Fail-open cache, same as requireJWT.
    try {
      if (require('../../services/access_revocation').isTokenStale(decoded.id, decoded.iat)) {
        await sessions.revokeById(session.id);
        return res.fail('Refresh token revoked', 401, 'REFRESH_REVOKED');
      }
    } catch (_) { /* fail open */ }

    if (doctorStateAnswer(user) !== null) {
      await sessions.revokeById(session.id);
      await safeRun('UPDATE users SET refresh_token = NULL WHERE id = $1', [user.id]);
      return res.fail('Refresh token revoked', 401, 'REFRESH_REVOKED');
    }

    const tokens = generateDoctorTokens(user, session.id);
    const rotated = await sessions.rotate(session.id, refreshToken, tokens.refreshToken, user.id);
    if (!rotated) {
      return res.fail('Refresh token revoked', 401, 'REFRESH_REVOKED');
    }

    return res.ok({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  // ─── POST /logout ────────────────────────────────────────
  // Signs out THIS DEVICE only (C1). Authenticates explicitly, like the
  // patient logout.
  router.post('/logout', requireJWT, async (req, res) => {
    try {
      if (req.user.sid) {
        await sessions.revokeById(req.user.sid);
      } else {
        await sessions.revokeLegacyForUser(req.user.id);
        await safeRun(
          'UPDATE users SET refresh_token = NULL, push_token = NULL WHERE id = $1',
          [req.user.id]
        );
      }
    } catch (err) {
      console.error('[doctor-auth/logout] failed:', err && err.message);
    }
    return res.ok({ message: 'Signed out' });
  });

  return router;
};

// ─── Helper ────────────────────────────────────────────────
// The doctor's own identity card — no pricing, no patient data, and none of
// the credential columns.
function sanitizeDoctor(user) {
  return {
    id: user.id,
    name: user.name,
    nameAr: user.name_ar || null,
    email: user.email,
    phone: user.phone,
    lang: user.lang || 'en',
    role: user.role,
    specialtyId: user.specialty_id || null,
    onboardingComplete: user.onboarding_complete === true,
    isPaused: user.is_paused === true,
    appearancePreference: user.appearance_preference || null,
    createdAt: user.created_at,
  };
}
