require('dotenv').config();
console.log('🔥 SERVER BOOTED FROM:', __dirname);
const path = require('path');
const { bootCheck } = require('./bootCheck');
const ROOT = path.resolve(__dirname, '..');
// src/server.js

const express = require('express');
const { randomUUID } = require('crypto');
const { db, migrate, } = require('./db');
const { hash } = require('./auth');
const { queueNotification } = require('./notify');
const { logOrderEvent } = require('./audit');
const { baseMiddlewares } = require('./middleware');
const { MODE, verbose: logVerbose, major: logMajor, fatal: logFatal } = require('./logger');
bootCheck({ ROOT, MODE });
const { safeAll, safeGet, tableExists } = require('./sql-utils');

const authRoutes = require('./routes/auth');
const doctorRoutes = require('./routes/doctor');
const patientRoutes = require('./routes/patient');
const { router: superadminRoutes } = require('./routes/superadmin');
const exportRoutes = require('./routes/exports'); // CSV exports
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const publicOrdersRoutes = require('./routes/public_orders');
const intakeRoutes = require('./routes/intake');
const orderFlowRoutes = require('./routes/order_flow');
const { startSlaWorker, runSlaSweep } = require('./sla_worker');
const { scheduleSlaWatcher } = require('./jobs/sla_watcher');
const { runSlaSweep: runWatcherSweep } = require('./sla_watcher');
const { runSlaSweep: runSlaSweepJob } = require('./sla');
const paymentRoutes = require('./routes/payments');
const { checkAndMarkBreaches } = require('./sla');
const { startCaseSlaWorker } = require('./case_sla_worker');

const app = express();

const STAGING_AUTH_USER = process.env.STAGING_USER || 'demo';
const STAGING_AUTH_PASS = process.env.STAGING_PASS || 'demo123';
const EXEMPT_PATHS = new Set(['/health', '/status']);
const ASSET_EXTENSIONS = new Set([
  '.css',
  '.js',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.map',
  '.json'
]);

function isAssetRequest(reqPath) {
  if (!reqPath) return false;
  if (reqPath.startsWith('/public/') || reqPath.startsWith('/assets/')) return true;
  if (reqPath === '/favicon.ico') return true;
  const ext = path.extname(reqPath).toLowerCase();
  return ASSET_EXTENSIONS.has(ext);
}

function sendAuthChallenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="Tashkheesa Staging"');
  return res.status(401).send('Authentication required');
}

function stagingBasicAuth(req, res, next) {
  if (MODE !== 'staging') return next();
  const normalizedPath = req.path || '/';
  if (EXEMPT_PATHS.has(normalizedPath) || isAssetRequest(normalizedPath)) {
    return next();
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    return sendAuthChallenge(res);
  }
  const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const [user = '', pass = ''] = credentials.split(':');
  if (user === STAGING_AUTH_USER && pass === STAGING_AUTH_PASS) {
    return next();
  }
  logMajor(`Staging auth failed for ${normalizedPath}`);
  return sendAuthChallenge(res);
}

if (MODE === 'staging') {
  app.use(stagingBasicAuth);
}

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Core middlewares (helmet, cookies, rate limit, i18n, user from JWT)
baseMiddlewares(app);

// Health endpoints (skip Basic Auth in staging via middleware logic)
app.get('/health', (req, res) => {
  return res.json({ ok: true, mode: MODE, timestamp: Date.now() });
});
app.get('/status', (req, res) => {
  return res.json({ ok: true, mode: MODE, timestamp: Date.now() });
});

// Run DB migrations
migrate();

if (MODE === 'staging') {
  seedDemoData();
}

// Home – redirect based on role
app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');

  switch (req.user.role) {
    case 'patient':
      return res.redirect('/dashboard');
case 'doctor':
  return res.redirect('/portal/doctor');
      case 'admin':
      return res.redirect('/admin');
    case 'superadmin':
      return res.redirect('/superadmin');
    default:
      return res.redirect('/login');
  }
});

// Language switch
app.get('/lang/:code', (req, res) => {
  const code = req.params.code === 'ar' ? 'ar' : 'en';
  res.cookie('lang', code, {
    httpOnly: false,
    maxAge: 365 * 24 * 60 * 60 * 1000
  });
  const ref = req.get('referer') || '/';
  const isLangRef = ref.startsWith('/lang/');
  const fallback = '/';
  res.redirect(isLangRef ? fallback : ref);
});

// Routes
app.use('/', authRoutes);
app.use('/', doctorRoutes);
app.use('/', patientRoutes);
app.use('/', superadminRoutes);
app.use('/', exportRoutes); // exports/CSV
app.use('/', adminRoutes);
app.use('/', publicRoutes);
app.use('/', publicOrdersRoutes);
app.use('/', intakeRoutes);
app.use('/', orderFlowRoutes);
app.use('/payments', paymentRoutes);

// Internal SLA trigger (superadmin only)
app.get('/internal/run-sla-check', (req, res) => {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).send('Forbidden');
  }
  runSlaSweep();
  return res.redirect('/superadmin?sla_ran=1');
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  logFatal('Unhandled error', err);
  if (MODE === 'production') {
    return res.status(status).send('An unexpected error occurred.');
  }
  return res.status(status).send(err.stack || 'Internal Server Error');
});

// ----------------------------------------------------
// ----------------------------------------------------
// SINGLE SLA WRITER MODE
// ----------------------------------------------------

if (process.env.SLA_MODE === 'primary') {
  logMajor('🟢 SLA MODE: primary (single writer enabled)');

  startSlaWorker();
  startCaseSlaWorker();

  const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    try {
      runWatcherSweep(new Date());
    } catch (err) {
      logFatal('SLA sweep error', err);
    }
  }, SWEEP_INTERVAL_MS);

} else {
  logMajor('🟡 SLA MODE: passive (no SLA mutations)');
}

const PORT = process.env.PORT || 3000;
require('./db').migrate();
app.listen(PORT, () => {
  logMajor(`Tashkheesa portal running on http://localhost:${PORT}`);
});


// Simple SLA reminder + breach marker
function runSlaReminderJob() {
  const now = new Date();
  const nowIso = now.toISOString();
  let reminders = 0;
  let breaches = 0;

  const reminderOrders = db
    .prepare(
      `SELECT id, doctor_id, deadline_at
       FROM orders
       WHERE status = 'accepted'
         AND deadline_at IS NOT NULL
         AND completed_at IS NULL
         AND breached_at IS NULL
         AND COALESCE(sla_reminder_sent, 0) = 0`
    )
    .all();

  reminderOrders.forEach((o) => {
    if (!o.deadline_at) return;
    const diffMin = Math.floor((new Date(o.deadline_at).getTime() - now.getTime()) / 60000);
    if (diffMin > 0 && diffMin <= 60 && o.doctor_id) {
      queueNotification({
        orderId: o.id,
        toUserId: o.doctor_id,
        channel: 'internal',
        template: 'sla_reminder_doctor',
        status: 'queued'
      });
      db.prepare(
        `UPDATE orders
         SET sla_reminder_sent = 1,
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, o.id);
      reminders += 1;
    }
  });

  const superadmins = db
    .prepare("SELECT id FROM users WHERE role = 'superadmin' AND is_active = 1")
    .all();

  const breachOrders = db
    .prepare(
      `SELECT id, doctor_id, deadline_at
       FROM orders
       WHERE status = 'accepted'
         AND deadline_at IS NOT NULL
         AND completed_at IS NULL
         AND breached_at IS NULL`
    )
    .all();

  breachOrders.forEach((o) => {
    if (!o.deadline_at) return;
    if (new Date(o.deadline_at) < now) {
      db.prepare(
        `UPDATE orders
         SET status = 'breached',
             breached_at = ?,
             updated_at = ?,
             sla_reminder_sent = 1
         WHERE id = ?`
      ).run(nowIso, nowIso, o.id);

      logOrderEvent({
        orderId: o.id,
        label: 'SLA breached – deadline passed without completion',
        actorRole: 'system'
      });

      if (o.doctor_id) {
        queueNotification({
          orderId: o.id,
          toUserId: o.doctor_id,
          channel: 'internal',
          template: 'sla_breached_doctor',
          status: 'queued'
        });
      }

      superadmins.forEach((admin) => {
        queueNotification({
          orderId: o.id,
          toUserId: admin.id,
          channel: 'internal',
          template: 'sla_breached_superadmin',
          status: 'queued'
        });
      });
      breaches += 1;
    }
  });

  if (reminders || breaches) {
    logMajor(`[SLA job] reminders=${reminders}, breaches=${breaches}`);
  }
}


function seedDemoData() {
  if (MODE !== 'staging') return;
  const existingUsers = safeGet('SELECT COUNT(*) as c FROM users', [], { c: 0 });
  if (existingUsers && existingUsers.c > 0) {
    logMajor('Skipping demo seed – users already exist.');
    return;
  }


  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const patientId = 'demo-patient';
  const doctorId = 'demo-radiology-doctor';
  const superadminId = 'demo-superadmin';
  const specialtyId = 'demo-specialty-radiology';
  const serviceId = 'demo-service-radiology';
  const passwordHash = hash('demo1234');
  const completedOrderId = randomUUID();
  const inReviewOrderId = randomUUID();
  const breachedOrderId = randomUUID();

  const completedCreated = new Date(now.getTime() - 5 * dayMs);
  const completedAccepted = new Date(completedCreated.getTime() + 2 * 60 * 60 * 1000);
  const completedDeadline = new Date(completedAccepted.getTime() + 3 * dayMs);
  const completedCompleted = new Date(completedAccepted.getTime() + 4 * 60 * 60 * 1000);

  const inReviewCreated = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const inReviewAccepted = new Date(inReviewCreated.getTime() + 30 * 60 * 1000);
  const inReviewDeadline = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  const breachedCreated = new Date(now.getTime() - 4 * dayMs);
  const breachedAccepted = new Date(breachedCreated.getTime() + 2 * 60 * 60 * 1000);
  const breachedDeadline = new Date(breachedAccepted.getTime() + 24 * 60 * 60 * 1000);
  const breachedAt = new Date(breachedDeadline.getTime() + 2 * 60 * 60 * 1000);

  const insertOrder = db.prepare(
    `INSERT INTO orders (
      id, patient_id, doctor_id, specialty_id, service_id,
      sla_hours, status, price, doctor_fee,
      created_at, accepted_at, deadline_at, completed_at, breached_at,
      reassigned_count, notes, payment_status, payment_method, payment_reference, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO specialties (id, name) VALUES (?, ?)').run(specialtyId, 'Radiology');
    db.prepare(
      'INSERT INTO services (id, specialty_id, name, base_price, doctor_fee, currency, payment_link) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(serviceId, specialtyId, 'Radiology review', 3500, 1500, 'EGP', null);

    const createdAtIso = now.toISOString();
    db.prepare(
      'INSERT INTO users (id, email, password_hash, name, role, specialty_id, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(patientId, 'demo.patient@tashkheesa.com', passwordHash, 'Demo Patient', 'patient', null, 1, createdAtIso);
    db.prepare(
      'INSERT INTO users (id, email, password_hash, name, role, specialty_id, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(doctorId, 'demo.doctor@tashkheesa.com', passwordHash, 'Radiology Doctor', 'doctor', specialtyId, 1, createdAtIso);
    db.prepare(
      'INSERT INTO users (id, email, password_hash, name, role, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(superadminId, 'demo.superadmin@tashkheesa.com', passwordHash, 'Superadmin', 'superadmin', 1, createdAtIso);

    insertOrder.run(
      completedOrderId,
      patientId,
      doctorId,
      specialtyId,
      serviceId,
      72,
      'completed',
      3500,
      1500,
      completedCreated.toISOString(),
      completedAccepted.toISOString(),
      completedDeadline.toISOString(),
      completedCompleted.toISOString(),
      null,
      0,
      'Demo completed order',
      'paid',
      'card',
      'DEMO-PAID',
      completedCreated.toISOString()
    );

    insertOrder.run(
      inReviewOrderId,
      patientId,
      doctorId,
      specialtyId,
      serviceId,
      24,
      'in_review',
      4000,
      1800,
      inReviewCreated.toISOString(),
      inReviewAccepted.toISOString(),
      inReviewDeadline.toISOString(),
      null,
      null,
      0,
      'Demo VIP in-review case',
      'unpaid',
      'manual',
      'DEMO-VIP',
      inReviewCreated.toISOString()
    );

    insertOrder.run(
      breachedOrderId,
      patientId,
      doctorId,
      specialtyId,
      serviceId,
      72,
      'breached',
      3200,
      1200,
      breachedCreated.toISOString(),
      breachedAccepted.toISOString(),
      breachedDeadline.toISOString(),
      null,
      breachedAt.toISOString(),
      1,
      'Demo breached order',
      'unpaid',
      'manual',
      'DEMO-BREACHED',
      breachedCreated.toISOString()
    );

    const eventInsert = db.prepare(
      'INSERT INTO order_events (id, order_id, label, meta, at) VALUES (?, ?, ?, ?, ?)'
    );
    eventInsert.run(randomUUID(), completedOrderId, 'Order completed (demo)', null, completedCompleted.toISOString());
    eventInsert.run(randomUUID(), inReviewOrderId, 'Order in review (demo)', null, now.toISOString());
    eventInsert.run(randomUUID(), breachedOrderId, 'Order breached (demo)', null, breachedAt.toISOString());

    if (tableExists('notifications')) {
      const notificationInsert = db.prepare(
        'INSERT INTO notifications (id, order_id, to_user_id, channel, template, status, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      const ts = now.toISOString();
      notificationInsert.run(randomUUID(), completedOrderId, patientId, 'internal', 'demo_payment_received', 'queued', ts);
      notificationInsert.run(randomUUID(), inReviewOrderId, doctorId, 'internal', 'demo_order_assigned', 'queued', ts);
      notificationInsert.run(randomUUID(), breachedOrderId, doctorId, 'internal', 'demo_order_breached', 'queued', ts);
    }
  });

  try {
    tx();
    logMajor('Demo data seeded for staging mode.');
  } catch (err) {
    logFatal('Demo seed failed', err);
  }
}
