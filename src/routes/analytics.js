/**
 * Analytics routes — admin dashboard KPIs, charts, and doctor performance.
 */

const express = require('express');
const { db } = require('../db');
const { requireRole } = require('../middleware');
const { major: logMajor } = require('../logger');

const router = express.Router();

// ── Helpers ─────────────────────────────────────────────

function safeGet(sql, params, fallback) {
  try {
    return db.prepare(sql).get(...(Array.isArray(params) ? params : []));
  } catch (e) {
    logMajor('analytics safeGet: ' + e.message);
    return fallback !== undefined ? fallback : null;
  }
}

function safeAll(sql, params) {
  try {
    return db.prepare(sql).all(...(Array.isArray(params) ? params : []));
  } catch (e) {
    logMajor('analytics safeAll: ' + e.message);
    return [];
  }
}

function periodStartDate(period) {
  var d = new Date();
  if (period === '7d')  d.setDate(d.getDate() - 7);
  else if (period === '30d') d.setDate(d.getDate() - 30);
  else if (period === '90d') d.setDate(d.getDate() - 90);
  else d.setMonth(d.getMonth() - 12); // default 12m
  return d.toISOString();
}

function prevPeriodStartDate(period) {
  var d = new Date();
  if (period === '7d')  d.setDate(d.getDate() - 14);
  else if (period === '30d') d.setDate(d.getDate() - 60);
  else if (period === '90d') d.setDate(d.getDate() - 180);
  else d.setMonth(d.getMonth() - 24);
  return d.toISOString();
}

function pctChange(current, previous) {
  if (!previous || previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function tableExists(name) {
  try {
    var row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return !!row;
  } catch (_) {
    return false;
  }
}

// ── GET /portal/admin/analytics ─────────────────────────
router.get(
  '/portal/admin/analytics',
  requireRole('admin', 'superadmin'),
  (req, res) => {
    try {
      var period = req.query.period || '30d';
      var startDate = periodStartDate(period);
      var prevStart = prevPeriodStartDate(period);
      var lang = (req.user && req.user.lang) || 'en';
      var isAr = lang === 'ar';

      // ── KPIs (current period) ──
      var totalCases = (safeGet(
        "SELECT COUNT(*) as c FROM orders WHERE created_at >= ?",
        [startDate], { c: 0 }
      ) || {}).c || 0;

      var paidCases = (safeGet(
        "SELECT COUNT(*) as c FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= ?",
        [startDate], { c: 0 }
      ) || {}).c || 0;

      var totalRevenue = (safeGet(
        "SELECT COALESCE(SUM(price), 0) as t FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= ?",
        [startDate], { t: 0 }
      ) || {}).t || 0;

      var avgCaseValue = paidCases > 0 ? Math.round(totalRevenue / paidCases) : 0;

      var totalUsers = (safeGet(
        "SELECT COUNT(*) as c FROM users WHERE created_at >= ?",
        [startDate], { c: 0 }
      ) || {}).c || 0;

      var activeDoctors = (safeGet(
        "SELECT COUNT(*) as c FROM users WHERE role='doctor' AND is_active=1",
        [], { c: 0 }
      ) || {}).c || 0;

      // Completed cases for SLA
      var completedCases = (safeGet(
        "SELECT COUNT(*) as c FROM orders WHERE status IN ('completed','done','delivered') AND created_at >= ?",
        [startDate], { c: 0 }
      ) || {}).c || 0;

      var onTimeCases = (safeGet(
        "SELECT COUNT(*) as c FROM orders WHERE status IN ('completed','done','delivered') AND completed_at IS NOT NULL AND deadline_at IS NOT NULL AND datetime(completed_at) <= datetime(deadline_at) AND created_at >= ?",
        [startDate], { c: 0 }
      ) || {}).c || 0;

      var slaCompliance = completedCases > 0 ? Math.round((onTimeCases / completedCases) * 100 * 10) / 10 : 100;

      // Previous period for comparison
      var prevCases = (safeGet(
        "SELECT COUNT(*) as c FROM orders WHERE created_at >= ? AND created_at < ?",
        [prevStart, startDate], { c: 0 }
      ) || {}).c || 0;

      var prevRevenue = (safeGet(
        "SELECT COALESCE(SUM(price), 0) as t FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= ? AND created_at < ?",
        [prevStart, startDate], { t: 0 }
      ) || {}).t || 0;

      var prevUsers = (safeGet(
        "SELECT COUNT(*) as c FROM users WHERE created_at >= ? AND created_at < ?",
        [prevStart, startDate], { c: 0 }
      ) || {}).c || 0;

      // ── Attention Counts (all-time, not period-filtered) ──
      var breachedAttention = (safeGet(
        "SELECT COUNT(*) as c FROM orders WHERE status = 'breached'",
        [], { c: 0 }
      ) || {}).c || 0;

      var unpaidAttention = (safeGet(
        "SELECT COUNT(*) as c FROM orders WHERE payment_status = 'unpaid' AND status NOT IN ('expired_unpaid','cancelled')",
        [], { c: 0 }
      ) || {}).c || 0;

      var expiredAttention = (safeGet(
        "SELECT COUNT(*) as c FROM orders WHERE status = 'expired_unpaid'",
        [], { c: 0 }
      ) || {}).c || 0;

      // ── Charts Data ──

      // Revenue by month
      var revenueTrend = safeAll(
        "SELECT strftime('%Y-%m', created_at) as month, COALESCE(SUM(price), 0) as revenue, COUNT(*) as cases FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= ? GROUP BY strftime('%Y-%m', created_at) ORDER BY month ASC",
        [startDate]
      );

      // Revenue by service
      var revenueByService = safeAll(
        "SELECT COALESCE(sv.name, 'Unknown') as name, COALESCE(SUM(o.price), 0) as revenue, COUNT(o.id) as cases FROM orders o LEFT JOIN services sv ON sv.id = o.service_id WHERE o.payment_status IN ('paid','captured') AND o.created_at >= ? GROUP BY o.service_id ORDER BY revenue DESC LIMIT 8",
        [startDate]
      );

      // Cases by status
      var casesByStatus = safeAll(
        "SELECT LOWER(status) as status, COUNT(*) as count FROM orders WHERE created_at >= ? GROUP BY LOWER(status) ORDER BY count DESC",
        [startDate]
      );

      // User growth (daily)
      var userGrowth = safeAll(
        "SELECT strftime('%Y-%m-%d', created_at) as date, role, COUNT(*) as count FROM users WHERE created_at >= ? GROUP BY date, role ORDER BY date ASC",
        [startDate]
      );

      // Top doctors
      var topDoctors = safeAll(
        "SELECT u.id, u.name, u.specialty_id, COALESCE(sp.name, '') as specialty_name, COUNT(o.id) as cases, COALESCE(SUM(o.price), 0) as revenue FROM users u LEFT JOIN orders o ON u.id = o.doctor_id AND o.payment_status IN ('paid','captured') AND o.created_at >= ? LEFT JOIN specialties sp ON sp.id = u.specialty_id WHERE u.role = 'doctor' AND u.is_active = 1 GROUP BY u.id ORDER BY revenue DESC LIMIT 10",
        [startDate]
      );

      // SLA daily compliance
      var slaTrend = safeAll(
        "SELECT strftime('%Y-%m-%d', completed_at) as date, COUNT(*) as total, SUM(CASE WHEN datetime(completed_at) <= datetime(deadline_at) THEN 1 ELSE 0 END) as on_time FROM orders WHERE status IN ('completed','done','delivered') AND completed_at IS NOT NULL AND deadline_at IS NOT NULL AND created_at >= ? GROUP BY strftime('%Y-%m-%d', completed_at) ORDER BY date ASC",
        [startDate]
      );

      // Average turnaround time
      var avgTat = (safeGet(
        "SELECT AVG((julianday(completed_at) - julianday(accepted_at)) * 24) as hours FROM orders WHERE completed_at IS NOT NULL AND accepted_at IS NOT NULL AND created_at >= ?",
        [startDate], { hours: 0 }
      ) || {}).hours || 0;

      // Phase 3: Payment methods breakdown
      var paymentMethods = safeAll(
        "SELECT COALESCE(payment_method, 'unknown') as method, COUNT(*) as count, COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) as revenue FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= ? GROUP BY COALESCE(payment_method, 'unknown') ORDER BY count DESC",
        [startDate]
      );

      // Phase 3: Notifications sent/failed
      var notificationStats = [];
      if (tableExists('notifications')) {
        notificationStats = safeAll(
          "SELECT COALESCE(channel, 'unknown') as channel, status, COUNT(*) as count FROM notifications WHERE created_at >= ? GROUP BY channel, status ORDER BY channel, status",
          [startDate]
        );
      }

      // Phase 3: Doctor workload distribution
      var doctorWorkload = safeAll(
        "SELECT COALESCE(u.name, 'Unassigned') as name, COUNT(o.id) as cases FROM orders o LEFT JOIN users u ON u.id = o.doctor_id WHERE o.created_at >= ? GROUP BY o.doctor_id HAVING COUNT(o.id) > 0 ORDER BY cases DESC LIMIT 15",
        [startDate]
      );

      res.render('admin_analytics', {
        user: req.user,
        lang: lang,
        isAr: isAr,
        period: period,
        kpis: {
          totalCases: totalCases,
          paidCases: paidCases,
          totalRevenue: totalRevenue,
          avgCaseValue: avgCaseValue,
          totalUsers: totalUsers,
          activeDoctors: activeDoctors,
          completedCases: completedCases,
          slaCompliance: slaCompliance,
          avgTatHours: Math.round(avgTat * 10) / 10,
          casesChange: pctChange(totalCases, prevCases),
          revenueChange: pctChange(totalRevenue, prevRevenue),
          usersChange: pctChange(totalUsers, prevUsers)
        },
        charts: {
          revenueTrend: revenueTrend,
          revenueByService: revenueByService,
          casesByStatus: casesByStatus,
          userGrowth: userGrowth,
          topDoctors: topDoctors,
          slaTrend: slaTrend,
          paymentMethods: paymentMethods,
          notificationStats: notificationStats,
          doctorWorkload: doctorWorkload
        },
        attention: {
          breached: breachedAttention,
          unpaid: unpaidAttention,
          expired: expiredAttention
        },
        portalFrame: true,
        portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
        portalActive: 'analytics'
      });
    } catch (err) {
      logMajor('Analytics error: ' + err.message);
      res.status(500).render('admin_analytics', {
        user: req.user,
        lang: 'en',
        isAr: false,
        period: '30d',
        kpis: {},
        charts: {},
        error: 'Failed to load analytics',
        portalFrame: true,
        portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
        portalActive: 'analytics'
      });
    }
  }
);

// ── GET /portal/doctor/analytics ────────────────────────
router.get(
  '/portal/doctor/analytics',
  requireRole('doctor'),
  (req, res) => {
    try {
      var doctorId = req.user.id;
      var period = req.query.period || '30d';
      var startDate = periodStartDate(period);
      var lang = (req.user && req.user.lang) || 'en';
      var isAr = lang === 'ar';

      var totalCases = (safeGet(
        "SELECT COUNT(*) as c FROM orders WHERE doctor_id = ? AND created_at >= ?",
        [doctorId, startDate], { c: 0 }
      ) || {}).c || 0;

      var completedCases = (safeGet(
        "SELECT COUNT(*) as c FROM orders WHERE doctor_id = ? AND status IN ('completed','done','delivered') AND created_at >= ?",
        [doctorId, startDate], { c: 0 }
      ) || {}).c || 0;

      var totalRevenue = (safeGet(
        "SELECT COALESCE(SUM(price), 0) as t FROM orders WHERE doctor_id = ? AND payment_status IN ('paid','captured') AND created_at >= ?",
        [doctorId, startDate], { t: 0 }
      ) || {}).t || 0;

      var onTimeCases = (safeGet(
        "SELECT COUNT(*) as c FROM orders WHERE doctor_id = ? AND status IN ('completed','done','delivered') AND completed_at IS NOT NULL AND deadline_at IS NOT NULL AND datetime(completed_at) <= datetime(deadline_at) AND created_at >= ?",
        [doctorId, startDate], { c: 0 }
      ) || {}).c || 0;

      var slaCompliance = completedCases > 0 ? Math.round((onTimeCases / completedCases) * 100 * 10) / 10 : 100;

      // Monthly revenue
      var monthlyRevenue = safeAll(
        "SELECT strftime('%Y-%m', created_at) as month, COALESCE(SUM(price), 0) as revenue, COUNT(*) as cases FROM orders WHERE doctor_id = ? AND payment_status IN ('paid','captured') AND created_at >= ? GROUP BY strftime('%Y-%m', created_at) ORDER BY month ASC",
        [doctorId, startDate]
      );

      // Cases by specialty
      var casesBySpecialty = safeAll(
        "SELECT COALESCE(sp.name, 'Other') as name, COUNT(*) as count FROM orders o LEFT JOIN specialties sp ON sp.id = o.specialty_id WHERE o.doctor_id = ? AND o.created_at >= ? GROUP BY o.specialty_id ORDER BY count DESC",
        [doctorId, startDate]
      );

      // Recent cases
      var recentCases = safeAll(
        "SELECT o.id, o.status, o.price, o.created_at, o.completed_at, COALESCE(sv.name, 'Service') as service_name, COALESCE(u.name, 'Patient') as patient_name FROM orders o LEFT JOIN services sv ON sv.id = o.service_id LEFT JOIN users u ON u.id = o.patient_id WHERE o.doctor_id = ? ORDER BY o.created_at DESC LIMIT 20",
        [doctorId]
      );

      // Upcoming appointments
      var upcomingAppts = 0;
      if (tableExists('appointments')) {
        upcomingAppts = (safeGet(
          "SELECT COUNT(*) as c FROM appointments WHERE doctor_id = ? AND status IN ('confirmed','pending') AND scheduled_at >= datetime('now')",
          [doctorId], { c: 0 }
        ) || {}).c || 0;
      }

      res.render('doctor_analytics', {
        portalFrame: true,
        portalRole: 'doctor',
        portalActive: 'analytics',
        brand: 'Tashkheesa',
        title: isAr ? 'تحليلاتي' : 'My Analytics',
        user: req.user,
        lang: lang,
        isAr: isAr,
        period: period,
        kpis: {
          totalCases: totalCases,
          completedCases: completedCases,
          totalRevenue: totalRevenue,
          slaCompliance: slaCompliance,
          upcomingAppts: upcomingAppts
        },
        charts: {
          monthlyRevenue: monthlyRevenue,
          casesBySpecialty: casesBySpecialty
        },
        recentCases: recentCases
      });
    } catch (err) {
      logMajor('Doctor analytics error: ' + err.message);
      res.status(500).send('Analytics error');
    }
  }
);

// ── GET /api/analytics/export ───────────────────────────
// CSV export of analytics data
router.get(
  '/api/analytics/export',
  requireRole('admin', 'superadmin'),
  (req, res) => {
    try {
      var period = req.query.period || '30d';
      var type = req.query.type || 'cases';
      var startDate = periodStartDate(period);

      var rows = [];
      var headers = [];

      if (type === 'revenue') {
        headers = ['Month', 'Revenue', 'Cases'];
        rows = safeAll(
          "SELECT strftime('%Y-%m', created_at) as month, COALESCE(SUM(price), 0) as revenue, COUNT(*) as cases FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= ? GROUP BY strftime('%Y-%m', created_at) ORDER BY month ASC",
          [startDate]
        );
      } else if (type === 'doctors') {
        headers = ['Doctor', 'Specialty', 'Cases', 'Revenue'];
        rows = safeAll(
          "SELECT u.name as doctor, COALESCE(sp.name, '') as specialty, COUNT(o.id) as cases, COALESCE(SUM(o.price), 0) as revenue FROM users u LEFT JOIN orders o ON u.id = o.doctor_id AND o.payment_status IN ('paid','captured') AND o.created_at >= ? LEFT JOIN specialties sp ON sp.id = u.specialty_id WHERE u.role = 'doctor' GROUP BY u.id ORDER BY revenue DESC",
          [startDate]
        );
      } else {
        headers = ['Case ID', 'Status', 'Service', 'Price', 'Created', 'Completed'];
        rows = safeAll(
          "SELECT o.id, o.status, COALESCE(sv.name, '') as service, o.price, o.created_at, o.completed_at FROM orders o LEFT JOIN services sv ON sv.id = o.service_id WHERE o.created_at >= ? ORDER BY o.created_at DESC",
          [startDate]
        );
      }

      // Build CSV
      var csv = headers.join(',') + '\n';
      rows.forEach(function(row) {
        var vals = headers.map(function(h) {
          var key = h.toLowerCase().replace(/\s+/g, '_');
          var v = row[key] !== undefined ? row[key] : (row[h] !== undefined ? row[h] : '');
          return '"' + String(v).replace(/"/g, '""') + '"';
        });
        csv += vals.join(',') + '\n';
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="analytics-' + type + '-' + period + '.csv"');
      res.send(csv);
    } catch (err) {
      logMajor('Analytics export error: ' + err.message);
      res.status(500).json({ ok: false, error: 'Export failed' });
    }
  }
);

module.exports = router;
