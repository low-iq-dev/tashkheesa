const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { major: logMajor } = require('./logger');

const DEFAULT_DB_PATH =
  process.env.PORTAL_DB_PATH ||
  process.env.DB_PATH ||
  path.join(__dirname, '..', 'data', 'portal.db');

const FALLBACK_DB_PATH = path.join('/tmp', 'tashkheesa-portal.db');

function ensureWritableDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    // ignore; directory may already exist or we lack permissions
  }
  const testFile = path.join(dir, `.tashkheesa-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(testFile, '', { flag: 'wx' });
    fs.unlinkSync(testFile);
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(testFile);
    } catch (cleanupErr) {
      // ignore cleanup errors
    }
    return false;
  }
}

function resolveDbPath(primaryPath, fallbackPath) {
  const primaryDir = path.dirname(primaryPath);
  if (ensureWritableDirectory(primaryDir)) {
    return primaryPath;
  }

  const fallbackDir = path.dirname(fallbackPath);
  if (ensureWritableDirectory(fallbackDir)) {
    logMajor(
      `Default SQLite directory ${primaryDir} is not writable; writing database to ${fallbackPath} instead.`
    );
    return fallbackPath;
  }

  throw new Error(
    `Unable to write to SQLite directories: ${primaryDir} and ${fallbackDir}`
  );
}

const dbPath = resolveDbPath(DEFAULT_DB_PATH, FALLBACK_DB_PATH);
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

module.exports = {
  db,
  migrate
};
