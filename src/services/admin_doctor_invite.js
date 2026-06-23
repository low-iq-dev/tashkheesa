// src/services/admin_doctor_invite.js
//
// Operator-initiated doctor INVITE / resend-welcome — slice 2b. A STANDALONE
// action (NOT coupled to approve, which stays SILENT — see admin_doctor_approve.js).
// Available on ANY ACTIVE doctor, serving as BOTH first-invite AND resend; the
// Command app warns before a re-send, the backend always allows the (re)send.
//
// Mirrors the pause/approve write template (services/admin_doctor_pause.js /
// admin_doctor_approve.js): the route hands in an already-connected client (from
// the INJECTED pool's db.connect()) and this service owns BEGIN/COMMIT/ROLLBACK.
//
// This is the EXTRACTED + REFACTORED token logic from the web's
// _issueDoctorWelcomePayload (src/routes/superadmin.js:3132), but running on the
// injected txn client instead of the module pool + req. The web flow's
// best-effort stamp becomes an IN-TXN write here (deliberately stricter): token
// INSERT + welcome stamp + audit are atomic, and FOR UPDATE serializes
// concurrent invites for one doctor. The PURE payload build is shared via
// ./doctor_welcome_payload (so superadmin.js stays untouched — zero web risk).
//
// RLS is out of scope — the portal connects as the bypass role; the JWT +
// superadmin gate on the route is the security boundary.

'use strict';

const { randomUUID } = require('crypto');
const { buildDoctorWelcomePayload, WELCOME_EXPIRY_HOURS } = require('./doctor_welcome_payload');

// Throw-to-reject: carries an HTTP status + machine code out of the txn to the
// route, which maps err.http/err.code → res.fail (same as admin_doctor_pause.js).
function af(msg, http, code) {
  const e = new Error(msg);
  e.http = http;
  e.code = code;
  return e;
}

/**
 * @param {import('pg').PoolClient} client  already-connected pg client
 * @param {{ doctorId: string, baseUrl: string|null, actorId: string }} opts
 * @returns {Promise<{ welcomePayload: object, lastInvitedAt: string|null }>}
 */
async function inviteDoctor(client, opts) {
  const doctorId = String(opts && opts.doctorId ? opts.doctorId : '').trim();
  const actorId = opts && opts.actorId ? opts.actorId : null;
  const baseUrl = opts && opts.baseUrl ? opts.baseUrl : null;

  await client.query('BEGIN');
  try {
    // (1) lock the row; must exist and be a doctor (re-read in-txn, never trust
    //     the caller). FOR UPDATE serializes two operators on the same doctor.
    const u = (await client.query(
      `SELECT id, role, is_active, name, lang, welcome_email_last_sent_at
         FROM users WHERE id = $1 FOR UPDATE`,
      [doctorId]
    )).rows[0];
    if (!u || u.role !== 'doctor') throw af('Doctor not found', 404, 'DOCTOR_NOT_FOUND');

    // (2) must be ACTIVE — you cannot invite a pending/inactive doctor (approve
    //     them first). An already-invited ACTIVE doctor is NOT rejected: /invite
    //     is BOTH first-invite and resend.
    if (u.is_active !== true) throw af('Doctor is not active', 409, 'DOCTOR_NOT_ACTIVE');

    // (3) issue a fresh 7-day magic-login token. Columns/expiry match the web
    //     helper exactly (id, user_id, token, expires_at, used_at, created_at).
    //     Explicit ::int cast on the interval multiplier (Tier-A typing).
    const token = randomUUID();
    await client.query(
      `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
         VALUES ($1, $2, $3, NOW() + ($4::int * interval '1 hour'), NULL, NOW())`,
      [randomUUID(), doctorId, token, WELCOME_EXPIRY_HOURS]
    );

    // (4) stamp the last-sent timestamp IN-TXN (stricter than the web's
    //     best-effort) so token + stamp + audit stay consistent. RETURNING gives
    //     the exact NOW() written for the response's lastInvitedAt.
    const upd = await client.query(
      `UPDATE users SET welcome_email_last_sent_at = NOW() WHERE id = $1
         RETURNING welcome_email_last_sent_at`,
      [doctorId]
    );
    const stamped = upd.rows[0] && upd.rows[0].welcome_email_last_sent_at;
    const lastInvitedAt = stamped ? new Date(stamped).toISOString() : null;

    // (5) admin audit on the txn client (atomic with token + stamp). Shape
    //     matches admin_doctor_pause.js / admin_doctor_approve.js.
    await client.query(
      `INSERT INTO error_logs (id, level, category, message, user_id, context)
         VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [
        randomUUID(),
        `invited_doctor: ${doctorId}`,
        actorId,
        JSON.stringify({ action: 'invited_doctor', target: doctorId }),
      ]
    );

    await client.query('COMMIT');

    // (6) build the welcome payload from the committed token (pure, no DB). A
    //     null baseUrl yields a null magicLinkUrl (same as the web helper).
    const welcomePayload = buildDoctorWelcomePayload({ doctor: u, token, baseUrl });
    return { welcomePayload, lastInvitedAt };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

module.exports = { inviteDoctor };
