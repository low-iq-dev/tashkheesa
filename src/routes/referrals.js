// src/routes/referrals.js
// Referral Program (Phase 9)

const express = require('express');
const { randomUUID } = require('crypto');
const { db } = require('../db');
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
function ensureReferralCode(userId) {
  var existing = safeGet('SELECT code FROM referral_codes WHERE user_id = ? AND is_active = 1', [userId], null);
  if (existing) return existing.code;

  // Generate unique code
  var attempts = 0;
  while (attempts < 10) {
    var code = generateReferralCode();
    var dup = safeGet('SELECT id FROM referral_codes WHERE code = ?', [code], null);
    if (!dup) {
      var id = randomUUID();
      db.prepare(
        'INSERT INTO referral_codes (id, user_id, code, type, reward_type, reward_value, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
      ).run(id, userId, code, 'patient', 'discount', 10, new Date().toISOString());
      return code;
    }
    attempts++;
  }
  return null;
}

// GET /portal/patient/referrals — View referral dashboard
router.get('/portal/patient/referrals', requireRole('patient'), function(req, res) {
  try {
    var userId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var code = ensureReferralCode(userId);

    var codeRow = safeGet('SELECT * FROM referral_codes WHERE user_id = ? AND is_active = 1', [userId], null);

    var redemptions = safeAll(
      `SELECT r.*, u.name as referred_name
       FROM referral_redemptions r
       LEFT JOIN users u ON u.id = r.referred_id
       WHERE r.referrer_id = ?
       ORDER BY r.created_at DESC`,
      [userId], []
    );

    var totalReferred = redemptions.length;
    var totalRewarded = redemptions.filter(function(r) { return r.reward_granted === 1; }).length;

    res.render('patient_referrals', {
      referralCode: code,
      codeRow: codeRow || {},
      redemptions: redemptions,
      totalReferred: totalReferred,
      totalRewarded: totalRewarded,
      lang: lang,
      isAr: isAr,
      pageTitle: isAr ? 'برنامج الإحالة' : 'Referral Program'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// POST /api/referral/validate — Validate a referral code
router.post('/api/referral/validate', function(req, res) {
  try {
    var code = sanitizeString(req.body.code || '', 20).trim().toUpperCase();

    if (!code) {
      return res.status(400).json({ ok: false, error: 'Code is required' });
    }

    var codeRow = safeGet(
      'SELECT rc.*, u.name as referrer_name FROM referral_codes rc LEFT JOIN users u ON u.id = rc.user_id WHERE rc.code = ? AND rc.is_active = 1',
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

// GET /portal/admin/referrals — Admin referral analytics
router.get('/portal/admin/referrals', requireRole('admin', 'superadmin'), function(req, res) {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var codes = safeAll(
      `SELECT rc.*, u.name as user_name, u.email as user_email
       FROM referral_codes rc
       LEFT JOIN users u ON u.id = rc.user_id
       ORDER BY rc.times_used DESC, rc.created_at DESC
       LIMIT 200`,
      [], []
    );

    var totalCodes = codes.length;
    var totalRedemptions = safeGet('SELECT COUNT(*) as count FROM referral_redemptions', [], { count: 0 });
    var totalRewarded = safeGet('SELECT COUNT(*) as count FROM referral_redemptions WHERE reward_granted = 1', [], { count: 0 });

    res.render('admin_referrals', {
      codes: codes,
      totalCodes: totalCodes,
      totalRedemptions: totalRedemptions ? totalRedemptions.count : 0,
      totalRewarded: totalRewarded ? totalRewarded.count : 0,
      lang: lang,
      isAr: isAr,
      pageTitle: isAr ? 'تحليلات الإحالات' : 'Referral Analytics',
      portalFrame: true,
      portalRole: 'superadmin',
      portalActive: 'referrals'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

module.exports = router;
module.exports.ensureReferralCode = ensureReferralCode;
