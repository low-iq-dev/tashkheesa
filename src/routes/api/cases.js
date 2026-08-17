/**
 * Cases API Routes — /api/v1/cases/*
 *
 * Handles case submission, listing, detail, and status actions.
 * Wraps the existing order logic from the portal.
 */

const router = require('express').Router();
const { randomUUID } = require('crypto');
const { coerceCountry } = require('../../launch-market');
const { egpChargeFromLocal } = require('../../fx');
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
// Mobile checkout: mint the Paymob link server-side inside GET /cases/:id/payment
// (the app never calls the web POST /payments/paymob/create-intention route).
const { ensurePaymentLinkForOrder } = require('../../services/paymob_intention');
const { logErrorToDb } = require('../../logger');

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

    // AUDIT-P1-3: these were case-SENSITIVE comparisons against lowercase
    // values. case_lifecycle forces canonical UPPERCASE on write, and
    // 'under_review' / 'in_progress' exist nowhere in the codebase at all. Every
    // filter therefore matched zero rows for any case created through the web
    // wizard: the app showed an empty list for both Active and Completed.
    if (statusFilter === 'active') {
      whereClause += " AND LOWER(COALESCE(o.status, '')) IN ('draft','submitted','new','paid','assigned','accepted','in_review','rejected_files','sla_breach','reassigned')";
    } else if (statusFilter === 'completed') {
      whereClause += " AND LOWER(COALESCE(o.status, '')) IN ('completed','done','delivered','report_ready','finalized')";
    } else if (statusFilter === 'cancelled') {
      whereClause += " AND LOWER(COALESCE(o.status, '')) IN ('cancelled','canceled','refunded','expired_unpaid')";
    }

    const cases = await safeAll(`
      SELECT
        o.id, o.reference_id as "referenceId", o.patient_id as "patientId",
        o.doctor_id as "doctorId", o.service_id as "serviceId",
        o.status, o.clinical_question as "clinicalQuestion",
        -- AUDIT-APP-H1: price is the amount the patient actually owes
        -- (base + urgency uplift). This projected base_price, so the app showed
        -- a smaller figure than the card was charged.
        o.price, o.base_price as "basePrice", o.urgency_uplift_amount as "urgencyUplift", o.currency,
        -- AUDIT-APP-H3: deadline_at is NULL by design until a doctor accepts, so
        -- the app's SLA countdown showed nothing for the whole pre-acceptance
        -- window — exactly when the patient is watching the clock they paid for.
        COALESCE(o.deadline_at, o.sla_deadline) as "slaDeadline",
        o.deadline_at as "acceptedDeadline",
        -- AUDIT-APP-M1: return the tier and hours instead of making the app
        -- infer them from (deadline - created), which includes the whole
        -- pre-acceptance wait and mislabels Urgent cases as VIP.
        o.sla_hours as "slaHours", o.urgency_tier as "urgencyTier",
        o.created_at as "createdAt",
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
        o.price, o.base_price as "basePrice", o.urgency_uplift_amount as "urgencyUplift", o.currency,
        COALESCE(o.deadline_at, o.sla_deadline) as "slaDeadline",
        o.deadline_at as "acceptedDeadline",
        o.sla_hours as "slaHours", o.urgency_tier as "urgencyTier",
        o.created_at as "createdAt",
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

    // AUDIT-APP-M5: whether this patient has already rated the case. The review
    // endpoint has existed since launch with ZERO call sites in the app — there
    // was no rating UI at all, so `reviews` is empty and doctor quality is
    // unmeasurable. The app now renders the prompt on completed cases, and
    // needs this flag to avoid offering it a second time (the POST 409s).
    const review = await safeGet(
      'SELECT id, rating FROM reviews WHERE order_id = $1 AND patient_id = $2',
      [caseData.id, req.user.id]
    );
    caseData.hasReview = !!review;
    caseData.reviewRating = review ? review.rating : null;

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
    // AUDIT-APP-H12 — the app exports MAX_FILES = 15 and ALLOWED_FILE_TYPES and
    // imports neither; its validateFile() takes a mimeType and never reads it.
    // Server-side there was no cap either, so a patient could attach 200 files
    // of any type. The real allowlist lives in middleware/upload.js, which only
    // guards POST /api/v1/files — so this is the one place that can enforce it
    // for the case-creation payload.
    body('files').isArray({ min: 1, max: 15 })
      .withMessage('Attach between 1 and 15 files.'),
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
    // SLA hours per §2 — AUDIT-P0-8: use the canonical map in case_lifecycle
    // instead of an inline copy, so this can never drift from the web funnel
    // or from the doctor acceptance-window calculation again.
    const slaHours = require('../../case_lifecycle').slaHoursForTier(tier);
    const urgencyFlag = tier !== 'standard';
    const urgencyTier = tier;

    // Validate service exists AND is bookable. The mobile path historically
    // checked NEITHER is_visible NOR coming_soon (spec §4.5) — a stale app
    // screen or a direct POST could mint an order for a service with no active
    // doctor. coming_soon is NOT NULL DEFAULT false in prod; COALESCE keeps the
    // guard safe on any older clone lacking the column defaults.
    const service = await safeGet('SELECT * FROM services WHERE id = $1', [serviceId]);
    if (!service) {
      return res.fail('Invalid service', 400, 'INVALID_SERVICE');
    }
    const isVisible = service.is_visible == null ? true : !!service.is_visible;
    const isComingSoon = service.coming_soon == null ? false : !!service.coming_soon;
    if (!isVisible || isComingSoon) {
      return res.fail('This service is not available for booking', 400, 'SERVICE_NOT_BOOKABLE');
    }

    // ALWAYS-CHARGE-EGP: look up the patient's LOCAL market price (real country,
    // NOT clamped), then convert to the EGP charge base. The card is charged in
    // EGP (currency pinned 'EGP' below); display_* hold the local figures for show.
    const displayCountry = String(country || 'EG').trim().toUpperCase() || 'EG';
    const regionalPrice = await safeGet(
      "SELECT tashkheesa_price, currency FROM service_regional_prices WHERE service_id = $1 AND country_code = $2 AND COALESCE(status, 'active') = 'active'",
      [serviceId, displayCountry]
    );
    const localBase = regionalPrice?.tashkheesa_price != null ? regionalPrice.tashkheesa_price : service.base_price;
    const localCurrency = regionalPrice?.currency || service.currency || 'EGP';
    let charge;
    try {
      charge = egpChargeFromLocal(localBase, localCurrency);
    } catch (fxErr) {
      return res.fail('Unsupported currency for this market', 400, 'UNSUPPORTED_CURRENCY');
    }

    // ── AUDIT-APP-H1: APPLY THE URGENCY UPLIFT ─────────────────────────────
    //
    // This route priced every order at the flat base and NEVER applied the tier
    // multiplier, while the app displayed basePrice x 1.3 (vip) / 1.6 (urgent)
    // as the checkout total. Two consequences: the patient saw one number on
    // the review screen and a smaller one on the confirmation, and Tashkheesa
    // collected NO urgency premium on any app order while still honouring the
    // 18h/4h SLA — and earnings_writer had no uplift to split with the doctor.
    //
    // computeOrderPricing is the same helper the web wizard uses
    // (routes/patient.js), so app and web now price identically, including any
    // per-service vip_multiplier / urgent_multiplier override.
    const { computeOrderPricing } = require('../../services/urgency_pricing');
    const pricing = computeOrderPricing({
      basePrice: charge.egpBase,
      urgencyTier: urgencyTier,
      servicesRow: service
    });
    // AUDIT (2026-08-17) — display_price is written UN-MULTIPLIED, deliberately.
    //
    // A `displayPricing = computeOrderPricing({ basePrice: charge.displayPrice,
    // urgencyTier })` block used to sit here and its totalPrice was stored in
    // display_price. That breaks the column's contract. Both readers assert the
    // opposite invariant — display_price is the LOCAL BASE, and the tier
    // multiplier is re-derived as (price / base_price) and applied at RENDER
    // time:
    //   * routes/patient.js:3087-3095 (pay page / order review)
    //   * src/notification_worker.js:216-223 (payment-success receipt)
    // Pre-multiplying here therefore made an app-created VIP order render at
    // base × 1.3 × 1.3 — a 69% overstatement of what the patient is told they
    // paid, against an EGP charge that is correctly base × 1.3. The web wizard
    // (routes/patient.js persistTierPricing) stores charge.displayPrice raw;
    // this path now matches it, so app and web agree.

    // AUDIT-APP-M2: derive specialty_id from the service row rather than
    // trusting the client. orders.specialty_id has no FK, so a stale client
    // build can write a dangling id that LOOKS populated — which defeats the
    // `no_specialty` guard in auto_assign entirely.
    const resolvedSpecialtyId = service.specialty_id || specialtyId || null;
    if (specialtyId && service.specialty_id && String(specialtyId) !== String(service.specialty_id)) {
      return res.fail('Selected specialty does not match the chosen service.', 400, 'SPECIALTY_SERVICE_MISMATCH');
    }

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
      -- AUDIT-P1-3: specialty_id was validated as REQUIRED at the top of this
      -- handler and destructured from the body, then omitted from the column
      -- list. orders.specialty_id therefore stayed NULL on every app-created
      -- case, and nothing backfills it (there are no triggers). Downstream:
      -- auto_assign bails with 'no_specialty', bulkAutoAssign skips the case,
      -- and the SLA-breach reassign falls back to ANY doctor. Every case
      -- submitted from the mobile app was unroutable.
      -- deadline_at is deliberately NOT set here. Per the SLA model the clock
      -- starts when a doctor ACCEPTS (case_lifecycle sets deadline_at then, and
      -- markCasePaid explicitly nulls it), so stamping it at creation would
      -- produce phantom breaches on unpaid cases. sla_deadline below is the
      -- informational "promised by" figure shown to the patient.
      INSERT INTO orders (
        id, reference_id, patient_id, service_id, specialty_id, status,
        clinical_question, medical_history, country,
        base_price, price, urgency_uplift_amount, currency, doctor_fee,
        display_price, display_currency,
        sla_deadline, sla_hours, urgency_flag, urgency_tier, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'submitted', $6, $7, $8, $9, $10, $11, 'EGP', $12, $13, $14, $15, $16, $17, $18, NOW())
    `, [
      orderId, refNumber, req.user.id, serviceId, resolvedSpecialtyId,
      clinicalQuestion, medicalHistory || null, displayCountry,
      // base_price stays the un-uplifted figure; price is what the patient owes
      // (owedCentsForOrder reads `price`), and urgency_uplift_amount is the
      // delta the 30/70 doctor split applies to.
      charge.egpBase, pricing.totalPrice, pricing.upliftAmount,
      charge.doctorFeeEgp, charge.displayPrice, charge.displayCurrency,
      slaDeadline, slaHours, urgencyFlag, urgencyTier
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
      price: created.display_price != null ? created.display_price : created.price,
      currency: created.display_currency || created.currency,
      // AUDIT-P1-3: was created.deadline_at, which is NULL by design until a
      // doctor accepts — so the app always showed "no deadline". Report the
      // promised turnaround instead, and expose the live deadline separately
      // once it exists.
      slaHours: created.sla_hours != null ? Number(created.sla_hours) : null,
      slaDeadline: created.deadline_at || created.sla_deadline || null,
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

    // AUDIT-P1-3: same case-sensitivity bug — a web-created case is 'SUBMITTED',
    // so POST /cases/:id/cancel always returned CANNOT_CANCEL.
    if (!['submitted', 'new', 'draft'].includes(String(caseData.status || '').toLowerCase())) {
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

    // MOBILE checkout: the app only READS this endpoint — it never calls the WEB
    // POST /payments/paymob/create-intention. So a fresh unpaid order has a NULL
    // payment_link and the app shows "Payment link unavailable". Mint the Paymob
    // intention here (idempotently — reuses an existing link) so the app receives
    // a checkoutUrl. ADDITIVE: the proven web POST route is untouched. A mint
    // failure must NOT turn this read endpoint into a 500 — on ANY error we log
    // and leave paymentLink null (app shows unavailable; the patient can retry).
    if (payment && String(payment.status || '').toLowerCase() !== 'paid' && !payment.paymentLink) {
      try {
        const proto = req.secure ? 'https'
          : (req.headers['x-forwarded-proto'] || req.protocol || 'https');
        const host = req.headers['x-forwarded-host'] || req.get('host');
        const redirectionUrl = proto + '://' + host + '/portal/patient/payment-return';
        const minted = await ensurePaymentLinkForOrder({
          orderId: caseData.id,
          patientId: req.user.id,
          redirectionUrl: redirectionUrl
        });
        if (minted && minted.checkoutUrl) {
          payment.paymentLink = minted.checkoutUrl;
        }
      } catch (mintErr) {
        logErrorToDb(mintErr, {
          context: 'mobile_pay_mint',
          orderId: caseData.id,
          userId: req.user && req.user.id,
          requestId: req.requestId
        });
        // Leave payment.paymentLink null — endpoint still returns 200.
        //
        // AUDIT-APP-C6: but tell the app WHY. The single most common mint
        // failure is PATIENT_PROFILE_INCOMPLETE (OTP signup captures a phone
        // and nothing else; Paymob's intention API requires a billing name and
        // e-mail). Without a reason code the app rendered a generic "payment
        // link unavailable" dead end for a condition the patient can fix in
        // fifteen seconds. .fields lists exactly what is missing.
        payment.paymentLinkError = mintErr && mintErr.code === 'PATIENT_PROFILE_INCOMPLETE'
          ? 'PATIENT_PROFILE_INCOMPLETE'
          : 'PAYMENT_LINK_UNAVAILABLE';
        if (mintErr && Array.isArray(mintErr.fields)) {
          payment.paymentLinkErrorFields = mintErr.fields;
        }
      }
    }

    return res.ok(payment || { status: 'pending' });
  });

  // ─── GET /cases/:id/report ───────────────────────────────
  // AUDIT-APP-C2 — this route did not exist. The patient app calls it from the
  // case-detail screen ("View Report"), so the ENTIRE product deliverable — the
  // written second opinion the patient paid for — 404'd in the app.
  //
  // Mirrors the web /portal/case/:id/download-report contract: resolve
  // orders.report_url, else the newest report_exports row, and return a
  // short-lived signed URL. Ownership-scoped like every other route here, and
  // gated on delivery so a draft PDF is never reachable.
  router.get('/:id/report', async (req, res) => {
    const order = await safeGet(
      `SELECT id, status, report_url FROM orders_active
        WHERE id = $1 AND patient_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!order) return res.fail('Case not found', 404, 'CASE_NOT_FOUND');

    const DELIVERED = ['completed', 'done', 'delivered', 'report_ready', 'report-ready', 'finalized'];
    if (!DELIVERED.includes(String(order.status || '').toLowerCase())) {
      return res.fail('Your report is not ready yet.', 409, 'REPORT_NOT_READY');
    }

    let key = order.report_url || null;
    if (!key) {
      const exported = await safeGet(
        `SELECT file_path FROM report_exports WHERE case_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [order.id]
      );
      if (exported) key = exported.file_path;
    }
    if (!key) return res.fail('Your report is not ready yet.', 409, 'REPORT_NOT_READY');

    // Legacy rows hold a full HTTP URL; newer rows hold an R2 object key.
    if (/^https?:\/\//i.test(key)) {
      return res.ok({ url: key, expiresInSeconds: null });
    }
    try {
      const url = await getSignedDownloadUrl(key, 3600, {
        downloadName: `Tashkheesa-Report-${String(order.id).slice(0, 12).toUpperCase()}.pdf`
      });
      return res.ok({ url, expiresInSeconds: 3600 });
    } catch (err) {
      logErrorToDb(err, { context: 'mobile_report_sign', orderId: order.id });
      return res.fail('Could not prepare your report. Please try again.', 500, 'REPORT_SIGN_ERROR');
    }
  });

  // ─── POST /cases/:id/review ──────────────────────────────

  router.post('/:id/review', [
    body('rating').isInt({ min: 1, max: 5 }),
    body('comment').optional().isString(),
  ], async (req, res) => {
    const caseData = await safeGet(
      // AUDIT-P1-3: was `status = 'completed'` (case-sensitive) — the DB stores
      // 'COMPLETED', so review submission 404'd for every case.
      `SELECT * FROM orders_active
        WHERE id = $1 AND patient_id = $2
          AND LOWER(COALESCE(status, '')) IN ('completed','done','delivered','report_ready','finalized')`,
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

    // AUDIT-P1-2: the reviews table column is review_text, not comment — this
    // INSERT threw on every mobile review submission.
    await safeRun(`
      INSERT INTO reviews (id, order_id, patient_id, doctor_id, rating, review_text, created_at)
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
