// src/services/admin_doctor_pause.js
//
// Operator-initiated doctor PAUSE / REACTIVATE — the first mutating writes in
// the Command app. Mirrors the refund write template (services/admin_refund.js):
// the route hands in an already-connected client (from the INJECTED pool's
// db.connect()) and this service owns the BEGIN/COMMIT/ROLLBACK.
//
// `is_paused = true` removes the doctor from assignment eligibility — the assign
// endpoint, candidates picker, and bulk-auto-assign all reject/skip paused
// doctors. It is a pure flag flip + audit: NO case cascade, NO is_available
// change, login still works (distinct from is_active). Reactivate clears the
// three pause columns. Asymmetric writes, so two routes (not one toggle).
//
// Idempotency is REJECT (not no-op): an explicit operator action that would
// change nothing surfaces as an error (ALREADY_PAUSED / NOT_PAUSED).
//
// RLS is out of scope — the portal connects as the bypass role; the JWT +
// superadmin gate on the route is the security boundary.

'use strict';

const { randomUUID } = require('crypto');

// Throw-to-reject: carries an HTTP status + machine code out of the txn to the
// route, which maps err.http/err.code → res.fail (same as admin_refund.js).
function af(msg, http, code) {
  const e = new Error(msg);
  e.http = http;
  e.code = code;
  return e;
}

/**
 * @param {import('pg').PoolClient} client  already-connected pg client
 * @param {{ doctorId: string, paused: boolean, reason?: string|null, actorId: string }} opts
 * @returns {Promise<{ id: string, isPaused: boolean, pausedAt: string|null, pauseReason: string|null }>}
 */
async function setDoctorPause(client, opts) {
  const doctorId = String(opts && opts.doctorId ? opts.doctorId : '').trim();
  const paused = !!(opts && opts.paused);
  const reason = opts && opts.reason != null ? String(opts.reason).trim() : null;
  const actorId = opts && opts.actorId ? opts.actorId : null;

  await client.query('BEGIN');
  try {
    // (1) lock the row; must exist and be a doctor (re-read in-txn, never trust
    //     the caller). FOR UPDATE serializes two operators on the same doctor.
    const u = (await client.query(
      `SELECT id, role, is_paused FROM users WHERE id = $1 FOR UPDATE`,
      [doctorId]
    )).rows[0];
    if (!u || u.role !== 'doctor') throw af('Doctor not found', 404, 'DOCTOR_NOT_FOUND');

    // (2) idempotency — reject, not no-op.
    if (paused && u.is_paused === true) throw af('Doctor is already paused', 409, 'ALREADY_PAUSED');
    if (!paused && u.is_paused !== true) throw af('Doctor is not paused', 409, 'NOT_PAUSED');

    // (3) the asymmetric write — pause stamps the flag + time + reason;
    //     reactivate clears all three.
    const upd = paused
      ? await client.query(
          `UPDATE users SET is_paused = true, paused_at = NOW(), pause_reason = $2
             WHERE id = $1
           RETURNING id, is_paused, paused_at, pause_reason`,
          [doctorId, reason]
        )
      : await client.query(
          `UPDATE users SET is_paused = false, paused_at = NULL, pause_reason = NULL
             WHERE id = $1
           RETURNING id, is_paused, paused_at, pause_reason`,
          [doctorId]
        );
    const row = upd.rows[0];

    // (4) admin audit on the txn client (atomic with the flag write). Shape
    //     matches admin_refund.js / doctor_pause.js: error_logs, level 'audit',
    //     category 'admin_audit', user_id = the operator (actor).
    const action = paused ? 'paused_doctor' : 'reactivated_doctor';
    await client.query(
      `INSERT INTO error_logs (id, level, category, message, user_id, context)
         VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [
        randomUUID(),
        `${action}: ${doctorId}`,
        actorId,
        JSON.stringify({ action, target: doctorId, reason: paused ? reason : null }),
      ]
    );

    await client.query('COMMIT');

    return {
      id: row.id,
      isPaused: !!row.is_paused,
      pausedAt: row.paused_at ? new Date(row.paused_at).toISOString() : null,
      pauseReason: row.pause_reason || null,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

module.exports = { setDoctorPause };
