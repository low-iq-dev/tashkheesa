// src/services/admin_doctor_reject.js
//
// Operator-initiated doctor REJECT (pending → rejected) — slice 3. Mirrors the
// approve write template (services/admin_doctor_approve.js): the route hands in
// an already-connected client (from the INJECTED pool's db.connect()) and this
// service owns BEGIN/COMMIT/ROLLBACK.
//
// Atomic. Flips the pending/active flags, clears approved_at, stamps the
// rejection reason, and audits — nothing else. Like the SILENT approve service,
// this does NOT send any notification; the web reject's INTERNAL-ONLY in-app
// notice is fired POST-COMMIT/off-txn by the route (so a notify failure can't
// roll back the rejection). No email/WhatsApp ('doctor_rejected' has no such
// template).
//
// There is NO rejected_by / rejected_at column (unlike approve's approved_by) —
// the actor and the reason are captured in the error_logs admin_audit row's
// context instead, so no schema change is needed.
//
// RLS is out of scope — the portal connects as the bypass role; the JWT +
// superadmin gate on the route is the security boundary.

'use strict';

const { randomUUID } = require('crypto');

// Throw-to-reject: carries an HTTP status + machine code out of the txn to the
// route, which maps err.http/err.code → res.fail (same as admin_doctor_approve.js).
function af(msg, http, code) {
  const e = new Error(msg);
  e.http = http;
  e.code = code;
  return e;
}

/**
 * @param {import('pg').PoolClient} client  already-connected pg client
 * @param {{ doctorId: string, reason?: string, actorId: string }} opts
 * @returns {Promise<{ id: string, isActive: boolean, pendingApproval: boolean, rejectionReason: string|null }>}
 */
async function setDoctorRejection(client, opts) {
  const doctorId = String(opts && opts.doctorId ? opts.doctorId : '').trim();
  const actorId = opts && opts.actorId ? opts.actorId : null;
  // Optional reason → defaults to 'Not approved' (matches the web reject at
  // superadmin.js:3292). The route also applies this default; defaulting here
  // too keeps the service self-contained (rejection_reason is never empty).
  const reason = (opts && typeof opts.reason === 'string' && opts.reason.trim())
    ? opts.reason.trim()
    : 'Not approved';

  await client.query('BEGIN');
  try {
    // (1) lock the row; must exist and be a doctor (re-read in-txn, never trust
    //     the caller). FOR UPDATE serializes two operators on the same doctor.
    const u = (await client.query(
      `SELECT id, role, pending_approval FROM users WHERE id = $1 FOR UPDATE`,
      [doctorId]
    )).rows[0];
    if (!u || u.role !== 'doctor') throw af('Doctor not found', 404, 'DOCTOR_NOT_FOUND');

    // (2) must be pending — reject (not no-op) an already-approved/active row.
    //     The web reject omits this guard; we add it for symmetry with approve.
    if (u.pending_approval !== true) throw af('Doctor is not pending approval', 409, 'NOT_PENDING');

    // (3) the write — clears pending + active, clears approved_at, stamps the
    //     reason. Matches the web reject's columns exactly. approved_by is left
    //     untouched (unlike approve, which sets it).
    const upd = await client.query(
      `UPDATE users
          SET pending_approval = false,
              is_active = false,
              approved_at = NULL,
              rejection_reason = $2
        WHERE id = $1
       RETURNING id, is_active, pending_approval, rejection_reason`,
      [doctorId, reason]
    );
    const row = upd.rows[0];

    // (4) admin audit on the txn client (atomic with the flag write). Shape
    //     matches admin_doctor_approve.js / admin_doctor_pause.js. The reason is
    //     carried in the context JSON — our substitute for a rejected_by/at column.
    await client.query(
      `INSERT INTO error_logs (id, level, category, message, user_id, context)
         VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [
        randomUUID(),
        `rejected_doctor: ${doctorId}`,
        actorId,
        JSON.stringify({ action: 'rejected_doctor', target: doctorId, reason }),
      ]
    );

    await client.query('COMMIT');

    return {
      id: row.id,
      isActive: !!row.is_active,
      pendingApproval: !!row.pending_approval,
      rejectionReason: row.rejection_reason || null,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

module.exports = { setDoctorRejection };
