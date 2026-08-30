/**
 * Services & Specialties API Routes — /api/v1/specialties, /api/v1/services
 *
 * Read-only endpoints for the service catalog.
 * Used by the case submission form.
 */

const router = require('express').Router();
const { coerceCountry } = require('../../launch-market');
const { serviceBookableClause } = require('../../services/service_bookable');

// One definition of "a patient may order this", shared with the web wizard and
// the case-intake path. Aliased `s` to match every query in this file.
const BOOKABLE = serviceBookableClause('s');

module.exports = function (db, { safeGet, safeAll }) {

  // ─── GET /specialties ────────────────────────────────────

  router.get('/specialties', async (req, res) => {
    const specialties = await safeAll(`
      SELECT
        sp.id, sp.name, sp.name_ar as "nameAr",
        -- Count what /specialties/:id/services will actually return. The old
        -- count and the old list used the same predicate, so they agreed —
        -- this is prophylactic, not a bug fix: the two are now pinned to one
        -- rule so they cannot drift when it next changes. The specialty half
        -- of the clause is redundant against the outer WHERE, and kept anyway
        -- so this line is correct on its own terms.
        COUNT(DISTINCT CASE WHEN ${BOOKABLE} THEN s.id END)::int as "serviceCount"
      FROM specialties sp
      LEFT JOIN services s ON s.specialty_id = sp.id
      -- COALESCE to match serviceBookableClause, which treats an unset flag
      -- as visible. Strict equality here would drop a NULL-visibility
      -- specialty from this list while its services stayed orderable through
      -- /services. Zero such rows today; the two should still agree.
      WHERE COALESCE(sp.is_visible, true) = true
      GROUP BY sp.id, sp.name, sp.name_ar
      ORDER BY sp.name ASC
    `, []);

    return res.ok(specialties);
  });

  // ─── GET /specialties/:id/services ───────────────────────

  router.get('/specialties/:id/services', async (req, res) => {
    const services = await safeAll(`
      SELECT DISTINCT ON (s.id)
        s.id, s.name, s.base_price as "basePrice", s.currency,
        s.sla_hours as "slaHours", s.specialty_id as "specialtyId"
      FROM services s
      -- 2026-08-25: was s.is_visible = true alone, so this happily listed
      -- services under a specialty an operator had hidden — 24 of them, 8
      -- Nephrology. Same rule as the web wizard now, from one place.
      WHERE s.specialty_id = $1 AND ${BOOKABLE}
      ORDER BY s.id
    `, [req.params.id]);

    return res.ok(services);
  });


// Which market's prices this request may see.
//
// AUDIT 2026-08-30. Both routes below took the country from `req.query.country`
// — a value the caller types — so a client chose its own price band. The web
// funnel has never worked that way: getDisplayCountryCode() in routes/patient.js
// prefers the AUTHENTICATED user's stored country and only falls back to a
// header for an anonymous visitor.
//
// The exposure was limited (every foreign market prices higher than EG, and the
// card is charged in EGP after FX, so picking one cannot underpay) but "limited"
// is not a property to rely on: it holds only while the price tables happen to
// be ordered that way, and nothing enforces that.
//
// So: a signed-in caller is priced for the country on their account, and the
// query parameter is honoured only for anonymous catalogue browsing, where
// there is no account to read and no charge to make.
function pricingCountryFor(req) {
  const fromUser = req && req.user && (req.user.country_code || req.user.country);
  if (fromUser) return coerceCountry(fromUser);
  return coerceCountry(req && req.query && req.query.country);
}

  // ─── GET /services ───────────────────────────────────────
  // Optional: ?specialty=spec-cardiology&country=EG

  router.get('/services', async (req, res) => {
    const { specialty } = req.query;
    let paramIndex = 1;

    let whereExtra = '';
    const params = [pricingCountryFor(req)];

    if (specialty) {
      whereExtra = ` AND s.specialty_id = $${++paramIndex}`;
      params.push(specialty);
    }

    const sql = `
      SELECT * FROM (
        SELECT DISTINCT ON (s.id)
          s.id, s.name, s.specialty_id as "specialtyId",
          sp.name as "specialtyName",
          sp.name_ar as "specialtyNameAr",
          COALESCE(rp.tashkheesa_price, s.base_price) as "basePrice",
          COALESCE(rp.currency, s.currency) as currency,
          s.sla_hours as "slaHours"
        FROM services s
        LEFT JOIN specialties sp ON s.specialty_id = sp.id
        LEFT JOIN service_regional_prices rp
          ON rp.service_id = s.id
          AND rp.country_code = $1
          AND COALESCE(rp.status, 'active') = 'active'
        WHERE ${BOOKABLE}${whereExtra}
        ORDER BY s.id, rp.tashkheesa_price DESC NULLS LAST
      ) svc
      ORDER BY "specialtyName" ASC NULLS LAST, name ASC
    `;

    const services = await safeAll(sql, params);
    return res.ok(services);
  });

  // ─── GET /services/:id/price ─────────────────────────────

  router.get('/services/:id/price', async (req, res) => {
    const serviceId = req.params.id;

    // 2026-08-25: had no filter at all, so it returned a live quote for any
    // service id — hidden, coming_soon, or under a hidden specialty. A client
    // could price a Nephrology review nobody can deliver. 404 rather than a
    // distinct status: an unbookable service should look absent to the API,
    // which is what every other endpoint here now reports.
    const service = await safeGet(
      `SELECT s.* FROM services s WHERE s.id = $1 AND ${BOOKABLE}`,
      [serviceId]
    );
    if (!service) return res.fail('Service not found', 404);

    const regional = await safeGet(`
      SELECT tashkheesa_price as price, doctor_commission as "doctorFee", currency
      FROM service_regional_prices
      WHERE service_id = $1 AND country_code = $2 AND COALESCE(status, 'active') = 'active'
    `, [serviceId, pricingCountryFor(req)]);

    if (regional) {
      return res.ok({
        serviceId,
        price: regional.price,
        doctorFee: regional.doctorFee,
        currency: regional.currency,
        slaHours: service.sla_hours,
        source: 'regional',
      });
    }

    return res.ok({
      serviceId,
      price: service.base_price,
      doctorFee: service.doctor_fee,
      currency: service.currency || 'EGP',
      slaHours: service.sla_hours,
      source: 'base',
    });
  });

  return router;
};
