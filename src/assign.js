const { db } = require('./db');

function pickDoctorForOrder({ specialtyId }) {
  if (!specialtyId) return null;

  // Eligible doctors by specialty
  const doctors = db
    .prepare(
      `SELECT id, name, email
       FROM users
       WHERE role = 'doctor'
         AND is_active = 1
         AND specialty_id = ?
       ORDER BY name ASC`
    )
    .all(specialtyId);

  if (!doctors || !doctors.length) return null;

  const loadStmt = db.prepare(
    `SELECT COUNT(*) AS c
     FROM orders
     WHERE doctor_id = ?
       AND status IN ('new','accepted','in_review')`
  );

  let best = null;
  doctors.forEach((doc) => {
    const row = loadStmt.get(doc.id);
    const load = row ? row.c || 0 : 0;
    if (!best || load < best.load || (load === best.load && doc.name.localeCompare(best.name) < 0)) {
      best = { ...doc, load };
    }
  });

  return best;
}

module.exports = { pickDoctorForOrder };
