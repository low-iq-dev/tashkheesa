// src/routes/superadmin.js
const express = require('express');
const { db } = require('../db');
const { randomUUID } = require('crypto');
const { hash, requireSuperadmin } = require('../auth');
const { queueNotification, doctorNotify } = require('../notify');
const { runSlaSweep } = require('../sla_watcher');
const { logOrderEvent } = require('../audit');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');
const { pickDoctorForOrder } = require('../assign');
const { recalcSlaBreaches } = require('../sla');
const { randomUUID: uuidv4 } = require('crypto');
const { safeAll, safeGet, tableExists } = require('../sql-utils');

const router = express.Router();

const IS_PROD = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// buildFilters: used for dashboard and CSV export
function buildFilters(query) {
  const where = [];
  const params = [];

  if (query.from && query.from.trim()) {
    where.push('DATE(o.created_at) >= DATE(?)');
    params.push(query.from.trim());
  }
  if (query.to && query.to.trim()) {
    where.push('DATE(o.created_at) <= DATE(?)');
    params.push(query.to.trim());
  }
  if (query.specialty && query.specialty.trim() && query.specialty !== 'all') {
    where.push('o.specialty_id = ?');
    params.push(query.specialty.trim());
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, params };
}

function getActiveSuperadmins() {
  return db.prepare("SELECT id, name FROM users WHERE role = 'superadmin' AND is_active = 1").all();
}

function selectSlaRelevantOrders() {
  return db
    .prepare(
      `SELECT o.*, d.name AS doctor_name
       FROM orders o
       LEFT JOIN users d ON d.id = o.doctor_id
       WHERE o.status = 'accepted'
         AND o.accepted_at IS NOT NULL
         AND o.completed_at IS NULL
         AND o.deadline_at IS NOT NULL`
    )
    .all();
}

function countOpenCasesForDoctor(doctorId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c
       FROM orders
       WHERE doctor_id = ?
         AND status IN ('new', 'accepted', 'breached')`
    )
    .get(doctorId);
  return row ? row.c || 0 : 0;
}

function findBestAlternateDoctor(specialtyId, excludeDoctorId) {
  const doctors = db
    .prepare(
      `SELECT id, name
       FROM users
       WHERE role = 'doctor'
         AND is_active = 1
         AND specialty_id = ?
         AND id != ?`
    )
    .all(specialtyId, excludeDoctorId || '');

  if (!doctors || !doctors.length) return null;

  let best = null;
  doctors.forEach((doc) => {
    const openCount = countOpenCasesForDoctor(doc.id);
    if (!best || openCount < best.openCount) {
      best = { ...doc, openCount };
    }
  });
  return best;
}

function performSlaCheck(now = new Date()) {
  const summary = {
    preBreachWarnings: 0,
    breached: 0,
    reassigned: 0,
    noDoctor: 0
  };

  const orders = selectSlaRelevantOrders();
  const superadmins = getActiveSuperadmins();
  const nowIso = now.toISOString();

  orders.forEach((order) => {
    if (!order.deadline_at) return;

    const deadline = new Date(order.deadline_at);
    const msToDeadline = deadline - now;

    // Breach handling
    if (msToDeadline <= 0) {
      db.prepare(
        `UPDATE orders
         SET status = 'breached',
             breached_at = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, nowIso, order.id);

      logOrderEvent({
        orderId: order.id,
        label: 'Order breached SLA',
        actorRole: 'system'
      });
      summary.breached += 1;

      if (order.doctor_id) {
        queueNotification({
          orderId: order.id,
          toUserId: order.doctor_id,
          channel: 'internal',
          template: 'order_breached_doctor',
          status: 'queued'
        });
      }
      superadmins.forEach((admin) => {
        queueNotification({
          orderId: order.id,
          toUserId: admin.id,
          channel: 'internal',
          template: 'order_breached_superadmin',
          status: 'queued'
        });
      });

      // Auto-reassign if possible
      const alternateDoctor = findBestAlternateDoctor(order.specialty_id, order.doctor_id);
      if (!alternateDoctor) {
        logOrderEvent({
          orderId: order.id,
          label: 'No available doctor to reassign case',
          actorRole: 'system'
        });
        summary.noDoctor += 1;
        return;
      }

      db.prepare(
        `UPDATE orders
         SET doctor_id = ?,
             status = 'new',
             accepted_at = NULL,
             deadline_at = NULL,
             reassigned_count = COALESCE(reassigned_count, 0) + 1,
             updated_at = ?
         WHERE id = ?`
      ).run(alternateDoctor.id, nowIso, order.id);

      logOrderEvent({
        orderId: order.id,
        label: `Order auto-reassigned from Doctor ${order.doctor_name || order.doctor_id || ''} to Doctor ${alternateDoctor.name} due to SLA breach`,
        actorRole: 'system'
      });

      if (order.doctor_id) {
        queueNotification({
          orderId: order.id,
          toUserId: order.doctor_id,
          channel: 'internal',
          template: 'order_reassigned_from_doctor',
          status: 'queued'
        });
      }
      queueNotification({
        orderId: order.id,
        toUserId: alternateDoctor.id,
        channel: 'internal',
        template: 'order_reassigned_to_doctor',
        status: 'queued'
      });
      superadmins.forEach((admin) => {
        queueNotification({
          orderId: order.id,
          toUserId: admin.id,
          channel: 'internal',
          template: 'order_reassigned_superadmin',
          status: 'queued'
        });
      });
      summary.reassigned += 1;
      return;
    }

    // Pre-breach warning (within 60 minutes)
    if (msToDeadline <= 60 * 60 * 1000 && Number(order.pre_breach_notified || 0) === 0) {
      db.prepare(
        `UPDATE orders
         SET pre_breach_notified = 1,
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, order.id);

      logOrderEvent({
        orderId: order.id,
        label: 'SLA pre-breach warning sent to superadmins',
        actorRole: 'system'
      });

      superadmins.forEach((admin) => {
        queueNotification({
          orderId: order.id,
          toUserId: admin.id,
          channel: 'internal',
          template: 'order_sla_pre_breach',
          status: 'queued'
        });
      });

      summary.preBreachWarnings += 1;
    }
  });

  return summary;
}

function loadOrderWithPatient(orderId) {
  return db
    .prepare(
      `SELECT o.id, o.status, o.payment_status, o.payment_method, o.payment_reference, o.price, o.currency,
              o.patient_id, u.name AS patient_name, u.email AS patient_email
       FROM orders o
       LEFT JOIN users u ON u.id = o.patient_id
       WHERE o.id = ?`
    )
    .get(orderId);
}

// MAIN SUPERADMIN DASHBOARD
router.get('/superadmin', requireSuperadmin, (req, res) => {
  // Refresh SLA breaches on each dashboard load
  recalcSlaBreaches();

  const query = req.query || {};
  const from = query.from || '';
  const to = query.to || '';
  const specialty = query.specialty || 'all';

  // Update overdue orders to breached on read
  const overdueOrders = safeAll(
    `SELECT id, status, deadline_at, completed_at
     FROM orders
     WHERE status NOT IN ('completed','breached')
       AND completed_at IS NULL
       AND deadline_at IS NOT NULL
       AND datetime(deadline_at) < datetime('now')`,
    [],
    []
  );
  overdueOrders.forEach((o) => enforceBreachIfNeeded(o));

  const { whereSql, params } = buildFilters(query);
  const pendingDoctorsRow = safeGet(
    "SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND pending_approval = 1",
    [],
    { c: 0 }
  );
  const pendingDoctorsCount = (pendingDoctorsRow && pendingDoctorsRow.c) || 0;

  // KPI aggregates
  const kpiSql = `
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(price), 0) AS revenue,
      COALESCE(SUM(price - COALESCE(doctor_fee, 0)), 0) AS gross_profit,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'breached' THEN 1 ELSE 0 END) AS breached
    FROM orders o
    ${whereSql}
  `;
  const kpisFallback = {
    total_orders: 0,
    revenue: 0,
    gross_profit: 0,
    completed: 0,
    breached: 0
  };
  const kpis = safeGet(kpiSql, params, kpisFallback);

  // SLA Metrics
  const completedRows = safeAll(
    `
    SELECT accepted_at, completed_at, deadline_at
    FROM orders o
    ${whereSql ? whereSql + ' AND ' : 'WHERE '}
    status = 'completed'
  `,
    params,
    []
  );

  let onTimeCount = 0;
  let tatSumMinutes = 0;
  let tatCount = 0;

  completedRows.forEach((o) => {
    const accepted = o.accepted_at ? new Date(o.accepted_at) : null;
    const completed = o.completed_at ? new Date(o.completed_at) : null;
    const deadline = o.deadline_at ? new Date(o.deadline_at) : null;

    if (deadline && completed && completed <= deadline) {
      onTimeCount += 1;
    }

    if (accepted && completed) {
      const diffMs = completed - accepted;
      const diffMin = diffMs / 60000;
      if (!Number.isNaN(diffMin) && diffMin >= 0) {
        tatSumMinutes += diffMin;
        tatCount += 1;
      }
    }
  });

  const onTimePercent =
    completedRows.length > 0
      ? Math.round((onTimeCount * 100) / completedRows.length)
      : 0;

  const avgTatMinutes =
    tatCount > 0 ? Math.round(tatSumMinutes / tatCount) : null;

  // Revenue by specialty
  const { whereSql: revWhere, params: revParams } = buildFilters(query);
  const revJoinFilters = revWhere ? revWhere.replace('WHERE', 'AND') : '';

  const revBySpecSql = `
    SELECT
      s.id AS specialty_id,
      s.name AS name,
      COUNT(o.id) AS count,
      COALESCE(SUM(o.price), 0) AS revenue,
      COALESCE(SUM(o.price - COALESCE(o.doctor_fee, 0)), 0) AS gp
    FROM specialties s
    LEFT JOIN orders o ON o.specialty_id = s.id
      ${revJoinFilters}
    GROUP BY s.id, s.name
    HAVING COUNT(o.id) > 0
    ORDER BY revenue DESC
  `;
  const revenueBySpecialty = safeAll(revBySpecSql, revParams, []);

  // Latest events
  const eventsSql = `
    SELECT
      e.id,
      e.at,
      e.label,
      e.order_id,
      o.status,
      o.sla_hours
    FROM order_events e
    JOIN orders o ON o.id = e.order_id
    ${whereSql}
    ORDER BY e.at DESC
    LIMIT 15
  `;
  const events = safeAll(eventsSql, params, []);

  // Recent orders with payment info
  const ordersListRaw = safeAll(
    `SELECT o.id, o.created_at, o.price, o.payment_status, o.payment_link, o.status, o.reassigned_count, o.deadline_at, o.completed_at,
            sv.name AS service_name, s.name AS specialty_name
     FROM orders o
     LEFT JOIN services sv ON sv.id = o.service_id
     LEFT JOIN specialties s ON s.id = o.specialty_id
     ${whereSql}
     ORDER BY o.created_at DESC
     LIMIT 20`,
    params,
    []
  );

  const ordersList = (ordersListRaw || []).map((o) => {
    enforceBreachIfNeeded(o);
    const computed = computeSla(o);
    return {
      ...o,
      status: computed.effectiveStatus || o.status,
      effectiveStatus: computed.effectiveStatus,
      sla: computed.sla
    };
  });

  const slaRiskOrdersRaw = safeAll(
    `SELECT o.id, o.deadline_at, s.name AS specialty_name, u.name AS doctor_name,
            (julianday(o.deadline_at) - julianday('now')) * 24 AS hours_remaining
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN users u ON u.id = o.doctor_id
     WHERE o.deadline_at IS NOT NULL
       AND o.completed_at IS NULL
       AND (julianday(o.deadline_at) - julianday('now')) * 24 <= 24
       AND (julianday(o.deadline_at) - julianday('now')) * 24 >= 0
     ORDER BY o.deadline_at ASC
     LIMIT 10`,
    [],
    []
  );
  const slaRiskOrders = (slaRiskOrdersRaw || []).map((order) => ({
    ...order,
    hours_remaining: typeof order.hours_remaining === 'number'
      ? Math.max(0, Number(order.hours_remaining))
      : null
  }));

  const breachedOrders = safeAll(
    `SELECT o.id, o.breached_at, o.specialty_id, s.name AS specialty_name, u.name AS doctor_name
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN users u ON u.id = o.doctor_id
     WHERE o.status = 'breached'
        OR (o.completed_at IS NOT NULL
            AND o.deadline_at IS NOT NULL
            AND datetime(o.completed_at) > datetime(o.deadline_at))
     ORDER BY COALESCE(o.breached_at, o.completed_at) DESC
     LIMIT 10`,
    [],
    []
  );
  const totalBreached = (breachedOrders && breachedOrders.length) ? breachedOrders.length : 0;

  const notificationLog = tableExists('notifications')
    ? safeAll(
        `SELECT n.id, n.at, n.order_id, n.channel, n.template, n.status,
                COALESCE(u.name, n.to_user_id) AS doctor_name
         FROM notifications n
         LEFT JOIN users u ON u.id = n.to_user_id
         ORDER BY n.at DESC
         LIMIT 20`,
        [],
        []
      )
    : [];

  const slaEvents = tableExists('order_events')
    ? safeAll(
        `SELECT id, order_id, label, at
         FROM order_events
         WHERE LOWER(label) LIKE '%sla%'
            OR LOWER(label) LIKE '%reassign%'
         ORDER BY at DESC
         LIMIT 20`,
        [],
        []
      )
    : [];

  // Specialty list for filters
  const specialties = safeAll(
    'SELECT id, name FROM specialties ORDER BY name ASC',
    [],
    []
  );

  const totalOrders = kpis?.total_orders || 0;
  const completedCount = kpis?.completed || 0;
  const breachedCount = kpis?.breached || 0;
  const revenue = kpis?.revenue || 0;
  const grossProfit = kpis?.gross_profit || 0;

  // Render page
  res.render('superadmin', {
    user: req.user,
    totalOrders,
    completedCount,
    breachedCount,
    revenue,
    grossProfit,
    onTimePercent,
    avgTatMinutes,
    revenueBySpecialty: revenueBySpecialty || [],
    events: events || [],
    ordersList: ordersList || [],
    slaRiskOrders,
    breachedOrders,
    totalBreached,
    notificationLog: notificationLog || [],
    slaEvents,
    specialties: specialties || [],
    pendingDoctorsCount,
    filters: {
      from,
      to,
      specialty
    }
  });
});

// New order form (superadmin)
router.get('/superadmin/orders/new', requireSuperadmin, (req, res) => {
  const patients = db
    .prepare("SELECT id, name, email FROM users WHERE role = 'patient'")
    .all();

  const doctors = db
    .prepare("SELECT id, name, email, specialty_id FROM users WHERE role = 'doctor'")
    .all();

  const specialties = db
    .prepare('SELECT id, name FROM specialties ORDER BY name')
    .all();

  const services = db
    .prepare('SELECT id, specialty_id, code, name, base_price, doctor_fee FROM services ORDER BY name')
    .all();

  const defaultService = services && services.length ? services[0] : null;

  res.render('superadmin_order_new', {
    user: req.user,
    patients,
    doctors,
    specialties,
    services,
    defaults: {
      sla_hours: 72,
      price: defaultService ? defaultService.base_price : undefined,
      doctor_fee: defaultService ? defaultService.doctor_fee : undefined
    },
    error: null
  });
});

// Create manual order (superadmin)
router.post('/superadmin/orders', requireSuperadmin, (req, res) => {
  const {
    patient_id,
    doctor_id,
    specialty_id,
    service_id,
    sla_hours,
    price,
    doctor_fee,
    notes
  } = req.body || {};

  const requiredMissing = !patient_id || !specialty_id || !service_id || !sla_hours;
  if (requiredMissing) {
    const patients = db
      .prepare("SELECT id, name, email FROM users WHERE role = 'patient'")
      .all();
    const doctors = db
      .prepare("SELECT id, name, email, specialty_id FROM users WHERE role = 'doctor'")
      .all();
    const specialties = db
      .prepare('SELECT id, name FROM specialties ORDER BY name')
      .all();
    const services = db
      .prepare('SELECT id, specialty_id, code, name FROM services ORDER BY name')
      .all();

    return res.status(400).render('superadmin_order_new', {
      user: req.user,
      patients,
      doctors,
      specialties,
      services,
      defaults: { sla_hours: Number(sla_hours) || 72, price, doctor_fee, notes },
      error: 'Please fill all required fields.'
    });
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const deadline = doctor_id
    ? new Date(now.getTime() + Number(sla_hours || 0) * 60 * 60 * 1000).toISOString()
    : null;
  const orderId = `manual-order-${Date.now()}`;

  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(service_id);
  const orderPrice = price ? Number(price) : service ? service.base_price : null;
  const orderDoctorFee = doctor_fee ? Number(doctor_fee) : service ? service.doctor_fee : null;
  const orderPaymentLink = service ? service.payment_link : null;
  const orderCurrency = service ? service.currency || 'EGP' : 'EGP';
  const selectedDoctor = doctor_id
    ? db.prepare("SELECT id, name, email, phone FROM users WHERE id = ? AND role = 'doctor'").get(doctor_id)
    : null;
  const autoDoctor = !doctor_id ? pickDoctorForOrder({ specialtyId: specialty_id }) : null;
  const chosenDoctor = selectedDoctor || autoDoctor;
  const status = chosenDoctor ? 'accepted' : 'new';
  const acceptedAt = chosenDoctor ? createdAt : null;

  db.prepare(
    `INSERT INTO orders (
      id, patient_id, doctor_id, specialty_id, service_id,
      sla_hours, status, price, doctor_fee,
      created_at, accepted_at, deadline_at, completed_at,
      breached_at, reassigned_count, report_url, notes,
      payment_status, payment_method, payment_reference, payment_link
    ) VALUES (
      @id, @patient_id, @doctor_id, @specialty_id, @service_id,
      @sla_hours, @status, @price, @doctor_fee,
      @created_at, @accepted_at, @deadline_at, NULL,
      NULL, 0, NULL, @notes,
      @payment_status, @payment_method, @payment_reference, @payment_link
    )`
  ).run({
    id: orderId,
    patient_id,
    doctor_id: chosenDoctor ? chosenDoctor.id : null,
    specialty_id,
    service_id,
    sla_hours: Number(sla_hours),
    status,
    price: orderPrice,
    doctor_fee: orderDoctorFee,
    created_at: createdAt,
    accepted_at: acceptedAt,
    deadline_at: chosenDoctor ? deadline : null,
    notes: notes || null,
    payment_status: 'unpaid',
    payment_method: null,
    payment_reference: null,
    payment_link: orderPaymentLink
  });

  logOrderEvent({
    orderId,
    label: 'Order created by superadmin',
    actorUserId: req.user.id,
    actorRole: req.user.role
  });
  if (chosenDoctor) {
    logOrderEvent({
      orderId,
      label: selectedDoctor
        ? `Assigned to doctor ${doctor_id}`
        : `Auto-assigned to Dr. ${autoDoctor.name}`,
      actorUserId: req.user.id,
      actorRole: req.user.role
    });
    queueNotification({
      orderId,
      toUserId: chosenDoctor.id,
      channel: 'internal',
      template: 'order_assigned_doctor',
      status: 'queued'
    });
    if (selectedDoctor) {
      doctorNotify({ doctor: selectedDoctor, template: 'order_assigned_doctor', order: { id: orderId } });
    }
    if (autoDoctor) {
      queueNotification({
        orderId,
        toUserId: autoDoctor.id,
        channel: 'internal',
        template: 'order_auto_assigned_doctor',
        status: 'queued'
      });
    }
  } else {
    logOrderEvent({
      orderId,
      label: 'Order created without assigned doctor',
      actorUserId: req.user.id,
      actorRole: req.user.role
    });
  }

  return res.redirect('/superadmin?created=1');
});

// Order detail (superadmin)
router.get('/superadmin/orders/:id', requireSuperadmin, (req, res) => {
  const orderId = req.params.id;
  const order = db
    .prepare(
      `SELECT o.*,
              p.name AS patient_name, p.email AS patient_email,
              d.name AS doctor_name, d.email AS doctor_email,
              s.name AS specialty_name,
              sv.name AS service_name,
              sv.base_price AS service_price,
              sv.doctor_fee AS service_doctor_fee,
              sv.currency AS service_currency,
              sv.payment_link AS service_payment_link
       FROM orders o
       LEFT JOIN users p ON p.id = o.patient_id
       LEFT JOIN users d ON d.id = o.doctor_id
       LEFT JOIN specialties s ON s.id = o.specialty_id
       LEFT JOIN services sv ON sv.id = o.service_id
       WHERE o.id = ?`
    )
    .get(orderId);

  if (!order) {
    return res.redirect('/superadmin');
  }

  const events = db
    .prepare(
      `SELECT id, label, meta, at
       FROM order_events
       WHERE order_id = ?
       ORDER BY at DESC
       LIMIT 20`
    )
    .all(orderId);

  const doctors = db
    .prepare("SELECT id, name FROM users WHERE role = 'doctor' AND is_active = 1 ORDER BY name ASC")
    .all();

  const displayPrice = order.price != null ? order.price : order.service_price;
  const displayDoctorFee = order.doctor_fee != null ? order.doctor_fee : order.service_doctor_fee;
  const displayCurrency = order.currency || order.service_currency || 'EGP';
  const paymentLink = order.payment_link || order.service_payment_link || null;

  return res.render('superadmin_order_detail', {
    user: req.user,
    order: {
      ...order,
      displayPrice,
      displayDoctorFee,
      displayCurrency,
      payment_link: paymentLink
    },
    events,
    doctors
  });
});

// DOCTOR MANAGEMENT
router.get('/superadmin/doctors', requireSuperadmin, (req, res) => {
  const statusFilter = req.query.status || 'all';
  const conditions = ["u.role = 'doctor'"];
  if (statusFilter === 'pending') {
    conditions.push('u.pending_approval = 1');
  } else if (statusFilter === 'approved') {
    conditions.push('u.pending_approval = 0');
    conditions.push('u.is_active = 1');
  } else if (statusFilter === 'rejected') {
    conditions.push('u.pending_approval = 0');
    conditions.push('u.is_active = 0');
    conditions.push('u.rejection_reason IS NOT NULL');
  } else if (statusFilter === 'inactive') {
    conditions.push('u.is_active = 0');
  }

  const doctors = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.phone, u.notify_whatsapp, u.is_active, u.created_at, u.specialty_id,
              u.pending_approval, u.approved_at, u.rejection_reason, u.signup_notes,
              s.name AS specialty_name
       FROM users u
       LEFT JOIN specialties s ON s.id = u.specialty_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY u.pending_approval DESC, u.is_active DESC, u.created_at DESC`
    )
    .all();
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const pendingDoctorsRow = db
    .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND pending_approval = 1")
    .get();
  const pendingDoctorsCount = pendingDoctorsRow ? pendingDoctorsRow.c : 0;
  res.render('superadmin_doctors', { user: req.user, doctors, specialties, statusFilter, pendingDoctorsCount });
});

router.get('/superadmin/doctors/new', requireSuperadmin, (req, res) => {
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('superadmin_doctor_form', { user: req.user, specialties, error: null, doctor: null, isEdit: false });
});

router.post('/superadmin/doctors/new', requireSuperadmin, (req, res) => {
  const { name, email, specialty_id, phone, notify_whatsapp, is_active } = req.body || {};
  if (!name || !email) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    return res.status(400).render('superadmin_doctor_form', {
      user: req.user,
      specialties,
      error: 'Name and email are required.',
      doctor: { name, email, specialty_id, phone, notify_whatsapp, is_active },
      isEdit: false
    });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    return res.status(400).render('superadmin_doctor_form', {
      user: req.user,
      specialties,
      error: 'Email already exists.',
      doctor: { name, email, specialty_id, phone, notify_whatsapp, is_active },
      isEdit: false
    });
  }

  const password_hash = hash('Doctor123!');
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, specialty_id, phone, lang, notify_whatsapp, is_active)
     VALUES (?, ?, ?, ?, 'doctor', ?, ?, 'en', ?, ?)`
  ).run(
    randomUUID(),
    email,
    password_hash,
    name,
    specialty_id || null,
    phone || null,
    notify_whatsapp ? 1 : 0,
    is_active ? 1 : 0
  );

  return res.redirect('/superadmin/doctors');
});

router.get('/superadmin/doctors/:id/edit', requireSuperadmin, (req, res) => {
  const doctor = db
    .prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'")
    .get(req.params.id);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('superadmin_doctor_form', { user: req.user, specialties, error: null, doctor, isEdit: true });
});

router.post('/superadmin/doctors/:id/edit', requireSuperadmin, (req, res) => {
  const doctor = db
    .prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'")
    .get(req.params.id);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const { name, specialty_id, phone, notify_whatsapp, is_active } = req.body || {};
  db.prepare(
    `UPDATE users
     SET name = ?, specialty_id = ?, phone = ?, notify_whatsapp = ?, is_active = ?
     WHERE id = ? AND role = 'doctor'`
  ).run(
    name || doctor.name,
    specialty_id || null,
    phone || null,
    notify_whatsapp ? 1 : 0,
    is_active ? 1 : 0,
    req.params.id
  );
  return res.redirect('/superadmin/doctors');
});

router.post('/superadmin/doctors/:id/toggle', requireSuperadmin, (req, res) => {
  const doctorId = req.params.id;
  db.prepare(
    `UPDATE users
     SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END
     WHERE id = ? AND role = 'doctor'`
  ).run(doctorId);
  return res.redirect('/superadmin/doctors');
});

// Doctor detail (approval)
router.get('/superadmin/doctors/:id', requireSuperadmin, (req, res) => {
  const doctorId = req.params.id;
  const doctor = db
    .prepare(
      `SELECT u.*, s.name AS specialty_name
       FROM users u
       LEFT JOIN specialties s ON s.id = u.specialty_id
       WHERE u.id = ? AND u.role = 'doctor'`
    )
    .get(doctorId);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const pendingDoctorsRow = db
    .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND pending_approval = 1")
    .get();
  const pendingDoctorsCount = pendingDoctorsRow ? pendingDoctorsRow.c : 0;
  res.render('superadmin_doctor_detail', { user: req.user, doctor, pendingDoctorsCount });
});

router.post('/superadmin/doctors/:id/approve', requireSuperadmin, (req, res) => {
  const doctorId = req.params.id;
  const doctor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'").get(doctorId);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE users
     SET pending_approval = 0,
         is_active = 1,
         approved_at = ?,
         rejection_reason = NULL
     WHERE id = ? AND role = 'doctor'`
  ).run(nowIso, doctorId);

  queueNotification({
    orderId: null,
    toUserId: doctorId,
    channel: 'internal',
    template: 'doctor_approved',
    status: 'queued'
  });

  return res.redirect(`/superadmin/doctors/${doctorId}`);
});

router.post('/superadmin/doctors/:id/reject', requireSuperadmin, (req, res) => {
  const doctorId = req.params.id;
  const doctor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'").get(doctorId);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const { rejection_reason } = req.body || {};
  db.prepare(
    `UPDATE users
     SET pending_approval = 0,
         is_active = 0,
         approved_at = NULL,
         rejection_reason = ?
     WHERE id = ? AND role = 'doctor'`
  ).run(rejection_reason || 'Not approved', doctorId);

  queueNotification({
    orderId: null,
    toUserId: doctorId,
    channel: 'internal',
    template: 'doctor_rejected',
    status: 'queued'
  });

  return res.redirect(`/superadmin/doctors/${doctorId}`);
});

// SERVICE CATALOG
router.get('/superadmin/services', requireSuperadmin, (req, res) => {
  const services = db
    .prepare(
      `SELECT sv.id, sv.name, sv.code, sv.base_price, sv.doctor_fee, sv.currency, sv.payment_link,
              sp.name AS specialty_name
       FROM services sv
       LEFT JOIN specialties sp ON sp.id = sv.specialty_id
       ORDER BY specialty_name ASC, sv.name ASC`
    )
    .all();
  res.render('superadmin_services', { user: req.user, services });
});

router.get('/superadmin/services/new', requireSuperadmin, (req, res) => {
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('superadmin_service_form', { user: req.user, specialties, error: null, service: {}, isEdit: false });
});

router.post('/superadmin/services/new', requireSuperadmin, (req, res) => {
  const { name, code, specialty_id, base_price, doctor_fee, currency, payment_link } = req.body || {};
  if (!name || !specialty_id) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    return res.status(400).render('superadmin_service_form', {
      user: req.user,
      specialties,
      error: 'Name and specialty are required.',
      service: req.body,
      isEdit: false
    });
  }
  db.prepare(
    `INSERT INTO services (id, name, code, specialty_id, base_price, doctor_fee, currency, payment_link)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    name,
    code || null,
    specialty_id || null,
    base_price ? Number(base_price) : null,
    doctor_fee ? Number(doctor_fee) : null,
    currency || 'EGP',
    payment_link || null
  );
  return res.redirect('/superadmin/services');
});

router.get('/superadmin/services/:id/edit', requireSuperadmin, (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!service) return res.redirect('/superadmin/services');
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('superadmin_service_form', { user: req.user, service, specialties, error: null, isEdit: true });
});

router.post('/superadmin/services/:id/edit', requireSuperadmin, (req, res) => {
  const { name, code, specialty_id, base_price, doctor_fee, currency, payment_link } = req.body || {};
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!service) return res.redirect('/superadmin/services');
  if (!name || !specialty_id) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    return res.status(400).render('superadmin_service_form', {
      user: req.user,
      service: { ...service, ...req.body },
      specialties,
      error: 'Name and specialty are required.',
      isEdit: true
    });
  }
  db.prepare(
    `UPDATE services
     SET name=?, code=?, specialty_id=?, base_price=?, doctor_fee=?, currency=?, payment_link=?
     WHERE id=?`
  ).run(
    name,
    code || null,
    specialty_id || null,
    base_price ? Number(base_price) : null,
    doctor_fee ? Number(doctor_fee) : null,
    currency || 'EGP',
    payment_link || null,
    req.params.id
  );
  return res.redirect('/superadmin/services');
});

// PAYMENT FLOW
router.get('/superadmin/orders/:id/payment', requireSuperadmin, (req, res) => {
  const order = loadOrderWithPatient(req.params.id);
  if (!order) return res.redirect('/superadmin');
  const methods = ['cash', 'card', 'bank_transfer', 'online_link'];
  res.render('superadmin_order_payment', { user: req.user, order, methods });
});

router.post('/superadmin/orders/:id/mark-paid', requireSuperadmin, (req, res) => {
  const { payment_method, payment_reference } = req.body || {};
  const orderId = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.redirect('/superadmin');

  const nowIso = new Date().toISOString();

  db.prepare(
    `UPDATE orders
     SET payment_status = 'paid',
         payment_method = COALESCE(?, payment_method, 'manual'),
         payment_reference = COALESCE(?, payment_reference, 'manual-marked'),
         updated_at = ?
     WHERE id = ?`
  ).run(payment_method || null, payment_reference || null, nowIso, orderId);

  db.prepare(
    `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    orderId,
    'Payment marked as paid (superadmin)',
    JSON.stringify({ from: order.payment_status || 'unpaid', to: 'paid', payment_method, payment_reference }),
    nowIso,
    req.user.id,
    'superadmin'
  );

  if (order.patient_id) {
    queueNotification({
      orderId,
      toUserId: order.patient_id,
      channel: 'internal',
      template: 'payment_marked_paid_patient',
      status: 'queued'
    });
  }

  return res.redirect(`/superadmin/orders/${orderId}`);
});

router.post('/superadmin/orders/:id/mark-unpaid', requireSuperadmin, (req, res) => {
  const orderId = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.redirect('/superadmin');

  const nowIso = new Date().toISOString();

  db.prepare(
    `UPDATE orders
     SET payment_status = 'unpaid',
         payment_method = NULL,
         payment_reference = NULL,
         updated_at = ?
     WHERE id = ?`
  ).run(nowIso, orderId);

  db.prepare(
    `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    orderId,
    'Payment marked as unpaid (superadmin)',
    JSON.stringify({ from: order.payment_status || 'paid', to: 'unpaid' }),
    nowIso,
    req.user.id,
    'superadmin'
  );

  return res.redirect(`/superadmin/orders/${orderId}`);
});

// Unified payment update handler
router.post('/superadmin/orders/:id/payment', requireSuperadmin, (req, res) => {
  const orderId = req.params.id;
  const { payment_status, payment_method, payment_reference } = req.body || {};
  const allowed = ['unpaid', 'paid', 'refunded'];

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.redirect('/superadmin');

  const status = allowed.includes(payment_status) ? payment_status : order.payment_status;
  const nowIso = new Date().toISOString();

  db.prepare(
    `UPDATE orders
     SET payment_status = ?,
         payment_method = ?,
         payment_reference = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(status, payment_method || null, payment_reference || null, nowIso, orderId);

  let label = null;
  if (status === 'paid') label = 'Payment marked as PAID';
  if (status === 'unpaid') label = 'Payment marked as UNPAID';
  if (status === 'refunded') label = 'Payment marked as REFUNDED';
  if (label) {
    logOrderEvent({
      orderId,
      label,
      actorUserId: req.user.id,
      actorRole: req.user.role
    });
  }

  // Optional notify patient on paid
  if (order.patient_id && order.payment_status !== 'paid' && status === 'paid') {
    queueNotification({
      orderId,
      toUserId: order.patient_id,
      channel: 'internal',
      template: 'payment_marked_paid',
      status: 'queued'
    });
  }

  return res.redirect('/superadmin');
});

// Reassign order to a different doctor (superadmin)
router.post('/superadmin/orders/:id/reassign', requireSuperadmin, (req, res) => {
  const orderId = req.params.id;
  const { doctor_id: newDoctorId } = req.body || {};

  const order = db
    .prepare(
      `SELECT o.*, d.name AS doctor_name
       FROM orders o
       LEFT JOIN users d ON d.id = o.doctor_id
       WHERE o.id = ?`
    )
    .get(orderId);

  if (!order || !newDoctorId) {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  const newDoctor = db
    .prepare("SELECT id, name FROM users WHERE id = ? AND role = 'doctor' AND is_active = 1")
    .get(newDoctorId);
  if (!newDoctor) {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  if (order.doctor_id === newDoctor.id) {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  db.prepare(
    `UPDATE orders
     SET doctor_id = ?,
         reassigned_count = COALESCE(reassigned_count,0) + 1,
         updated_at = ?
     WHERE id = ?`
  ).run(newDoctor.id, new Date().toISOString(), orderId);

  logOrderEvent({
    orderId,
    label: `Order reassigned from ${order.doctor_name || order.doctor_id || 'Unassigned'} to ${newDoctor.name} by superadmin`,
    actorUserId: req.user.id,
    actorRole: req.user.role
  });

  queueNotification({
    orderId,
    toUserId: newDoctor.id,
    channel: 'internal',
    template: 'order_reassigned_doctor',
    status: 'queued'
  });

  return res.redirect(`/superadmin/orders/${orderId}`);
});

router.get('/superadmin/run-sla-check', requireSuperadmin, (req, res) => {
  const summary = performSlaCheck();
  const text = `SLA check completed: ${summary.preBreachWarnings} pre-breach warnings, ${summary.breached} breached, ${summary.reassigned} reassigned, ${summary.noDoctor} without doctor.`;

  if ((req.query && req.query.format === 'json') || (req.accepts('json') && !req.accepts('html'))) {
    return res.json(summary);
  }
  return res.send(text);
});

router.get('/superadmin/tools/run-sla-check', requireSuperadmin, (req, res) => {
  performSlaCheck();
  return res.redirect('/superadmin');
});

router.post('/superadmin/sla/recalc', requireSuperadmin, (req, res) => {
  try {
    recalcSlaBreaches();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('SLA recalc failed', err);
  }
  return res.redirect('/superadmin');
});

router.get('/superadmin/tools/run-sla-sweep', requireSuperadmin, (req, res) => {
  runSlaSweep(new Date());
  return res.redirect('/superadmin?sla_ran=1');
});

router.get('/superadmin/debug/reset-link/:userId', requireSuperadmin, (req, res) => {
  const userId = req.params.userId;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).send('User not found');

  const token = uuidv4();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`
  ).run(uuidv4(), user.id, token, expiresAt, now.toISOString());

  const baseUrl = String(process.env.BASE_URL || '').trim() || (() => {
    try {
      const protoRaw = (req.get('x-forwarded-proto') || req.protocol || 'http');
      const proto = String(protoRaw).split(',')[0].trim() || 'http';
      const host = req.get('x-forwarded-host') || req.get('host');
      return host ? `${proto}://${host}` : '';
    } catch (_) {
      return '';
    }
  })();

  // Prefer absolute URLs when possible; never default to localhost.
  const url = baseUrl ? `${baseUrl}/reset-password/${token}` : `/reset-password/${token}`;

  if (!IS_PROD) {
    // eslint-disable-next-line no-console
    console.log('[RESET LINK DEBUG]', url);
  }

  return res.send(`Reset link: ${url}`);
});

// Global events view
router.get('/superadmin/events', requireSuperadmin, (req, res) => {
  const { role, label, order_id, from, to } = req.query || {};
  const where = [];
  const params = [];

  if (role && role !== 'all') {
    where.push('e.actor_role = ?');
    params.push(role);
  }
  if (label && label.trim()) {
    where.push('e.label LIKE ?');
    params.push(`%${label.trim()}%`);
  }
  if (order_id && order_id.trim()) {
    where.push('e.order_id = ?');
    params.push(order_id.trim());
  }
  if (from && from.trim()) {
    where.push('DATE(e.at) >= DATE(?)');
    params.push(from.trim());
  }
  if (to && to.trim()) {
    where.push('DATE(e.at) <= DATE(?)');
    params.push(to.trim());
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const events = db
    .prepare(
      `SELECT e.*, o.specialty_id, o.service_id,
              d.name AS doctor_name, p.name AS patient_name
       FROM order_events e
       LEFT JOIN orders o ON o.id = e.order_id
       LEFT JOIN users d ON d.id = o.doctor_id
       LEFT JOIN users p ON p.id = o.patient_id
       ${whereSql}
       ORDER BY e.at DESC
       LIMIT 100`
    )
    .all(...params);

  res.render('superadmin_events', {
    user: req.user,
    events,
    filters: { role: role || 'all', label: label || '', order_id: order_id || '', from: from || '', to: to || '' }
  });
});

module.exports = { router, buildFilters };
