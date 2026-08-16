'use strict';

// Shared lifecycle endpoints for the new addon system. Mounted on the
// Express app but ENTIRELY DORMANT until ADDON_SYSTEM_V2=true. Phase 2
// only wires the skeleton; Phase 3 flips the flag; Phase 4 drives these
// from the doctor / case-completion UI.
//
// Endpoint surface (Phase 4 target):
//   POST /api/orders/:orderId/addons/:addonServiceId/fulfill   (doctor)
//   POST /api/orders/:orderId/addons/:addonServiceId/cancel    (patient, admin)
//
// Phase 2 behaviour: every endpoint returns 503 Service Unavailable when
// the flag is false. This proves the mount is live without exposing
// half-built behaviour.

const express = require('express');
const { requireRole } = require('../middleware');
const { getAddon, isEnabled } = require('../services/addons/registry');
const { queryOne } = require('../pg');

const router = express.Router();

function flagGate(req, res, next) {
  if (!isEnabled()) {
    return res.status(503).json({
      error: 'ADDON_SYSTEM_V2 is disabled',
      hint:  'This endpoint is part of the new addon abstraction and will be enabled in Phase 3.'
    });
  }
  next();
}

router.post(
  '/api/orders/:orderId/addons/:addonServiceId/fulfill',
  flagGate,
  requireRole(['doctor']),
  async function(req, res) {
    try {
      const order = await queryOne(`SELECT * FROM orders_active WHERE id = $1`, [req.params.orderId]);
      if (!order) return res.status(404).json({ error: 'order not found' });

      // AUDIT-P0-7 — IDOR: this handler loaded the order and never compared
      // order.doctor_id against req.user.id, so ANY doctor could mark ANY
      // other doctor's add-on fulfilled — and video_consult.onFulfill stamps
      // `doctor_id` / `fulfilled_by` from req.user into metadata_json, so the
      // wrong doctor was recorded as having delivered it. Requiring
      // accepted_at as well means an assigned-but-unaccepted case cannot be
      // fulfilled either.
      if (String(order.doctor_id || '') !== String(req.user.id)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      if (!order.accepted_at) {
        return res.status(409).json({ error: 'case not accepted yet' });
      }

      const addon = await queryOne(
        `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = $2`,
        [req.params.orderId, req.params.addonServiceId]
      );
      if (!addon) return res.status(404).json({ error: 'addon not attached to order' });
      if (addon.status !== 'paid') {
        return res.status(409).json({ error: 'addon is not in paid state', status: addon.status });
      }
      const svc = getAddon(req.params.addonServiceId);
      if (!svc) return res.status(404).json({ error: 'unknown addon service' });

      const updated = await svc.onFulfill({
        order,
        addon,
        doctor: req.user,
        payload: req.body || {}
      });
      return res.json({ ok: true, addon: updated });
    } catch (err) {
      console.error('[addons.fulfill] error', err && err.message ? err.message : err);
      return res.status(500).json({ error: 'internal error' });
    }
  }
);

router.post(
  '/api/orders/:orderId/addons/:addonServiceId/cancel',
  flagGate,
  requireRole(['patient', 'admin', 'superadmin']),
  async function(req, res) {
    try {
      // AUDIT-P0-7 — IDOR: this looked the add-on up by order_id +
      // addon_service_id and updated it with NO ownership check whatsoever.
      // Any patient could cancel any other patient's paid add-on by guessing
      // or enumerating an order id. For a prescription that is doubly
      // damaging: onComplete refuses to pay the doctor for a cancelled add-on,
      // so the victim loses the prescription they paid for AND the doctor
      // loses the fee. Admin/superadmin retain the override.
      const order = await queryOne(`SELECT id, patient_id FROM orders_active WHERE id = $1`, [req.params.orderId]);
      if (!order) return res.status(404).json({ error: 'order not found' });
      const role = String((req.user && req.user.role) || '').toLowerCase();
      const isStaff = role === 'admin' || role === 'superadmin';
      if (!isStaff && String(order.patient_id || '') !== String(req.user.id)) {
        return res.status(403).json({ error: 'forbidden' });
      }

      const addon = await queryOne(
        `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = $2`,
        [req.params.orderId, req.params.addonServiceId]
      );
      if (!addon) return res.status(404).json({ error: 'addon not attached to order' });
      if (addon.status === 'cancelled' || addon.status === 'refunded') {
        return res.json({ ok: true, addon, note: 'already terminal' });
      }
      const updated = await queryOne(
        `UPDATE order_addons
            SET status       = 'cancelled',
                cancelled_at = NOW()
          WHERE id = $1
        RETURNING *`,
        [addon.id]
      );
      return res.json({ ok: true, addon: updated });
    } catch (err) {
      console.error('[addons.cancel] error', err && err.message ? err.message : err);
      return res.status(500).json({ error: 'internal error' });
    }
  }
);

module.exports = router;
