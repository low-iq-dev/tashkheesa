const { queryAll, queryOne } = require('./pg');

async function pickDoctorForOrder({ specialtyId, serviceId }) {
  if (!specialtyId) return null;

  // §4.6: onboarding gate + service-level matching. When serviceId is missing
  // (legacy caller), fall back to specialty-only so we never hard-fail routing.
  const serviceClause = serviceId
    ? `AND COALESCE(u.onboarding_complete, false) = true
         AND EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = u.id AND ds.service_id = $2)`
    : '';
  const params = serviceId ? [specialtyId, serviceId] : [specialtyId];

  // Eligible doctors by specialty
  const doctors = await queryAll(
    `SELECT u.id, u.name, u.email
     FROM users u
     WHERE u.role = 'doctor'
       AND u.is_active = true
       AND COALESCE(u.is_paused, false) = false
       AND COALESCE(u.pending_approval, false) = false
       AND u.specialty_id = $1
       ${serviceClause}
     ORDER BY u.name ASC`,
    params
  );

  if (!doctors || !doctors.length) return null;

  let best = null;
  for (const doc of doctors) {
    // AUDIT-P0-2c — the load count was `status IN ('new','accepted','in_review')`:
    // case-sensitive, against two values that STATUS_ALIASES maps away. Live
    // rows are 'ASSIGNED' / 'IN_REVIEW', so this counted 0 for every doctor and
    // the localeCompare tiebreaker below silently decided every assignment —
    // i.e. the alphabetically-first doctor took every case while colleagues sat
    // idle. Matches the status list used by doctor.js countActiveCases.
    const row = await queryOne(
      `SELECT COUNT(*) AS c
       FROM orders_active
       WHERE doctor_id = $1
         AND LOWER(COALESCE(status, '')) IN ('assigned','in_review','rejected_files','breached','sla_breach')`,
      [doc.id]
    );
    const load = row ? Number(row.c) || 0 : 0;
    if (!best || load < best.load || (load === best.load && doc.name.localeCompare(best.name) < 0)) {
      best = { ...doc, load };
    }
  }

  return best;
}

module.exports = { pickDoctorForOrder };
