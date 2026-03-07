// src/routes/referrals.js
// Referral Program (Phase 9)

const express = require('express');
const { randomUUID } = require('crypto');
const { execute } = require('../pg');
const { requireRole } = require('../middleware');
const { sanitizeString } = require('../validators/sanitize');
const { logErrorToDb } = require('../logger');
const { safeAll, safeGet } = require('../sql-utils');

const router = express.Router();

// Generate a referral code: TASH-XXXXX
function generateReferralCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 for clarity
  var code = 'TASH-';
  for (var i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Ensure patient has a referral code (create if not exists)
async function ensureReferralCode(userId) {
  var existing = await safeGet('SELECT code FROM referral_codes WHERE user_id = $1 AND is_active = true', [userId], null);
  if (existing) return existing.code;

  // Generate unique code
  var attempts = 0;
  while (attempts < 10) {
    var code = generateReferralCode();
    var dup = await safeGet('SELECT id FROM referral_codes WHERE code = $1', [code], null);
    if (!dup) {
      var id = randomUUID();
      await execute(
        'INSERT INTO referral_codes (id, user_id, code, type, reward_type, reward_value, is_active, created_at) VALUES ($1, $2, $3, $4, $5, $6, true, $7)',
        [id, userId, code, 'patient', 'discount', 10, new Date().toISOString()]
      );
      return code;
    }
    attempts++;
  }
  return null;
}

// GET /portal/patient/referrals — View referral dashboard
router.get('/portal/patient/referrals', requireRole('patient'), async function(req, res) {
  try {
    var userId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var code = await ensureReferralCode(userId);

    var codeRow = await safeGet('SELECT * FROM referral_codes WHERE user_id = $1 AND is_active = true', [userId], null);

    var redemptions = await safeAll(
      `SELECT r.*, u.name as referred_name
       FROM referral_redemptions r
       LEFT JOIN users u ON u.id = r.referred_id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC`,
      [userId], []
    );

    var totalReferred = redemptions.length;
    var totalRewarded = redemptions.filter(function(r) { return r.reward_granted === true; }).length;

    res.render('patient_referrals', {
      referralCode: code,
      codeRow: codeRow || {},
      redemptions: redemptions,
      totalReferred: totalReferred,
      totalRewarded: totalRewarded,
      lang: lang,
      isAr: isAr,
      pageTitle: isAr ? 'برنامج الإحالة' : 'Referral Program',
      portalFrame: true,
      portalRole: 'patient',
      portalActive: 'referrals',
      brand: 'Tashkheesa',
      title: isAr ? 'برنامج الإحالة' : 'Referral Program',
      user: req.user
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// POST /api/referral/validate — Validate a referral code
router.post('/api/referral/validate', async function(req, res) {
  try {
    var code = sanitizeString(req.body.code || '', 20).trim().toUpperCase();

    if (!code) {
      return res.status(400).json({ ok: false, error: 'Code is required' });
    }

    var codeRow = await safeGet(
      'SELECT rc.*, u.name as referrer_name FROM referral_codes rc LEFT JOIN users u ON u.id = rc.user_id WHERE rc.code = $1 AND rc.is_active = true',
      [code], null
    );

    if (!codeRow) {
      return res.json({ ok: false, valid: false, error: 'Invalid referral code' });
    }

    if (codeRow.max_uses > 0 && codeRow.times_used >= codeRow.max_uses) {
      return res.json({ ok: false, valid: false, error: 'This referral code has reached its usage limit' });
    }

    return res.json({
      ok: true,
      valid: true,
      reward_type: codeRow.reward_type,
      reward_value: codeRow.reward_value,
      referrer_name: codeRow.referrer_name ? codeRow.referrer_name.split(' ')[0] : ''
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/referral/apply — Apply referral discount to an order
router.post('/api/referral/apply', requireRole('patient'), async function(req, res) {
  try {
    var code = sanitizeString(req.body.code || '', 20).trim().toUpperCase();
    var orderId = sanitizeString(req.body.order_id || '', 50).trim();
    var patientId = req.user.id;

    if (!code || !orderId) {
      return res.status(400).json({ ok: false, error: 'Code and order_id are required' });
    }

    // Verify order belongs to this patient and is unpaid
    var order = await safeGet('SELECT id, patient_id, locked_price, price, payment_status, referral_code FROM orders WHERE id = $1', [orderId], null);
    if (!order || String(order.patient_id) !== String(patientId)) {
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }
    if (order.payment_status === 'paid') {
      return res.status(400).json({ ok: false, error: 'Order already paid' });
    }
    if (order.referral_code) {
      return res.status(400).json({ ok: false, error: 'Referral code already applied' });
    }

    // Validate referral code
    var codeRow = await safeGet(
      'SELECT * FROM referral_codes WHERE code = $1 AND is_active = true',
      [code], null
    );
    if (!codeRow) {
      return res.json({ ok: false, error: 'Invalid referral code' });
    }
    // Cannot use own code
    if (String(codeRow.user_id) === String(patientId)) {
      return res.json({ ok: false, error: 'Cannot use your own referral code' });
    }
    if (codeRow.max_uses > 0 && codeRow.times_used >= codeRow.max_uses) {
      return res.json({ ok: false, error: 'Referral code has reached its usage limit' });
    }

    // Calculate discount
    var originalPrice = order.locked_price != null ? Number(order.locked_price) : Number(order.price || 0);
    var discountAmount = 0;
    if (codeRow.reward_type === 'discount') {
      discountAmount = Math.round(originalPrice * (Number(codeRow.reward_value) / 100) * 100) / 100;
    } else {
      discountAmount = Number(codeRow.reward_value || 0);
    }
    var newPrice = Math.max(0, originalPrice - discountAmount);

    // Update order with referral info
    await execute(
      'UPDATE orders SET referral_code = $1, referral_discount = $2, locked_price = $3 WHERE id = $4',
      [code, discountAmount, newPrice, orderId]
    );

    // Create redemption record
    var redemptionId = require('crypto').randomUUID();
    await execute(
      'INSERT INTO referral_redemptions (id, referral_code_id, referrer_id, referred_id, order_id, reward_granted, created_at) VALUES ($1, $2, $3, $4, $5, false, $6)',
      [redemptionId, codeRow.id, codeRow.user_id, patientId, orderId, new Date().toISOString()]
    );

    // Increment usage count
    await execute('UPDATE referral_codes SET times_used = times_used + 1 WHERE id = $1', [codeRow.id]);

    return res.json({
      ok: true,
      discount_amount: discountAmount,
      new_price: newPrice,
      reward_type: codeRow.reward_type,
      reward_value: codeRow.reward_value
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /portal/admin/referrals — Admin referral analytics
router.get('/portal/admin/referrals', requireRole('admin', 'superadmin'), async function(req, res) {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var codes = await safeAll(
      `SELECT rc.*, u.name as user_name, u.email as user_email
       FROM referral_codes rc
       LEFT JOIN users u ON u.id = rc.user_id
       ORDER BY rc.times_used DESC, rc.created_at DESC
       LIMIT 200`,
      [], []
    );

    var totalCodes = codes.length;
    var totalRedemptions = await safeGet('SELECT COUNT(*) as count FROM referral_redemptions', [], { count: 0 });
    var totalRewarded = await safeGet('SELECT COUNT(*) as count FROM referral_redemptions WHERE reward_granted = true', [], { count: 0 });

    res.render('admin_referrals', {
      codes: codes,
      totalCodes: totalCodes,
      totalRedemptions: totalRedemptions ? totalRedemptions.count : 0,
      totalRewarded: totalRewarded ? totalRewarded.count : 0,
      lang: lang,
      isAr: isAr,
      pageTitle: isAr ? 'تحليلات الإحالات' : 'Referral Analytics',
      portalFrame: true,
      portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
      portalActive: 'referrals'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

module.exports = router;
module.exports.ensureReferralCode = ensureReferralCode;
