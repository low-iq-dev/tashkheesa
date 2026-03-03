const express = require('express');
const router = express.Router();
const { safeAll, safeGet } = require('../sql-utils');

// Secret key for Tash API access - set TASH_API_KEY in your .env
const TASH_API_KEY = process.env.TASH_API_KEY || 'tash-default-key-change-me';

function requireTashKey(req, res, next) {
  const key = req.headers['x-tash-key'];
  if (!key || key !== TASH_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.get('/api/tash/stats', requireTashKey, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();

    // Total counts
    const totalOrders = await safeGet('SELECT COUNT(*) AS c FROM orders', [], { c: 0 });
    const totalPatients = await safeGet("SELECT COUNT(*) AS c FROM users WHERE role = 'patient'", [], { c: 0 });
    const activeDoctors = await safeGet("SELECT COUNT(*) AS c FROM users WHERE role = 'doctor' AND COALESCE(is_active, false) = true", [], { c: 0 });

    // Order statuses
    const pendingOrders = await safeGet("SELECT COUNT(*) AS c FROM orders WHERE LOWER(COALESCE(status, '')) IN ('new', 'accepted', 'in_review')", [], { c: 0 });
    const completedOrders = await safeGet("SELECT COUNT(*) AS c FROM orders WHERE LOWER(COALESCE(status, '')) = 'completed'", [], { c: 0 });
    const breachedOrders = await safeGet("SELECT COUNT(*) AS c FROM orders WHERE LOWER(COALESCE(status, '')) IN ('breached', 'breached_sla')", [], { c: 0 });

    // Revenue
    const totalRevenue = await safeGet("SELECT COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) AS total FROM orders WHERE LOWER(COALESCE(payment_status, '')) = 'paid'", [], { total: 0 });

    // Today's activity
    const newOrdersToday = await safeGet("SELECT COUNT(*) AS c FROM orders WHERE created_at >= $1", [todayStart], { c: 0 });
    const newPatientsToday = await safeGet("SELECT COUNT(*) AS c FROM users WHERE role = 'patient' AND created_at >= $1", [todayStart], { c: 0 });

    // This month vs last month
    const thisMonthOrders = await safeGet("SELECT COUNT(*) AS c FROM orders WHERE created_at >= $1", [thisMonthStart], { c: 0 });
    const lastMonthOrders = await safeGet("SELECT COUNT(*) AS c FROM orders WHERE created_at >= $1 AND created_at < $2", [lastMonthStart, thisMonthStart], { c: 0 });
    const thisMonthRevenue = await safeGet("SELECT COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) AS total FROM orders WHERE LOWER(COALESCE(payment_status, '')) = 'paid' AND created_at >= $1", [thisMonthStart], { total: 0 });
    const lastMonthRevenue = await safeGet("SELECT COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) AS total FROM orders WHERE LOWER(COALESCE(payment_status, '')) = 'paid' AND created_at >= $1 AND created_at < $2", [lastMonthStart, thisMonthStart], { total: 0 });

    // Failed payments
    const failedPayments = await safeGet("SELECT COUNT(*) AS c FROM orders WHERE LOWER(COALESCE(payment_status, '')) = 'failed'", [], { c: 0 });

    // Breached cases details (doctor SLA exceeded)
    const breachedDetails = await safeAll(
      "SELECT id, status, deadline_at, created_at FROM orders WHERE LOWER(COALESCE(status, '')) IN ('breached', 'breached_sla') ORDER BY deadline_at DESC LIMIT 10",
      [], []
    );

    res.json({
      timestamp: now.toISOString(),
      overview: {
        total_orders: totalOrders.c,
        total_patients: totalPatients.c,
        active_doctors: activeDoctors.c,
        total_revenue_egp: totalRevenue.total
      },
      orders: {
        pending: pendingOrders.c,
        completed: completedOrders.c,
        breached: breachedOrders.c
      },
      today: {
        new_orders: newOrdersToday.c,
        new_patients: newPatientsToday.c
      },
      month_comparison: {
        this_month_orders: thisMonthOrders.c,
        last_month_orders: lastMonthOrders.c,
        this_month_revenue_egp: thisMonthRevenue.total,
        last_month_revenue_egp: lastMonthRevenue.total
      },
      alerts: {
        failed_payments: failedPayments.c,
        breached_cases: breachedDetails
      }
    });
  } catch (err) {
    console.error('Tash stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
