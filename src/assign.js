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
       AND u.specialty_id = $1
       ${serviceClause}
     ORDER BY u.name ASC`,
    params
  );

  if (!doctors || !doctors.length) return null;

  let best = null;
  for (const doc of doctors) {
    const row = await queryOne(
      `SELECT COUNT(*) AS c
       FROM orders_active
       WHERE doctor_id = $1
         AND status IN ('new','accepted','in_review')`,
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
