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
const { normalizePhone, dialCodeFromE164 } = require('../../validators/phone_identity');
const { generateTokens } = require('../../middleware/requireJWT');
// NEW-AUTH-1 — the deletion code draws on the SAME per-phone OTP budget as the
// sign-in doors (60s cooldown, 3 sends / 15 min): the limiter instances are
// shared, so this door cannot be used to double anyone's SMS allowance.
const { otpSendCooldown, otpSendCap } = require('../../middleware/otp_phone_limits');
// Lazy-load express-validator — top-level require takes ~120s and starves DB pool on boot.
let _ev;
function ev() { if (!_ev) _ev = require('express-validator'); return _ev; }
function body(...a) { return ev().body(...a); }
function validationResult(...a) { return ev().validationResult(...a); }

// The number a deletion code is sent to AND checked against. One derivation
// for both, so the two can never disagree: the stored phone, normalised to
// E.164 with the account's country as the hint for a legacy local spelling;
// the stored string itself when it cannot be normalised (it is what the web
// deletion page has always used).
function deletionPhoneFor(row) {
  const raw = row && row.phone ? String(row.phone).trim() : '';
  if (!raw) return '';
  const chk = normalizePhone(raw, (row && (row.country_code || row.country)) || null, 'en');
  return chk.ok ? chk.normalized : raw;
}

// '+201277399043' -> '+20•••••9043'. Enough for the patient to recognise
// their own number, not enough to read someone else's off a screenshot.
function maskPhone(e164) {
  const s = String(e164 || '').trim();
  if (s.length < 6) return '';
  const dial = dialCodeFromE164(s) || s.slice(0, 3);
  const rest = s.replace(/^\+/, '').slice(dial.replace(/^\+/, '').length);
  const tail = rest.slice(-4);
  return dial + '•'.repeat(Math.max(1, rest.length - tail.length)) + tail;
}

// Run a shared express-rate-limit instance as a gate and report the verdict
// instead of letting it write its own 429. The instance (and so the counter)
// is the shared OTP one; only the response shape is ours, so the app gets a
// single code for "wait" and a retry hint.
function runLimiter(limiter, req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const sink = {
      headersSent: false,
      writableEnded: false,
      statusCode: 200,
      status(c) { sink.statusCode = c; return sink; },
      send() { done({ blocked: true, info: req.rateLimit }); return sink; },
      json() { done({ blocked: true, info: req.rateLimit }); return sink; },
      setHeader() {}, append() {}, on() {},
    };
    try {
      limiter(req, sink, (err) => (err ? reject(err) : done({ blocked: false })));
    } catch (err) { reject(err); }
  });
}

module.exports = function (db, { safeGet, safeAll, safeRun }) {
  // C1 (Batch C) — push registration is per DEVICE (session row, migration
  // 110). A second phone no longer steals the first one's push token.
  const sessionStore = require('../../services/user_sessions')({ safeGet, safeAll, safeRun });

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
      // NEW-AUTH-5 — phone-signup accounts have no password; the app hides
      // Change Password and picks the right deletion factor from this.
      hasPassword: !!user.password_hash,
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
      hasPassword: !!updated.password_hash,
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

    // C1 — store on this device's session row when the access token names one
    // (`sid`); a sid-less token was minted pre-C1 and keeps the single-slot
    // behaviour. The send path reads the union of both.
    let stored = false;
    if (req.user.sid) {
      stored = await sessionStore.setPushToken(req.user.sid, token, req.user.id);
    }
    if (!stored) {
      await safeRun('UPDATE users SET push_token = $1 WHERE id = $2', [token, req.user.id]);
    }
    return res.ok({ message: 'Push token registered' });
  });

  // ─── DELETE /profile/push-token ──────────────────────────

  router.delete('/push-token', async (req, res) => {
    // C1 — clear this device's registration; the mirror column is cleared
    // too (pre-C1 clients read only it, and a stale mirror keeps pushing to
    // a device that asked to stop).
    if (req.user.sid) {
      await sessionStore.setPushToken(req.user.sid, null, req.user.id);
    }
    await safeRun('UPDATE users SET push_token = NULL WHERE id = $1', [req.user.id]);
    return res.ok({ message: 'Push token removed' });
  });

  // ─── PATCH /profile/password ─────────────────────────────

  router.patch('/password', [
    body('currentPassword').notEmpty(),
    body('newPassword').isLength({ min: 8 }),
  ], async (req, res) => {
    const user = await safeGet('SELECT id, email, role, name, password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.fail('User not found', 404);

    // NEW-AUTH-5 — a phone-signup account has no password to change.
    // bcrypt.compare against a NULL hash threw, and the patient got a 500.
    // Checked before the body validation so the answer is the same whatever
    // the app sent.
    if (!user.password_hash) {
      return res.fail('This account signs in with a code and has no password to change.', 400, 'NO_PASSWORD_SET');
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.fail(errors.array()[0].msg, 422);
    }

    const valid = await bcrypt.compare(req.body.currentPassword, user.password_hash);
    if (!valid) {
      return res.fail('Current password is incorrect', 401, 'WRONG_PASSWORD');
    }

    const hashed = await bcrypt.hash(req.body.newPassword, 10);
    // A4 — a password change ends old sessions too (tokens_valid_after).
    // Launch gates 2026-09-15 (Task 3): the cut is an APP timestamp taken
    // immediately before the statement, never the database's NOW(). JWT iat is
    // app-clock seconds, so a database clock running ahead of this host would
    // revoke the access token the app refreshes right after the change.
    const revokedAt = new Date();
    await safeRun('UPDATE users SET password_hash = $1, tokens_valid_after = $3::timestamptz WHERE id = $2', [hashed, req.user.id, revokedAt]);

    // AUDIT-AUTH-4 (2026-09-23) — the cut above revokes the pair on THIS phone
    // too, and nothing replaced it: success alert, then "session expired"
    // within the 60s revocation-cache window. Mint a fresh pair now, AFTER the
    // stamp. access_revocation compares iat (whole seconds) with
    // floor(cut / 1000) and only revokes an EARLIER second, so a token minted
    // after this line survives even in the same second as the cut.
    //
    // Other devices are signed out eagerly (their rows revoked now, rather
    // than when they next try to refresh); this device keeps its row — and its
    // push registration — with the new refresh token in it.
    const sid = req.user.sid || null;
    await sessionStore.revokeOthersForUser(user.id, sid);
    let tokens = null;
    if (sid) {
      const pair = generateTokens(user, sid);
      if (await sessionStore.reissue(sid, pair.refreshToken, user.id)) tokens = pair;
    }
    if (!tokens) {
      // A sid-less (pre-C1) token, or its row is gone: open a new device row.
      const newSid = sessionStore.newSessionId();
      tokens = generateTokens(user, newSid);
      const b = req.body || {};
      await sessionStore.createSession({
        id: newSid,
        userId: user.id,
        refreshToken: tokens.refreshToken,
        client: 'patient_app',
        deviceId: b.deviceId ? String(b.deviceId).slice(0, 128) : null,
        deviceName: b.deviceName ? String(b.deviceName).slice(0, 128) : null,
      });
    }

    return res.ok({
      message: 'Password updated successfully',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
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

  // ─── POST /profile/account/code ──────────────────────────
  // NEW-AUTH-1 (2026-09-23) — send the deletion code to the phone ON FILE.
  //
  // The app used POST /auth/otp/request with the stored '+2010…' plus a
  // countryCode, which that route glued into '+20+2010…'; Twilio refused it,
  // the route said "sent", and every phone-signup patient's deletion ended in
  // WRONG_CODE. The web page (/patient/delete-account/code) never had this
  // problem because it sends to users.phone; this is the same approach, and
  // DELETE /profile/account below checks the code against the same number
  // (deletionPhoneFor), so the two cannot disagree.
  //
  // 200 { sent: true, maskedPhone }   400 NO_PHONE
  // 429 OTP_COOLDOWN { retryAfterSec } 502 OTP_SEND_FAILED

  router.post('/account/code', async (req, res) => {
    const row = await safeGet('SELECT phone, country, country_code, role FROM users WHERE id = $1', [req.user.id]);
    if (!row) return res.fail('User not found', 404);
    // Only patient accounts are erasable here — don't spend an SMS on anyone else.
    if (row.role !== 'patient') {
      return res.fail('Only patient accounts can be deleted here.', 403, 'ROLE_NOT_ERASABLE');
    }
    const phone = deletionPhoneFor(row);
    if (!phone) {
      return res.fail('There is no phone number on your account. Please contact us to delete it.', 400, 'NO_PHONE');
    }

    // Same limiter instances as /auth/otp/request, keyed on the same E.164
    // string that door keys on for this number.
    req.otpPhone = { key: phone };
    for (const limiter of [otpSendCooldown, otpSendCap]) {
      const verdict = await runLimiter(limiter, req);
      if (verdict.blocked) {
        const reset = verdict.info && verdict.info.resetTime ? new Date(verdict.info.resetTime).getTime() : null;
        const retryAfterSec = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 1000)) : null;
        const body = {
          success: false,
          error: 'Please wait a little before requesting another code.',
          code: 'OTP_COOLDOWN',
        };
        if (retryAfterSec) body.retryAfterSec = retryAfterSec;
        return res.status(429).json(body);
      }
    }

    // sendOtpViaTwilio NEVER throws; with credentials missing it returns
    // { stub: true }. A stub is a failure here, exactly as on the web page:
    // offering the code field to a patient who will never receive a code ends
    // in "invalid code" forever, for precisely the password-less accounts
    // this route exists to serve.
    const { sendOtpViaTwilio } = require('../../services/twilio_verify');
    let sent = null;
    try { sent = await sendOtpViaTwilio(phone); } catch (_) { sent = null; }
    if (!sent || sent.stub || sent.ok === false) {
      return res.fail(
        'We could not send a confirmation code. Please try again shortly, or contact us and we will delete your account for you.',
        502, 'OTP_SEND_FAILED'
      );
    }
    return res.ok({ sent: true, maskedPhone: maskPhone(phone) });
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
      const row = await safeGet('SELECT password_hash, phone, country, country_code, role FROM users WHERE id = $1', [userId]);
      if (!row) return res.fail('User not found', 404);
      if (String(row.role || '').toLowerCase() !== 'patient') {
        return res.fail('Only patient accounts can be deleted here.', 403, 'ROLE_NOT_ERASABLE');
      }

      const password = String((req.body && req.body.password) || '');
      const otp = String((req.body && req.body.otp) || '').trim();

      if (row.password_hash) {
        if (!password) {
          // AUDIT-APP-AUTH-1 (2026-09-22) — the code says WHICH factor, because
          // the app cannot know: GET /profile does not expose whether the
          // account has a password, and an OTP-signup user can add an email
          // later, so nothing client-side distinguishes the two. The app calls
          // DELETE with no body, reads the code, renders the right field and
          // resubmits. Message unchanged; only the code narrowed.
          return res.fail('Please confirm your password to delete your account.', 401, 'REAUTH_REQUIRED_PASSWORD');
        }
        const valid = await bcrypt.compare(password, row.password_hash);
        if (!valid) return res.fail('Current password is incorrect', 401, 'WRONG_PASSWORD');
      } else {
        // Phone-signup account: the verification code is their login factor,
        // so it is also their deletion factor.
        if (!otp) {
          return res.fail('Please confirm the code we sent you to delete your account.', 401, 'REAUTH_REQUIRED_OTP');
        }
        if (!/^\d{6}$/.test(otp) || !row.phone) {
          return res.fail('That code is not valid.', 401, 'WRONG_CODE');
        }
        const { verifyOtpCode } = require('../../services/twilio_verify');
        // The number POST /profile/account/code sent the code to.
        const result = await verifyOtpCode(deletionPhoneFor(row), otp);
        if (!result || !result.valid) {
          return res.fail('That code is not valid or has expired.', 401, 'WRONG_CODE');
        }
      }

      const { deleteAccount, purgeStorageKeys } = require('../../services/account_deletion');
      const outcome = await deleteAccount(userId);

      // After commit, never inside it: an R2 timeout must not roll back a
      // durable erasure, and a rolled-back erasure must not have already
      // destroyed the files.
      purgeStorageKeys(outcome.storageKeys, { userId: userId }, {
      externalUrls: outcome.externalUrls,
      uploadcareUuids: outcome.uploadcareUuids,
    }).catch(() => {});

      // Same as the web route: a paid case still running when its patient
      // erased leaves a doctor with a shell and a live SLA clock.
      if (outcome.inFlight && outcome.inFlight.length) {
        try {
          const { notifyAdmins } = require('../../notify');
          notifyAdmins({
            template: 'admin_patient_erased_with_live_cases',
            dedupeKey: 'erasure:' + userId,
            payload: {
              erasedUserId: userId,
              cases: outcome.inFlight,
              note: 'Patient deleted their account from the app. These paid cases are still open and their files and messages are gone.',
            },
          }).catch(() => {});
        } catch (_) { /* notification is never load-bearing */ }
      }

      // Invalidate any web session this person also holds. The tombstone was
      // written inside the transaction; this just refreshes the cache early.
      try { require('../../middleware').refreshTombstones().catch(() => {}); } catch (_) {}

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
