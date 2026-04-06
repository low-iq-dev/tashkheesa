/**
 * Tashkheesa API v1 — Main Router
 *
 * Mount this in your existing server.js with:
 *   const apiV1 = require('./routes/api_v1')(db, helpers);
 *   app.use('/api/v1', apiV1);
 *
 * This connects the mobile app to your existing backend
 * without changing any portal functionality.
 *
 * @param {Object} db - PostgreSQL pool instance
 * @param {Object} helpers - { safeGet, safeAll, safeRun, sendOtpViaTwilio, sendEmail }
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const apiResponse = require('../middleware/apiResponse');
const { requireJWT, requireRole } = require('../middleware/requireJWT');

module.exports = function (db, helpers) {
  const router = express.Router();

  // ─── Global API Middleware ─────────────────────────────────

  // Standard JSON response helpers (res.ok, res.fail)
  router.use(apiResponse);

  // JSON body parsing
  router.use(express.json({ limit: '5mb' }));

  // CORS for mobile app
  router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ─── Rate Limiting ─────────────────────────────────────────

  // Stricter limits on auth endpoints
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    validate: false,
    message: { success: false, error: 'Too many attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // General API limiter
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    validate: false,
    message: { success: false, error: 'Too many requests. Slow down.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.use(apiLimiter);

  // ─── Public Routes (no auth required) ──────────────────────

  const authRoutes = require('./api/auth')(db, helpers);
  router.use('/auth', authLimiter, authRoutes);

  // ─── Health check ──────────────────────────────────────────

  router.get('/health', (req, res) => {
    res.ok({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
  });

  // ─── Protected Routes (JWT required) ───────────────────────

  router.use(requireJWT);
  router.use(requireRole('patient'));

  // Services & Specialties (read-only)
  const servicesRoutes = require('./api/services')(db, helpers);
  router.use(servicesRoutes); // Mounts /specialties and /services

  // Cases
  const casesRoutes = require('./api/cases')(db, helpers);
  router.use('/cases', casesRoutes);

  // Conversations / Messages
  const convoRoutes = require('./api/conversations')(db, helpers);
  router.use('/conversations', convoRoutes);

  // Notifications
  const notifRoutes = require('./api/notifications')(db, helpers);
  router.use('/notifications', notifRoutes);

  // Profile
  const profileRoutes = require('./api/profile')(db, helpers);
  router.use('/profile', profileRoutes);

  // ─── Prescriptions (read-only for patient) ─────────────────

  router.get('/prescriptions', async (req, res) => {
    const prescriptions = await helpers.safeAll(`
      SELECT p.id, p.order_id as "orderId",
             s.name as "serviceName", d.name as "doctorName",
             p.created_at as "createdAt"
      FROM prescriptions p
      LEFT JOIN orders o ON p.order_id = o.id
      LEFT JOIN services s ON o.service_id = s.id
      LEFT JOIN users d ON p.doctor_id = d.id
      WHERE p.patient_id = $1
      ORDER BY p.created_at DESC
    `, [req.user.id]);

    return res.ok(prescriptions);
  });

  router.get('/prescriptions/:id', async (req, res) => {
    const prescription = await helpers.safeGet(`
      SELECT p.*, s.name as "serviceName", d.name as "doctorName"
      FROM prescriptions p
      LEFT JOIN orders o ON p.order_id = o.id
      LEFT JOIN services s ON o.service_id = s.id
      LEFT JOIN users d ON p.doctor_id = d.id
      WHERE p.id = $1 AND p.patient_id = $2
    `, [req.params.id, req.user.id]);

    if (!prescription) return res.fail('Prescription not found', 404);
    return res.ok(prescription);
  });

  // ─── Global Error Handler ──────────────────────────────────

  router.use((err, req, res, next) => {
    console.error('[api] Error:', err.message, err.stack?.split('\n')[1]);
    return res.fail(
      process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message,
      500,
      'INTERNAL_ERROR'
    );
  });

  // ─── 404 handler ───────────────────────────────────────────

  router.use((req, res) => {
    res.fail(`API endpoint not found: ${req.method} ${req.path}`, 404, 'NOT_FOUND');
  });

  return router;
};
