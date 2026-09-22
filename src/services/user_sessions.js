'use strict';

// src/services/user_sessions.js
//
// Batch C (fix plan 2026-09-15, C1) — one row per signed-in device.
//
// THE BUG THIS EXISTS TO FIX
// --------------------------
// users.refresh_token is a single shared column and every sign-in and every
// refresh overwrites it (routes/api/auth.js, routes/api/admin.js). A second
// sign-in anywhere — another device, Command, an account merge — silently
// invalidated the first device's token, and that client's next refresh
// returned REFRESH_REVOKED against a perfectly good session. users.push_token
// had the same shape: a second device silently stole push.
//
// THE MODEL
// ---------
// user_sessions (migration 110): one row per device. The refresh token is the
// row's identity — a sign-in INSERTs a row, a refresh rotates the token
// INSIDE its row (lookup is by token, unique index), a sign-out revokes that
// row only. The session id travels in the JWTs as the `sid` claim so access-
// token-authenticated writes (logout, push registration) can target the
// device they came from.
//
// WHO IS AUTHORITATIVE
// --------------------
// From migration 110 onward, user_sessions is authoritative for refresh and
// push tokens. users.refresh_token / users.push_token are kept as a
// TRANSITION MIRROR only:
//   * mirror WRITE on create/rotate — so a rollback to pre-C1 code leaves the
//     most recent device signed in (exactly the pre-C1 behaviour);
//   * mirror READ as a refresh fallback — a token minted by pre-C1 code in
//     the deploy window (after the migration snapshot, before cutover) is
//     adopted into a session row on its first refresh instead of being
//     rejected;
//   * push senders read the UNION of live session push tokens and the mirror.
// Dropping the mirror (column removal) is a later, separate migration; until
// then no code path may treat the columns as the source of truth.
//
// All functions take the same injected query helpers the API routers already
// use ({ safeGet, safeAll, safeRun }) so hermetic route tests can stub them.

const { randomUUID } = require('crypto');

function newSessionId() {
  return 'sess-' + randomUUID();
}

module.exports = function createSessionStore({ safeGet, safeAll, safeRun }) {
  /**
   * Record a fresh sign-in as a new device session. The caller mints the
   * token pair FIRST (with this id as the `sid` claim) and passes the refresh
   * token in — the `sid` claim is also what makes two same-second tokens for
   * one user distinct under the unique refresh_token index.
   *
   * If the client supplied a stable deviceId, any prior live session for the
   * same (user, device) is revoked first: a re-login on the same phone
   * replaces its row rather than accumulating one per sign-in.
   */
  async function createSession({ id, userId, refreshToken, client, deviceId, deviceName }) {
    if (deviceId) {
      await safeRun(
        `UPDATE user_sessions SET revoked_at = NOW()
          WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
        [userId, deviceId]
      );
    }
    await safeRun(
      `INSERT INTO user_sessions (id, user_id, refresh_token, client, device_id, device_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, refreshToken, client || null, deviceId || null, deviceName || null]
    );
    // Transition mirror (see header). Pre-C1 code reads this column.
    await safeRun('UPDATE users SET refresh_token = $1 WHERE id = $2', [refreshToken, userId]);
    return id;
  }

  /** The live session a presented refresh token belongs to, or null. */
  async function findLiveByToken(refreshToken) {
    if (!refreshToken) return null;
    return safeGet(
      'SELECT * FROM user_sessions WHERE refresh_token = $1 AND revoked_at IS NULL',
      [refreshToken]
    );
  }

  /**
   * Rotate the refresh token inside its session row. Guarded on the OLD token
   * still being the row's current one, so two racing refreshes from the same
   * device cannot both succeed — the loser sees rowCount 0 and reports
   * REFRESH_REVOKED, same as the single-column rotation did.
   */
  async function rotate(sessionId, oldToken, newToken, userId) {
    const r = await safeRun(
      `UPDATE user_sessions
          SET refresh_token = $1, last_seen_at = NOW()
        WHERE id = $2 AND refresh_token = $3 AND revoked_at IS NULL`,
      [newToken, sessionId, oldToken]
    );
    const rotated = !!(r && r.rowCount);
    if (rotated) {
      // Transition mirror (see header).
      await safeRun('UPDATE users SET refresh_token = $1 WHERE id = $2', [newToken, userId]);
    }
    return rotated;
  }

  /**
   * Adopt a token that pre-C1 code minted after the migration-110 snapshot:
   * it matches users.refresh_token but has no session row. Creates the row it
   * should have had (device 'legacy', like the seeded ones) and returns it.
   */
  async function adoptLegacyToken(user, refreshToken) {
    // Spec review S3 — pre-C1 semantics were single-slot: at the moment the
    // mirror's token is adopted, any OTHER token still sitting in a live
    // 'legacy' row (the migration-110 seed taken before old code rotated in
    // the deploy window) was already rotated away and must not stay
    // redeemable as a second phantom device.
    await safeRun(
      `UPDATE user_sessions SET revoked_at = NOW()
        WHERE user_id = $1 AND device_id = 'legacy' AND refresh_token <> $2 AND revoked_at IS NULL`,
      [user.id, refreshToken]
    );
    const id = newSessionId();
    await safeRun(
      `INSERT INTO user_sessions (id, user_id, refresh_token, push_token, client, device_id)
       VALUES ($1, $2, $3, $4, 'legacy', 'legacy')
       ON CONFLICT DO NOTHING`,
      [id, user.id, refreshToken, user.push_token || null]
    );
    return findLiveByToken(refreshToken);
  }

  /**
   * Sign out one device. Row is kept (revoked_at) for audit. If the mirror
   * column happens to hold THIS session's token (this device was the last to
   * sign in or rotate), it is cleared too, so a rollback to pre-C1 code does
   * not resurrect a token the user just retired.
   */
  async function revokeById(sessionId, userId) {
    // `userId` (adversarial X5, defense-in-depth): every caller today derives
    // sessionId from a SIGNED JWT's sid, so it can only name the caller's own
    // row — but the WHERE clause makes cross-user revocation structurally
    // impossible even if a future caller wires a sid from anywhere else.
    await safeRun(
      `UPDATE user_sessions SET revoked_at = NOW()
        WHERE id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR user_id = $2)`,
      [sessionId, userId || null]
    );
    await safeRun(
      `UPDATE users SET refresh_token = NULL
        WHERE id = (SELECT user_id FROM user_sessions WHERE id = $1)
          AND refresh_token = (SELECT refresh_token FROM user_sessions WHERE id = $1)`,
      [sessionId]
    );
    // Spec review S4 — the push MIRROR (users.push_token) must not keep
    // following a device that just signed out (the pre-C1 AUDIT-APP-H6
    // contract). Cleared when it is attributable to THIS device (matches the
    // revoked session's push token), or when the user has no live session
    // left at all (single-device user whose pre-C1 registration lives only in
    // the mirror). A still-signed-in OTHER device's mirror registration is
    // left alone.
    await safeRun(
      `UPDATE users SET push_token = NULL
        WHERE id = (SELECT user_id FROM user_sessions WHERE id = $1)
          AND push_token IS NOT NULL
          AND (
            push_token = (SELECT push_token FROM user_sessions WHERE id = $1)
            OR NOT EXISTS (
              SELECT 1 FROM user_sessions s2
               WHERE s2.user_id = (SELECT user_id FROM user_sessions WHERE id = $1)
                 AND s2.revoked_at IS NULL
            )
          )`,
      [sessionId]
    );
  }

  /**
   * Sign out the pre-C1 sessions of a user — the target of a logout carrying
   * an access token with no `sid` claim. Such a token can only have been
   * minted by pre-C1 code, and the only session rows those sign-ins have are
   * the 'legacy' ones (seeded by migration 110 or adopted above).
   */
  async function revokeLegacyForUser(userId) {
    await safeRun(
      `UPDATE user_sessions SET revoked_at = NOW()
        WHERE user_id = $1 AND device_id = 'legacy' AND revoked_at IS NULL`,
      [userId]
    );
  }

  /**
   * Kill every device (deactivate / reject / explicit revoke-all). The
   * account-state gate on refresh already refuses blocked users; this makes
   * the stored tokens dead too, matching the existing refresh_token = NULL
   * writes those admin paths keep doing to the mirror column.
   */
  async function revokeAllForUser(userId) {
    await safeRun(
      'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
  }

  /**
   * Register / replace this DEVICE's push token (targeted by `sid`).
   * `userId` — same X5 defense-in-depth ownership clause as revokeById.
   */
  async function setPushToken(sessionId, pushToken, userId) {
    const r = await safeRun(
      `UPDATE user_sessions SET push_token = $1, last_seen_at = NOW()
        WHERE id = $2 AND revoked_at IS NULL AND ($3::text IS NULL OR user_id = $3)`,
      [pushToken || null, sessionId, userId || null]
    );
    return !!(r && r.rowCount);
  }

  /**
   * Every live device push token for a user — sessions UNION the transition
   * mirror (users.push_token), deduped, so a device registered by pre-C1 code
   * keeps receiving push until it re-registers.
   */
  async function livePushTokensForUser(userId) {
    const rows = await safeAll(
      `SELECT DISTINCT push_token FROM user_sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND push_token IS NOT NULL`,
      [userId]
    );
    const tokens = (rows || []).map((r) => r.push_token).filter(Boolean);
    const legacy = await safeGet('SELECT push_token FROM users WHERE id = $1', [userId]);
    if (legacy && legacy.push_token && !tokens.includes(legacy.push_token)) {
      tokens.push(legacy.push_token);
    }
    return tokens;
  }

  return {
    newSessionId,
    createSession,
    findLiveByToken,
    rotate,
    adoptLegacyToken,
    revokeById,
    revokeLegacyForUser,
    revokeAllForUser,
    setPushToken,
    livePushTokensForUser,
  };
};

module.exports.newSessionId = newSessionId;
