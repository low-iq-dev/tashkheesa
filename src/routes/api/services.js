/**
 * Services & Specialties API Routes — /api/v1/specialties, /api/v1/services
 *
 * Read-only endpoints for the service catalog.
 * Used by the case submission form.
 */

const router = require('express').Router();

module.exports = function (db, { safeGet, safeAll }) {

  // ─── GET /specialties ────────────────────────────────────

  router.get('/specialties', async (req, res) => {
    const specialties = await safeAll(`
      SELECT
        sp.id, sp.name,
        COUNT(DISTINCT CASE WHEN s.is_visible = true THEN s.id END)::int as "serviceCount"
      FROM specialties sp
      LEFT JOIN services s ON s.specialty_id = sp.id
      WHERE sp.is_visible = true
      GROUP BY sp.id, sp.name
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
      WHERE s.specialty_id = $1 AND s.is_visible = true
      ORDER BY s.id
    `, [req.params.id]);

    return res.ok(services);
  });

  // ─── GET /services ───────────────────────────────────────
  // Optional: ?specialty=spec-cardiology&country=EG

  router.get('/services', async (req, res) => {
    const { specialty, country } = req.query;
    let paramIndex = 1;

    let whereExtra = '';
    const params = [country || 'EG'];

    if (specialty) {
      whereExtra = ` AND s.specialty_id = $${++paramIndex}`;
      params.push(specialty);
    }

    const sql = `
      SELECT * FROM (
        SELECT DISTINCT ON (s.id)
          s.id, s.name, s.specialty_id as "specialtyId",
          sp.name as "specialtyName",
          COALESCE(rp.tashkheesa_price, s.base_price) as "basePrice",
          COALESCE(rp.currency, s.currency) as currency,
          s.sla_hours as "slaHours"
        FROM services s
        LEFT JOIN specialties sp ON s.specialty_id = sp.id
        LEFT JOIN service_regional_prices rp
          ON rp.service_id = s.id
          AND rp.country_code = $1
          AND COALESCE(rp.status, 'active') = 'active'
        WHERE s.is_visible = true${whereExtra}
        ORDER BY s.id, rp.tashkheesa_price DESC NULLS LAST
      ) svc
      ORDER BY "specialtyName" ASC NULLS LAST, name ASC
    `;

    const services = await safeAll(sql, params);
    return res.ok(services);
  });

  // ─── GET /services/:id/price ─────────────────────────────

  router.get('/services/:id/price', async (req, res) => {
    const { country } = req.query;
    const serviceId = req.params.id;

    const service = await safeGet('SELECT * FROM services WHERE id = $1', [serviceId]);
    if (!service) return res.fail('Service not found', 404);

    const regional = await safeGet(`
      SELECT tashkheesa_price as price, doctor_commission as "doctorFee", currency
      FROM service_regional_prices
      WHERE service_id = $1 AND country_code = $2 AND COALESCE(rp.status, 'active') = 'active'
    `, [serviceId, country || 'EG']);

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
