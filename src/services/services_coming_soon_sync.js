// src/services/services_coming_soon_sync.js
//
// Re-sync helper — keeps services.coming_soon truthful. A service is
// coming_soon iff it has NO active doctor mapped to it. Keyed on
// users.is_active (NOT is_paused — pausing a doctor must not hide a service
// from the catalogue; see design §4.3 / §10). Idempotent: safe to call after
// any doctor_services change or any change to a doctor's is_active.
//
// Runs the EXACT design §4.3 UPDATE, unchanged. Accepts an optional pg client
// so a caller can fold the re-sync into its own transaction (atomic with the
// status flip); when omitted it runs a single autocommit statement on the pool.
//
// Callers that own a txn (the Command services admin_doctor_approve /
// admin_doctor_pause) pass their client so the recompute commits/rolls-back
// atomically with the write. Web routes (superadmin.js, execute()/pool
// autocommit) call it with no client, post-commit + best-effort.

'use strict';

const { pool } = require('../pg');

const RESYNC_SQL = `
  UPDATE public.services sv
  SET coming_soon = NOT EXISTS (
    SELECT 1 FROM public.doctor_services ds
    JOIN public.users u ON u.id = ds.doctor_id
    WHERE ds.service_id = sv.id
      AND u.role = 'doctor' AND u.is_active = true
  )`;

/**
 * Recompute services.coming_soon for every service.
 * @param {import('pg').PoolClient} [client] optional txn client; pool if omitted
 * @returns {Promise<import('pg').QueryResult>}
 */
async function resyncComingSoon(client) {
  const runner = client || pool;
  return runner.query(RESYNC_SQL);
}

module.exports = { resyncComingSoon };
