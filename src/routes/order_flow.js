const multer = require('multer');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { randomUUID } = require('crypto');
const {
  createDraftCase,
  submitCase,
  getCase
} = require('../case_lifecycle');
const { db } = require('../db');

const router = express.Router();

function buildConfirmationView(order) {
  const isFast = order.urgency_flag === 1 || order.urgency_flag === true;

  return {
    reference: order.reference_code || order.id,
    slaType: isFast ? 'Fast Track (24h)' : 'Standard (72h)',
    slaDeadline: isFast ? '24 hours' : '72 hours',
    supportEmail: 'support@tashkheesa.com'
  };
}

const uploadRoot = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });

// NOTE: We keep this cookie only for legacy redirects; it is NOT the source of truth.
const LEGACY_INTAKE_COOKIE = 'intake_token';

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const orderId = getOrderIdFromReq(req);
    if (!orderId) return cb(new Error('order_id_missing'));
    const dir = path.join(uploadRoot, 'orders', String(orderId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '_' + safeName);
  }
});

const upload = multer({ storage });

function attachFileToOrder(orderId, file) {
  // Store a public URL (served via /uploads static mount)
  const publicUrl = `/uploads/orders/${orderId}/${file.filename}`;
  db.prepare(
    `INSERT INTO order_files (id, order_id, url, label, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(randomUUID(), orderId, publicUrl, file.originalname);
}


function getOrderIdFromReq(req) {
  // Canonical: explicit route param
  if (req.params && req.params.orderId) return String(req.params.orderId);
  // Legacy fallback: cookie
  const c = req.cookies && req.cookies[LEGACY_INTAKE_COOKIE];
  return c ? String(c) : '';
}

function upsertCaseContext(orderId, { reason_for_review, language, urgency_flag }) {
  // Persist draft intake fields durably (restart-safe)
  const exists = db.prepare('SELECT 1 FROM case_context WHERE case_id = ?').get(orderId);
  if (exists) {
    db.prepare(
      `UPDATE case_context
       SET reason_for_review = ?, urgency_flag = ?, language = ?
       WHERE case_id = ?`
    ).run(reason_for_review || '', urgency_flag ? 1 : 0, language || 'en', orderId);
  } else {
    db.prepare(
      `INSERT INTO case_context (case_id, reason_for_review, urgency_flag, language)
       VALUES (?, ?, ?, ?)`
    ).run(orderId, reason_for_review || '', urgency_flag ? 1 : 0, language || 'en', orderId);
  }

  // Best-effort mirror into the canonical CASE_TABLE columns if present
  try {
    db.prepare(
      `UPDATE orders
       SET language = ?, urgency_flag = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(language || 'en', urgency_flag ? 1 : 0, orderId);
  } catch (e) {
    // ignore if schema differs
  }
}

router.get('/order/start', (req, res) => {
  const orderId = createDraftCase({
    language: 'en',
    urgency_flag: false,
    reason_for_review: ''
  });

  // Legacy cookie only (optional) for backwards compatibility; URL param is canonical.
  res.cookie(LEGACY_INTAKE_COOKIE, orderId, { httpOnly: true, sameSite: 'lax' });

  return res.redirect(`/order/${encodeURIComponent(orderId)}/upload`);
});

// Legacy path (kept): redirect to canonical orderId route if possible
router.get('/order/upload', (req, res) => {
  const legacyId = req.cookies && req.cookies[LEGACY_INTAKE_COOKIE];
  if (!legacyId) return res.redirect('/order/start');
  return res.redirect(`/order/${encodeURIComponent(String(legacyId))}/upload`);
});

router.get('/order/:orderId/upload', (req, res) => {
  const orderId = String(req.params.orderId);
  return res.render('order_upload', { sessionToken: orderId, existingFiles: [] });
});

// Legacy path (kept): redirect to canonical param route if possible
router.post('/order/review', (req, res) => {
  const legacyId = req.cookies && req.cookies[LEGACY_INTAKE_COOKIE];
  if (!legacyId) return res.redirect('/order/start');
  return res.redirect(307, `/order/${encodeURIComponent(String(legacyId))}/review`);
});

router.post('/order/:orderId/review', upload.array('files'), (req, res) => {
  const orderId = String(req.params.orderId);
  const reason = (req.body.reason || '').trim();
  const language = (req.body.language || 'en').trim();
  const urgency = req.body.urgency === 'yes' ? 'yes' : 'no';

  const uploadedFiles = (req.files || []).map(f => ({
    filename: f.filename,
    originalname: f.originalname,
    path: f.path,
    mimetype: f.mimetype
  }));

  // Persist draft intake fields durably (restart-safe)
  upsertCaseContext(orderId, {
    reason_for_review: reason,
    language,
    urgency_flag: urgency === 'yes'
  });

  uploadedFiles.forEach((file) => {
    attachFileToOrder(orderId, file);
  });

  return res.render('order_review', {
    sessionToken: orderId,
    reason,
    language,
    urgency,
    files: uploadedFiles
  });
});

// Legacy path (kept): redirect to canonical param route if possible
router.post('/order/payment', (req, res) => {
  const legacyId = req.cookies && req.cookies[LEGACY_INTAKE_COOKIE];
  if (!legacyId) return res.redirect('/order/start');
  return res.redirect(307, `/order/${encodeURIComponent(String(legacyId))}/payment`);
});

router.post('/order/:orderId/payment', (req, res) => {
  const orderId = String(req.params.orderId);
  const currentCase = getCase(orderId);

  // Move order into submitted state (payment capture is separate)
  submitCase(orderId);

  return res.render('order_payment', {
    sessionToken: orderId,
    reason: currentCase.reason_for_review,
    urgency: currentCase.urgency_flag ? 'yes' : 'no',
    language: currentCase.language,
    files: [],
    caseData: currentCase
  });
});

// Legacy path (kept): redirect to canonical param route if possible
router.post('/order/confirmation', (req, res) => {
  const legacyId = req.cookies && req.cookies[LEGACY_INTAKE_COOKIE];
  if (!legacyId) return res.redirect('/order/start');
  return res.redirect(307, `/order/${encodeURIComponent(String(legacyId))}/confirmation`);
});

router.post('/order/:orderId/confirmation', (req, res) => {
  const orderId = String(req.params.orderId);

  const currentCase = getCase(orderId);
  const paymentStatus = String(currentCase?.payment_status || '').toLowerCase();

  // Clear legacy cookie (not used as source of truth)
  res.clearCookie(LEGACY_INTAKE_COOKIE);

  const view = buildConfirmationView(currentCase);
  return res.render('order_confirmation', view);
});

module.exports = router;
