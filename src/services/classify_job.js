// src/services/classify_job.js
//
// Standalone classifier driver. Extracted from src/routes/patient.js step 2
// POST handler (lines ~1721-1793 pre-refactor) so the same code path serves
// BOTH the pg-boss worker (`specialty-classify` queue) and the inline
// rollback fallback (CLASSIFIER_ASYNC=false).
//
// House style: takes only an orderId. Re-reads everything else from the DB.
//
// Logic is byte-for-byte identical to the previous inline block, with TWO
// additive changes called out here:
//   1. The Anthropic call is timed; latency_ms is written to the audit row.
//   2. The model name (currently Haiku, from src/config/anthropic.js) is
//      written to the audit row.
// Both columns existed in `specialty_classifications` since migration 056 but
// were left NULL by the inline code. No schema change required.
//
// Out of scope for this refactor: prompt_hash, alternates_json (stay NULL).

'use strict';

const { randomUUID } = require('crypto');
const { queryOne, queryAll, execute } = require('../pg');
const { logErrorToDb } = require('../logger');
const { classifyCase } = require('./specialty_classifier');
const { getThresholds } = require('./admin_settings');
const { modelHaiku } = require('../config/anthropic');
const { recordAiHealth } = require('./ai_health');
const { serviceBookableClause } = require('./service_bookable');

async function runClassification(orderId) {
  if (!orderId) return;
  try {
    // Re-read the draft text fields by id (worker has no caller-context).
    // Ownership was validated by the route handler before enqueue.
    const draft = await queryOne(
      `SELECT clinical_question, medical_history, current_medications
         -- include-deleted-ok: classification runs at draft creation;
         -- soft-delete happens 48h later. Worst case is one wasted call
         -- on a draft that has since expired.
         FROM orders WHERE id = $1`,
      [orderId]
    );
    if (!draft) return;

    const specialtiesRaw = await queryAll(
      `SELECT id, name, name_ar FROM specialties
       WHERE COALESCE(is_visible, true) = true
       ORDER BY name ASC`,
      []
    );
    // 2026-08-25: gated on is_visible alone. coming_soon was NOT filtered, and
    // that is worse here than anywhere else on the platform: when the
    // classifier returns a confident pick the wizard LOCKS the patient to it
    // (patient_new_case.ejs renders the locked callout with no override grid),
    // but the step-3 catalogue and its POST both use the bookable rule. So a
    // coming_soon recommendation produced a card the patient could not see and
    // a submission the server rejected with err=invalid_service — an
    // unrecoverable loop with no way out of the wizard.
    //
    // Zero such rows exist today, but resyncComingSoon recomputes coming_soon
    // on every doctor save, approve and pause: one deactivated Cardiology
    // doctor creates it.
    const servicesRaw = await queryAll(
      `SELECT sv.id, sv.specialty_id, sv.name, sv.base_price, sv.currency
         FROM services sv
        WHERE ${serviceBookableClause('sv')}
        ORDER BY sv.specialty_id ASC, sv.name ASC`,
      []
    );
    const specMap = {};
    for (const sp of specialtiesRaw) {
      specMap[sp.id] = { id: sp.id, name: sp.name, services: [] };
    }
    for (const sv of servicesRaw) {
      if (specMap[sv.specialty_id]) {
        specMap[sv.specialty_id].services.push({
          id: sv.id,
          name: sv.name,
          price: (sv.currency || 'EGP') + ' ' + Math.round(Number(sv.base_price) || 0)
        });
      }
    }
    const specialtiesWithServices = Object.values(specMap).filter(function (s) {
      return s.services.length > 0;
    });

    const filesForClassifier = await queryAll(
      'SELECT label, url FROM order_files WHERE order_id = $1',
      [orderId]
    );
    const caseText = [draft.clinical_question, draft.medical_history, draft.current_medications]
      .filter(Boolean).join('\n\n');
    const fileMetadata = {
      patient_info: {},
      documents_inventory: filesForClassifier.map(function (f) {
        return { type: String(f.label || 'document').toLowerCase() };
      }),
      lab_abnormalities: []
    };

    // Additive: time the call + capture model name for the audit row.
    const model = modelHaiku();
    const startedAt = Date.now();
    const result = await classifyCase(caseText, fileMetadata, specialtiesWithServices);
    const latencyMs = Date.now() - startedAt;
    await recordAiHealth(true); // live Anthropic call succeeded → clear any AI-billing flag

    await execute(
      `INSERT INTO specialty_classifications
         (id, case_id, specialty_id, service_id, confidence, reasoning, model, latency_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [randomUUID(), orderId, result.specialty_id, result.service_id,
       result.confidence, result.reasoning, model, latencyMs, new Date().toISOString()]
    );

    try {
      const { min: minThreshold } = await getThresholds();
      if (Number(result.confidence) < Number(minThreshold)) {
        await execute(
          `UPDATE orders SET assignment_status = 'manual_queue', updated_at = $1 WHERE id = $2`,
          [new Date().toISOString(), orderId]
        );
      }
    } catch (_) { /* non-fatal — column default 'auto' is the safe fallback */ }
  } catch (err) {
    logErrorToDb(err, {
      context: 'classify_job',
      category: 'patient_case',
      orderId
    });
    // Trip the AI-health flag if this is an Anthropic billing outage (no-op otherwise).
    await recordAiHealth(false, err, { context: 'classify_job' });
    throw err; // let pg-boss mark the job failed + retry per retryLimit
  }
}

module.exports = { runClassification };
