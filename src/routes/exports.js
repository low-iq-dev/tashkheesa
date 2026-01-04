// src/routes/exports.js
const express = require('express');
const { db } = require('../db');
const { requireSuperadmin } = require('../auth');
const { buildFilters } = require('./superadmin');

const router = express.Router();

// CSV export for superadmin – respects filters (from / to / specialty)
router.get(
  '/superadmin/exports/orders.csv',
  requireSuperadmin,
  (req, res) => {
    const { whereSql, params } = buildFilters(req.query || {});

    const rows = db
      .prepare(
        `
        SELECT
          o.id AS order_id,
          o.created_at,
          sp.name AS specialty,
          sv.name AS service,
          o.sla_hours,
          o.status,
          o.accepted_at,
          o.deadline_at,
          o.completed_at,
          COALESCE(o.price, 0) AS price,
          COALESCE(o.doctor_fee, 0) AS doctor_fee,
          (COALESCE(o.price, 0) - COALESCE(o.doctor_fee, 0)) AS gp,
          COALESCE(o.reassigned_count, 0) AS reassigned_count
        FROM orders o
        LEFT JOIN specialties sp ON sp.id = o.specialty_id
        LEFT JOIN services sv ON sv.id = o.service_id
        ${whereSql}
        ORDER BY o.created_at DESC
      `
      )
      .all(...params);

    const header =
      'order_id,created_at,specialty,service,sla_hours,status,accepted_at,deadline_at,completed_at,price,doctor_fee,gp,reassigned_count\n';

    const body = rows
      .map((r) =>
        [
          r.order_id,
          r.created_at,
          r.specialty || '',
          r.service || '',
          r.sla_hours || '',
          r.status || '',
          r.accepted_at || '',
          r.deadline_at || '',
          r.completed_at || '',
          r.price ?? 0,
          r.doctor_fee ?? 0,
          r.gp ?? 0,
          r.reassigned_count ?? 0
        ]
          .map((v) =>
            `"${String(v)
              .replace(/"/g, '""')
              .replace(/\r?\n/g, ' ')}"`
          )
          .join(',')
      )
      .join('\n');

    // Use UTF-8 for Excel compatibility.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');

    const fileDate = new Date().toISOString().slice(0, 10);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="tashkheesa_orders_${fileDate}.csv"`
    );

    // Add UTF-8 BOM so Excel renders correctly.
    res.send('\ufeff' + header + body);
  }
);

module.exports = router;
module.exports.router = router;
