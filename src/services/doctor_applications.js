'use strict';

// Public doctor-application staging write.
//
// Split-lifecycle (mirrors src/services/admin_refund.js): the CALLER owns the pg
// client (db.connect()/release()); this service owns ONLY the BEGIN/COMMIT, with
// a ROLLBACK in catch and a rethrow. It never calls connect()/release() and
// never uses withTransaction.
//
// Applications are NOT doctors: this writes to `doctor_applications` only and
// touches `users` not at all. The row is the operator's review queue (slice 2).

/**
 * @param {import('pg').PoolClient} client  already-connected pg client (caller owns its lifecycle)
 * @param {object} data  normalized record from validators/apply.buildApplicationRecord()
 * @returns {Promise<{ id: string, status: string, source: string, createdAt: string|null }>}
 */
async function createApplication(client, data) {
  await client.query('BEGIN');
  try {
    const ins = await client.query(
      `INSERT INTO doctor_applications (
         full_name, full_name_ar, email, phone,
         specialty_id, specialty_other, sub_specialties,
         medical_license_number, license_country, bio, bio_ar,
         cv_url, current_affiliation, years_experience,
         source, submitter_ip, user_agent
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7::jsonb,
         $8, $9, $10, $11,
         $12, $13, $14,
         $15, $16, $17
       )
       RETURNING id, status, source, created_at`,
      [
        data.full_name,
        data.full_name_ar,
        data.email,
        data.phone,
        data.specialty_id,
        data.specialty_other,
        JSON.stringify(Array.isArray(data.sub_specialties) ? data.sub_specialties : []),
        data.medical_license_number,
        data.license_country,
        data.bio,
        data.bio_ar,
        data.cv_url,
        data.current_affiliation,
        data.years_experience,
        data.source || 'web_apply',
        data.submitter_ip,
        data.user_agent,
      ]
    );

    await client.query('COMMIT');

    const row = ins.rows[0] || null;
    return row
      ? {
          id: row.id,
          status: row.status,
          source: row.source,
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        }
      : null;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

module.exports = { createApplication };
