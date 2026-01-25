const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { major: logMajor } = require('./logger');

const dbPath = process.env.PORTAL_DB_PATH;
if (!dbPath) {
  throw new Error("FATAL: PORTAL_DB_PATH is not set");
}

const db = new Database(dbPath);

// Run on startup to ensure tables exist
function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT,
      name TEXT,
      role TEXT,
      specialty_id TEXT,
      phone TEXT,
      lang TEXT DEFAULT 'en',
      notify_whatsapp INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS specialties (
      id TEXT PRIMARY KEY,
      name TEXT
    );

    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      specialty_id TEXT,
      code TEXT,
      name TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      patient_id TEXT,
      doctor_id TEXT,
      specialty_id TEXT,
      service_id TEXT,
      sla_hours INTEGER,
      status TEXT,
      price REAL,
      doctor_fee REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      accepted_at TEXT,
      deadline_at TEXT,
      completed_at TEXT,
      breached_at TEXT,
      reassigned_count INTEGER DEFAULT 0,
      report_url TEXT,
      notes TEXT,
      diagnosis_text TEXT,
      impression_text TEXT,
      recommendation_text TEXT,
      uploads_locked INTEGER DEFAULT 0,
      additional_files_requested INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      label TEXT,
      meta TEXT,
      at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_additional_files (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      file_url TEXT,
      uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_files (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      url TEXT,
      label TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      to_user_id TEXT,
      channel TEXT,
      template TEXT,
      status TEXT,
      response TEXT,
      at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      reference_code TEXT UNIQUE,
      status TEXT,
      sla_type TEXT,
      sla_deadline TEXT,
      language TEXT DEFAULT 'en',
      urgency_flag INTEGER DEFAULT 0,
      sla_paused_at TEXT,
      sla_remaining_seconds INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      paid_at TEXT,
      breached_at TEXT
    );

    CREATE TABLE IF NOT EXISTS case_files (
      id TEXT PRIMARY KEY,
      case_id TEXT,
      filename TEXT,
      file_type TEXT,
      storage_path TEXT,
      uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
      is_valid INTEGER
    );

    CREATE TABLE IF NOT EXISTS case_context (
      case_id TEXT PRIMARY KEY,
      reason_for_review TEXT,
      urgency_flag INTEGER DEFAULT 0,
      language TEXT DEFAULT 'en'
    );

    CREATE TABLE IF NOT EXISTS doctor_assignments (
      id TEXT PRIMARY KEY,
      case_id TEXT,
      doctor_id TEXT,
      assigned_at TEXT,
      accepted_at TEXT,
      completed_at TEXT,
      reassigned_from_doctor_id TEXT
    );

    CREATE TABLE IF NOT EXISTS case_events (
      id TEXT PRIMARY KEY,
      case_id TEXT,
      event_type TEXT,
      event_payload TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Safe column additions for services
  const servicesInfo = db.prepare('PRAGMA table_info(services)').all();
  const servicesHas = (col) => servicesInfo.some((c) => c.name === col);
  if (!servicesHas('base_price')) {
    db.exec('ALTER TABLE services ADD COLUMN base_price REAL');
  }
  if (!servicesHas('doctor_fee')) {
    db.exec('ALTER TABLE services ADD COLUMN doctor_fee REAL');
  }
  if (!servicesHas('currency')) {
    db.exec("ALTER TABLE services ADD COLUMN currency TEXT DEFAULT 'EGP'");
  }
  if (!servicesHas('payment_link')) {
    db.exec('ALTER TABLE services ADD COLUMN payment_link TEXT');
  }

  // Safe column additions for orders
  const ordersInfo = db.prepare('PRAGMA table_info(orders)').all();
  const ordersHas = (col) => ordersInfo.some((c) => c.name === col);
  if (!ordersHas('medical_history')) {
    db.exec('ALTER TABLE orders ADD COLUMN medical_history TEXT');
  }
  if (!ordersHas('current_medications')) {
    db.exec('ALTER TABLE orders ADD COLUMN current_medications TEXT');
  }
  if (!ordersHas('diagnosis_text')) {
    db.exec('ALTER TABLE orders ADD COLUMN diagnosis_text TEXT');
  }
  if (!ordersHas('impression_text')) {
    db.exec('ALTER TABLE orders ADD COLUMN impression_text TEXT');
  }
  if (!ordersHas('recommendation_text')) {
    db.exec('ALTER TABLE orders ADD COLUMN recommendation_text TEXT');
  }
  if (!ordersHas('payment_status')) {
    db.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'unpaid'");
  }
  if (!ordersHas('payment_method')) {
    db.exec('ALTER TABLE orders ADD COLUMN payment_method TEXT');
  }
  if (!ordersHas('payment_reference')) {
    db.exec('ALTER TABLE orders ADD COLUMN payment_reference TEXT');
  }
  if (!ordersHas('payment_link')) {
    db.exec('ALTER TABLE orders ADD COLUMN payment_link TEXT');
  }

  // Safe column additions for users (doctor approval workflow)
  const usersInfo = db.prepare('PRAGMA table_info(users)').all();
  const usersHas = (col) => usersInfo.some((c) => c.name === col);
  if (!usersHas('pending_approval')) {
    db.exec('ALTER TABLE users ADD COLUMN pending_approval INTEGER DEFAULT 0');
  }
  if (!usersHas('approved_at')) {
    db.exec('ALTER TABLE users ADD COLUMN approved_at TEXT');
  }
  if (!usersHas('rejection_reason')) {
    db.exec('ALTER TABLE users ADD COLUMN rejection_reason TEXT');
  }
  if (!usersHas('signup_notes')) {
    db.exec('ALTER TABLE users ADD COLUMN signup_notes TEXT');
  }

  // Safe column additions for order_events (actor tracking)
  const eventsInfo = db.prepare('PRAGMA table_info(order_events)').all();
  const eventsHas = (col) => eventsInfo.some((c) => c.name === col);
  if (!eventsHas('actor_user_id')) {
    db.exec('ALTER TABLE order_events ADD COLUMN actor_user_id TEXT');
  }
  if (!eventsHas('actor_role')) {
    db.exec('ALTER TABLE order_events ADD COLUMN actor_role TEXT');
  }

  // Safe column additions for order_additional_files (labels for uploads)
  const addFilesInfo = db.prepare('PRAGMA table_info(order_additional_files)').all();
  const addFilesHas = (col) => addFilesInfo.some((c) => c.name === col);
  if (!addFilesHas('label')) {
    db.exec('ALTER TABLE order_additional_files ADD COLUMN label TEXT');
  }

  // Password reset tokens table
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // SLA pre-breach flag
  const ordersInfoWithPreBreach = db.prepare('PRAGMA table_info(orders)').all();
  const ordersHasColumn = (col) => ordersInfoWithPreBreach.some((c) => c.name === col);
  if (!ordersHasColumn('pre_breach_notified')) {
    db.exec('ALTER TABLE orders ADD COLUMN pre_breach_notified INTEGER DEFAULT 0');
  }
  if (!ordersHasColumn('sla_reminder_sent')) {
    db.exec('ALTER TABLE orders ADD COLUMN sla_reminder_sent INTEGER DEFAULT 0');
  }
}
function acceptOrder(orderId, doctorId) {
  const tx = db.transaction(() => {
    // 1. Fetch order and ensure it is still new
    const order = db
      .prepare(`SELECT * FROM orders WHERE id = ?`)
      .get(orderId);

    if (!order) {
      throw new Error('ORDER_NOT_FOUND');
    }

    if (order.status !== 'new') {
      throw new Error('ORDER_ALREADY_ACCEPTED');
    }

    const now = new Date().toISOString();

    // 2. Assign doctor + mark accepted
    db.prepare(`
      UPDATE orders
      SET
        doctor_id = ?,
        status = 'review',
        accepted_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(doctorId, now, now, orderId);

    // 3. Audit event
    db.prepare(`
      INSERT INTO order_events (id, order_id, label, actor_user_id, actor_role)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      orderId,
      'doctor_accepted',
      doctorId,
      'doctor'
    );

    return true;
  });

  return tx();
}

function getActiveCasesForDoctor(doctorId) {
  return db.prepare(`
    SELECT *
    FROM orders
    WHERE doctor_id = ?
      AND status IN ('review')
      AND completed_at IS NULL
    ORDER BY accepted_at DESC
  `).all(doctorId);
}

function getOrdersColumns() {
  try {
    return db.prepare("PRAGMA table_info('orders')").all().map((r) => r.name);
  } catch (e) {
    return [];
  }
}

function getOrderEventsColumns() {
  try {
    return db.prepare("PRAGMA table_info('order_events')").all().map((r) => r.name);
  } catch (e) {
    return [];
  }
}

function markOrderCompleted({ orderId, doctorId, reportUrl }) {
  if (!orderId) throw new Error('orderId is required');

  const now = new Date().toISOString();
  const ordersCols = getOrdersColumns();

  const tx = db.transaction(() => {
    const sets = ["status = 'completed'"];
    const params = [];

    // timestamps (schema-safe)
    if (ordersCols.includes('completed_at')) {
      sets.push('completed_at = COALESCE(completed_at, ?)');
      params.push(now);
    }
    if (ordersCols.includes('updated_at')) {
      sets.push('updated_at = ?');
      params.push(now);
    }

    // doctor assignment (if supported)
    if (doctorId && ordersCols.includes('doctor_id')) {
      sets.push('doctor_id = COALESCE(doctor_id, ?)');
      params.push(doctorId);
    }

    // persist report URL (if supported)
    if (ordersCols.includes('report_url')) {
      sets.push('report_url = ?');
      params.push(reportUrl || null);
    }

    // run update
    db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params, orderId);

    // optional audit event (schema-safe)
    const evCols = getOrderEventsColumns();
    if (evCols.includes('id') && evCols.includes('order_id') && evCols.includes('label')) {
      const evId = `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // Build a dynamic insert based on what columns exist.
      const cols = ['id', 'order_id', 'label'];
      const vals = [evId, orderId, 'report_completed'];

      if (evCols.includes('meta')) {
        cols.push('meta');
        vals.push(JSON.stringify({ reportUrl: reportUrl || null }));
      }
      if (evCols.includes('at')) {
        cols.push('at');
        vals.push(now);
      }
      if (evCols.includes('actor_user_id')) {
        cols.push('actor_user_id');
        vals.push(doctorId || null);
      }
      if (evCols.includes('actor_role')) {
        cols.push('actor_role');
        vals.push('doctor');
      }

      const placeholders = cols.map(() => '?').join(', ');
      db.prepare(`INSERT INTO order_events (${cols.join(', ')}) VALUES (${placeholders})`).run(...vals);
    }

    return true;
  });

  return tx();
}

module.exports = {
  db,
  migrate,
  acceptOrder,
  getActiveCasesForDoctor,
  markOrderCompleted
};