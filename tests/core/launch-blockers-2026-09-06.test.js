// tests/core/launch-blockers-2026-09-06.test.js
//
// Regression guards for the five pre-launch blockers fixed on 2026-09-06.
// Every assertion below was verified NEGATIVELY: the fix was reverted, the
// test was confirmed to fail, and the fix was restored.
//
// The five:
//   1. mobile OTP / password login minted tokens with no account-status gate
//   2. phone suffix matching authenticated a caller as a DIFFERENT user, then
//      overwrote that user's phone number with the caller's
//   3. a failed doctor diagnosis save redirected to a success URL
//   4. password reset / magic-login reactivated deactivated + rejected doctors
//   5. doctor approval sent a welcome with no login link
//
// Source-grep assertions run through stripComments() — see
// tests/_helpers/strip-comments.js for why (these files now carry long AUDIT
// comments that name the very literals being forbidden).

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🚧 Launch blockers 2026-09-06 — auth gates, phone identity, honest saves\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function code(rel) {
  return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
function raw(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function check(name, fn) {
  try {
    const why = fn();
    if (why) t.fail(name, new Error(why));
    else t.pass(name);
  } catch (err) {
    t.fail(name, err);
  }
}

// ── BLOCKER 1 — every token-minting path consults the shared gate ──────────

check('login_gate module exists and blocks pending_approval and inactive doctors', () => {
  const { loginBlockReason, LOGIN_BLOCKED } = require('../../src/services/login_gate');
  const doctor = (over) => Object.assign({ role: 'doctor' }, over);

  if (loginBlockReason(doctor({ pending_approval: true })) !== LOGIN_BLOCKED.PENDING_APPROVAL) {
    return 'a pending_approval doctor was not blocked';
  }
  if (loginBlockReason(doctor({ is_active: false })) !== LOGIN_BLOCKED.INACTIVE) {
    return 'a deactivated doctor was not blocked';
  }
  if (loginBlockReason(doctor({ is_active: true })) !== null) {
    return 'an active doctor was blocked';
  }
  // NULL is_active must read as ACTIVE, matching COALESCE(is_active, true) in
  // doctor.js:125 / assign.js:20 / auto_assign.js:74. A truthiness test here
  // would lock out the oldest doctor rows while still routing cases to them.
  if (loginBlockReason(doctor({ is_active: null })) !== null) {
    return 'a NULL is_active doctor was blocked — must read as active';
  }
  // is_paused is deliberately NOT a login gate (migrations/040: "excluded from
  // open-pool broadcasts", not logged out). It is set automatically on SLA
  // breach with no human in the loop, so gating login on it would be a silent
  // lockout. If this assertion is ever "fixed", read that migration first.
  if (loginBlockReason(doctor({ is_paused: true })) !== null) {
    return 'is_paused blocked login — see migrations/040, pause is not a login gate';
  }
  // Patients have no approval lifecycle.
  if (loginBlockReason({ role: 'patient', is_active: false }) !== null) {
    return 'a patient was gated by the doctor approval lifecycle';
  }
  if (loginBlockReason(null) !== null) {
    return 'a missing row produced a block reason instead of deferring to the caller';
  }
  return null;
});

check('every mobile auth handler that mints tokens calls loginBlockReason', () => {
  const src = code('src/routes/api/auth.js');
  // generateTokens( is the mint. Every occurrence must be preceded, within the
  // same handler, by a gate call. Counting is the robust proxy: there are four
  // mint sites (register, login, otp/verify, refresh) and register is the one
  // that just created the row.
  const mints = (src.match(/generateTokens\(/g) || []).length;
  const gates = (src.match(/loginBlockReason\(/g) || []).length;
  if (mints === 0) return 'generateTokens( not found — did api/auth.js move?';
  if (gates < 3) {
    return 'expected loginBlockReason at login, otp/verify and refresh; found ' + gates;
  }
  return null;
});

check('refresh re-checks status and burns the stored token when blocked', () => {
  const src = code('src/routes/api/auth.js');
  const i = src.indexOf("router.post('/refresh'");
  if (i < 0) return "POST /refresh not found";
  const body = src.slice(i, i + 3000);
  if (!/loginBlockReason\(/.test(body)) {
    return 'POST /refresh does not re-check account status — a 30-day refresh '
         + 'token would outlive a deactivation by up to a month';
  }
  if (!/refresh_token\s*=\s*NULL/i.test(body)) {
    return 'POST /refresh does not clear users.refresh_token on a blocked account';
  }
  return null;
});

check('the web login paths use the shared gate rather than inline copies', () => {
  const src = code('src/routes/auth.js');
  if (!/loginBlockReason\(/.test(src)) {
    return 'src/routes/auth.js no longer calls loginBlockReason';
  }
  // The two inline copies this replaced. Their return is what let mobile drift.
  if (/if\s*\(\s*!user\.is_active\s*\)/.test(src)) {
    return 'an inline `!user.is_active` login gate is back in src/routes/auth.js — '
         + 'use loginBlockReason so all four paths stay in step';
  }
  return null;
});

check('deactivating or rejecting a doctor revokes their refresh token', () => {
  const sa = code('src/routes/superadmin.js');
  if (!/is_active\s*=\s*false,\s*refresh_token\s*=\s*NULL/.test(sa)) {
    return 'the outreach deactivate UPDATE does not clear refresh_token';
  }
  const rejectIdx = sa.indexOf("doctors/:id/reject");
  if (rejectIdx < 0) return 'the reject route was not found';
  if (!/refresh_token\s*=\s*NULL/.test(sa.slice(rejectIdx, rejectIdx + 2500))) {
    return 'the web reject UPDATE does not clear refresh_token';
  }
  const svc = code('src/services/admin_doctor_reject.js');
  if (!/refresh_token\s*=\s*NULL/.test(svc)) {
    return 'admin_doctor_reject.js does not clear refresh_token';
  }
  return null;
});

// ── BLOCKER 2 — phone identity ────────────────────────────────────────────

check('isSameNumber accepts legacy spellings and refuses cross-country collisions', () => {
  const { isSameNumber } = require('../../src/validators/phone_identity');

  // The spellings the module exists to reconcile (see its 2026-08-25 header).
  if (!isSameNumber('+201277399043', '+201277399043', '+20')) return 'exact match rejected';
  if (!isSameNumber('01277399043', '+201277399043', '+20')) return 'EG local spelling rejected';
  if (!isSameNumber('1277399043', '+201277399043', '+20')) return 'bare spelling rejected';
  if (!isSameNumber('201277399043', '+201277399043', '+20')) return 'no-plus E.164 rejected';

  // THE TAKEOVER. Both are 12 digits in E.164, so the last-9 key is identical
  // and the old code would have signed the caller in as this row.
  if (isSameNumber('+447383109933', '+207383109933', '+20')) {
    return 'a GB number matched an EG number — the 9-digit collision is back';
  }
  if (isSameNumber('+201277399043', '+441277399043', '+44')) {
    return 'an EG number matched a GB number';
  }
  // Without a hint it must still refuse a different country.
  if (isSameNumber('+447383109933', '+207383109933', null)) {
    return 'cross-country match accepted when no country hint was supplied';
  }
  if (isSameNumber('', '+201277399043', '+20')) return 'an empty stored value matched';
  return null;
});

check('the suffix branch verifies candidates instead of returning them', () => {
  const src = code('src/validators/phone_identity.js');
  const i = src.indexOf('significantDigits(normalized || raw, 9)');
  if (i < 0) return 'the suffix branch was not found';
  const branch = src.slice(i, i + 2200);
  if (!/isSameNumber\(/.test(branch)) {
    return 'the suffix branch does not verify candidates with isSameNumber — a row '
         + 'sharing the last 9 digits can be signed in as a different person';
  }
  if (/matchedBy:\s*'suffix'\s*\}/.test(branch)) {
    return "an unverified matchedBy: 'suffix' result is being returned again";
  }
  return null;
});

check('the OTP phone heal-write is gated to verified match kinds', () => {
  const src = code('src/routes/api/auth.js');
  const i = src.indexOf('UPDATE users SET phone = $1 WHERE id = $2');
  if (i < 0) return 'the heal-write was not found';
  const before = src.slice(Math.max(0, i - 1200), i);
  // The CONDITION on the branch that performs the write, not merely the
  // presence of the variable somewhere above it. A first draft of this test
  // checked only that `_healableMatch` appeared nearby, and it passed happily
  // while the mutation had removed it from the `if` and left the declaration
  // and the suppression-log behind — exactly the shape a careless revert takes.
  const guard = before
    .split('\n')
    .reverse()
    .find((line) => /^\s*if\s*\(/.test(line));
  if (!guard || !/_healableMatch/.test(guard)) {
    return 'the branch performing the heal-write is not conditioned on '
         + '_healableMatch — an unverified match would overwrite the matched '
         + "account's phone with the caller's, locking the real owner out "
         + 'permanently';
  }
  if (!/'suffix_verified'/.test(before)) {
    return 'the heal allowlist does not name suffix_verified';
  }
  if (/'suffix'\s*[,\]]/.test(before)) {
    return "the heal allowlist contains the unverified 'suffix' kind";
  }
  return null;
});

check('findUserByPhone is given the caller country code at the OTP call site', () => {
  const src = code('src/routes/api/auth.js');
  if (!/findUserByPhone\(\s*\n?\s*safeAll,\s*normalizedPhone,\s*fullPhone,\s*OTP_ROLES,\s*countryCode/.test(src)) {
    return 'findUserByPhone is not being passed countryCode — legacy LOCAL '
         + 'spellings will stop resolving and patients will get duplicate accounts';
  }
  return null;
});

// ── BLOCKER 3 — the doctor diagnosis save tells the truth ─────────────────

check('a failed diagnosis save does not redirect to a success URL', () => {
  const src = code('src/routes/doctor.js');
  const i = src.indexOf("/portal/doctor/case/:caseId/diagnosis'");
  if (i < 0) return 'the diagnosis route was not found';
  const handler = src.slice(i, i + 6000);

  if (/success=notes_saved/.test(handler)) {
    return 'the handler still redirects with ?success=notes_saved — a parameter '
         + 'nothing reads, on both the success and failure paths';
  }
  if (!/error=notes_save_failed/.test(handler)) {
    return 'the catch block does not redirect with ?error=notes_save_failed';
  }
  if (!/saved=1/.test(handler)) {
    return 'the success path does not signal anything the view can render';
  }
  // The specific defect: the catch must RETURN, not fall through to the
  // success redirect below it.
  const catchIdx = handler.indexOf("context: 'doctor.save_diagnosis'");
  if (catchIdx < 0) return 'the diagnosis catch block was not found';
  const tail = handler.slice(catchIdx, handler.indexOf('saved=1'));
  if (!/return\s+res\.redirect/.test(tail)) {
    return 'the catch block does not return — control still falls through to '
         + 'the success redirect';
  }
  return null;
});

check('the case view renders both outcomes of a notes save', () => {
  const view = raw('src/views/portal_doctor_case.ejs');
  if (!/notesFlash/.test(view)) {
    return 'portal_doctor_case.ejs does not render notesFlash — a successful '
         + 'save is still an unexplained 302';
  }
  if (/Auto-saved as you type/.test(view.replace(/<%#[\s\S]*?%>/g, ''))) {
    return 'the "Auto-saved as you type" label is back, and there is still no '
         + 'autosave code in this view';
  }
  const doctorSrc = code('src/routes/doctor.js');
  if (!/notesFlash/.test(doctorSrc)) {
    return 'doctor.js does not pass notesFlash to the view';
  }
  for (const codeName of ['notes_save_failed', 'accept_failed', 'reason_required']) {
    if (!doctorSrc.includes(codeName + ':')) {
      return 'REPORT_SUBMIT_ERRORS has no entry for ' + codeName
           + ' — a handler redirects with it and the view renders nothing';
    }
  }
  return null;
});

// ── BLOCKER 4 — a reset is not an appeal ──────────────────────────────────

check('password reset no longer unconditionally reactivates an account', () => {
  const src = code('src/routes/auth.js');
  if (/SET password_hash = \$1,\s*is_active = true/.test(src)) {
    return 'an unconditional `is_active = true` is back in a password write — a '
         + 'deactivated doctor can restore themselves with any outstanding link';
  }
  const guarded = (src.match(/password_hash IS NULL AND rejection_reason IS NULL/g) || []).length;
  if (guarded < 2) {
    return 'expected the guarded activation in BOTH /set-password and '
         + '/reset-password/:token; found ' + guarded;
  }
  return null;
});

check('magic-login refuses deactivated and rejected accounts', () => {
  const src = code('src/routes/auth.js');
  const i = src.indexOf("router.get('/magic-login/:token'");
  if (i < 0) return 'the magic-login route was not found';
  const handler = src.slice(i, i + 3000);
  if (!/is_active === false/.test(handler)) {
    return 'magic-login does not check is_active — it will set a 7-day session '
         + 'cookie for a deactivated account and send it to /set-password';
  }
  if (!/rejection_reason/.test(handler)) {
    return 'magic-login does not check rejection_reason';
  }
  return null;
});

check('deactivate and reject burn outstanding password-reset tokens', () => {
  const sa = code('src/routes/superadmin.js');
  const burns = (sa.match(/DELETE FROM password_reset_tokens WHERE user_id = \$1 AND used_at IS NULL/g) || []).length;
  // One pre-existing remint burn inside _issueDoctorWelcomePayload, plus the
  // two added on deactivate and reject.
  if (burns < 3) {
    return 'expected token burns on deactivate and reject in addition to the '
         + 'remint burn; found ' + burns;
  }
  const svc = code('src/services/admin_doctor_reject.js');
  if (!/DELETE FROM password_reset_tokens/.test(svc)) {
    return 'admin_doctor_reject.js does not burn outstanding tokens — a rejected '
         + 'doctor keeps a live welcome link';
  }
  return null;
});

// ── BLOCKER 5 — no welcome without a login link ───────────────────────────

check('a welcome is only queued when the payload carries a magic link', () => {
  const sa = code('src/routes/superadmin.js');
  if (!/function _welcomePayloadIsSendable/.test(sa)) {
    return '_welcomePayloadIsSendable is gone';
  }
  const guards = (sa.match(/_welcomePayloadIsSendable\(/g) || []).length;
  // Definition + approve + resend + bulk outreach.
  if (guards < 4) {
    return 'expected the sendable check on the approve, resend and bulk-outreach '
         + 'senders; found ' + (guards - 1) + ' call sites';
  }

  const approveIdx = sa.indexOf("router.post('/superadmin/doctors/:id/approve'");
  if (approveIdx < 0) return 'the approve route was not found';
  const approve = sa.slice(approveIdx, approveIdx + 4000);
  if (!/if\s*\(\s*welcomeOk\s*\)/.test(approve)) {
    return 'the approve handler queues the welcome unconditionally — a token '
         + 'failure sends a doctor a welcome with an empty login link';
  }
  if (!/welcome=failed/.test(approve)) {
    return 'the approve handler does not tell the operator the welcome failed';
  }
  return null;
});

check('the doctor detail view distinguishes approved from approved-but-unsent', () => {
  const view = raw('src/views/superadmin_doctor_detail.ejs');
  if (!/flashWelcomeFailed/.test(view)) {
    return 'superadmin_doctor_detail.ejs does not render the welcome-failed '
         + 'state — the operator is told the welcome was queued either way';
  }
  return null;
});

check('_welcomePayloadIsSendable rejects the shapes that reach it', () => {
  // Exercised directly rather than by grep: magicLinkUrl: null is a SILENT
  // return from _issueDoctorWelcomePayload (baseUrl unresolvable), not a throw,
  // and that is the half the pre-existing try/catch never covered.
  const sa = raw('src/routes/superadmin.js');
  const m = sa.match(/function _welcomePayloadIsSendable\(payload\)\s*\{[\s\S]*?\n\}/);
  if (!m) return 'could not extract _welcomePayloadIsSendable';
  // eslint-disable-next-line no-new-func
  const fn = new Function(m[0] + '; return _welcomePayloadIsSendable;')();
  if (fn({ magicLinkUrl: 'https://tashkheesa.com/magic-login/abc' }) !== true) return 'a real link was rejected';
  if (fn({ magicLinkUrl: null }) !== false) return 'magicLinkUrl: null was accepted';
  if (fn({ magicLinkUrl: '   ' }) !== false) return 'a blank link was accepted';
  if (fn({}) !== false) return 'an empty payload was accepted';
  if (fn(null) !== false) return 'null was accepted';
  return null;
});
