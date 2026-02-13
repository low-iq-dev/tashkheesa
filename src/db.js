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
      language TEXT DEFAULT 'en',
      urgency_flag INTEGER DEFAULT 0,
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
  if (!ordersHas('language')) {
    db.exec("ALTER TABLE orders ADD COLUMN language TEXT DEFAULT 'en'");
  }
  if (!ordersHas('urgency_flag')) {
    db.exec('ALTER TABLE orders ADD COLUMN urgency_flag INTEGER DEFAULT 0');
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

  // === PHASE 5: PATIENT ONBOARDING COLUMNS ===
  if (!usersHas('onboarding_complete')) {
    db.exec('ALTER TABLE users ADD COLUMN onboarding_complete INTEGER DEFAULT 0');
    logMajor('✅ Migration: Added onboarding_complete column to users');
  }
  if (!usersHas('date_of_birth')) {
    db.exec('ALTER TABLE users ADD COLUMN date_of_birth TEXT');
  }
  if (!usersHas('gender')) {
    db.exec('ALTER TABLE users ADD COLUMN gender TEXT');
  }
  if (!usersHas('known_conditions')) {
    db.exec('ALTER TABLE users ADD COLUMN known_conditions TEXT');
  }
  if (!usersHas('current_medications')) {
    db.exec('ALTER TABLE users ADD COLUMN current_medications TEXT');
  }
  if (!usersHas('allergies')) {
    db.exec('ALTER TABLE users ADD COLUMN allergies TEXT');
  }
  if (!usersHas('previous_surgeries')) {
    db.exec('ALTER TABLE users ADD COLUMN previous_surgeries TEXT');
  }
  if (!usersHas('family_history')) {
    db.exec('ALTER TABLE users ADD COLUMN family_history TEXT');
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

  // === PHASE 1: CRITICAL FIXES ===

  // FIX #1: Add dedupe_key column to notifications table for deduplication
  const notificationsInfo = db.prepare('PRAGMA table_info(notifications)').all();
  const notificationsHas = (col) => notificationsInfo.some((c) => c.name === col);
  if (!notificationsHas('dedupe_key')) {
    db.exec('ALTER TABLE notifications ADD COLUMN dedupe_key TEXT');
    // Create unique index but allow NULL values (SQLite quirk: multiple NULLs are allowed)
    try {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL');
    } catch (e) {
      // Index might already exist, that's OK
    }
    logMajor('✅ Migration: Added dedupe_key column to notifications table');
  }

  // Notification worker columns: attempts, retry_after
  const notifInfo2 = db.prepare('PRAGMA table_info(notifications)').all();
  const notifHas2 = (col) => notifInfo2.some((c) => c.name === col);
  if (!notifHas2('attempts')) {
    db.exec('ALTER TABLE notifications ADD COLUMN attempts INTEGER DEFAULT 0');
    logMajor('✅ Migration: Added attempts column to notifications table');
  }
  if (!notifHas2('retry_after')) {
    db.exec('ALTER TABLE notifications ADD COLUMN retry_after TEXT');
    logMajor('✅ Migration: Added retry_after column to notifications table');
  }

  // Index for worker polling
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status)');
  } catch (e) { /* may already exist */ }

  // === PHASE 2: PERFORMANCE & SECURITY FIXES ===

  // FIX #5: Add critical indexes for query performance
  // These are essential for production as data grows (prevents O(n) table scans)
  const existingIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
  const hasIndex = (name) => existingIndexes.includes(name);

  const indexesToCreate = [
    { name: 'idx_orders_status', sql: 'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)' },
    { name: 'idx_orders_deadline_at', sql: 'CREATE INDEX IF NOT EXISTS idx_orders_deadline_at ON orders(deadline_at)' },
    { name: 'idx_orders_patient_id', sql: 'CREATE INDEX IF NOT EXISTS idx_orders_patient_id ON orders(patient_id)' },
    { name: 'idx_orders_doctor_id', sql: 'CREATE INDEX IF NOT EXISTS idx_orders_doctor_id ON orders(doctor_id)' },
    { name: 'idx_orders_created_at', sql: 'CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)' },
    { name: 'idx_notifications_to_user_id', sql: 'CREATE INDEX IF NOT EXISTS idx_notifications_to_user_id ON notifications(to_user_id)' },
    { name: 'idx_notifications_order_id', sql: 'CREATE INDEX IF NOT EXISTS idx_notifications_order_id ON notifications(order_id)' },
    { name: 'idx_users_email', sql: 'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)' },
    { name: 'idx_users_role', sql: 'CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)' },
    { name: 'idx_order_events_order_id', sql: 'CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id)' }
  ];

  indexesToCreate.forEach(({ name, sql }) => {
    try {
      if (!hasIndex(name)) {
        db.exec(sql);
        logMajor(`✅ Migration: Created index ${name}`);
      }
    } catch (e) {
      logMajor(`⚠️  Index ${name} creation failed (may already exist): ${e.message}`);
    }
  });

  // === VIDEO CONSULTATION TABLES ===

  db.exec(`
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      patient_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      specialty_id TEXT,
      scheduled_at TEXT NOT NULL,
      duration_minutes INTEGER DEFAULT 30,
      status TEXT DEFAULT 'pending',
      video_call_id TEXT,
      payment_id TEXT,
      price REAL NOT NULL,
      doctor_commission_pct REAL NOT NULL,
      cancel_reason TEXT,
      rescheduled_from TEXT,
      rescheduled_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS video_calls (
      id TEXT PRIMARY KEY,
      appointment_id TEXT NOT NULL,
      patient_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      twilio_room_name TEXT UNIQUE,
      initiated_by TEXT,
      started_at TEXT,
      ended_at TEXT,
      duration_seconds INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS appointment_payments (
      id TEXT PRIMARY KEY,
      appointment_id TEXT,
      patient_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'EGP',
      status TEXT DEFAULT 'pending',
      method TEXT,
      reference TEXT,
      refund_reason TEXT,
      refunded_at TEXT,
      paid_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS doctor_earnings (
      id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL,
      appointment_id TEXT NOT NULL,
      gross_amount REAL NOT NULL,
      commission_pct REAL NOT NULL,
      earned_amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      paid_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Safe column additions for services (video consultation pricing)
  const svcInfo2 = db.prepare('PRAGMA table_info(services)').all();
  const svcHas2 = (col) => svcInfo2.some((c) => c.name === col);
  if (!svcHas2('video_consultation_price')) {
    db.exec('ALTER TABLE services ADD COLUMN video_consultation_price REAL');
  }
  if (!svcHas2('video_doctor_commission_pct')) {
    db.exec('ALTER TABLE services ADD COLUMN video_doctor_commission_pct REAL DEFAULT 70');
  }

  // Video consultation indexes
  const videoIndexes = [
    { name: 'idx_appointments_patient_id', sql: 'CREATE INDEX IF NOT EXISTS idx_appointments_patient_id ON appointments(patient_id)' },
    { name: 'idx_appointments_doctor_id', sql: 'CREATE INDEX IF NOT EXISTS idx_appointments_doctor_id ON appointments(doctor_id)' },
    { name: 'idx_appointments_scheduled_at', sql: 'CREATE INDEX IF NOT EXISTS idx_appointments_scheduled_at ON appointments(scheduled_at)' },
    { name: 'idx_appointments_status', sql: 'CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status)' },
    { name: 'idx_video_calls_appointment_id', sql: 'CREATE INDEX IF NOT EXISTS idx_video_calls_appointment_id ON video_calls(appointment_id)' },
    { name: 'idx_doctor_earnings_doctor_id', sql: 'CREATE INDEX IF NOT EXISTS idx_doctor_earnings_doctor_id ON doctor_earnings(doctor_id)' },
    { name: 'idx_appointment_payments_appointment_id', sql: 'CREATE INDEX IF NOT EXISTS idx_appointment_payments_appointment_id ON appointment_payments(appointment_id)' }
  ];

  videoIndexes.forEach(({ name, sql }) => {
    try {
      db.exec(sql);
    } catch (e) {
      logMajor(`⚠️  Index ${name} creation failed (may already exist): ${e.message}`);
    }
  });

  // === APPOINTMENT SCHEDULING TABLES ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS doctor_availability (
      id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      timezone TEXT DEFAULT 'Africa/Cairo',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS appointment_slots (
      id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL,
      available_at TEXT NOT NULL,
      duration_minutes INTEGER DEFAULT 30,
      is_booked INTEGER DEFAULT 0,
      booked_by_patient_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Add columns to services table if not exist
  const svcInfo3 = db.prepare('PRAGMA table_info(services)').all();
  const svcHas3 = (col) => svcInfo3.some((c) => c.name === col);
  if (!svcHas3('appointment_price')) {
    db.exec('ALTER TABLE services ADD COLUMN appointment_price REAL DEFAULT 0');
  }
  if (!svcHas3('doctor_commission_pct')) {
    db.exec('ALTER TABLE services ADD COLUMN doctor_commission_pct REAL DEFAULT 70');
  }

  // Appointment scheduling indexes
  const schedIndexes = [
    { name: 'idx_doctor_availability_doctor_id', sql: 'CREATE INDEX IF NOT EXISTS idx_doctor_availability_doctor_id ON doctor_availability(doctor_id)' },
    { name: 'idx_appointment_slots_doctor_id', sql: 'CREATE INDEX IF NOT EXISTS idx_appointment_slots_doctor_id ON appointment_slots(doctor_id)' },
    { name: 'idx_appointment_slots_available_at', sql: 'CREATE INDEX IF NOT EXISTS idx_appointment_slots_available_at ON appointment_slots(available_at)' },
    { name: 'idx_appointment_slots_is_booked', sql: 'CREATE INDEX IF NOT EXISTS idx_appointment_slots_is_booked ON appointment_slots(is_booked)' }
  ];

  schedIndexes.forEach(({ name, sql }) => {
    try {
      db.exec(sql);
    } catch (e) {
      logMajor(`⚠️  Index ${name} creation failed (may already exist): ${e.message}`);
    }
  });

  // === ADD-ON SERVICES COLUMNS ===
  const ordersInfoAddons = db.prepare('PRAGMA table_info(orders)').all();
  const ordersHasAddon = (col) => ordersInfoAddons.some((c) => c.name === col);

  if (!ordersHasAddon('video_consultation_selected')) {
    db.exec('ALTER TABLE orders ADD COLUMN video_consultation_selected INTEGER DEFAULT 0');
  }
  if (!ordersHasAddon('video_consultation_price')) {
    db.exec('ALTER TABLE orders ADD COLUMN video_consultation_price REAL DEFAULT 0');
  }
  if (!ordersHasAddon('addons_json')) {
    db.exec('ALTER TABLE orders ADD COLUMN addons_json TEXT');
  }
  if (!ordersHasAddon('total_price_with_addons')) {
    db.exec('ALTER TABLE orders ADD COLUMN total_price_with_addons REAL');
  }

  // === 24-HOUR SLA ADD-ON COLUMNS ===
  if (!ordersHasAddon('sla_24hr_selected')) {
    db.exec('ALTER TABLE orders ADD COLUMN sla_24hr_selected INTEGER DEFAULT 0');
  }
  if (!ordersHasAddon('sla_24hr_price')) {
    db.exec('ALTER TABLE orders ADD COLUMN sla_24hr_price REAL DEFAULT 0');
  }
  if (!ordersHasAddon('sla_24hr_deadline')) {
    db.exec('ALTER TABLE orders ADD COLUMN sla_24hr_deadline TEXT');
  }

  // Appointment SLA columns
  const apptInfo = db.prepare('PRAGMA table_info(appointments)').all();
  const apptHas = (col) => apptInfo.some((c) => c.name === col);
  if (!apptHas('sla_24hr_selected')) {
    db.exec('ALTER TABLE appointments ADD COLUMN sla_24hr_selected INTEGER DEFAULT 0');
  }
  if (!apptHas('diagnosis_submitted_at')) {
    db.exec('ALTER TABLE appointments ADD COLUMN diagnosis_submitted_at TEXT');
  }
  if (!apptHas('sla_compliant')) {
    db.exec('ALTER TABLE appointments ADD COLUMN sla_compliant INTEGER');
  }

  // === PHASE 10: APPOINTMENT REMINDER COLUMNS ===
  if (!apptHas('reminder_24h_sent')) {
    db.exec('ALTER TABLE appointments ADD COLUMN reminder_24h_sent INTEGER DEFAULT 0');
    logMajor('✅ Migration: Added reminder_24h_sent column to appointments');
  }
  if (!apptHas('reminder_1h_sent')) {
    db.exec('ALTER TABLE appointments ADD COLUMN reminder_1h_sent INTEGER DEFAULT 0');
    logMajor('✅ Migration: Added reminder_1h_sent column to appointments');
  }

  // Multi-currency video pricing column on services
  if (!svcHas3('video_consultation_prices_json')) {
    db.exec("ALTER TABLE services ADD COLUMN video_consultation_prices_json TEXT DEFAULT '{}'");
  }
  if (!svcHas3('sla_24hr_price')) {
    db.exec('ALTER TABLE services ADD COLUMN sla_24hr_price REAL DEFAULT 100');
  }
  if (!svcHas3('sla_24hr_prices_json')) {
    db.exec("ALTER TABLE services ADD COLUMN sla_24hr_prices_json TEXT DEFAULT '{}'");
  }

  // === IMAGE ANNOTATION TABLE ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_annotations (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      image_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      annotation_data TEXT,
      annotated_image_data TEXT,
      annotations_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
  `);

  const annIndexes = [
    { name: 'idx_case_annotations_case_id', sql: 'CREATE INDEX IF NOT EXISTS idx_case_annotations_case_id ON case_annotations(case_id)' },
    { name: 'idx_case_annotations_image_id', sql: 'CREATE INDEX IF NOT EXISTS idx_case_annotations_image_id ON case_annotations(image_id)' },
    { name: 'idx_case_annotations_doctor_id', sql: 'CREATE INDEX IF NOT EXISTS idx_case_annotations_doctor_id ON case_annotations(doctor_id)' }
  ];
  annIndexes.forEach(({ name, sql }) => {
    try { db.exec(sql); } catch (e) {
      logMajor(`⚠️  Index ${name} creation failed: ${e.message}`);
    }
  });

  // === REPORT EXPORTS TABLE ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS report_exports (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // === ADMIN SETTINGS TABLE ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // === REVIEWS TABLE ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      patient_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      review_text TEXT,
      is_anonymous INTEGER DEFAULT 0,
      is_visible INTEGER DEFAULT 1,
      admin_flagged INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  var reviewIndexes = [
    { name: 'idx_reviews_doctor_id', sql: 'CREATE INDEX IF NOT EXISTS idx_reviews_doctor_id ON reviews(doctor_id)' },
    { name: 'idx_reviews_patient_id', sql: 'CREATE INDEX IF NOT EXISTS idx_reviews_patient_id ON reviews(patient_id)' },
    { name: 'idx_reviews_order_id', sql: 'CREATE INDEX IF NOT EXISTS idx_reviews_order_id ON reviews(order_id)' }
  ];
  reviewIndexes.forEach(({ name, sql }) => {
    try { db.exec(sql); } catch (e) {
      logMajor(`⚠️  Index ${name} creation failed: ${e.message}`);
    }
  });

  // === ERROR LOGGING TABLE ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS error_logs (
      id TEXT PRIMARY KEY,
      error_id TEXT,
      level TEXT DEFAULT 'error',
      message TEXT,
      stack TEXT,
      context TEXT,
      request_id TEXT,
      user_id TEXT,
      url TEXT,
      method TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const errorLogIndexes = [
    { name: 'idx_error_logs_created_at', sql: 'CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at)' },
    { name: 'idx_error_logs_level', sql: 'CREATE INDEX IF NOT EXISTS idx_error_logs_level ON error_logs(level)' },
    { name: 'idx_error_logs_user_id', sql: 'CREATE INDEX IF NOT EXISTS idx_error_logs_user_id ON error_logs(user_id)' }
  ];
  errorLogIndexes.forEach(({ name, sql }) => {
    try { db.exec(sql); } catch (e) {
      logMajor(`⚠️  Index ${name} creation failed: ${e.message}`);
    }
  });

  // Report + settings + performance indexes
  const miscIndexes = [
    { name: 'idx_report_exports_case_id', sql: 'CREATE INDEX IF NOT EXISTS idx_report_exports_case_id ON report_exports(case_id)' },
    { name: 'idx_orders_payment_status', sql: 'CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status)' },
    { name: 'idx_notifications_channel', sql: 'CREATE INDEX IF NOT EXISTS idx_notifications_channel ON notifications(channel)' }
  ];
  miscIndexes.forEach(({ name, sql }) => {
    try { db.exec(sql); } catch (e) {
      logMajor(`⚠️  Index ${name} creation failed: ${e.message}`);
    }
  });

  // === PHASE 6: MESSAGING TABLES ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      patient_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT DEFAULT 'text',
      file_url TEXT,
      file_name TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  var msgIndexes = [
    { name: 'idx_messages_conversation_id', sql: 'CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)' },
    { name: 'idx_messages_sender_id', sql: 'CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id)' },
    { name: 'idx_conversations_patient_id', sql: 'CREATE INDEX IF NOT EXISTS idx_conversations_patient_id ON conversations(patient_id)' },
    { name: 'idx_conversations_doctor_id', sql: 'CREATE INDEX IF NOT EXISTS idx_conversations_doctor_id ON conversations(doctor_id)' },
    { name: 'idx_conversations_order_id', sql: 'CREATE INDEX IF NOT EXISTS idx_conversations_order_id ON conversations(order_id)' }
  ];
  msgIndexes.forEach(({ name, sql }) => {
    try { db.exec(sql); } catch (e) {
      logMajor(`⚠️  Index ${name} creation failed: ${e.message}`);
    }
  });

  // === PHASE 6b: CONVERSATIONS — add closed_at column if missing ===
  try {
    var convInfo = db.prepare('PRAGMA table_info(conversations)').all();
    var convHas = function(col) { return convInfo.some(function(c) { return c.name === col; }); };
    if (!convHas('closed_at')) {
      db.exec('ALTER TABLE conversations ADD COLUMN closed_at TEXT');
      logMajor('✅ Migration: Added closed_at column to conversations');
    }
  } catch (e) {
    logMajor('⚠️  conversations closed_at migration: ' + e.message);
  }

  // === PHASE 7: PRESCRIPTIONS TABLE ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS prescriptions (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      patient_id TEXT NOT NULL,
      medications TEXT NOT NULL,
      diagnosis TEXT,
      notes TEXT,
      is_active INTEGER DEFAULT 1,
      valid_until TEXT,
      pdf_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  var rxIndexes = [
    { name: 'idx_prescriptions_order_id', sql: 'CREATE INDEX IF NOT EXISTS idx_prescriptions_order_id ON prescriptions(order_id)' },
    { name: 'idx_prescriptions_patient_id', sql: 'CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_id ON prescriptions(patient_id)' },
    { name: 'idx_prescriptions_doctor_id', sql: 'CREATE INDEX IF NOT EXISTS idx_prescriptions_doctor_id ON prescriptions(doctor_id)' }
  ];
  rxIndexes.forEach(({ name, sql }) => {
    try { db.exec(sql); } catch (e) {
      logMajor(`⚠️  Index ${name} creation failed: ${e.message}`);
    }
  });

  // === PHASE 8: MEDICAL RECORDS TABLE ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS medical_records (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      record_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      file_url TEXT,
      file_name TEXT,
      date_of_record TEXT,
      provider TEXT,
      tags TEXT,
      is_shared_with_doctors INTEGER DEFAULT 0,
      is_hidden INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_medical_records_patient_id ON medical_records(patient_id)');
  } catch (e) {
    logMajor(`⚠️  Index idx_medical_records_patient_id creation failed: ${e.message}`);
  }

  // === PHASE 8b: MEDICAL RECORDS — add order_id, doctor_id columns ===
  try {
    var mrInfo = db.prepare('PRAGMA table_info(medical_records)').all();
    var mrHas = function(col) { return mrInfo.some(function(c) { return c.name === col; }); };
    if (!mrHas('order_id')) {
      db.exec('ALTER TABLE medical_records ADD COLUMN order_id TEXT');
      logMajor('✅ Migration: Added order_id column to medical_records');
    }
    if (!mrHas('doctor_id')) {
      db.exec('ALTER TABLE medical_records ADD COLUMN doctor_id TEXT');
      logMajor('✅ Migration: Added doctor_id column to medical_records');
    }
  } catch (e) {
    logMajor('⚠️  medical_records migration: ' + e.message);
  }

  // === PHASE 9: REFERRAL PROGRAM TABLES ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS referral_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      type TEXT DEFAULT 'patient',
      reward_type TEXT DEFAULT 'discount',
      reward_value REAL DEFAULT 10,
      max_uses INTEGER DEFAULT 0,
      times_used INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS referral_redemptions (
      id TEXT PRIMARY KEY,
      referral_code_id TEXT NOT NULL,
      referrer_id TEXT NOT NULL,
      referred_id TEXT NOT NULL,
      order_id TEXT,
      reward_granted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  var refIndexes = [
    { name: 'idx_referral_codes_user_id', sql: 'CREATE INDEX IF NOT EXISTS idx_referral_codes_user_id ON referral_codes(user_id)' },
    { name: 'idx_referral_codes_code', sql: 'CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code)' },
    { name: 'idx_referral_redemptions_referrer_id', sql: 'CREATE INDEX IF NOT EXISTS idx_referral_redemptions_referrer_id ON referral_redemptions(referrer_id)' }
  ];
  refIndexes.forEach(({ name, sql }) => {
    try { db.exec(sql); } catch (e) {
      logMajor(`⚠️  Index ${name} creation failed: ${e.message}`);
    }
  });

  // Add referral_code column to users for storing which code was used at registration
  const usersInfo2 = db.prepare('PRAGMA table_info(users)').all();
  const usersHas2 = (col) => usersInfo2.some((c) => c.name === col);
  if (!usersHas2('referred_by_code')) {
    db.exec('ALTER TABLE users ADD COLUMN referred_by_code TEXT');
  }
  if (!usersHas2('email_marketing_opt_out')) {
    db.exec('ALTER TABLE users ADD COLUMN email_marketing_opt_out INTEGER DEFAULT 0');
    logMajor('✅ Migration: Added email_marketing_opt_out column to users');
  }
  if (!usersHas2('country')) {
    db.exec("ALTER TABLE users ADD COLUMN country TEXT DEFAULT 'EG'");
    logMajor('✅ Migration: Added country column to users');
  }

  // === PHASE 11: EMAIL MARKETING CAMPAIGNS TABLES ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subject_en TEXT NOT NULL,
      subject_ar TEXT,
      template TEXT NOT NULL,
      target_audience TEXT DEFAULT 'all',
      status TEXT DEFAULT 'draft',
      scheduled_at TEXT,
      sent_at TEXT,
      total_recipients INTEGER DEFAULT 0,
      total_sent INTEGER DEFAULT 0,
      total_failed INTEGER DEFAULT 0,
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      sent_at TEXT,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_id ON campaign_recipients(campaign_id)');
  } catch (e) {
    logMajor(`⚠️  Index idx_campaign_recipients_campaign_id creation failed: ${e.message}`);
  }

  // === SERVICE REGIONAL PRICING TABLE ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_regional_prices (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      country_code TEXT NOT NULL,
      currency TEXT NOT NULL,
      hospital_cost REAL,
      tashkheesa_price REAL,
      doctor_commission REAL,
      status TEXT DEFAULT 'active',
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(service_id, country_code)
    );
  `);

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_srp_service_id ON service_regional_prices(service_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_srp_country_code ON service_regional_prices(country_code)');
  } catch (e) {
    logMajor('⚠️  service_regional_prices index creation failed: ' + e.message);
  }

  // === SEED: Specialties, Services, and EG Regional Prices ===
  seedPricingData();
}

function seedPricingData() {
  // Only seed if table is empty
  var existingCount = 0;
  try {
    var row = db.prepare('SELECT COUNT(*) as c FROM service_regional_prices').get();
    existingCount = row ? row.c : 0;
  } catch (_) {}
  if (existingCount > 0) return;

  logMajor('📊 Seeding regional pricing data...');

  var specialties = [
    { id: 'radiology', name: 'Radiology' },
    { id: 'cardiology', name: 'Cardiology' },
    { id: 'oncology', name: 'Oncology' },
    { id: 'neurology', name: 'Neurology' },
    { id: 'lab_pathology', name: 'Lab & Pathology' }
  ];

  var services = [
    // RADIOLOGY
    { id: 'rad_ct_review', specialty_id: 'radiology', name: 'CT Scan Review' },
    { id: 'rad_mri_review', specialty_id: 'radiology', name: 'MRI Review' },
    { id: 'rad_cxr_review', specialty_id: 'radiology', name: 'Chest X-Ray Review' },
    { id: 'rad_us_review', specialty_id: 'radiology', name: 'Ultrasound Review' },
    { id: 'rad_neuro_imaging', specialty_id: 'radiology', name: 'Neuro Imaging Review' },
    { id: 'rad_spine_mri', specialty_id: 'radiology', name: 'Spine MRI Review' },
    { id: 'rad_ct_mr_angio', specialty_id: 'radiology', name: 'CT/MR Angiography Review' },
    { id: 'rad_onc_petct_staging', specialty_id: 'radiology', name: 'Oncology PET-CT Staging' },
    { id: 'rad_abd_pelvis_ct_mri', specialty_id: 'radiology', name: 'Abdomen/Pelvis CT/MRI Review' },
    { id: 'rad_msk_imaging', specialty_id: 'radiology', name: 'Musculoskeletal Imaging Review' },
    { id: 'rad_cardiac_ct', specialty_id: 'radiology', name: 'Cardiac CT Review' },
    { id: 'rad_cardiac_mri', specialty_id: 'radiology', name: 'Cardiac MRI Review' },
    // CARDIOLOGY
    { id: 'card_ecg_12lead', specialty_id: 'cardiology', name: '12-Lead ECG Interpretation' },
    { id: 'card_rhythm_strip', specialty_id: 'cardiology', name: 'Rhythm Strip Analysis' },
    { id: 'card_echo', specialty_id: 'cardiology', name: 'Echocardiogram Review' },
    { id: 'card_stress_treadmill', specialty_id: 'cardiology', name: 'Stress Treadmill Test Review' },
    { id: 'card_stress_echo', specialty_id: 'cardiology', name: 'Stress Echo Review' },
    { id: 'card_holter_24_72', specialty_id: 'cardiology', name: 'Holter Monitor (24-72h) Review' },
    { id: 'card_event_monitor', specialty_id: 'cardiology', name: 'Event Monitor Review' },
    { id: 'card_ctca', specialty_id: 'cardiology', name: 'CT Coronary Angiography Review' },
    { id: 'card_calcium_score', specialty_id: 'cardiology', name: 'Calcium Score Review' },
    { id: 'card_cmr', specialty_id: 'cardiology', name: 'Cardiac MR Review' },
    { id: 'card_preop_clearance', specialty_id: 'cardiology', name: 'Pre-Op Cardiac Clearance' },
    // ONCOLOGY
    { id: 'onc_petct_imaging', specialty_id: 'oncology', name: 'PET-CT Imaging Review' },
    { id: 'onc_ct_mri_staging', specialty_id: 'oncology', name: 'CT/MRI Staging Review' },
    { id: 'onc_histo_reports', specialty_id: 'oncology', name: 'Histopathology Report Review' },
    { id: 'onc_cytology_reports', specialty_id: 'oncology', name: 'Cytology Report Review' },
    { id: 'onc_heme_onc_blood', specialty_id: 'oncology', name: 'Hemato-Oncology Blood Review' },
    { id: 'onc_bone_marrow_biopsy', specialty_id: 'oncology', name: 'Bone Marrow Biopsy Review' },
    { id: 'onc_tumor_markers', specialty_id: 'oncology', name: 'Tumor Markers Review' },
    { id: 'onc_recist_response', specialty_id: 'oncology', name: 'RECIST Response Assessment' },
    { id: 'onc_rt_planning_scan', specialty_id: 'oncology', name: 'RT Planning Scan Review' },
    // NEUROLOGY
    { id: 'neuro_brain_mri', specialty_id: 'neurology', name: 'Brain MRI Review' },
    { id: 'neuro_brain_ct', specialty_id: 'neurology', name: 'Brain CT Review' },
    { id: 'neuro_spine_mri', specialty_id: 'neurology', name: 'Neuro Spine MRI Review' },
    { id: 'neuro_eeg', specialty_id: 'neurology', name: 'EEG Interpretation' },
    { id: 'neuro_emg_ncs', specialty_id: 'neurology', name: 'EMG/NCS Review' },
    { id: 'neuro_cta', specialty_id: 'neurology', name: 'Neuro CTA Review' },
    { id: 'neuro_mra', specialty_id: 'neurology', name: 'Neuro MRA Review' },
    { id: 'neuro_neurovascular', specialty_id: 'neurology', name: 'Neurovascular Review' },
    { id: 'neuro_perfusion', specialty_id: 'neurology', name: 'Perfusion Imaging Review' },
    { id: 'neuro_epilepsy_imaging', specialty_id: 'neurology', name: 'Epilepsy Imaging Review' },
    { id: 'neuro_stroke_imaging', specialty_id: 'neurology', name: 'Stroke Imaging Review' },
    // LAB & PATHOLOGY
    { id: 'lab_cbc', specialty_id: 'lab_pathology', name: 'Complete Blood Count (CBC)' },
    { id: 'lab_kidney_urea', specialty_id: 'lab_pathology', name: 'Kidney Function - Urea' },
    { id: 'lab_kidney_creat', specialty_id: 'lab_pathology', name: 'Kidney Function - Creatinine' },
    { id: 'lab_kidney_uric_acid', specialty_id: 'lab_pathology', name: 'Kidney Function - Uric Acid' },
    { id: 'lab_liver_ast', specialty_id: 'lab_pathology', name: 'Liver Function - AST' },
    { id: 'lab_liver_alt', specialty_id: 'lab_pathology', name: 'Liver Function - ALT' },
    { id: 'lab_liver_ggt', specialty_id: 'lab_pathology', name: 'Liver Function - GGT' },
    { id: 'lab_liver_alp', specialty_id: 'lab_pathology', name: 'Liver Function - ALP' },
    { id: 'lab_liver_albumin', specialty_id: 'lab_pathology', name: 'Liver Function - Albumin' },
    { id: 'lab_electrolytes_na', specialty_id: 'lab_pathology', name: 'Electrolytes - Sodium' },
    { id: 'lab_electrolytes_k', specialty_id: 'lab_pathology', name: 'Electrolytes - Potassium' },
    { id: 'lab_thyroid_panel', specialty_id: 'lab_pathology', name: 'Thyroid Panel' },
    { id: 'lab_lipid_profile', specialty_id: 'lab_pathology', name: 'Lipid Profile' },
    { id: 'lab_diabetes', specialty_id: 'lab_pathology', name: 'Diabetes Panel (HbA1c/FBS)' },
    { id: 'lab_autoimmune_ana', specialty_id: 'lab_pathology', name: 'Autoimmune - ANA' },
    { id: 'lab_autoimmune_anti_dna', specialty_id: 'lab_pathology', name: 'Autoimmune - Anti-DNA' },
    { id: 'lab_autoimmune_asma', specialty_id: 'lab_pathology', name: 'Autoimmune - ASMA' },
    { id: 'lab_autoimmune_anca', specialty_id: 'lab_pathology', name: 'Autoimmune - ANCA' },
    { id: 'lab_autoimmune_c3', specialty_id: 'lab_pathology', name: 'Autoimmune - Complement C3' },
    { id: 'lab_autoimmune_c4', specialty_id: 'lab_pathology', name: 'Autoimmune - Complement C4' },
    { id: 'lab_coag_pt', specialty_id: 'lab_pathology', name: 'Coagulation - PT/INR' },
    { id: 'lab_coag_ptt', specialty_id: 'lab_pathology', name: 'Coagulation - PTT' },
    { id: 'lab_tumor_cea', specialty_id: 'lab_pathology', name: 'Tumor Marker - CEA' },
    { id: 'lab_tumor_ca153', specialty_id: 'lab_pathology', name: 'Tumor Marker - CA 15-3' },
    { id: 'lab_tumor_ca199', specialty_id: 'lab_pathology', name: 'Tumor Marker - CA 19-9' },
    { id: 'lab_tumor_ca125', specialty_id: 'lab_pathology', name: 'Tumor Marker - CA 125' },
    { id: 'lab_tumor_psa', specialty_id: 'lab_pathology', name: 'Tumor Marker - PSA' },
    { id: 'lab_tumor_afp', specialty_id: 'lab_pathology', name: 'Tumor Marker - AFP' },
    { id: 'lab_hormone_dhea', specialty_id: 'lab_pathology', name: 'Hormone - DHEA-S' },
    { id: 'lab_hormone_e2', specialty_id: 'lab_pathology', name: 'Hormone - Estradiol (E2)' },
    { id: 'lab_hormone_testo', specialty_id: 'lab_pathology', name: 'Hormone - Testosterone' },
    { id: 'lab_hormone_lh', specialty_id: 'lab_pathology', name: 'Hormone - LH' },
    { id: 'lab_hormone_fsh', specialty_id: 'lab_pathology', name: 'Hormone - FSH' },
    { id: 'lab_hormone_prl', specialty_id: 'lab_pathology', name: 'Hormone - Prolactin' },
    { id: 'lab_urinalysis', specialty_id: 'lab_pathology', name: 'Urinalysis' },
    { id: 'lab_urine_culture', specialty_id: 'lab_pathology', name: 'Urine Culture' },
    { id: 'lab_stool_analysis', specialty_id: 'lab_pathology', name: 'Stool Analysis' },
    { id: 'lab_stool_culture', specialty_id: 'lab_pathology', name: 'Stool Culture' },
    { id: 'lab_histo_small', specialty_id: 'lab_pathology', name: 'Histopathology - Small Biopsy' },
    { id: 'lab_histo_large', specialty_id: 'lab_pathology', name: 'Histopathology - Large Biopsy' },
    { id: 'lab_histo_organ', specialty_id: 'lab_pathology', name: 'Histopathology - Organ/Resection' },
    { id: 'lab_cytology', specialty_id: 'lab_pathology', name: 'Cytology' },
    { id: 'lab_micro_urine_cs', specialty_id: 'lab_pathology', name: 'Microbiology - Urine C&S' },
    { id: 'lab_micro_stool_cs', specialty_id: 'lab_pathology', name: 'Microbiology - Stool C&S' },
    { id: 'lab_micro_sputum_cs', specialty_id: 'lab_pathology', name: 'Microbiology - Sputum C&S' },
    { id: 'lab_micro_blood_cs', specialty_id: 'lab_pathology', name: 'Microbiology - Blood C&S' },
    { id: 'lab_bone_marrow', specialty_id: 'lab_pathology', name: 'Bone Marrow Aspirate Review' },
    { id: 'lab_pap_smear', specialty_id: 'lab_pathology', name: 'Pap Smear' },
    { id: 'lab_body_fluids', specialty_id: 'lab_pathology', name: 'Body Fluids Analysis' },
    { id: 'lab_fna', specialty_id: 'lab_pathology', name: 'Fine Needle Aspiration (FNA)' },
    { id: 'lab_sensitivity', specialty_id: 'lab_pathology', name: 'Sensitivity Testing' },
    { id: 'lab_genetic_molecular', specialty_id: 'lab_pathology', name: 'Genetic/Molecular Testing' }
  ];

  // EG pricing: service_id -> { hospital_cost, status }
  var egPricing = {
    rad_ct_review: { cost: 7900, status: 'active' },
    rad_mri_review: { cost: 7300, status: 'active' },
    rad_cxr_review: { cost: 550, status: 'active' },
    rad_us_review: { cost: 1500, status: 'active' },
    rad_neuro_imaging: { cost: 4550, status: 'active' },
    rad_spine_mri: { cost: 8100, status: 'active' },
    rad_ct_mr_angio: { cost: 15200, status: 'active' },
    rad_onc_petct_staging: { cost: null, status: 'not_available' },
    rad_abd_pelvis_ct_mri: { cost: 7000, status: 'active' },
    rad_msk_imaging: { cost: 1600, status: 'active' },
    rad_cardiac_ct: { cost: 6900, status: 'active' },
    rad_cardiac_mri: { cost: 7300, status: 'active' },
    card_ecg_12lead: { cost: 500, status: 'active' },
    card_rhythm_strip: { cost: 500, status: 'active' },
    card_echo: { cost: 1200, status: 'active' },
    card_stress_treadmill: { cost: 1350, status: 'active' },
    card_stress_echo: { cost: 1800, status: 'active' },
    card_holter_24_72: { cost: 3000, status: 'active' },
    card_event_monitor: { cost: null, status: 'not_available' },
    card_ctca: { cost: 6900, status: 'active' },
    card_calcium_score: { cost: 3200, status: 'active' },
    card_cmr: { cost: 7300, status: 'active' },
    card_preop_clearance: { cost: null, status: 'not_available' },
    onc_petct_imaging: { cost: null, status: 'not_available' },
    onc_ct_mri_staging: { cost: 15200, status: 'active' },
    onc_histo_reports: { cost: null, status: 'external' },
    onc_cytology_reports: { cost: null, status: 'external' },
    onc_heme_onc_blood: { cost: null, status: 'external' },
    onc_bone_marrow_biopsy: { cost: 10000, status: 'active' },
    onc_tumor_markers: { cost: null, status: 'external' },
    onc_recist_response: { cost: null, status: 'not_available' },
    onc_rt_planning_scan: { cost: null, status: 'not_available' },
    neuro_brain_mri: { cost: 3200, status: 'active' },
    neuro_brain_ct: { cost: 1350, status: 'active' },
    neuro_spine_mri: { cost: 8100, status: 'active' },
    neuro_eeg: { cost: 11500, status: 'active' },
    neuro_emg_ncs: { cost: 6000, status: 'active' },
    neuro_cta: { cost: 7900, status: 'active' },
    neuro_mra: { cost: 5400, status: 'active' },
    neuro_neurovascular: { cost: null, status: 'needs_clarification' },
    neuro_perfusion: { cost: null, status: 'needs_clarification' },
    neuro_epilepsy_imaging: { cost: null, status: 'needs_clarification' },
    neuro_stroke_imaging: { cost: null, status: 'needs_clarification' },
    lab_cbc: { cost: 380, status: 'active' },
    lab_kidney_urea: { cost: 180, status: 'active' },
    lab_kidney_creat: { cost: 180, status: 'active' },
    lab_kidney_uric_acid: { cost: 180, status: 'active' },
    lab_liver_ast: { cost: 180, status: 'active' },
    lab_liver_alt: { cost: 180, status: 'active' },
    lab_liver_ggt: { cost: 220, status: 'active' },
    lab_liver_alp: { cost: 190, status: 'active' },
    lab_liver_albumin: { cost: 190, status: 'active' },
    lab_electrolytes_na: { cost: 230, status: 'active' },
    lab_electrolytes_k: { cost: 230, status: 'active' },
    lab_thyroid_panel: { cost: 1010, status: 'active' },
    lab_lipid_profile: { cost: 680, status: 'active' },
    lab_diabetes: { cost: 620, status: 'active' },
    lab_autoimmune_ana: { cost: 700, status: 'active' },
    lab_autoimmune_anti_dna: { cost: 1300, status: 'active' },
    lab_autoimmune_asma: { cost: 1300, status: 'active' },
    lab_autoimmune_anca: { cost: 2200, status: 'active' },
    lab_autoimmune_c3: { cost: 400, status: 'active' },
    lab_autoimmune_c4: { cost: 400, status: 'active' },
    lab_coag_pt: { cost: 250, status: 'active' },
    lab_coag_ptt: { cost: 270, status: 'active' },
    lab_tumor_cea: { cost: 440, status: 'active' },
    lab_tumor_ca153: { cost: 600, status: 'active' },
    lab_tumor_ca199: { cost: 600, status: 'active' },
    lab_tumor_ca125: { cost: 600, status: 'active' },
    lab_tumor_psa: { cost: 460, status: 'active' },
    lab_tumor_afp: { cost: 440, status: 'active' },
    lab_hormone_dhea: { cost: 440, status: 'active' },
    lab_hormone_e2: { cost: 330, status: 'active' },
    lab_hormone_testo: { cost: 680, status: 'active' },
    lab_hormone_lh: { cost: 300, status: 'active' },
    lab_hormone_fsh: { cost: 330, status: 'active' },
    lab_hormone_prl: { cost: 330, status: 'active' },
    lab_urinalysis: { cost: 160, status: 'active' },
    lab_urine_culture: { cost: 540, status: 'active' },
    lab_stool_analysis: { cost: 170, status: 'active' },
    lab_stool_culture: { cost: 600, status: 'active' },
    lab_histo_small: { cost: 1450, status: 'active' },
    lab_histo_large: { cost: 2600, status: 'active' },
    lab_histo_organ: { cost: 3700, status: 'active' },
    lab_cytology: { cost: 900, status: 'active' },
    lab_micro_urine_cs: { cost: 540, status: 'active' },
    lab_micro_stool_cs: { cost: 600, status: 'active' },
    lab_micro_sputum_cs: { cost: 6000, status: 'active' },
    lab_micro_blood_cs: { cost: 830, status: 'active' },
    lab_bone_marrow: { cost: 10000, status: 'active' },
    lab_pap_smear: { cost: null, status: 'needs_clarification' },
    lab_body_fluids: { cost: null, status: 'needs_clarification' },
    lab_fna: { cost: null, status: 'needs_clarification' },
    lab_sensitivity: { cost: null, status: 'needs_clarification' },
    lab_genetic_molecular: { cost: null, status: 'needs_clarification' }
  };

  var otherRegions = [
    { code: 'SA', currency: 'SAR' },
    { code: 'AE', currency: 'AED' },
    { code: 'GB', currency: 'GBP' },
    { code: 'US', currency: 'USD' }
  ];

  var now = new Date().toISOString();
  var idCounter = 0;
  function nextId() { return 'srp_' + (++idCounter); }

  var tx = db.transaction(function() {
    // 1. Ensure specialties
    var insSpec = db.prepare('INSERT OR IGNORE INTO specialties (id, name) VALUES (?, ?)');
    specialties.forEach(function(s) { insSpec.run(s.id, s.name); });

    // 2. Ensure services
    var insSvc = db.prepare('INSERT OR IGNORE INTO services (id, specialty_id, code, name) VALUES (?, ?, ?, ?)');
    services.forEach(function(s) { insSvc.run(s.id, s.specialty_id, s.id, s.name); });

    // 3. Insert EG prices
    var insPrice = db.prepare(
      'INSERT OR IGNORE INTO service_regional_prices (id, service_id, country_code, currency, hospital_cost, tashkheesa_price, doctor_commission, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    var egCount = 0;
    var placeholderCount = 0;

    services.forEach(function(svc) {
      var p = egPricing[svc.id];
      if (!p) return;

      var hc = p.cost;
      var tp = (hc !== null) ? Math.ceil(hc * 1.15) : null;
      var dc = (tp !== null) ? Math.ceil(tp * 0.20) : null;

      insPrice.run(nextId(), svc.id, 'EG', 'EGP', hc, tp, dc, p.status, null, now, now);
      egCount++;

      // 4. Insert placeholder rows for SA, AE, GB, US
      otherRegions.forEach(function(r) {
        insPrice.run(nextId(), svc.id, r.code, r.currency, null, null, null, 'pending_pricing', 'Awaiting regional pricing', now, now);
        placeholderCount++;
      });
    });

    logMajor('📊 Seeded ' + egCount + ' EG prices + ' + placeholderCount + ' regional placeholders (' + otherRegions.length + ' regions x ' + egCount + ' services)');
  });

  try {
    tx();
  } catch (e) {
    logMajor('⚠️  Pricing seed failed (may already exist): ' + e.message);
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
