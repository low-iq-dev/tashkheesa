const { queryAll, queryOne } = require('./pg');

async function pickDoctorForOrder({ specialtyId }) {
  if (!specialtyId) return null;

  // Eligible doctors by specialty
  const doctors = await queryAll(
    `SELECT id, name, email
     FROM users
     WHERE role = 'doctor'
       AND is_active = true
       AND specialty_id = $1
     ORDER BY name ASC`,
    [specialtyId]
  );

  if (!doctors || !doctors.length) return null;

  let best = null;
  for (const doc of doctors) {
    const row = await queryOne(
      `SELECT COUNT(*) AS c
       FROM orders
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
