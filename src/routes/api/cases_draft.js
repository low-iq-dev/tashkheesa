'use strict';

// src/routes/api/cases_draft.js — /api/v1/cases/draft/*
//
// CASE-FLOW REBUILD 2026-08-25.
//
// THE PROBLEM THIS SOLVES. A half-finished case existed in two incompatible
// places. The web wizard's draft is a real `orders` row (status='DRAFT', with a
// draft_step counter, migration 021). The mobile app's draft was a JSON blob in
// the phone's own storage, and the app only ever told the server about a case
// at the very end, via a single POST /api/v1/cases that created it whole.
//
// Consequences, all of them things a patient actually hits:
//   * Start a case on the laptop, open the phone, and it is not there. Start it
//     on the phone, open the laptop, same. To the patient this reads as the app
//     losing their case.
//   * The AI specialty classifier runs off the draft row at web step 2. The app
//     had no draft row, so it could never call the classifier — the patient had
//     to know for themselves that a shadow on a chest X-ray is Pulmonology and
//     not Radiology or Cardiology.
//   * A lost or wiped phone is a lost case.
//
// This router gives the app the SAME row the web wizard uses. Not a parallel
// draft system — the same table, the same status, the same draft_step, the same
// classifier enqueue. That is what makes the app mirror the portal rather than
// merely resemble it.
//
// ── Mounting ────────────────────────────────────────────────────────────────
// Mounted at '/cases/draft' BEFORE '/cases' in api_v1.js. Order matters:
// cases.js owns GET '/:id', which would otherwise swallow '/cases/draft' and
// answer it with "case not found". Anything this router does not handle falls
// through to cases.js unchanged.
//
// ── What this router does NOT do ────────────────────────────────────────────
// It does not price anything itself. Pricing, service validation, the
// specialty/service reconciliation and the Cairo urgent-window gate all live in
// services/case_intake_pricing.js, shared with POST /api/v1/cases so a case
// born from a draft cannot be priced differently from one born whole.

const router = require('express').Router();
const { randomUUID } = require('crypto');
const { queryOne, queryAll, execute } = require('../../pg');
const { logErrorToDb } = require('../../logger');
const { logOrderEvent } = require('../../audit');
const { IntakeError, resolveAndPriceIntake } = require('../../services/case_intake_pricing');
const { scheduleImageQualityChecks } = require('../../services/case_image_quality');
const { generateReferenceId } = require('../../utils/reference');

router.use(require('express').json());

// The draft row's provenance. The web wizard stamps 'patient_wizard_v2'; app
// drafts are tagged separately so we can tell, later, which surface a case was
// started on — without which "does anyone actually finish on the other device?"
// is unanswerable. Both are DRAFT rows and every reader treats them alike.
const DRAFT_SOURCE = 'patient_app_v1';

// Same ceiling POST /api/v1/cases enforces (AUDIT-APP-H12). The app exports a
// MAX_FILES constant and imports it nowhere, so the server is the only place
// this is real.
const MAX_FILES = 15;

// ─── Ownership ──────────────────────────────────────────────────────────────
//
// Every :id route goes through this. It deliberately does NOT distinguish
// "no such draft" from "someone else's draft" — both answer 404, so the API
// cannot be used to probe which order ids exist.
//
// `UPPER(COALESCE(status,''))='DRAFT'` rather than `status='DRAFT'`: this
// column is written in both cases across the codebase and Postgres comparison
// is case-sensitive. The web wizard already guards it this way; a plain
// equality here would silently fail to find drafts written by the other
// surface, which is the exact class of bug this whole router exists to end.
async function loadOwnedDraft(orderId, patientId) {
  if (!orderId || !patientId) return null;
  return await queryOne(
    // orders_active, not orders: a soft-deleted draft must not be resumable.
    // Reviving one would hand the patient back a case an operator deliberately
    // removed, and the submit path would then price and charge for it.
    `SELECT id, patient_id, status, payment_status, draft_step, language,
            clinical_question, medical_history, current_medications,
            specialty_id, service_id, urgency_tier, country, created_at, updated_at
       FROM orders_active
      WHERE id = $1 AND patient_id = $2
        AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
    [orderId, patientId]
  );
}

// Shape a draft for the client. One serialiser so the create, read, patch and
// resume responses cannot drift into three different shapes.
function serializeDraft(row, files) {
  return {
    id: row.id,
    draftStep: row.draft_step == null ? 0 : Number(row.draft_step),
    clinicalQuestion: row.clinical_question || '',
    medicalHistory: row.medical_history || '',
    currentMedications: row.current_medications || '',
    specialtyId: row.specialty_id || null,
    serviceId: row.service_id || null,
    urgencyTier: row.urgency_tier || 'standard',
    country: row.country || null,
    language: row.language || null,
    files: (files || []).map(f => ({
      id: f.id,
      filename: f.filename,
      mimeType: f.mime_type,
      size: f.size == null ? null : Number(f.size),
      aiQualityStatus: f.ai_quality_status || null
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function draftFiles(orderId) {
  return await queryAll(
    `SELECT id, filename, mime_type, size, ai_quality_status
       FROM order_files WHERE order_id = $1 ORDER BY created_at ASC`,
    [orderId]
  );
}

// Map an IntakeError to its typed response; anything else is a real fault and
// must not be reported to the patient as a validation problem.
function failFromError(res, err, context, req) {
  if (err instanceof IntakeError) {
    return res.fail(err.message, err.status, err.code);
  }
  logErrorToDb(err, {
    context: context,
    requestId: req && req.requestId,
    userId: req && req.user && req.user.id,
    url: req && req.originalUrl,
    method: req && req.method,
    category: 'patient_case'
  });
  return res.fail('Something went wrong. Please try again.', 500, 'INTERNAL_ERROR');
}

// ─── GET /cases/draft ───────────────────────────────────────────────────────
//
// The patient's open draft, if they have one. This is the endpoint that makes
// cross-device continuity visible: the app calls it on launch and, if a draft
// comes back, offers to resume it — INCLUDING one started on the web portal,
// because it is the same row.
//
// Most recent wins if somehow there are several. We do not delete the others:
// an abandoned draft carries the patient's own words about their condition, and
// silently destroying that to keep a table tidy is not ours to do. The R2
// lifecycle rule on orders/draft/ already reclaims the storage.
router.get('/', async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT id, patient_id, status, payment_status, draft_step, language,
              clinical_question, medical_history, current_medications,
              specialty_id, service_id, urgency_tier, country, created_at, updated_at
         FROM orders_active
        WHERE patient_id = $1 AND UPPER(COALESCE(status, '')) = 'DRAFT'
        ORDER BY updated_at DESC NULLS LAST, created_at DESC
        LIMIT 1`,
      [req.user.id]
    );
    if (!row) return res.ok({ draft: null });
    return res.ok({ draft: serializeDraft(row, await draftFiles(row.id)) });
  } catch (err) {
    return failFromError(res, err, 'api.cases_draft.resume', req);
  }
});

// ─── POST /cases/draft ──────────────────────────────────────────────────────
//
// Step 1. Creates the draft row from the patient's description of their
// condition. This is the moment the case starts existing on the server, which
// is deliberate: everything after it — the classifier, cross-device resume,
// per-file upload against a real order id — needs a row to hang off.
//
// The 10-character floor matches both the web wizard and POST /api/v1/cases.
// It is not a quality bar, it is a "did the field actually get filled in" bar.
router.post('/', async (req, res) => {
  const b = req.body || {};
  const clinicalQuestion = String(b.clinicalQuestion || '').trim();
  if (clinicalQuestion.length < 10) {
    return res.fail(
      'Please describe your concern in at least 10 characters.',
      422, 'VALIDATION_ERROR'
    );
  }

  const medicalHistory = b.medicalHistory ? String(b.medicalHistory).trim() : null;
  const currentMedications = b.currentMedications ? String(b.currentMedications).trim() : null;
  const country = b.country ? String(b.country).trim().toUpperCase() : null;
  const language = b.language === 'ar' ? 'ar' : 'en';

  try {
    // One open draft per patient. Reusing it rather than minting a second is
    // what stops "I closed the app on step 2 and started again" from leaving a
    // trail of half-cases — and it means the resume endpoint above always has
    // an unambiguous answer.
    const existing = await queryOne(
      `SELECT id FROM orders_active
        WHERE patient_id = $1 AND UPPER(COALESCE(status, '')) = 'DRAFT'
        ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      [req.user.id]
    );

    const nowIso = new Date().toISOString();
    let orderId;

    if (existing) {
      orderId = existing.id;
      await execute(
        `UPDATE orders
            SET clinical_question = $1, medical_history = $2, current_medications = $3,
                country = COALESCE($4, country),
                language = $5,
                draft_step = GREATEST(COALESCE(draft_step, 0), 1),
                updated_at = $6
          WHERE id = $7 AND patient_id = $8 AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
        [clinicalQuestion, medicalHistory, currentMedications, country, language,
         nowIso, orderId, req.user.id]
      );
    } else {
      orderId = randomUUID();
      await execute(
        `INSERT INTO orders
           (id, patient_id, status, language, clinical_question, medical_history,
            current_medications, country, payment_status, source, draft_step,
            created_at, updated_at)
         VALUES ($1, $2, 'DRAFT', $3, $4, $5, $6, $7, 'unpaid', $8, 1, $9, $9)`,
        [orderId, req.user.id, language, clinicalQuestion, medicalHistory,
         currentMedications, country, DRAFT_SOURCE, nowIso]
      );
      try {
        logOrderEvent({
          orderId, label: 'draft_created',
          actorUserId: req.user.id, actorRole: 'patient'
        });
      } catch (_) { /* timeline is not worth failing a draft over */ }
    }

    const row = await loadOwnedDraft(orderId, req.user.id);
    return res.ok({ draft: serializeDraft(row, await draftFiles(orderId)) });
  } catch (err) {
    return failFromError(res, err, 'api.cases_draft.create', req);
  }
});

// ─── PATCH /cases/draft/:id ─────────────────────────────────────────────────
//
// Partial update as the patient moves through the wizard. Only the fields
// present in the body are touched, so the app can autosave one screen without
// having to send — and therefore without being able to clobber — the others.
//
// draft_step only ever moves FORWARD (GREATEST), matching the web wizard.
// Going back a step to re-read something must not un-record work already done,
// or a patient who taps back on the review screen loses their specialty choice.
router.patch('/:id', async (req, res) => {
  try {
    const draft = await loadOwnedDraft(req.params.id, req.user.id);
    if (!draft) return res.fail('Draft not found', 404, 'NOT_FOUND');

    const b = req.body || {};
    const sets = [];
    const params = [];
    let n = 1;

    function set(column, value) {
      sets.push(column + ' = $' + n++);
      params.push(value);
    }

    if (b.clinicalQuestion !== undefined) {
      const q = String(b.clinicalQuestion || '').trim();
      if (q.length < 10) {
        return res.fail(
          'Please describe your concern in at least 10 characters.',
          422, 'VALIDATION_ERROR'
        );
      }
      set('clinical_question', q);
    }
    if (b.medicalHistory !== undefined) {
      set('medical_history', b.medicalHistory ? String(b.medicalHistory).trim() : null);
    }
    if (b.currentMedications !== undefined) {
      set('current_medications', b.currentMedications ? String(b.currentMedications).trim() : null);
    }
    if (b.country !== undefined && b.country) {
      set('country', String(b.country).trim().toUpperCase());
    }

    // specialty/service are NOT validated here — they are validated together,
    // against each other and against the catalogue, at submit. Validating a
    // half-set pair mid-autosave would reject the perfectly normal state of
    // "specialty chosen, service not yet".
    if (b.specialtyId !== undefined) set('specialty_id', b.specialtyId || null);
    if (b.serviceId !== undefined) set('service_id', b.serviceId || null);
    if (b.urgencyTier !== undefined) {
      const { normalizeTier } = require('../../services/case_intake_pricing');
      set('urgency_tier', normalizeTier(String(b.urgencyTier || 'standard'), false));
    }

    if (b.draftStep !== undefined) {
      const step = Math.max(0, Math.min(5, Number(b.draftStep) || 0));
      sets.push('draft_step = GREATEST(COALESCE(draft_step, 0), $' + n++ + ')');
      params.push(step);
    }

    if (sets.length === 0) {
      return res.ok({ draft: serializeDraft(draft, await draftFiles(draft.id)) });
    }

    sets.push('updated_at = $' + n++);
    params.push(new Date().toISOString());
    params.push(draft.id, req.user.id);

    await execute(
      `UPDATE orders SET ${sets.join(', ')}
        WHERE id = $${n++} AND patient_id = $${n++}
          AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
      params
    );

    const row = await loadOwnedDraft(draft.id, req.user.id);
    return res.ok({ draft: serializeDraft(row, await draftFiles(draft.id)) });
  } catch (err) {
    return failFromError(res, err, 'api.cases_draft.patch', req);
  }
});

// ─── GET /cases/draft/:id ───────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const draft = await loadOwnedDraft(req.params.id, req.user.id);
    if (!draft) return res.fail('Draft not found', 404, 'NOT_FOUND');
    return res.ok({ draft: serializeDraft(draft, await draftFiles(draft.id)) });
  } catch (err) {
    return failFromError(res, err, 'api.cases_draft.read', req);
  }
});

// ─── POST /cases/draft/:id/files ────────────────────────────────────────────
//
// Attach an already-uploaded R2 object to the draft.
//
// The two-call shape (POST /api/v1/files to put the bytes in R2, then this to
// record it) is what lets the app upload one file at a time with its own
// progress and its OWN retry. The old flow batched every file into the final
// POST /cases, so file 3 of 12 failing on a bad signal took files 4-12 with it
// and offered the patient nothing but "start again".
//
// Files land against the draft's real order id, exactly as the web wizard's
// uploads do, so a document added on the laptop is visible on the phone.
router.post('/:id/files', async (req, res) => {
  try {
    const draft = await loadOwnedDraft(req.params.id, req.user.id);
    if (!draft) return res.fail('Draft not found', 404, 'NOT_FOUND');

    const b = req.body || {};
    const key = b.fileId ? String(b.fileId).trim() : '';
    const filename = b.filename ? String(b.filename).trim() : '';
    if (!key || !filename) {
      return res.fail('fileId and filename are required', 400, 'INVALID_FILE');
    }
    // Pin the key to the prefix POST /api/v1/files actually produces. Without
    // this a client could name any R2 object — including another patient's —
    // and have it attached to their own case.
    if (!/^orders\/draft\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(key)) {
      return res.fail('fileId must be a valid R2 key', 400, 'INVALID_FILE');
    }
    // ...and pin it to THIS patient's folder. The regex above only proves the
    // shape; this proves ownership. api/files.js writes every upload under
    // orders/draft/<uploader id>/, so anything else is someone else's file.
    if (key.split('/')[2] !== String(req.user.id)) {
      return res.fail('fileId must be a valid R2 key', 400, 'INVALID_FILE');
    }

    const existing = await queryOne(
      'SELECT COUNT(*) AS c FROM order_files WHERE order_id = $1', [draft.id]
    );
    if (existing && Number(existing.c) >= MAX_FILES) {
      return res.fail('Attach between 1 and ' + MAX_FILES + ' files.', 400, 'TOO_MANY_FILES');
    }

    const { isImageExtension } = require('../../ai_image_check');
    const mimeType = b.mimeType ? String(b.mimeType) : null;
    const isImage = isImageExtension(filename) || /^image\//i.test(mimeType || '');
    const fileRowId = randomUUID();

    await execute(
      `INSERT INTO order_files
         (id, order_id, url, filename, mime_type, size, ai_quality_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [fileRowId, draft.id, key, filename, mimeType,
       b.size == null ? null : Number(b.size),
       isImage ? 'pending' : 'skipped']
    );
    await execute(
      `UPDATE orders SET updated_at = $1 WHERE id = $2`,
      [new Date().toISOString(), draft.id]
    );

    return res.ok({ file: { id: fileRowId, filename, mimeType, size: b.size ?? null } });
  } catch (err) {
    return failFromError(res, err, 'api.cases_draft.attach_file', req);
  }
});

// ─── DELETE /cases/draft/:id/files/:fileId ──────────────────────────────────
//
// Remove a document from the draft. Scoped through the draft's own id so a
// file id alone is not enough to delete anything.
//
// The R2 object is left in place: the lifecycle rule on orders/draft/ reclaims
// it, and deleting bytes synchronously from a request that might be a mis-tap
// is the wrong trade when storage is cheap and a patient's scan is not.
router.delete('/:id/files/:fileId', async (req, res) => {
  try {
    const draft = await loadOwnedDraft(req.params.id, req.user.id);
    if (!draft) return res.fail('Draft not found', 404, 'NOT_FOUND');

    const result = await execute(
      'DELETE FROM order_files WHERE id = $1 AND order_id = $2',
      [req.params.fileId, draft.id]
    );
    if (!result || result.rowCount === 0) {
      return res.fail('File not found', 404, 'NOT_FOUND');
    }
    return res.ok({ deleted: true });
  } catch (err) {
    return failFromError(res, err, 'api.cases_draft.delete_file', req);
  }
});

// ─── POST /cases/draft/:id/documents-done ───────────────────────────────────
//
// Step 2 complete. Two jobs, in this order:
//
//   1. Enforce "at least one document". This is a BUSINESS rule, confirmed
//      2026-08-25: a second opinion with nothing to give an opinion on is not a
//      product. The web wizard has always enforced it (err=needs_files); the
//      app never did, so an app case could reach a doctor with no images at
//      all. This is the parity half of the decision, not a new restriction.
//
//   2. Fire the specialty classifier. This is why the step exists as its own
//      call rather than a plain PATCH: the classifier reads the condition text
//      and the moment we know the patient has finished with documents is the
//      right moment to spend a Haiku call, so the suggestion is already waiting
//      when they land on step 3.
//
// Enqueued via pg-boss so the response is not blocked on the ~2-3s model call.
// Set CLASSIFIER_ASYNC=false to fall back to inline, matching the web wizard's
// rollback switch exactly — one env var moves BOTH surfaces, which is the point
// of calling the same runClassification.
router.post('/:id/documents-done', async (req, res) => {
  try {
    const draft = await loadOwnedDraft(req.params.id, req.user.id);
    if (!draft) return res.fail('Draft not found', 404, 'NOT_FOUND');

    const count = await queryOne(
      'SELECT COUNT(*) AS c FROM order_files WHERE order_id = $1', [draft.id]
    );
    if (!count || Number(count.c) === 0) {
      return res.fail(
        'Please attach at least one scan or report before continuing.',
        422, 'NEEDS_FILES'
      );
    }

    await execute(
      `UPDATE orders
          SET draft_step = GREATEST(COALESCE(draft_step, 0), 2), updated_at = $1
        WHERE id = $2 AND patient_id = $3 AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
      [new Date().toISOString(), draft.id, req.user.id]
    );

    // Classifier failure must never block the patient. Step 3 renders the plain
    // specialty grid when no classification row exists, which is the same
    // fallback the web wizard uses and is a perfectly usable screen.
    if (process.env.CLASSIFIER_ASYNC !== 'false') {
      try {
        const { enqueueSpecialtyClassify } = require('../../job_queue');
        await enqueueSpecialtyClassify(draft.id);
      } catch (err) {
        logErrorToDb(err, {
          context: 'api.cases_draft.enqueue_classify',
          userId: req.user.id, orderId: draft.id, category: 'patient_case'
        });
      }
    } else {
      try {
        const { runClassification } = require('../../services/classify_job');
        await runClassification(draft.id);
      } catch (err) {
        logErrorToDb(err, {
          context: 'api.cases_draft.classify_inline',
          userId: req.user.id, orderId: draft.id, category: 'patient_case'
        });
      }
    }

    return res.ok({ draftStep: 2, fileCount: Number(count.c) });
  } catch (err) {
    return failFromError(res, err, 'api.cases_draft.documents_done', req);
  }
});

// ─── GET /cases/draft/:id/classification ────────────────────────────────────
//
// The app polls this on step 3 while the banner says "analysing…". It is the
// JSON twin of the web wizard's /patient/new-case/:id/classification.json.
//
// `null` is a normal answer, not an error: it means the worker has not landed a
// row yet, or the call failed and never will. The client shows the plain grid
// either way — nothing in the flow may depend on the AI being present.
router.get('/:id/classification', async (req, res) => {
  try {
    const draft = await loadOwnedDraft(req.params.id, req.user.id);
    if (!draft) return res.fail('Draft not found', 404, 'NOT_FOUND');

    const row = await queryOne(
      `SELECT specialty_id, service_id, confidence, reasoning
         FROM specialty_classifications
        WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [draft.id]
    );
    if (!row) return res.ok({ classification: null });

    // The thresholds are operator-tunable from /superadmin/settings, so they
    // are read live rather than baked in. `locked` tells the client the AI is
    // confident enough that overriding carries the SLA-refund consequence
    // below; `belowFloor` tells it to show the plain grid with no suggestion
    // at all rather than lead with a guess it does not stand behind.
    let thresholds = null;
    try {
      thresholds = await require('../../services/admin_settings').getThresholds();
    } catch (_) { /* fall through to an unqualified suggestion */ }

    const confidence = row.confidence == null ? null : Number(row.confidence);
    return res.ok({
      classification: {
        specialtyId: row.specialty_id || null,
        serviceId: row.service_id || null,
        confidence: confidence,
        reasoning: row.reasoning || null,
        locked: !!(thresholds && confidence != null && confidence >= thresholds.lock),
        belowFloor: !!(thresholds && confidence != null &&
                       thresholds.min != null && confidence < thresholds.min)
      }
    });
  } catch (err) {
    return failFromError(res, err, 'api.cases_draft.classification', req);
  }
});

// ─── POST /cases/draft/:id/submit ───────────────────────────────────────────
//
// The draft becomes a real case.
//
// Everything money-related routes through services/case_intake_pricing so this
// cannot drift from POST /api/v1/cases or from the web wizard. What is left
// here is the state transition and the two audit trails.
//
// ── The override record ─────────────────────────────────────────────────────
//
// If the patient chose a different specialty or service than the AI suggested,
// we record BOTH picks in specialty_classification_overrides. Two reasons, and
// the second one matters more than it looks:
//
//   1. The patient is knowingly routing their own case, so the SLA refund
//      guarantee no longer applies — no_sla_refund_eligibility is set, exactly
//      as the web wizard sets it. The app MUST tell the patient this before
//      they override; a silent forfeit of a refund right would be indefensible.
//
//   2. It is the training signal. Every one of these rows is a labelled
//      correction, and the learner reads them back. Which is also why the
//      insert is best-effort and never blocks a submission: losing one training
//      row is nothing, losing a patient's case is not.
//
// The locked-tier check mirrors the web wizard's: above the lock threshold the
// client hides the override affordance entirely, so a mismatched pair arriving
// here is a forged or badly stale client and is refused rather than recorded.
router.post('/:id/submit', async (req, res) => {
  try {
    const draft = await loadOwnedDraft(req.params.id, req.user.id);
    if (!draft) return res.fail('Draft not found', 404, 'NOT_FOUND');

    const b = req.body || {};
    const specialtyId = b.specialtyId || draft.specialty_id || null;
    const serviceId = b.serviceId || draft.service_id || null;
    const urgencyTier = b.urgencyTier || draft.urgency_tier || 'standard';
    const country = b.country || draft.country || 'EG';

    if (!serviceId) {
      return res.fail('Please choose a service.', 422, 'VALIDATION_ERROR');
    }
    if (!draft.clinical_question || String(draft.clinical_question).trim().length < 10) {
      return res.fail(
        'Please describe your concern in at least 10 characters.',
        422, 'VALIDATION_ERROR'
      );
    }

    // The documents rule, enforced again at the moment it becomes binding.
    // documents-done already checked it, but a client can call submit directly
    // and a file can be deleted between the two calls. Client-side enforcement
    // is not enforcement; this is the line that actually holds.
    const files = await queryAll(
      `SELECT id, filename, mime_type, url, uploadcare_uuid, ai_quality_status
         FROM order_files WHERE order_id = $1 ORDER BY created_at ASC`,
      [draft.id]
    );
    if (files.length === 0) {
      return res.fail(
        'Please attach at least one scan or report before submitting.',
        422, 'NEEDS_FILES'
      );
    }
    if (files.length > MAX_FILES) {
      return res.fail('Attach between 1 and ' + MAX_FILES + ' files.', 400, 'TOO_MANY_FILES');
    }

    // Validate + price. Throws IntakeError for anything the patient can fix.
    const intake = await resolveAndPriceIntake({
      serviceId, specialtyId, country, urgencyTier, urgent: false
    });

    // ── Override audit, best effort ──
    try {
      const classRow = await queryOne(
        `SELECT specialty_id, service_id, confidence FROM specialty_classifications
          WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [draft.id]
      );
      if (classRow) {
        const specialtyMismatch =
          classRow.specialty_id && String(classRow.specialty_id) !== String(intake.resolvedSpecialtyId);
        const serviceMismatch =
          classRow.service_id && String(classRow.service_id) !== String(serviceId);

        if (specialtyMismatch || serviceMismatch) {
          const { lock: lockThreshold } = await require('../../services/admin_settings').getThresholds();
          if (Number(classRow.confidence) >= lockThreshold) {
            return res.fail(
              'This case is locked to the recommended specialty. Please refresh and try again.',
              409, 'OVERRIDE_NOT_PERMITTED'
            );
          }
          await execute(
            `INSERT INTO specialty_classification_overrides
               (id, case_id, ai_specialty_id, ai_service_id, ai_confidence,
                patient_specialty_id, patient_service_id, override_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [randomUUID(), draft.id,
             classRow.specialty_id, classRow.service_id,
             classRow.confidence == null ? null : Number(classRow.confidence),
             intake.resolvedSpecialtyId, serviceId, new Date().toISOString()]
          );
          await execute(
            `UPDATE orders SET no_sla_refund_eligibility = true, updated_at = $1 WHERE id = $2`,
            [new Date().toISOString(), draft.id]
          );
        }
      }
    } catch (err) {
      if (err instanceof IntakeError) throw err;
      logErrorToDb(err, {
        context: 'api.cases_draft.override_audit',
        userId: req.user.id, orderId: draft.id, category: 'patient_case'
      });
    }

    // ── The transition ──
    //
    // deadline_at is deliberately NOT set. Per the SLA model the clock starts
    // when a DOCTOR ACCEPTS (case_lifecycle sets deadline_at then, and
    // markCasePaid explicitly nulls it), so stamping it now would manufacture
    // phantom breaches on a case nobody has even been paid for yet.
    // sla_deadline is the informational "promised by" figure shown to the
    // patient, which is a different thing wearing a similar name.
    //
    // The WHERE clause re-asserts DRAFT, so a double-tapped Submit updates
    // nothing the second time instead of re-pricing a live case.
    const refNumber = await generateReferenceId();
    const slaDeadline = new Date(Date.now() + intake.slaHours * 60 * 60 * 1000).toISOString();

    const result = await execute(
      // paymob_intention_id / payment_link are nulled alongside the price.
      // A draft should not have a live link yet, but "should not" is not an
      // invariant: the web wizard mints one at its step 5, and a patient who
      // backs out to change service and resubmits would otherwise be handed a
      // checkout for the OLD amount. Same rule the refund and admin price
      // paths follow (tests/lint/payment-money-paths-wiring).
      `UPDATE orders
          SET reference_id = COALESCE(reference_id, $1),
              paymob_intention_id = NULL,
              payment_link = NULL,
              service_id = $2,
              specialty_id = $3,
              status = 'submitted',
              country = $4,
              base_price = $5,
              price = $6,
              urgency_uplift_amount = $7,
              currency = 'EGP',
              doctor_fee = $8,
              display_price = $9,
              display_currency = $10,
              sla_deadline = $11,
              sla_hours = $12,
              urgency_flag = $13,
              urgency_tier = $14,
              draft_step = 5,
              updated_at = NOW()
        WHERE id = $15 AND patient_id = $16
          AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
      [refNumber, serviceId, intake.resolvedSpecialtyId, intake.displayCountry,
       intake.charge.egpBase, intake.pricing.totalPrice, intake.pricing.upliftAmount,
       intake.charge.doctorFeeEgp,
       // display_price is the LOCAL BASE, un-multiplied. See the long note in
       // case_intake_pricing.priceCaseForMarket — writing the uplifted total
       // here makes a VIP order render at base x 1.3 x 1.3.
       intake.charge.displayPrice, intake.charge.displayCurrency,
       slaDeadline, intake.slaHours, intake.urgencyFlag, intake.urgencyTier,
       draft.id, req.user.id]
    );

    if (!result || result.rowCount === 0) {
      // Lost the race with another submit, or the draft moved on. Report what
      // the row actually is now rather than inventing a failure.
      const now = await queryOne(
        'SELECT id, status, reference_id FROM orders_active WHERE id = $1 AND patient_id = $2',
        [draft.id, req.user.id]
      );
      if (now && String(now.status || '').toLowerCase() === 'submitted') {
        return res.ok({ id: now.id, referenceId: now.reference_id, status: now.status, alreadySubmitted: true });
      }
      return res.fail('This case could not be submitted. Please reopen it and try again.', 409, 'DRAFT_CONFLICT');
    }

    try {
      await execute(
        `INSERT INTO order_timeline (id, order_id, status, description, created_at)
         VALUES ($1, $2, 'submitted', 'Case submitted with files', NOW())`,
        [randomUUID(), draft.id]
      );
    } catch (err) {
      logErrorToDb(err, {
        context: 'api.cases_draft.timeline',
        userId: req.user.id, orderId: draft.id, category: 'patient_case'
      });
    }

    // Fire-and-forget AI image quality check, same worker shape as
    // POST /api/v1/cases. The HTTP response must not wait on it — the patient
    // goes straight to payment and the app polls GET /cases/:id for results.
    scheduleImageQualityChecks(files, intake.service);

    const created = await queryOne(
      `SELECT o.id, o.reference_id, o.status, o.price, o.display_price,
              o.currency, o.display_currency, o.sla_hours, o.deadline_at,
              o.sla_deadline, o.created_at,
              s.name AS "serviceName", sp.name AS "specialtyName"
         FROM orders_active o
         LEFT JOIN services s ON o.service_id = s.id
         LEFT JOIN specialties sp ON s.specialty_id = sp.id
        WHERE o.id = $1`,
      [draft.id]
    );

    return res.ok({
      id: created.id,
      referenceId: created.reference_id,
      status: created.status,
      serviceName: created.serviceName,
      specialtyName: created.specialtyName,
      price: created.display_price != null ? created.display_price : created.price,
      currency: created.display_currency || created.currency,
      slaHours: created.sla_hours != null ? Number(created.sla_hours) : null,
      slaDeadline: created.deadline_at || created.sla_deadline || null,
      createdAt: created.created_at
    });
  } catch (err) {
    return failFromError(res, err, 'api.cases_draft.submit', req);
  }
});

module.exports = router;
