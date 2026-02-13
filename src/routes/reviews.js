// src/routes/reviews.js
// Patient ratings & reviews

const express = require('express');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { requireRole } = require('../middleware');
const { sanitizeHtml, sanitizeString } = require('../validators/sanitize');
const { logErrorToDb } = require('../logger');
const { safeAll, safeGet } = require('../sql-utils');

const router = express.Router();

// Helper: check if case is completed
function isCaseCompleted(status) {
  var completedStatuses = ['completed', 'done', 'delivered', 'report_ready', 'report-ready', 'finalized'];
  return completedStatuses.indexOf(String(status || '').toLowerCase()) !== -1;
}

// POST /portal/patient/case/:caseId/review — Submit rating
router.post('/portal/patient/case/:caseId/review', requireRole('patient'), function(req, res) {
  try {
    var caseId = String(req.params.caseId || '').trim();
    var patientId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    // Load order
    var order = safeGet('SELECT id, patient_id, doctor_id, status FROM orders WHERE id = ?', [caseId], null);
    if (!order) return res.status(404).json({ ok: false, error: isAr ? 'الطلب غير موجود' : 'Order not found' });

    // Must be the patient's own order
    if (String(order.patient_id) !== String(patientId)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    // Must be completed
    if (!isCaseCompleted(order.status)) {
      return res.status(400).json({ ok: false, error: isAr ? 'لا يمكن التقييم إلا بعد اكتمال الحالة' : 'Can only review completed cases' });
    }

    // Check if already reviewed
    var existing = safeGet('SELECT id FROM reviews WHERE order_id = ?', [caseId], null);
    if (existing) {
      return res.status(400).json({ ok: false, error: isAr ? 'تم التقييم مسبقاً' : 'Already reviewed' });
    }

    // Validate rating
    var rating = parseInt(req.body.rating, 10);
    if (isNaN(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ ok: false, error: isAr ? 'التقييم يجب أن يكون بين 1 و 5' : 'Rating must be between 1 and 5' });
    }

    // Validate text (optional, max 2000 chars)
    var reviewText = sanitizeHtml(sanitizeString(req.body.review_text || '', 2000));
    var isAnonymous = req.body.is_anonymous === '1' || req.body.is_anonymous === 1 ? 1 : 0;

    var reviewId = randomUUID();
    var now = new Date().toISOString();

    db.prepare(
      `INSERT INTO reviews (id, order_id, patient_id, doctor_id, rating, review_text, is_anonymous, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(reviewId, caseId, patientId, order.doctor_id, rating, reviewText || null, isAnonymous, now, now);

    return res.json({ ok: true, message: isAr ? 'شكراً لتقييمك' : 'Thank you for your review' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PUT /portal/patient/review/:reviewId — Edit own review (within 7 days)
router.put('/portal/patient/review/:reviewId', requireRole('patient'), function(req, res) {
  try {
    var reviewId = String(req.params.reviewId).trim();
    var patientId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var review = safeGet('SELECT * FROM reviews WHERE id = ?', [reviewId], null);
    if (!review) return res.status(404).json({ ok: false, error: isAr ? 'التقييم غير موجود' : 'Review not found' });
    if (String(review.patient_id) !== String(patientId)) return res.status(403).json({ ok: false, error: 'Forbidden' });

    // Check 7-day edit window
    var createdAt = new Date(review.created_at);
    var now = new Date();
    var daysDiff = (now - createdAt) / (1000 * 60 * 60 * 24);
    if (daysDiff > 7) {
      return res.status(400).json({ ok: false, error: isAr ? 'انتهت فترة التعديل (7 أيام)' : 'Edit window expired (7 days)' });
    }

    var rating = parseInt(req.body.rating, 10);
    if (isNaN(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ ok: false, error: isAr ? 'التقييم يجب أن يكون بين 1 و 5' : 'Rating must be between 1 and 5' });
    }

    var reviewText = sanitizeHtml(sanitizeString(req.body.review_text || '', 2000));
    var isAnonymous = req.body.is_anonymous === '1' || req.body.is_anonymous === 1 ? 1 : 0;

    db.prepare(
      'UPDATE reviews SET rating = ?, review_text = ?, is_anonymous = ?, updated_at = ? WHERE id = ?'
    ).run(rating, reviewText || null, isAnonymous, new Date().toISOString(), reviewId);

    return res.json({ ok: true, message: isAr ? 'تم تحديث التقييم' : 'Review updated' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /portal/doctor/:doctorId/reviews — Public doctor review page
router.get('/portal/doctor/:doctorId/reviews', function(req, res) {
  try {
    var doctorId = String(req.params.doctorId).trim();
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var doctor = safeGet('SELECT id, name, specialty_id FROM users WHERE id = ? AND role = ?', [doctorId, 'doctor'], null);
    if (!doctor) return res.status(404).send(isAr ? 'الطبيب غير موجود' : 'Doctor not found');

    var specialty = doctor.specialty_id ? safeGet('SELECT name FROM specialties WHERE id = ?', [doctor.specialty_id], null) : null;

    var reviews = safeAll(
      `SELECT r.id, r.rating, r.review_text, r.is_anonymous, r.created_at,
              CASE WHEN r.is_anonymous = 1 THEN NULL ELSE u.name END as patient_name
       FROM reviews r
       LEFT JOIN users u ON u.id = r.patient_id
       WHERE r.doctor_id = ? AND r.is_visible = 1
       ORDER BY r.created_at DESC LIMIT 50`,
      [doctorId], []
    );

    // Average rating
    var statsRow = safeGet(
      'SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM reviews WHERE doctor_id = ? AND is_visible = 1',
      [doctorId], { avg_rating: 0, count: 0 }
    );

    // Rating distribution
    var distribution = safeAll(
      'SELECT rating, COUNT(*) as count FROM reviews WHERE doctor_id = ? AND is_visible = 1 GROUP BY rating ORDER BY rating DESC',
      [doctorId], []
    );

    res.render('doctor_reviews', {
      doctor,
      specialtyName: specialty ? specialty.name : '',
      reviews,
      avgRating: statsRow ? Math.round((statsRow.avg_rating || 0) * 10) / 10 : 0,
      totalReviews: statsRow ? statsRow.count : 0,
      distribution,
      lang,
      isAr,
      pageTitle: isAr ? ('تقييمات د. ' + doctor.name) : ('Reviews for Dr. ' + doctor.name)
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method });
    return res.status(500).send('Server error');
  }
});

// GET /api/doctors/:doctorId/rating — JSON: avg rating, count, distribution
router.get('/api/doctors/:doctorId/rating', function(req, res) {
  try {
    var doctorId = String(req.params.doctorId).trim();

    var statsRow = safeGet(
      'SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM reviews WHERE doctor_id = ? AND is_visible = 1',
      [doctorId], { avg_rating: 0, count: 0 }
    );

    var distribution = safeAll(
      'SELECT rating, COUNT(*) as count FROM reviews WHERE doctor_id = ? AND is_visible = 1 GROUP BY rating ORDER BY rating DESC',
      [doctorId], []
    );

    return res.json({
      ok: true,
      avgRating: statsRow ? Math.round((statsRow.avg_rating || 0) * 10) / 10 : 0,
      totalReviews: statsRow ? statsRow.count : 0,
      distribution
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /portal/admin/review/:reviewId — Admin can hide/flag reviews
router.delete('/portal/admin/review/:reviewId', requireRole('admin', 'superadmin'), function(req, res) {
  try {
    var reviewId = String(req.params.reviewId).trim();
    var action = req.body.action || 'hide'; // 'hide' or 'flag'

    if (action === 'flag') {
      db.prepare('UPDATE reviews SET admin_flagged = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), reviewId);
      return res.json({ ok: true, message: 'Review flagged' });
    } else {
      db.prepare('UPDATE reviews SET is_visible = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), reviewId);
      return res.json({ ok: true, message: 'Review hidden' });
    }
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /admin/reviews — Admin view all reviews
router.get('/admin/reviews', requireRole('admin', 'superadmin'), function(req, res) {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var reviews = safeAll(
      `SELECT r.*, u.name as patient_name, d.name as doctor_name
       FROM reviews r
       LEFT JOIN users u ON u.id = r.patient_id
       LEFT JOIN users d ON d.id = r.doctor_id
       ORDER BY r.created_at DESC LIMIT 200`,
      [], []
    );

    res.render('admin_reviews', {
      reviews,
      lang,
      isAr,
      pageTitle: isAr ? 'إدارة التقييمات' : 'Manage Reviews'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

module.exports = router;
