/**
 * Auth API Routes — /api/v1/auth/*
 *
 * Handles patient authentication for the mobile app.
 * Reuses existing user table and bcrypt hashing.
 */

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { body, validationResult } = require('express-validator');
const { generateTokens, verifyRefreshToken } = require('../../middleware/requireJWT');
const { verifyOtpCode } = require('../../services/twilio_verify');

module.exports = function (db, { safeGet, safeAll, safeRun, sendOtpViaTwilio, sendEmail }) {
  // ─── POST /register ──────────────────────────────────────

  router.post(
    '/register',
    [
      body('name').trim().notEmpty().withMessage('Name is required'),
      body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
      body('phone').trim().notEmpty().withMessage('Phone is required'),
      body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
      body('country').trim().notEmpty().withMessage('Country is required'),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.fail(errors.array()[0].msg, 422, 'VALIDATION_ERROR');
      }

      const { name, email, phone, countryCode, password, country, lang } = req.body;

      // Check existing user
      const existing = await safeGet('SELECT id FROM users WHERE email = $1', [email]);
      if (existing) {
        return res.fail('An account with this email already exists.', 409, 'EMAIL_EXISTS');
      }

      const existingPhone = await safeGet('SELECT id FROM users WHERE phone = $1', [phone]);
      if (existingPhone) {
        return res.fail('An account with this phone number already exists.', 409, 'PHONE_EXISTS');
      }

      // Create user
      const userId = randomUUID();
      const hashedPassword = await bcrypt.hash(password, 10);

      await safeRun(`
        INSERT INTO users (id, name, email, phone, password_hash, country, lang, role, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'patient', NOW())
      `, [userId, name, email, phone, hashedPassword, country, lang || 'en']);

      const user = await safeGet('SELECT * FROM users WHERE id = $1', [userId]);
      const tokens = generateTokens(user);

      // Store refresh token
      await safeRun('UPDATE users SET refresh_token = $1 WHERE id = $2', [tokens.refreshToken, userId]);

      return res.ok({
        user: sanitizeUser(user),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    }
  );

  // ─── POST /login ─────────────────────────────────────────

  router.post(
    '/login',
    [
      body('email').isEmail().normalizeEmail(),
      body('password').notEmpty(),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.fail('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
      }

      const { email, password } = req.body;

      const user = await safeGet('SELECT * FROM users WHERE email = $1 AND role = $2', [email, 'patient']);
      if (!user) {
        return res.fail('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.fail('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
      }

      const tokens = generateTokens(user);
      await safeRun('UPDATE users SET refresh_token = $1 WHERE id = $2', [tokens.refreshToken, user.id]);

      return res.ok({
        user: sanitizeUser(user),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    }
  );

  // ─── POST /refresh ───────────────────────────────────────

  router.post('/refresh', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.fail('Refresh token required', 401, 'NO_REFRESH_TOKEN');
    }

    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded) {
      return res.fail('Invalid refresh token', 401, 'INVALID_REFRESH');
    }

    // Verify token matches stored token (rotation check)
    const user = await safeGet(
      'SELECT * FROM users WHERE id = $1 AND refresh_token = $2',
      [decoded.id, refreshToken]
    );
    if (!user) {
      return res.fail('Refresh token revoked', 401, 'REFRESH_REVOKED');
    }

    // Generate new pair (rotation)
    const tokens = generateTokens(user);
    await safeRun('UPDATE users SET refresh_token = $1 WHERE id = $2', [tokens.refreshToken, user.id]);

    return res.ok({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  // ─── POST /otp/request ───────────────────────────────────

  router.post(
    '/otp/request',
    [body('phone').trim().notEmpty(), body('countryCode').trim().notEmpty()],
    async (req, res) => {
      const { phone, countryCode } = req.body;
      const fullPhone = `${countryCode}${phone}`.replace(/\s/g, '');

      // Generate 6-digit OTP
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

      // Store OTP (upsert)
      await safeRun(`
        INSERT INTO otp_codes (phone, code, expires_at, created_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3, created_at = NOW()
      `, [fullPhone, otp, expiresAt]);

      // Send via WhatsApp/SMS
      let sendResult = null;
      try {
        if (sendOtpViaTwilio) {
          sendResult = await sendOtpViaTwilio(fullPhone, `Your Tashkheesa verification code is: ${otp}`);
        }
      } catch (err) {
        console.error('[otp] Failed to send:', err.message);
        // Still return success — in dev, check DB for the code
      }

      const wasStub = !sendOtpViaTwilio || (sendResult && sendResult.stub);
      return res.ok({
        message: wasStub
          ? 'OTP generated. SMS delivery is not configured in this environment — contact support or check the otp_codes table in dev.'
          : 'OTP sent to your WhatsApp.'
      });
    }
  );

  // ─── POST /otp/verify ────────────────────────────────────

  router.post(
    '/otp/verify',
    [
      body('phone').trim().notEmpty(),
      body('countryCode').trim().notEmpty(),
      body('otp').trim().isLength({ min: 6, max: 6 }),
    ],
    async (req, res) => {
      const { phone, countryCode, otp } = req.body;
      const fullPhone = `${countryCode}${phone}`.replace(/\s/g, '');

      // Primary: Twilio Verify (when configured)
      const useTwilioVerify = !!(process.env.TWILIO_VERIFY_SERVICE_SID && process.env.TWILIO_ACCOUNT_SID);
      let codeValid = false;

      if (useTwilioVerify) {
        const result = await verifyOtpCode(fullPhone, otp);
        codeValid = result.valid;
      }

      // Fallback: check otp_codes table (dev mode, or if Twilio Verify not configured)
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

      // Clean up otp_codes regardless (Twilio Verify manages its own state)
      if (useTwilioVerify) {
        await safeRun('DELETE FROM otp_codes WHERE phone = $1', [fullPhone]);
      }

      // Find or create user
      let user = await safeGet('SELECT * FROM users WHERE phone = $1', [phone]);

      if (!user) {
        // Auto-create patient account from OTP login
        const userId = randomUUID();
        await safeRun(`
          INSERT INTO users (id, phone, role, country, lang, created_at)
          VALUES ($1, $2, 'patient', 'EG', 'en', NOW())
        `, [userId, phone]);
        user = await safeGet('SELECT * FROM users WHERE id = $1', [userId]);
      }

      const tokens = generateTokens(user);
      await safeRun('UPDATE users SET refresh_token = $1 WHERE id = $2', [tokens.refreshToken, user.id]);

      return res.ok({
        user: sanitizeUser(user),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    }
  );

  // ─── GET /me ─────────────────────────────────────────────
  // NOTE: This route needs requireJWT — mounted separately in api_v1.js

  router.get('/me', async (req, res) => {
    if (!req.user) return res.fail('Not authenticated', 401);
    const user = await safeGet('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.fail('User not found', 404);
    return res.ok(sanitizeUser(user));
  });

  // ─── POST /forgot-password ───────────────────────────────

  router.post('/forgot-password', [body('email').isEmail().normalizeEmail()], async (req, res) => {
    const { email } = req.body;
    const user = await safeGet('SELECT id, name, email FROM users WHERE email = $1', [email]);

    // Always return success (don't reveal if email exists)
    if (!user) {
      return res.ok({ message: 'If that email exists, a reset link has been sent.' });
    }

    const resetToken = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await safeRun('UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [resetToken, expiresAt, user.id]);

    // Send email with reset link
    if (sendEmail) {
      try {
        await sendEmail({
          to: user.email,
          subject: 'Tashkheesa — Reset your password',
          html: `<p>Hi ${user.name || 'there'},</p>
                 <p>Use this link to reset your password (expires in 1 hour):</p>
                 <p><a href="${process.env.APP_URL || 'https://portal.tashkheesa.com'}/reset-password?token=${resetToken}">Reset password</a></p>`,
        });
      } catch (err) {
        console.error('[email] Failed to send reset:', err.message);
      }
    }

    return res.ok({ message: 'If that email exists, a reset link has been sent.' });
  });

  // ─── POST /reset-password ────────────────────────────────

  router.post(
    '/reset-password',
    [
      body('token').notEmpty(),
      body('password').isLength({ min: 8 }),
    ],
    async (req, res) => {
      const { token, password } = req.body;

      const user = await safeGet(
        'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
        [token]
      );

      if (!user) {
        return res.fail('Invalid or expired reset token.', 400, 'INVALID_RESET_TOKEN');
      }

      const hashed = await bcrypt.hash(password, 10);
      await safeRun('UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
        [hashed, user.id]);

      return res.ok({ message: 'Password has been reset. You can now log in.' });
    }
  );

  return router;
};

// ─── Helper ────────────────────────────────────────────────

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    country: user.country,
    lang: user.lang || 'en',
    role: user.role,
    createdAt: user.created_at,
  };
}
