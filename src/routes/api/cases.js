/**
 * Cases API Routes — /api/v1/cases/*
 *
 * Handles case submission, listing, detail, and status actions.
 * Wraps the existing order logic from the portal.
 */

const router = require('express').Router();
const { randomUUID } = require('crypto');
const { coerceCountry } = require('../../launch-market');
// Lazy-load express-validator — top-level require takes ~120s and starves DB pool on boot.
let _ev;
function ev() { if (!_ev) _ev = require('express-validator'); return _ev; }
function body(...a) { return ev().body(...a); }
function validationResult(...a) { return ev().validationResult(...a); }
function query(...a) { return ev().query(...a); }
const { validateImageFromUrl, isImageExtension } = require('../../ai_image_check');
// DST-aware Cairo urgent-window gate (single source of truth; Egypt has DST since 2023).
const { isUrgentWindowOpen } = require('../../services/urgency_window');
// Theme 13 Sub-issue D + I: signed-URL generation for the AI image-quality
// worker when the file was uploaded directly to R2 (instead of the legacy
// Uploadcare CDN path). See POST /cases handler below.
const { getSignedDownloadUrl } = require('../../storage');

module.exports = function (db, { safeGet, safeAll, safeRun }) {

  // ─── GET /cases ──────────────────────────────────────────
  // List patient's cases with optional filters + pagination

  router.get('/', [
    query('page').optional().isInt({ min: 1 }),
    query('per_page').optional().isInt({ min: 1, max: 50 }),
    query('status').optional().isString(),
  ], async (req, res) => {
    const patientId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.per_page) || 20;
    const offset = (page - 1) * perPage;
    const statusFilter = req.query.status;

    let paramIndex = 1;
    let whereClause = `WHERE o.patient_id = $${paramIndex++} AND o.deleted_at IS NULL`;
    const params = [patientId];

    if (statusFilter === 'active') {
      whereClause += " AND o.status IN ('submitted','under_review','assigned','in_progress')";
    } else if (statusFilter === 'completed') {
      whereClause += " AND o.status = 'completed'";
    } else if (statusFilter === 'cancelled') {
      whereClause += " AND o.status = 'cancelled'";
    }

    const cases = await safeAll(`
      SELECT
        o.id, o.reference_id as "referenceId", o.patient_id as "patientId",
        o.doctor_id as "doctorId", o.service_id as "serviceId",
        o.status, o.clinical_question as "clinicalQuestion",
        o.base_price as price, o.currency,
        o.sla_deadline as "slaDeadline", o.created_at as "createdAt",
        o.completed_at as "completedAt",
        s.name as "serviceName", sp.name as "specialtyName",
        s.specialty_id as "specialtyId",
        d.name as "doctorName",
        dspec.name as "doctorSpecialty"
      FROM orders_active o
      LEFT JOIN services s ON o.service_id = s.id
      LEFT JOIN specialties sp ON s.specialty_id = sp.id
      LEFT JOIN users d ON o.doctor_id = d.id
      LEFT JOIN specialties dspec ON dspec.id = (
        SELECT ds.specialty_id FROM doctor_specialties ds WHERE ds.doctor_id = d.id LIMIT 1
      )
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `, [...params, perPage, offset]);

    const countRow = await safeGet(
      `SELECT COUNT(*)::int as total FROM orders_active o ${whereClause}`,
      params
    );

    return res.ok(cases, {
      page,
      per_page: perPage,
      total: countRow?.total || 0,
    });
  });

  // ─── GET /cases/:id ──────────────────────────────────────
  // Full case detail with timeline and files

  router.get('/:id', async (req, res) => {
    const caseData = await safeGet(`
      SELECT
        o.id, o.reference_id as "referenceId", o.patient_id as "patientId",
        o.doctor_id as "doctorId", o.service_id as "serviceId",
        o.status, o.clinical_question as "clinicalQuestion",
        o.base_price as price, o.currency,
        o.sla_deadline as "slaDeadline", o.created_at as "createdAt",
        o.completed_at as "completedAt", o.urgency_flag as "urgent",
        s.name as "serviceName", sp.name as "specialtyName",
        s.specialty_id as "specialtyId",
        d.name as "doctorName"
      FROM orders_active o
      LEFT JOIN services s ON o.service_id = s.id
      LEFT JOIN specialties sp ON s.specialty_id = sp.id
      LEFT JOIN users d ON o.doctor_id = d.id
      WHERE o.id = $1 AND o.patient_id = $2 AND o.deleted_at IS NULL
    `, [req.params.id, req.user.id]);

    if (!caseData) {
      return res.fail('Case not found', 404, 'CASE_NOT_FOUND');
    }

    // Get timeline events
    const timeline = await safeAll(`
      SELECT id, status, description, created_at as "createdAt", actor
      FROM order_timeline
      WHERE order_id = $1
      ORDER BY created_at ASC
    `, [caseData.id]) || [];

    // Get files
    const files = await safeAll(`
      SELECT
        id, uploadcare_uuid as "uploadcareUuid", filename,
        mime_type as "mimeType", size,
        ai_quality_status as "aiQualityStatus",
        ai_quality_note as "aiQualityNote",
        created_at as "createdAt"
      FROM order_files
      WHERE order_id = $1
      ORDER BY created_at ASC
    `, [caseData.id]) || [];

    // Add file URLs.
    // - cdnUrl: legacy direct-CDN link for pre-Phase-2 Uploadcare files (kept for
    //   backward compatibility with older mobile app builds).
    // - url: portal-issued path that 302-redirects to a short-lived signed R2 URL.
    //   Works for both Phase 2+ R2 files and legacy Uploadcare rows. New mobile
    //   code should follow this URL (fetch defaults to following 302).
    files.forEach(f => {
      f.cdnUrl = f.uploadcareUuid ? `https://ucarecdn.com/${f.uploadcareUuid}/` : null;
      f.url = `/files/${f.id}`;
    });

    // Payment status. The legacy `payments` table was dropped by
    // migration 042 (and re-created empty by the deleted boot script
    // src/migrate_mobile_api.js, which is why this used to return
    // `null` for every order). Source the same fields from `orders`
    // — payment_status / payment_link were added in migration 002.
    const payment = await safeGet(
      'SELECT payment_status as status, COALESCE(total_price_with_addons, price) as amount, currency, payment_link as "paymentLink" FROM orders_active WHERE id = $1',
      [caseData.id]
    );

    caseData.paymentStatus = payment?.status || 'pending';
    caseData.paymentLink = payment?.paymentLink || null;
    caseData.timeline = timeline;
    caseData.files = files;

    return res.ok(caseData);
  });

  // ─── POST /cases ─────────────────────────────────────────
  // Submit a new case

  router.post('/', [
    body('specialtyId').notEmpty(),
    body('serviceId').notEmpty(),
    body('clinicalQuestion').isLength({ min: 10 }).withMessage('Clinical question must be at least 10 characters'),
    body('files').isArray({ min: 1 }).withMessage('At least one file is required'),
    body('country').notEmpty(),
  ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.fail(errors.array()[0].msg, 422, 'VALIDATION_ERROR');
    }

    const {
      specialtyId, serviceId, clinicalQuestion,
      medicalHistory, files, country, urgent, urgency_tier: rawTier, sla_hours: rawSlaHours
    } = req.body;

    // Theme 13 Sub-issue D — per-file shape validation. Each file must carry
    // EITHER uploadcareUuid (legacy mobile clients, pre-2026-05) OR fileId
    // (new mobile clients sending an R2 key from POST /api/v1/files). Neither-
    // set or both-set are rejected — the server must never have ambiguous file
    // origin. fileId R2-key shape is pinned to the orders/draft/<patient>/
    // <filename> prefix produced by api/files.js (same regex as the portal
    // handler in patient.js for Sub-issue B). See THEME_13_R2_MIGRATION_FIX_PLAN.md §8 Q2.
    for (let i = 0; i < files.length; i++) {
      const f = files[i] || {};
      const hasUuid = !!(f.uploadcareUuid && String(f.uploadcareUuid).trim());
      const hasFileId = !!(f.fileId && String(f.fileId).trim());
      if (hasUuid && hasFileId) {
        return res.fail(
          'files[' + i + ']: cannot set both uploadcareUuid and fileId',
          400,
          'INVALID_FILE'
        );
      }
      if (!hasUuid && !hasFileId) {
        return res.fail(
          'files[' + i + ']: must set uploadcareUuid (legacy) or fileId (new R2 key)',
          400,
          'INVALID_FILE'
        );
      }
      if (hasFileId && !/^orders\/draft\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(String(f.fileId).trim())) {
        return res.fail(
          'files[' + i + ']: fileId must be a valid R2 key',
          400,
          'INVALID_FILE'
        );
      }
    }

    // Map urgency: prefer explicit urgency_tier, fall back to boolean urgent.
    // Canonical names per docs/PAYOUT_AND_URGENCY_POLICY.md §2: standard / vip
    // / urgent.  Legacy 'fast_track' from older mobile clients is normalized
    // to 'vip' on intake (migration 031 handles existing rows).
    let tier = rawTier || (urgent ? 'vip' : 'standard');
    if (tier === 'fast_track') tier = 'vip';
    // SLA hours per §2: standard 48h, vip 18h, urgent 4h.
    const slaHours = tier === 'urgent' ? 4 : tier === 'vip' ? 18 : 48;
    const urgencyFlag = tier !== 'standard';
    const urgencyTier = tier;

    // Validate service exists
    const service = await safeGet('SELECT * FROM services WHERE id = $1', [serviceId]);
    if (!service) {
      return res.fail('Invalid service', 400, 'INVALID_SERVICE');
    }

    // Get regional price if available
    const regionalPrice = await safeGet(
      "SELECT tashkheesa_price, currency FROM service_regional_prices WHERE service_id = $1 AND country_code = $2 AND COALESCE(status, 'active') = 'active'",
      [serviceId, coerceCountry(country)]
    );

    const price = regionalPrice?.tashkheesa_price || service.base_price;
    const currency = regionalPrice?.currency || service.currency || 'EGP';

    // Generate case
    const orderId = randomUUID();
    const refNumber = generateReferenceId();
    const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000).toISOString();

    // Urgent order cutoff: only 07:00–18:59 Cairo wall-clock time.
    // DST-aware via services/urgency_window (Egypt has DST again since April 2023).
    if (urgencyTier === 'urgent' && !isUrgentWindowOpen()) {
      return res.fail(
        'Urgent orders are only available between 7:00am and 7:00pm Cairo time. Please select standard or fast-track.',
        400,
        'URGENT_UNAVAILABLE'
      );
    }

    await safeRun(`
      INSERT INTO orders (
        id, reference_id, patient_id, service_id, status,
        clinical_question, medical_history, country,
        base_price, currency, sla_deadline, sla_hours, urgency_flag, urgency_tier, created_at
      ) VALUES ($1, $2, $3, $4, 'submitted', $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
    `, [
      orderId, refNumber, req.user.id, serviceId,
      clinicalQuestion, medicalHistory || null, coerceCountry(country),
      price, currency, slaDeadline, slaHours, urgencyFlag, urgencyTier
    ]);

    // Insert files. Tag images for async AI quality check; non-images are skipped.
    // Theme 13 Sub-issue D: dual-mode INSERT — each row carries EITHER url
    // (R2 key from new mobile clients) OR uploadcare_uuid (legacy CDN path).
    // The unified /files/:id reader (server.js:507-510) disambiguates by the
    // ^https?:// regex AND the column shape — R2 keys land in `url`, legacy
    // CDN UUIDs land in `uploadcare_uuid` with the CDN URL constructed at
    // read time. Per-file shape validation above guarantees exactly-one-of-two.
    const insertedFiles = [];
    for (const file of files) {
      const fileId = randomUUID();
      const isImage = isImageExtension(file.filename) || /^image\//i.test(file.mimeType || '');
      const initialStatus = isImage ? 'pending' : 'skipped';
      const r2Key = (file.fileId && String(file.fileId).trim()) || null;
      const ucUuid = (file.uploadcareUuid && String(file.uploadcareUuid).trim()) || null;
      await safeRun(`
        INSERT INTO order_files (id, order_id, url, uploadcare_uuid, filename, mime_type, size, ai_quality_status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      `, [fileId, orderId, r2Key, ucUuid, file.filename, file.mimeType, file.size, initialStatus]);
      insertedFiles.push({ id: fileId, r2Key: r2Key, uploadcareUuid: ucUuid, isImage, filename: file.filename });
    }

    // Fire-and-forget AI image quality check. The HTTP response must NOT wait —
    // patient gets case-submitted immediately; mobile polls GET /cases/:id for results.
    //
    // Theme 13 Sub-issue I (bundled with D): branch on r2Key vs uploadcareUuid
    // to source the image bytes. Legacy uploadcareUuid → public CDN URL.
    // R2 key → 1h signed URL via getSignedDownloadUrl(). The signed URL is
    // generated inside the setImmediate worker (which fires within ms of the
    // INSERT), so the 1h expiry is comfortably long. Signing failure is
    // recorded as ai_quality_status='error' so the case still submits.
    setImmediate(() => {
      (async () => {
        for (const f of insertedFiles) {
          if (!f.isImage) continue;
          try {
            let imageUrl = null;
            if (f.uploadcareUuid) {
              imageUrl = `https://ucarecdn.com/${f.uploadcareUuid}/`;
            } else if (f.r2Key) {
              try {
                imageUrl = await getSignedDownloadUrl(f.r2Key, 3600);
              } catch (signErr) {
                await safeRun(
                  `UPDATE order_files SET ai_quality_status = $1, ai_quality_note = $2 WHERE id = $3`,
                  ['error', ('signed-url-failed: ' + String((signErr && signErr.message) || signErr)).slice(0, 500), f.id]
                );
                continue;
              }
            }
            if (!imageUrl) continue;

            const result = await validateImageFromUrl(
              imageUrl,
              service?.name || null
            );

            let status;
            if (result && result.skipped) status = 'skipped';
            else if (result && result.is_medical_image === false) status = 'not_medical';
            else if (result && result.image_quality === 'poor') status = 'poor_quality';
            else if (result && result.image_quality === 'acceptable') status = 'acceptable';
            else if (result && result.matches_expected === false) status = 'wrong_type';
            else status = 'ok';

            const note =
              (result && result.skipped && result.reason) ||
              (result && result.recommendation) ||
              (result && Array.isArray(result.quality_issues) && result.quality_issues.join('; ')) ||
              null;

            await safeRun(
              `UPDATE order_files SET ai_quality_status = $1, ai_quality_note = $2 WHERE id = $3`,
              [status, note, f.id]
            );
          } catch (err) {
            try {
              await safeRun(
                `UPDATE order_files SET ai_quality_status = $1, ai_quality_note = $2 WHERE id = $3`,
                ['error', String((err && err.message) || err).slice(0, 500), f.id]
              );
            } catch (_) { /* swallow — best effort */ }
          }
        }
      })().catch(() => { /* swallow — fire-and-forget */ });
    });

    // Add timeline event
    await safeRun(`
      INSERT INTO order_timeline (id, order_id, status, description, created_at)
      VALUES ($1, $2, 'submitted', 'Case submitted with files', NOW())
    `, [randomUUID(), orderId]);

    // Return created case
    const created = await safeGet(`
      SELECT o.*, s.name as "serviceName", sp.name as "specialtyName"
      FROM orders_active o
      LEFT JOIN services s ON o.service_id = s.id
      LEFT JOIN specialties sp ON s.specialty_id = sp.id
      WHERE o.id = $1
    `, [orderId]);

    return res.ok({
      id: created.id,
      referenceId: created.reference_id,
      status: created.status,
      serviceName: created.serviceName,
      specialtyName: created.specialtyName,
      price,
      currency,
      slaDeadline,
      createdAt: created.created_at,
    });
  });

  // ─── POST /cases/:id/cancel ──────────────────────────────

  router.post('/:id/cancel', async (req, res) => {
    const caseData = await safeGet(
      'SELECT * FROM orders_active WHERE id = $1 AND patient_id = $2',
      [req.params.id, req.user.id]
    );

    if (!caseData) {
      return res.fail('Case not found', 404, 'CASE_NOT_FOUND');
    }

    // Allow cancellation only within 10 minutes of creation
    const createdAt = new Date(caseData.created_at);
    const now = new Date();
    const minutesSinceCreation = (now - createdAt) / (1000 * 60);

    if (minutesSinceCreation > 10) {
      return res.fail('Cancellation window has expired. Cases can only be cancelled within 10 minutes of submission.', 400, 'CANCEL_WINDOW_EXPIRED');
    }

    if (!['submitted', 'under_review'].includes(caseData.status)) {
      return res.fail('This case cannot be cancelled.', 400, 'CANNOT_CANCEL');
    }

    await safeRun("UPDATE orders SET status = 'cancelled' WHERE id = $1", [caseData.id]);

    await safeRun(`
      INSERT INTO order_timeline (id, order_id, status, description, created_at)
      VALUES ($1, $2, 'cancelled', 'Case cancelled by patient', NOW())
    `, [randomUUID(), caseData.id]);

    return res.ok({ message: 'Case cancelled.' });
  });

  // ─── GET /cases/:id/payment ──────────────────────────────

  router.get('/:id/payment', async (req, res) => {
    const caseData = await safeGet(
      'SELECT id FROM orders_active WHERE id = $1 AND patient_id = $2',
      [req.params.id, req.user.id]
    );
    if (!caseData) return res.fail('Case not found', 404);

    // Legacy `payments` table dropped by migration 042. Source the
    // same fields from `orders` — payment_method / paid_at exist
    // since migrations 002 / 020+032 respectively.
    const payment = await safeGet(
      'SELECT payment_status as status, COALESCE(total_price_with_addons, price) as amount, currency, payment_link as "paymentLink", payment_method as method, paid_at as "paidAt" FROM orders_active WHERE id = $1',
      [caseData.id]
    );

    return res.ok(payment || { status: 'pending' });
  });

  // ─── POST /cases/:id/review ──────────────────────────────

  router.post('/:id/review', [
    body('rating').isInt({ min: 1, max: 5 }),
    body('comment').optional().isString(),
  ], async (req, res) => {
    const caseData = await safeGet(
      "SELECT * FROM orders_active WHERE id = $1 AND patient_id = $2 AND status = 'completed'",
      [req.params.id, req.user.id]
    );
    if (!caseData) return res.fail('Case not found or not completed', 404);

    const existing = await safeGet(
      'SELECT id FROM reviews WHERE order_id = $1 AND patient_id = $2',
      [caseData.id, req.user.id]
    );
    if (existing) return res.fail('You already reviewed this case', 409);

    const { rating, comment } = req.body;
    const reviewId = randomUUID();

    await safeRun(`
      INSERT INTO reviews (id, order_id, patient_id, doctor_id, rating, comment, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [reviewId, caseData.id, req.user.id, caseData.doctor_id, rating, comment || null]);

    return res.ok({ id: reviewId, message: 'Review submitted. Thank you!' });
  });

  return router;
};

// ─── Helpers ───────────────────────────────────────────────

function generateReferenceId() {
  const year = new Date().getFullYear();
  const num = String(Math.floor(Math.random() * 999999)).padStart(6, '0');
  return `TSH-${year}-${num}`;
}
