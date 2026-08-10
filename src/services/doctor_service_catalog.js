'use strict';

// Doctor "My Services" union loader.
//
// Union = (a) visible services in the doctor's OWN specialty, plus
//         (b) every service the doctor already holds a doctor_services row
//             for (any specialty, any visibility — treated as an
//             unconfirmed default they must confirm/remove).
// Rows are grouped under each service's OWN specialty heading, the doctor's
// own specialty group first, then alphabetical by specialty name.
//
// NOTE: the `services` table has NO name_ar column (verified via schema);
// per-service name_ar is always null. Arabic headings come from
// specialties.name_ar (specialtyNameAr on each group).
//
// Consumes a pg client (thread the caller's txn client through). Read-only.

async function loadDoctorServiceCatalog(client, { doctorId, specialtyId }) {
  const did = doctorId == null ? '' : String(doctorId);
  const sid = specialtyId == null ? '' : String(specialtyId);

  // The union query. base_price/doctor_fee are double precision; sla_hours int.
  // `ticked` = the doctor already holds a doctor_services row for this service.
  const { rows } = await client.query(
    `
    WITH held AS (
      SELECT ds.service_id
      FROM doctor_services ds
      WHERE ds.doctor_id = $1
    ),
    unioned AS (
      -- (a) visible services in the doctor's own specialty
      SELECT sv.id
      FROM services sv
      WHERE sv.specialty_id = $2
        AND COALESCE(sv.is_visible, true) = true
      UNION
      -- (b) every service the doctor already holds (any specialty/visibility)
      SELECT h.service_id AS id
      FROM held h
    )
    SELECT
      sv.id,
      sv.name,
      sv.base_price,
      sv.doctor_fee,
      sv.sla_hours,
      COALESCE(sv.is_visible, true) AS is_visible,
      sv.specialty_id,
      COALESCE(sp.name, '') AS specialty_name,
      sp.name_ar AS specialty_name_ar,
      (h.service_id IS NOT NULL) AS ticked
    FROM unioned u
    JOIN services sv        ON sv.id = u.id
    LEFT JOIN specialties sp ON sp.id = sv.specialty_id
    LEFT JOIN held h         ON h.service_id = sv.id
    ORDER BY COALESCE(sp.name, '') ASC, sv.name ASC
    `,
    [did, sid]
  );

  const allowedIds = new Set(rows.map((r) => String(r.id)));

  // Group by the service's own specialty. Preserve query order within a group.
  const bySpec = new Map();
  for (const r of rows) {
    const key = r.specialty_id == null ? '' : String(r.specialty_id);
    if (!bySpec.has(key)) {
      bySpec.set(key, {
        specialtyId: key || null,
        specialtyName: r.specialty_name || '',
        specialtyNameAr: r.specialty_name_ar || null,
        services: []
      });
    }
    bySpec.get(key).services.push({
      id: String(r.id),
      name: r.name || '',
      name_ar: null, // services has no name_ar column
      base_price: r.base_price,
      doctor_fee: r.doctor_fee,
      sla_hours: r.sla_hours,
      is_visible: r.is_visible === true,
      ticked: r.ticked === true
    });
  }

  // Own specialty first, then alphabetical by specialty name.
  const groups = [...bySpec.values()].sort((a, b) => {
    const ownA = a.specialtyId === (sid || null) ? 0 : 1;
    const ownB = b.specialtyId === (sid || null) ? 0 : 1;
    if (ownA !== ownB) return ownA - ownB;
    return String(a.specialtyName).localeCompare(String(b.specialtyName));
  });

  return { groups, allowedIds, isEmpty: allowedIds.size === 0 };
}

module.exports = { loadDoctorServiceCatalog };
