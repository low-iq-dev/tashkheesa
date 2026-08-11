// src/services/admin_doctor_bulk_invite.js
//
// Bulk welcome-to-passwordless — Package 2 (Task 30) of the "My Services" build.
// Loops the existing inviteDoctor(client, …) over every password-less active
// doctor to onboard the doctors who have never logged in. Reuses the
// single-doctor invite verbatim (token mint + welcome stamp + audit, one
// txn/doctor) — this file only owns the SELECT + the per-doctor loop + the
// cooldown/skip policy. It NEVER mints or deletes tokens itself.
//
// IDEMPOTENCY / "one live token per doctor":
//   • This file contributes the welcome_email_last_sent_at COOLDOWN: a doctor
//     invited within DEFAULT_COOLDOWN_HOURS is reported skipped, not re-sent —
//     so a same-window re-run mints no second token and re-notifies nobody.
//   • The complementary guarantee — that even a POST-cooldown re-invite leaves
//     exactly one LIVE token — belongs to inviteDoctor's remint-DELETE (Task 27,
//     Package 2). That is intentionally NOT implemented here: this loop calls
//     inviteDoctor, so once Task 27 lands the remint-DELETE inside it, this file
//     inherits the single-live-token invariant with ZERO changes. We do not
//     replicate remint behaviour speculatively.
//
// SHIP IN THE SAME RELEASE AS THE ASSIGNMENT GATE (spec §9): all current doctors
// are onboarding_complete=false → unassignable until they confirm services; a
// gate without a way to (re)send invites strands every doctor.
//
// The caller hands in an already-connected pg client used ONLY for the read-side
// SELECT (thread your own connection); if omitted we borrow one from the pool.
// Each doctor is invited on a FRESH pool.connect() client because inviteDoctor
// owns its own BEGIN/COMMIT — reusing an in-txn client would nest transactions.

'use strict';

const { pool } = require('../pg');
const { inviteDoctor } = require('./admin_doctor_invite');

// Passive-recipient cooldown: don't re-blast a doctor invited in the last day.
// Matches the "one live token" posture — a fresh invite inside this window is a
// no-op skip, not a second send.
const DEFAULT_COOLDOWN_HOURS = 24;

/**
 * @param {import('pg').PoolClient|null} client  connected client for the read SELECT (borrowed from the pool if null)
 * @param {{ actorId: string, baseUrl: string|null, cooldownHours?: number,
 *           idPrefix?: string|null,
 *           onInvited?: (doctorId: string, welcomePayload: object) => (void|Promise<void>) }} opts
 * @returns {Promise<{ sent: number, skipped: number, failed: number,
 *   invited: Array<{doctorId:string, welcomePayload:object}>,
 *   skippedIds: string[], failedIds: string[] }>}
 */
async function bulkWelcomePasswordlessDoctors(client, opts = {}) {
  const actorId = opts.actorId || null;
  const baseUrl = opts.baseUrl || null;
  const cooldownHours = Number.isFinite(opts.cooldownHours) ? opts.cooldownHours : DEFAULT_COOLDOWN_HOURS;
  const idPrefix = opts.idPrefix || null; // test-scoping only; null in prod
  const onInvited = typeof opts.onInvited === 'function' ? opts.onInvited : null;

  // Borrow a read client if the caller didn't thread one.
  let readClient = client;
  let ownsRead = false;
  if (!readClient) { readClient = await pool.connect(); ownsRead = true; }

  const out = { sent: 0, skipped: 0, failed: 0, invited: [], skippedIds: [], failedIds: [] };

  try {
    // (1) ONE upfront SELECT of the whole password-less active-doctor cohort, with
    //     the DB computing per-row cooldown eligibility (TZ-safe — never a JS
    //     clock; explicit ::int cast is Tier-A typing). We partition in JS:
    //     eligible → invite now; cooled → reported skipped. Reading the cohort
    //     BEFORE the invite loop is deliberate — a doctor invited in THIS run was
    //     eligible at SELECT time, so it counts as sent and is never
    //     double-counted as cooled. The cohort is a few dozen rows in prod;
    //     idPrefix scopes tests to their own fixtures and is null in prod.
    const params = [cooldownHours];
    let where = `role = 'doctor' AND is_active = true AND password_hash IS NULL`;
    if (idPrefix) { params.push(idPrefix + '%'); where += ` AND id LIKE $${params.length}`; }
    const rows = (await readClient.query(
      `SELECT id,
              (welcome_email_last_sent_at IS NULL
               OR welcome_email_last_sent_at < NOW() - ($1::int * interval '1 hour')) AS eligible
         FROM users
        WHERE ${where}
        ORDER BY id ASC`,
      params
    )).rows;

    const toInvite = [];
    for (const r of rows) {
      if (r.eligible) toInvite.push(r.id);
      else { out.skipped += 1; out.skippedIds.push(r.id); } // within cooldown → not re-sent
    }

    // (2) Invite each eligible doctor on its OWN fresh txn client — inviteDoctor
    //     owns BEGIN/COMMIT, so reusing an in-txn client would nest transactions.
    //     One doctor's failure never aborts the batch. A benign not-active /
    //     not-found race (row changed between SELECT and lock) is a skip; anything
    //     else is a failure (logged, batch continues).
    for (const doctorId of toInvite) {
      const per = await pool.connect();
      try {
        const { welcomePayload } = await inviteDoctor(per, { doctorId, baseUrl, actorId });
        out.sent += 1;
        out.invited.push({ doctorId, welcomePayload });
        if (onInvited) { try { await onInvited(doctorId, welcomePayload); } catch (_) { /* notify is best-effort — route's concern */ } }
      } catch (err) {
        if (err && (err.code === 'DOCTOR_NOT_ACTIVE' || err.code === 'DOCTOR_NOT_FOUND')) {
          out.skipped += 1; out.skippedIds.push(doctorId);
        } else {
          out.failed += 1; out.failedIds.push(doctorId);
          console.error('[bulk-welcome] invite failed:', doctorId, err && err.message ? err.message : err);
        }
      } finally {
        per.release();
      }
    }

    return out;
  } finally {
    if (ownsRead) { try { readClient.release(); } catch (_) { /* already released */ } }
  }
}

module.exports = { bulkWelcomePasswordlessDoctors, DEFAULT_COOLDOWN_HOURS };
