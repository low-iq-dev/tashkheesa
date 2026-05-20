// ─────────────────────────────────────────────────────────────────────
// PARKED — Not wired into production. Reference implementation for
// future AI features (urgency triage, similar-case retrieval, etc.).
//
// The live specialty-routing system is src/services/specialty_classifier.js.
// Do not mount this route in server.js without explicit instruction.
// ─────────────────────────────────────────────────────────────────────
//
// routes/aiSuggestions.js
//
// Patient-facing endpoint to request a specialty suggestion mid-wizard.
// Mount with: app.use('/api/cases', requireAuth, require('./routes/aiSuggestions'));

const express = require('express');
const router = express.Router();
const { suggestSpecialty, recordHumanAction } = require('../services/ai/specialtyRouter');
// If this file ships at src/routes/aiSuggestions.js, '../db' resolves to src/db.js
const { pool } = require('../db');

// Simple in-memory rate limiter: max 3 calls per order per session.
// For multi-instance deployments, replace with Redis or pg-boss-backed counter.
const callCounts = new Map(); // orderId -> count

const MAX_CALLS_PER_ORDER = 3;

router.post('/:orderId/suggest-specialty', async (req, res) => {
  const orderId = String(req.params.orderId || '').trim();
  if (!orderId) return res.status(400).json({ error: 'invalid_order_id' });

  // patient_id is TEXT in this schema. Use whatever session field your auth sets.
  const patientId = req.session?.userId || req.session?.patient_id || req.user?.id;
  if (!patientId) return res.status(401).json({ error: 'unauthenticated' });
  const patientIdStr = String(patientId);

  try {
    // orders_active excludes soft-deleted rows (see migration 045).
    // Pre-payment canonical filter: status='new' AND payment_status='unpaid'.
    const { rows } = await pool.query(
      `SELECT id, patient_id, status, payment_status
         FROM orders_active
        WHERE id = $1 AND patient_id = $2
        LIMIT 1`,
      [orderId, patientIdStr]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'order_not_found' });
    }
    const { status, payment_status } = rows[0];
    if (!(status === 'new' && payment_status === 'unpaid')) {
      return res.status(409).json({ error: 'order_not_in_prepayment_state' });
    }
  } catch (err) {
    console.error('[suggest-specialty] order lookup failed:', err);
    return res.status(500).json({ error: 'lookup_failed' });
  }

  // Rate limit.
  const used = callCounts.get(orderId) || 0;
  if (used >= MAX_CALLS_PER_ORDER) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }
  callCounts.set(orderId, used + 1);
  // Clear after 30 min so old draft sessions don't pollute memory.
  setTimeout(() => callCounts.delete(orderId), 30 * 60 * 1000).unref?.();

  const { complaint, symptoms, patientAge, patientGender, locale } = req.body || {};

  if (!complaint || complaint.trim().length < 5) {
    return res.status(400).json({ error: 'complaint_too_short' });
  }

  try {
    const suggestion = await suggestSpecialty({
      orderId,
      patientId: patientIdStr,
      complaint,
      symptoms,
      patientAge,
      patientGender,
      locale,
    });

    if (!suggestion) {
      // Either disabled or failed — frontend should silently degrade.
      return res.json({ suggestion: null });
    }

    return res.json({ suggestion });
  } catch (err) {
    console.error('[suggest-specialty] error:', err);
    // Never fail the wizard because of AI — return null suggestion.
    return res.json({ suggestion: null });
  }
});

// ─── Second route on the same router ─────────────────────────────────────────

router.post('/suggestions/:suggestionId/action', async (req, res) => {
  const suggestionId = parseInt(req.params.suggestionId, 10);
  if (!Number.isInteger(suggestionId)) {
    return res.status(400).json({ error: 'invalid_suggestion_id' });
  }

  const patientId = req.session?.userId || req.session?.patient_id || req.user?.id;
  if (!patientId) return res.status(401).json({ error: 'unauthenticated' });

  const { chosenSpecialtyId, suggestedSpecialtyId } = req.body || {};
  if (!chosenSpecialtyId) {
    return res.status(400).json({ error: 'missing_chosen_specialty' });
  }

  try {
    // Verify the suggestion belongs to this patient.
    const { rows } = await pool.query(
      `SELECT s.id
         FROM ai_suggestions s
        WHERE s.id = $1 AND s.patient_id = $2
        LIMIT 1`,
      [suggestionId, String(patientId)]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'suggestion_not_found' });
    }

    await recordHumanAction({
      suggestionId,
      chosenSpecialtyId,
      suggestedSpecialtyId,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[suggestion-action] error:', err);
    res.json({ ok: false }); // fire-and-forget — never block the wizard
  }
});

module.exports = router;
