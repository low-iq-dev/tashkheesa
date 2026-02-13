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
