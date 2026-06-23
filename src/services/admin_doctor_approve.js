// src/services/admin_doctor_approve.js
//
// Operator-initiated doctor APPROVE (pending → active) — slice 2a. Mirrors the
// pause write template (services/admin_doctor_pause.js): the route hands in an
// already-connected client (from the INJECTED pool's db.connect()) and this
// service owns BEGIN/COMMIT/ROLLBACK.
//
// SILENT + atomic, by design. This flips the pending/active flags and audits —
// nothing else. The web approve ALSO issues a 7-day magic-login token and fires
// a doctor_approved notification (internal + email + WhatsApp). Those are
// deliberately OMITTED here and deferred to slice 2b (a separate reviewed
// build), exactly as case assignment shipped silent before assign-notifications.
// This service must NEVER touch password_reset_tokens / welcome_email_last_sent_at
// or call queueMultiChannelNotification / queueNotification / sendEmail / Twilio.
//
// RLS is out of scope — the portal connects as the bypass role; the JWT +
// superadmin gate on the route is the security boundary.

'use strict';

const { randomUUID } = require('crypto');

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
 * @param {{ doctorId: string, actorId: string }} opts
 * @returns {Promise<{ id: string, isActive: boolean, pendingApproval: boolean, approvedAt: string|null, approvedBy: string|null }>}
 */
async function setDoctorApproval(client, opts) {
  const doctorId = String(opts && opts.doctorId ? opts.doctorId : '').trim();
  const actorId = opts && opts.actorId ? opts.actorId : null;

  await client.query('BEGIN');
  try {
    // (1) lock the row; must exist and be a doctor (re-read in-txn, never trust
    //     the caller). FOR UPDATE serializes two operators on the same doctor.
    const u = (await client.query(
      `SELECT id, role, pending_approval FROM users WHERE id = $1 FOR UPDATE`,
      [doctorId]
    )).rows[0];
    if (!u || u.role !== 'doctor') throw af('Doctor not found', 404, 'DOCTOR_NOT_FOUND');

    // (2) must be pending — reject (not no-op) an already-approved/rejected row.
    if (u.pending_approval !== true) throw af('Doctor is not pending approval', 409, 'NOT_PENDING');

    // (3) the write — clears pending, activates, stamps approver. Matches the web
    //     approve's columns PLUS approved_by (web omits it; we set it for audit).
    const upd = await client.query(
      `UPDATE users
          SET pending_approval = false,
              is_active = true,
              approved_at = NOW(),
              approved_by = $2,
              rejection_reason = NULL
        WHERE id = $1
       RETURNING id, is_active, pending_approval, approved_at, approved_by`,
      [doctorId, actorId]
    );
    const row = upd.rows[0];

    // (4) admin audit on the txn client (atomic with the flag write). Shape
    //     matches admin_doctor_pause.js / admin_refund.js.
    await client.query(
      `INSERT INTO error_logs (id, level, category, message, user_id, context)
         VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [
        randomUUID(),
        `approved_doctor: ${doctorId}`,
        actorId,
        JSON.stringify({ action: 'approved_doctor', target: doctorId }),
      ]
    );

    await client.query('COMMIT');

    return {
      id: row.id,
      isActive: !!row.is_active,
      pendingApproval: !!row.pending_approval,
      approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
      approvedBy: row.approved_by || null,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

module.exports = { setDoctorApproval };
