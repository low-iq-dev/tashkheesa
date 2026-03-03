/**
 * Tash Monitoring API — Tashkheesa Backend
 * 
 * Add this file to: src/routes/tash-monitor.js
 * Then in src/server.js add:
 *   const tashMonitor = require('./routes/tash-monitor');
 *   app.use('/api/tash', tashMonitor);
 * 
 * Add to your .env:
 *   TASH_API_KEY=your-secret-key-here (make up a long random string)
 */

const express = require('express');
const router = express.Router();
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.resolve(__dirname, '../../data/portal.db');

// Auth middleware — Tash must send this key in every request
function requireTashKey(req, res, next) {
  const key = req.headers['x-tash-key'];
  if (!key || key !== process.env.TASH_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Helper to open DB
function getDb() {
  return new Database(DB_PATH, { readonly: true });
}

/**
 * GET /api/tash/health
 * Quick ping to confirm the API is reachable
 */
router.get('/health', requireTashKey, (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/**
 * GET /api/tash/overdue-orders
 * Returns orders that have breached their SLA deadline and are not yet completed
 * Tash uses this to alert Ziad about overdue doctor reports
 */
router.get('/overdue-orders', requireTashKey, (req, res) => {
  try {
    const db = getDb();
    const now = new Date().toISOString();

    const overdue = db.prepare(`
      SELECT 
        o.id,
        o.status,
        o.sla_hours,
        o.deadline_at,
        o.created_at,
        o.payment_status,
        o.price,
        o.locked_currency,
        o.breached_at,
        u_patient.email as patient_email,
        u_doctor.email as doctor_email,
        s.name as specialty
      FROM orders o
      LEFT JOIN users u_patient ON u_patient.id = o.patient_id
      LEFT JOIN users u_doctor ON u_doctor.id = o.doctor_id
      LEFT JOIN specialties s ON s.id = o.specialty_id
      WHERE 
        o.status NOT IN ('completed', 'cancelled', 'rejected')
        AND o.payment_status = 'paid'
        AND o.deadline_at IS NOT NULL
        AND o.deadline_at < ?
      ORDER BY o.deadline_at ASC
    `).all(now);

    db.close();
    res.json({ count: overdue.length, orders: overdue });
  } catch (err) {
    console.error('[tash-monitor] overdue-orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tash/payment-issues
 * Returns orders that are paid but stuck, or unpaid past 2 hours
 * Tash uses this to alert Ziad about payment failures
 */
router.get('/payment-issues', requireTashKey, (req, res) => {
  try {
    const db = getDb();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const issues = db.prepare(`
      SELECT 
        o.id,
        o.status,
        o.payment_status,
        o.payment_method,
        o.price,
        o.locked_currency,
        o.created_at,
        o.paid_at,
        u.email as patient_email
      FROM orders o
      LEFT JOIN users u ON u.id = o.patient_id
      WHERE 
        o.payment_status = 'unpaid'
        AND o.status NOT IN ('cancelled', 'rejected')
        AND o.created_at < ?
      ORDER BY o.created_at DESC
      LIMIT 20
    `).all(twoHoursAgo);

    db.close();
    res.json({ count: issues.length, issues });
  } catch (err) {
    console.error('[tash-monitor] payment-issues error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tash/dashboard
 * Full ops summary — Tash uses this for the daily 9am report to Ziad
 */
router.get('/dashboard', requireTashKey, (req, res) => {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // New orders in last 24h
    const newOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders 
      WHERE created_at > ? AND payment_status = 'paid'
    `).get(last24h);

    // Active orders (in progress)
    const activeOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders 
      WHERE status NOT IN ('completed', 'cancelled', 'rejected')
      AND payment_status = 'paid'
    `).get();

    // Overdue orders
    const overdueOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders 
      WHERE status NOT IN ('completed', 'cancelled', 'rejected')
      AND payment_status = 'paid'
      AND deadline_at IS NOT NULL
      AND deadline_at < ?
    `).get(now);

    // Completed in last 24h
    const completedToday = db.prepare(`
      SELECT COUNT(*) as count FROM orders 
      WHERE completed_at > ?
    `).get(last24h);

    // Revenue last 7 days
    const revenue7d = db.prepare(`
      SELECT 
        SUM(price) as total,
        locked_currency as currency
      FROM orders 
      WHERE payment_status = 'paid' 
      AND paid_at > ?
      GROUP BY locked_currency
    `).all(last7d);

    // New patients last 24h
    const newPatients = db.prepare(`
      SELECT COUNT(*) as count FROM users 
      WHERE role = 'patient' AND created_at > ?
    `).get(last24h);

    // Pending payment orders older than 2 hours
    const paymentIssues = db.prepare(`
      SELECT COUNT(*) as count FROM orders 
      WHERE payment_status = 'unpaid'
      AND status NOT IN ('cancelled', 'rejected')
      AND created_at < ?
    `).get(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());

    // Recent reviews
    const recentReviews = db.prepare(`
      SELECT rating, comment, created_at FROM reviews 
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 5
    `).all(last24h);

    db.close();

    res.json({
      generated_at: now,
      summary: {
        new_orders_24h: newOrders.count,
        active_orders: activeOrders.count,
        overdue_orders: overdueOrders.count,
        completed_today: completedToday.count,
        new_patients_24h: newPatients.count,
        payment_issues: paymentIssues.count,
      },
      revenue_7d: revenue7d,
      recent_reviews: recentReviews,
      alerts: {
        has_overdue: overdueOrders.count > 0,
        has_payment_issues: paymentIssues.count > 0,
      }
    });
  } catch (err) {
    console.error('[tash-monitor] dashboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tash/recent-reviews
 * Returns recent patient reviews so Tash can flag negative ones
 */
router.get('/recent-reviews', requireTashKey, (req, res) => {
  try {
    const db = getDb();
    const last48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const reviews = db.prepare(`
      SELECT 
        r.rating,
        r.comment,
        r.created_at,
        u.email as patient_email
      FROM reviews r
      LEFT JOIN users u ON u.id = r.patient_id
      WHERE r.created_at > ?
      ORDER BY r.created_at DESC
    `).all(last48h);

    db.close();

    const negative = reviews.filter(r => r.rating <= 2);
    res.json({ 
      count: reviews.length, 
      negative_count: negative.length,
      reviews,
      has_negative: negative.length > 0
    });
  } catch (err) {
    console.error('[tash-monitor] recent-reviews error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
