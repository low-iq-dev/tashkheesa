const { pool, queryOne, queryAll, execute, withTransaction } = require('./pg');
const { major: logMajor } = require('./logger');

// Run on startup to ensure tables exist
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT,
      name TEXT,
      role TEXT,
      specialty_id TEXT,
      phone TEXT,
      lang TEXT DEFAULT 'en',
      notify_whatsapp BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
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
      urgency_flag BOOLEAN DEFAULT false,
      price DOUBLE PRECISION,
      doctor_fee DOUBLE PRECISION,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP,
      accepted_at TIMESTAMP,
      deadline_at TIMESTAMP,
      completed_at TIMESTAMP,
      breached_at TIMESTAMP,
      reassigned_count INTEGER DEFAULT 0,
      report_url TEXT,
      notes TEXT,
      diagnosis_text TEXT,
      impression_text TEXT,
      recommendation_text TEXT,
      uploads_locked BOOLEAN DEFAULT false,
      additional_files_requested BOOLEAN DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      label TEXT,
      meta TEXT,
      at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_additional_files (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      file_url TEXT,
      uploaded_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_files (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      url TEXT,
      label TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      to_user_id TEXT,
      channel TEXT,
      template TEXT,
      status TEXT,
      response TEXT,
      at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      reference_code TEXT UNIQUE,
      status TEXT,
      sla_type TEXT,
      sla_deadline TIMESTAMP,
      language TEXT DEFAULT 'en',
      urgency_flag BOOLEAN DEFAULT false,
      sla_paused_at TIMESTAMP,
      sla_remaining_seconds INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP,
      paid_at TIMESTAMP,
      breached_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS case_files (
      id TEXT PRIMARY KEY,
      case_id TEXT,
      filename TEXT,
      file_type TEXT,
      storage_path TEXT,
      uploaded_at TIMESTAMP DEFAULT NOW(),
      is_valid BOOLEAN
    );

    CREATE TABLE IF NOT EXISTS case_context (
      case_id TEXT PRIMARY KEY,
      reason_for_review TEXT,
      urgency_flag BOOLEAN DEFAULT false,
      language TEXT DEFAULT 'en'
    );

    CREATE TABLE IF NOT EXISTS doctor_assignments (
      id TEXT PRIMARY KEY,
      case_id TEXT,
      doctor_id TEXT,
      assigned_at TIMESTAMP,
      accepted_at TIMESTAMP,
      completed_at TIMESTAMP,
      reassigned_from_doctor_id TEXT
    );

    CREATE TABLE IF NOT EXISTS case_events (
      id TEXT PRIMARY KEY,
      case_id TEXT,
      event_type TEXT,
      event_payload TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Helper: check if a column exists in a table (PostgreSQL)
  async function colExists(table, col) {
    const r = await queryOne(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",
      [table, col]
    );
    return !!r;
  }

  // Safe column additions for services
  if (!(await colExists('services', 'base_price'))) {
    await pool.query('ALTER TABLE services ADD COLUMN base_price DOUBLE PRECISION');
  }
  if (!(await colExists('services', 'doctor_fee'))) {
    await pool.query('ALTER TABLE services ADD COLUMN doctor_fee DOUBLE PRECISION');
  }
  if (!(await colExists('services', 'currency'))) {
    await pool.query("ALTER TABLE services ADD COLUMN currency TEXT DEFAULT 'EGP'");
  }
  if (!(await colExists('services', 'payment_link'))) {
    await pool.query('ALTER TABLE services ADD COLUMN payment_link TEXT');
  }
  if (!(await colExists('services', 'sla_hours'))) {
    await pool.query('ALTER TABLE services ADD COLUMN sla_hours INTEGER DEFAULT 72');
  }
  if (!(await colExists('services', 'is_visible'))) {
    await pool.query('ALTER TABLE services ADD COLUMN is_visible BOOLEAN DEFAULT true');
  }

  // Safe column additions for orders
  if (!(await colExists('orders', 'medical_history'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN medical_history TEXT');
  }
  if (!(await colExists('orders', 'current_medications'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN current_medications TEXT');
  }
  if (!(await colExists('orders', 'language'))) {
    await pool.query("ALTER TABLE orders ADD COLUMN language TEXT DEFAULT 'en'");
  }
  if (!(await colExists('orders', 'urgency_flag'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN urgency_flag BOOLEAN DEFAULT false');
  }
  if (!(await colExists('orders', 'diagnosis_text'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN diagnosis_text TEXT');
  }
  if (!(await colExists('orders', 'impression_text'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN impression_text TEXT');
  }
  if (!(await colExists('orders', 'recommendation_text'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN recommendation_text TEXT');
  }
  if (!(await colExists('orders', 'payment_status'))) {
    await pool.query("ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'unpaid'");
  }
  if (!(await colExists('orders', 'payment_method'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN payment_method TEXT');
  }
  if (!(await colExists('orders', 'payment_reference'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN payment_reference TEXT');
  }
  if (!(await colExists('orders', 'payment_link'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN payment_link TEXT');
  }

  // Safe column additions for users (doctor approval workflow + registration)
  if (!(await colExists('users', 'country_code'))) {
    await pool.query('ALTER TABLE users ADD COLUMN country_code TEXT');
  }
  if (!(await colExists('users', 'pending_approval'))) {
    await pool.query('ALTER TABLE users ADD COLUMN pending_approval BOOLEAN DEFAULT false');
  }
  if (!(await colExists('users', 'bio'))) {
    await pool.query('ALTER TABLE users ADD COLUMN bio TEXT');
  }
  if (!(await colExists('users', 'display_name'))) {
    await pool.query('ALTER TABLE users ADD COLUMN display_name TEXT');
  }
  if (!(await colExists('users', 'approved_at'))) {
    await pool.query('ALTER TABLE users ADD COLUMN approved_at TIMESTAMP');
  }
  if (!(await colExists('users', 'approved_by'))) {
    await pool.query('ALTER TABLE users ADD COLUMN approved_by TEXT');
  }
  if (!(await colExists('users', 'rejection_reason'))) {
    await pool.query('ALTER TABLE users ADD COLUMN rejection_reason TEXT');
  }
  if (!(await colExists('users', 'signup_notes'))) {
    await pool.query('ALTER TABLE users ADD COLUMN signup_notes TEXT');
  }

  // === PHASE 5: PATIENT ONBOARDING COLUMNS ===
  if (!(await colExists('users', 'onboarding_complete'))) {
    await pool.query('ALTER TABLE users ADD COLUMN onboarding_complete BOOLEAN DEFAULT false');
    logMajor('Migration: Added onboarding_complete column to users');
  }
  if (!(await colExists('users', 'date_of_birth'))) {
    await pool.query('ALTER TABLE users ADD COLUMN date_of_birth TEXT');
  }
  if (!(await colExists('users', 'gender'))) {
    await pool.query('ALTER TABLE users ADD COLUMN gender TEXT');
  }
  if (!(await colExists('users', 'known_conditions'))) {
    await pool.query('ALTER TABLE users ADD COLUMN known_conditions TEXT');
  }
  if (!(await colExists('users', 'current_medications'))) {
    await pool.query('ALTER TABLE users ADD COLUMN current_medications TEXT');
  }
  if (!(await colExists('users', 'allergies'))) {
    await pool.query('ALTER TABLE users ADD COLUMN allergies TEXT');
  }
  if (!(await colExists('users', 'previous_surgeries'))) {
    await pool.query('ALTER TABLE users ADD COLUMN previous_surgeries TEXT');
  }
  if (!(await colExists('users', 'family_history'))) {
    await pool.query('ALTER TABLE users ADD COLUMN family_history TEXT');
  }

  // Safe column additions for order_events (actor tracking)
  if (!(await colExists('order_events', 'actor_user_id'))) {
    await pool.query('ALTER TABLE order_events ADD COLUMN actor_user_id TEXT');
  }
  if (!(await colExists('order_events', 'actor_role'))) {
    await pool.query('ALTER TABLE order_events ADD COLUMN actor_role TEXT');
  }

  // Safe column additions for order_additional_files (labels for uploads)
  if (!(await colExists('order_additional_files', 'label'))) {
    await pool.query('ALTER TABLE order_additional_files ADD COLUMN label TEXT');
  }

  // Password reset tokens table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // SLA pre-breach flag
  if (!(await colExists('orders', 'pre_breach_notified'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN pre_breach_notified BOOLEAN DEFAULT false');
  }
  if (!(await colExists('orders', 'sla_reminder_sent'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN sla_reminder_sent BOOLEAN DEFAULT false');
  }

  // === PHASE 1: CRITICAL FIXES ===

  // FIX #1: Add dedupe_key column to notifications table for deduplication
  if (!(await colExists('notifications', 'dedupe_key'))) {
    await pool.query('ALTER TABLE notifications ADD COLUMN dedupe_key TEXT');
    try {
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL');
    } catch (e) {
      // Index might already exist, that's OK
    }
    logMajor('Migration: Added dedupe_key column to notifications table');
  }

  // Notification worker columns: attempts, retry_after
  if (!(await colExists('notifications', 'attempts'))) {
    await pool.query('ALTER TABLE notifications ADD COLUMN attempts INTEGER DEFAULT 0');
    logMajor('Migration: Added attempts column to notifications table');
  }
  if (!(await colExists('notifications', 'retry_after'))) {
    await pool.query('ALTER TABLE notifications ADD COLUMN retry_after TIMESTAMP');
    logMajor('Migration: Added retry_after column to notifications table');
  }

  // Index for worker polling
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status)');
  } catch (e) { /* may already exist */ }

  // === PHASE 2: PERFORMANCE & SECURITY FIXES ===

  // FIX #5: Add critical indexes for query performance
  // These are essential for production as data grows (prevents O(n) table scans)
  const indexesToCreate = [
    'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)',
    'CREATE INDEX IF NOT EXISTS idx_orders_deadline_at ON orders(deadline_at)',
    'CREATE INDEX IF NOT EXISTS idx_orders_patient_id ON orders(patient_id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_doctor_id ON orders(doctor_id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_to_user_id ON notifications(to_user_id)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_order_id ON notifications(order_id)',
    'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
    'CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)',
    'CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id)'
  ];

  for (const sql of indexesToCreate) {
    try {
      await pool.query(sql);
    } catch (e) {
      logMajor(`Index creation failed (may already exist): ${e.message}`);
    }
  }

  // === VIDEO CONSULTATION TABLES ===

  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      patient_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      specialty_id TEXT,
      scheduled_at TIMESTAMP NOT NULL,
      duration_minutes INTEGER DEFAULT 30,
      status TEXT DEFAULT 'pending',
      video_call_id TEXT,
      payment_id TEXT,
      price DOUBLE PRECISION NOT NULL,
      doctor_commission_pct DOUBLE PRECISION NOT NULL,
      cancel_reason TEXT,
      rescheduled_from TEXT,
      rescheduled_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_calls (
      id TEXT PRIMARY KEY,
      appointment_id TEXT NOT NULL,
      patient_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      twilio_room_name TEXT UNIQUE,
      initiated_by TEXT,
      started_at TIMESTAMP,
      ended_at TIMESTAMP,
      duration_seconds INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointment_payments (
      id TEXT PRIMARY KEY,
      appointment_id TEXT,
      patient_id TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      currency TEXT DEFAULT 'EGP',
      status TEXT DEFAULT 'pending',
      method TEXT,
      reference TEXT,
      refund_reason TEXT,
      refunded_at TIMESTAMP,
      paid_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS doctor_earnings (
      id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL,
      appointment_id TEXT NOT NULL,
      gross_amount DOUBLE PRECISION NOT NULL,
      commission_pct DOUBLE PRECISION NOT NULL,
      earned_amount DOUBLE PRECISION NOT NULL,
      status TEXT DEFAULT 'pending',
      paid_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Safe column additions for services (video consultation pricing)
  if (!(await colExists('services', 'video_consultation_price'))) {
    await pool.query('ALTER TABLE services ADD COLUMN video_consultation_price DOUBLE PRECISION');
  }
  if (!(await colExists('services', 'video_doctor_commission_pct'))) {
    await pool.query('ALTER TABLE services ADD COLUMN video_doctor_commission_pct DOUBLE PRECISION DEFAULT 70');
  }

  // Video consultation indexes
  const videoIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_appointments_patient_id ON appointments(patient_id)',
    'CREATE INDEX IF NOT EXISTS idx_appointments_doctor_id ON appointments(doctor_id)',
    'CREATE INDEX IF NOT EXISTS idx_appointments_scheduled_at ON appointments(scheduled_at)',
    'CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status)',
    'CREATE INDEX IF NOT EXISTS idx_video_calls_appointment_id ON video_calls(appointment_id)',
    'CREATE INDEX IF NOT EXISTS idx_doctor_earnings_doctor_id ON doctor_earnings(doctor_id)',
    'CREATE INDEX IF NOT EXISTS idx_appointment_payments_appointment_id ON appointment_payments(appointment_id)'
  ];

  for (const sql of videoIndexes) {
    try {
      await pool.query(sql);
    } catch (e) {
      logMajor(`Index creation failed (may already exist): ${e.message}`);
    }
  }

  // === APPOINTMENT SCHEDULING TABLES ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doctor_availability (
      id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      timezone TEXT DEFAULT 'Africa/Cairo',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointment_slots (
      id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL,
      available_at TIMESTAMP NOT NULL,
      duration_minutes INTEGER DEFAULT 30,
      is_booked BOOLEAN DEFAULT false,
      booked_by_patient_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Add columns to services table if not exist
  if (!(await colExists('services', 'appointment_price'))) {
    await pool.query('ALTER TABLE services ADD COLUMN appointment_price DOUBLE PRECISION DEFAULT 0');
  }
  if (!(await colExists('services', 'doctor_commission_pct'))) {
    await pool.query('ALTER TABLE services ADD COLUMN doctor_commission_pct DOUBLE PRECISION DEFAULT 70');
  }

  // Appointment scheduling indexes
  const schedIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_doctor_availability_doctor_id ON doctor_availability(doctor_id)',
    'CREATE INDEX IF NOT EXISTS idx_appointment_slots_doctor_id ON appointment_slots(doctor_id)',
    'CREATE INDEX IF NOT EXISTS idx_appointment_slots_available_at ON appointment_slots(available_at)',
    'CREATE INDEX IF NOT EXISTS idx_appointment_slots_is_booked ON appointment_slots(is_booked)'
  ];

  for (const sql of schedIndexes) {
    try {
      await pool.query(sql);
    } catch (e) {
      logMajor(`Index creation failed (may already exist): ${e.message}`);
    }
  }

  // === ADD-ON SERVICES COLUMNS ===
  if (!(await colExists('orders', 'video_consultation_selected'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN video_consultation_selected BOOLEAN DEFAULT false');
  }
  if (!(await colExists('orders', 'video_consultation_price'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN video_consultation_price DOUBLE PRECISION DEFAULT 0');
  }
  if (!(await colExists('orders', 'addons_json'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN addons_json TEXT');
  }
  if (!(await colExists('orders', 'total_price_with_addons'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN total_price_with_addons DOUBLE PRECISION');
  }

  // === 24-HOUR SLA ADD-ON COLUMNS ===
  if (!(await colExists('orders', 'sla_24hr_selected'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN sla_24hr_selected BOOLEAN DEFAULT false');
  }
  if (!(await colExists('orders', 'sla_24hr_price'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN sla_24hr_price DOUBLE PRECISION DEFAULT 0');
  }
  if (!(await colExists('orders', 'sla_24hr_deadline'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN sla_24hr_deadline TIMESTAMP');
  }

  // Referral discount columns on orders
  if (!(await colExists('orders', 'referral_code'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN referral_code TEXT');
  }
  if (!(await colExists('orders', 'referral_discount'))) {
    await pool.query('ALTER TABLE orders ADD COLUMN referral_discount DOUBLE PRECISION DEFAULT 0');
  }

  // Appointment SLA columns
  if (!(await colExists('appointments', 'sla_24hr_selected'))) {
    await pool.query('ALTER TABLE appointments ADD COLUMN sla_24hr_selected BOOLEAN DEFAULT false');
  }
  if (!(await colExists('appointments', 'diagnosis_submitted_at'))) {
    await pool.query('ALTER TABLE appointments ADD COLUMN diagnosis_submitted_at TIMESTAMP');
  }
  if (!(await colExists('appointments', 'sla_compliant'))) {
    await pool.query('ALTER TABLE appointments ADD COLUMN sla_compliant BOOLEAN');
  }

  // === PHASE 10: APPOINTMENT REMINDER COLUMNS ===
  if (!(await colExists('appointments', 'reminder_24h_sent'))) {
    await pool.query('ALTER TABLE appointments ADD COLUMN reminder_24h_sent BOOLEAN DEFAULT false');
    logMajor('Migration: Added reminder_24h_sent column to appointments');
  }
  if (!(await colExists('appointments', 'reminder_1h_sent'))) {
    await pool.query('ALTER TABLE appointments ADD COLUMN reminder_1h_sent BOOLEAN DEFAULT false');
    logMajor('Migration: Added reminder_1h_sent column to appointments');
  }

  // Multi-currency video pricing column on services
  if (!(await colExists('services', 'video_consultation_prices_json'))) {
    await pool.query("ALTER TABLE services ADD COLUMN video_consultation_prices_json TEXT DEFAULT '{}'");
  }
  if (!(await colExists('services', 'sla_24hr_price'))) {
    await pool.query('ALTER TABLE services ADD COLUMN sla_24hr_price DOUBLE PRECISION DEFAULT 100');
  }
  if (!(await colExists('services', 'sla_24hr_prices_json'))) {
    await pool.query("ALTER TABLE services ADD COLUMN sla_24hr_prices_json TEXT DEFAULT '{}'");
  }

  // === IMAGE ANNOTATION TABLE ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS case_annotations (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      image_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      annotation_data TEXT,
      annotated_image_data TEXT,
      annotations_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP
    )
  `);

  const annIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_case_annotations_case_id ON case_annotations(case_id)',
    'CREATE INDEX IF NOT EXISTS idx_case_annotations_image_id ON case_annotations(image_id)',
    'CREATE INDEX IF NOT EXISTS idx_case_annotations_doctor_id ON case_annotations(doctor_id)'
  ];
  for (const sql of annIndexes) {
    try { await pool.query(sql); } catch (e) {
      logMajor(`Index creation failed: ${e.message}`);
    }
  }

  // === REPORT EXPORTS TABLE ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_exports (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // === ADMIN SETTINGS TABLE ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // === REVIEWS TABLE ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      patient_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      review_text TEXT,
      is_anonymous BOOLEAN DEFAULT false,
      is_visible BOOLEAN DEFAULT true,
      admin_flagged BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const reviewIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_reviews_doctor_id ON reviews(doctor_id)',
    'CREATE INDEX IF NOT EXISTS idx_reviews_patient_id ON reviews(patient_id)',
    'CREATE INDEX IF NOT EXISTS idx_reviews_order_id ON reviews(order_id)'
  ];
  for (const sql of reviewIndexes) {
    try { await pool.query(sql); } catch (e) {
      logMajor(`Index creation failed: ${e.message}`);
    }
  }

  // === ERROR LOGGING TABLE ===
  await pool.query(`
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
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const errorLogIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_error_logs_level ON error_logs(level)',
    'CREATE INDEX IF NOT EXISTS idx_error_logs_user_id ON error_logs(user_id)'
  ];
  for (const sql of errorLogIndexes) {
    try { await pool.query(sql); } catch (e) {
      logMajor(`Index creation failed: ${e.message}`);
    }
  }

  // Report + settings + performance indexes
  const miscIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_report_exports_case_id ON report_exports(case_id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_channel ON notifications(channel)'
  ];
  for (const sql of miscIndexes) {
    try { await pool.query(sql); } catch (e) {
      logMajor(`Index creation failed: ${e.message}`);
    }
  }

  // === PHASE 6: MESSAGING TABLES ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      patient_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT DEFAULT 'text',
      file_url TEXT,
      file_name TEXT,
      is_read BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const msgIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)',
    'CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id)',
    'CREATE INDEX IF NOT EXISTS idx_conversations_patient_id ON conversations(patient_id)',
    'CREATE INDEX IF NOT EXISTS idx_conversations_doctor_id ON conversations(doctor_id)',
    'CREATE INDEX IF NOT EXISTS idx_conversations_order_id ON conversations(order_id)'
  ];
  for (const sql of msgIndexes) {
    try { await pool.query(sql); } catch (e) {
      logMajor(`Index creation failed: ${e.message}`);
    }
  }

  // === PHASE 6b: CONVERSATIONS — add closed_at column if missing ===
  if (!(await colExists('conversations', 'closed_at'))) {
    await pool.query('ALTER TABLE conversations ADD COLUMN closed_at TIMESTAMP');
    logMajor('Migration: Added closed_at column to conversations');
  }

  // === PHASE 7: PRESCRIPTIONS TABLE ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prescriptions (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      patient_id TEXT NOT NULL,
      medications TEXT NOT NULL,
      diagnosis TEXT,
      notes TEXT,
      is_active BOOLEAN DEFAULT true,
      valid_until TEXT,
      pdf_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const rxIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_prescriptions_order_id ON prescriptions(order_id)',
    'CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_id ON prescriptions(patient_id)',
    'CREATE INDEX IF NOT EXISTS idx_prescriptions_doctor_id ON prescriptions(doctor_id)'
  ];
  for (const sql of rxIndexes) {
    try { await pool.query(sql); } catch (e) {
      logMajor(`Index creation failed: ${e.message}`);
    }
  }

  // === PHASE 8: MEDICAL RECORDS TABLE ===
  await pool.query(`
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
      is_shared_with_doctors BOOLEAN DEFAULT false,
      is_hidden BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_medical_records_patient_id ON medical_records(patient_id)');
  } catch (e) {
    logMajor(`Index idx_medical_records_patient_id creation failed: ${e.message}`);
  }

  // === PHASE 8b: MEDICAL RECORDS — add order_id, doctor_id columns ===
  if (!(await colExists('medical_records', 'order_id'))) {
    await pool.query('ALTER TABLE medical_records ADD COLUMN order_id TEXT');
    logMajor('Migration: Added order_id column to medical_records');
  }
  if (!(await colExists('medical_records', 'doctor_id'))) {
    await pool.query('ALTER TABLE medical_records ADD COLUMN doctor_id TEXT');
    logMajor('Migration: Added doctor_id column to medical_records');
  }

  // === PHASE 9: REFERRAL PROGRAM TABLES ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      type TEXT DEFAULT 'patient',
      reward_type TEXT DEFAULT 'discount',
      reward_value DOUBLE PRECISION DEFAULT 10,
      max_uses INTEGER DEFAULT 0,
      times_used INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_redemptions (
      id TEXT PRIMARY KEY,
      referral_code_id TEXT NOT NULL,
      referrer_id TEXT NOT NULL,
      referred_id TEXT NOT NULL,
      order_id TEXT,
      reward_granted BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const refIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_referral_codes_user_id ON referral_codes(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code)',
    'CREATE INDEX IF NOT EXISTS idx_referral_redemptions_referrer_id ON referral_redemptions(referrer_id)'
  ];
  for (const sql of refIndexes) {
    try { await pool.query(sql); } catch (e) {
      logMajor(`Index creation failed: ${e.message}`);
    }
  }

  // Add referral_code column to users for storing which code was used at registration
  if (!(await colExists('users', 'referred_by_code'))) {
    await pool.query('ALTER TABLE users ADD COLUMN referred_by_code TEXT');
  }
  if (!(await colExists('users', 'email_marketing_opt_out'))) {
    await pool.query('ALTER TABLE users ADD COLUMN email_marketing_opt_out BOOLEAN DEFAULT false');
    logMajor('Migration: Added email_marketing_opt_out column to users');
  }
  if (!(await colExists('users', 'country'))) {
    await pool.query("ALTER TABLE users ADD COLUMN country TEXT DEFAULT 'EG'");
    logMajor('Migration: Added country column to users');
  }

  // === PHASE 11: EMAIL MARKETING CAMPAIGNS TABLES ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subject_en TEXT NOT NULL,
      subject_ar TEXT,
      template TEXT NOT NULL,
      target_audience TEXT DEFAULT 'all',
      status TEXT DEFAULT 'draft',
      scheduled_at TIMESTAMP,
      sent_at TIMESTAMP,
      total_recipients INTEGER DEFAULT 0,
      total_sent INTEGER DEFAULT 0,
      total_failed INTEGER DEFAULT 0,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      sent_at TIMESTAMP,
      error TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_id ON campaign_recipients(campaign_id)');
  } catch (e) {
    logMajor(`Index idx_campaign_recipients_campaign_id creation failed: ${e.message}`);
  }

  // === SERVICE REGIONAL PRICING TABLE ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_regional_prices (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      country_code TEXT NOT NULL,
      currency TEXT NOT NULL,
      hospital_cost DOUBLE PRECISION,
      tashkheesa_price DOUBLE PRECISION,
      doctor_commission DOUBLE PRECISION,
      status TEXT DEFAULT 'active',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(service_id, country_code)
    )
  `);

  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_srp_service_id ON service_regional_prices(service_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_srp_country_code ON service_regional_prices(country_code)');
  } catch (e) {
    logMajor('service_regional_prices index creation failed: ' + e.message);
  }

  // === FILE AI CHECKS TABLE ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS file_ai_checks (
      id TEXT PRIMARY KEY,
      file_id TEXT,
      order_id TEXT,
      is_medical_image BOOLEAN,
      image_quality TEXT,
      quality_issues TEXT,
      detected_scan_type TEXT,
      matches_expected BOOLEAN,
      confidence DOUBLE PRECISION,
      recommendation TEXT,
      checked_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // === CHAT MODERATION TABLE ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_reports (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT,
      reported_by TEXT NOT NULL,
      reporter_role TEXT NOT NULL,
      reason TEXT NOT NULL,
      details TEXT,
      status TEXT DEFAULT 'open',
      admin_notes TEXT,
      resolved_by TEXT,
      resolved_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_chat_reports_conversation ON chat_reports(conversation_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_chat_reports_status ON chat_reports(status)');
  } catch(e) {}

  // Chat moderation: muted_until on users
  if (!(await colExists('users', 'muted_until'))) {
    await pool.query('ALTER TABLE users ADD COLUMN muted_until TIMESTAMP');
  }

  // Video calls: no_show_party on appointments
  if (!(await colExists('appointments', 'no_show_party'))) {
    await pool.query('ALTER TABLE appointments ADD COLUMN no_show_party TEXT');
  }

  // Appointment payments: refund_status
  if (!(await colExists('appointment_payments', 'refund_status'))) {
    await pool.query('ALTER TABLE appointment_payments ADD COLUMN refund_status TEXT');
  }

  // === APPOINTMENT SLOT REQUEST FLOW ===
  // patient_requested_at: when patient submitted their preferred slot
  if (!(await colExists('appointments', 'patient_requested_at'))) {
    await pool.query('ALTER TABLE appointments ADD COLUMN patient_requested_at TIMESTAMP');
    logMajor('Migration: Added patient_requested_at to appointments');
  }
  // doctor_proposed_at: when doctor proposed an alternative time
  if (!(await colExists('appointments', 'doctor_proposed_at'))) {
    await pool.query('ALTER TABLE appointments ADD COLUMN doctor_proposed_at TIMESTAMP');
    logMajor('Migration: Added doctor_proposed_at to appointments');
  }
  // doctor_proposed_at: alternative time proposed by doctor
  if (!(await colExists('appointments', 'doctor_proposed_time'))) {
    await pool.query('ALTER TABLE appointments ADD COLUMN doctor_proposed_time TIMESTAMP');
    logMajor('Migration: Added doctor_proposed_time to appointments');
  }
  // patient_confirmed_at: when patient confirmed a doctor-proposed reschedule
  if (!(await colExists('appointments', 'patient_confirmed_at'))) {
    await pool.query('ALTER TABLE appointments ADD COLUMN patient_confirmed_at TIMESTAMP');
    logMajor('Migration: Added patient_confirmed_at to appointments');
  }
  // slot_notes: optional note from doctor with their proposal
  if (!(await colExists('appointments', 'slot_notes'))) {
    await pool.query('ALTER TABLE appointments ADD COLUMN slot_notes TEXT');
    logMajor('Migration: Added slot_notes to appointments');
  }

  // Video calls: duration_minutes (computed alias convenience)
  if (!(await colExists('video_calls', 'duration_minutes'))) {
    await pool.query('ALTER TABLE video_calls ADD COLUMN duration_minutes INTEGER');
  }
  if (!(await colExists('video_calls', 'patient_joined_at'))) {
    await pool.query('ALTER TABLE video_calls ADD COLUMN patient_joined_at TIMESTAMP');
  }
  if (!(await colExists('video_calls', 'doctor_joined_at'))) {
    await pool.query('ALTER TABLE video_calls ADD COLUMN doctor_joined_at TIMESTAMP');
  }

  // === PRE-LAUNCH LEADS TABLE ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pre_launch_leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      language TEXT DEFAULT 'en',
      service_interest TEXT,
      case_description TEXT,
      source TEXT DEFAULT 'coming_soon_page',
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pre_launch_leads_email ON pre_launch_leads(email)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pre_launch_leads_created_at ON pre_launch_leads(created_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pre_launch_leads_service_interest ON pre_launch_leads(service_interest)');
  } catch (e) {
    logMajor('pre_launch_leads index creation failed: ' + e.message);
  }

  // === SPECIALTY VISIBILITY ===
  if (!(await colExists('specialties', 'is_visible'))) {
    await pool.query('ALTER TABLE specialties ADD COLUMN is_visible BOOLEAN DEFAULT true');
    logMajor('Migration: Added is_visible column to specialties');
  }

  // Hide 11 unpriced specialties from patient-facing pages
  const unpricedSpecialties = [
    'spec-dermatology',
    'spec-ent',
    'spec-endocrinology',
    'spec-gastroenterology',
    'spec-general-surgery',
    'spec-internal-medicine',
    'spec-ophthalmology',
    'spec-orthopedics',
    'spec-pediatrics',
    'spec-pulmonology',
    'spec-urology',
  ];
  const phUnpriced = unpricedSpecialties.map((_, i) => `$${i + 1}`).join(', ');
  await pool.query(
    `UPDATE specialties SET is_visible = false WHERE id IN (${phUnpriced}) AND is_visible != false`,
    unpricedSpecialties
  );

  // Remove generic placeholder services (not real services)
  await pool.query(
    "DELETE FROM services WHERE id IN ('dermatology-svc', 'gastroenterology-svc', 'orthopedics-svc')"
  );

  // === INSTAGRAM SCHEDULED POSTS TABLE ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ig_scheduled_posts (
      id TEXT PRIMARY KEY,
      campaign_id TEXT,
      day_number INTEGER,
      post_type TEXT NOT NULL DEFAULT 'IMAGE',
      caption_en TEXT,
      caption_ar TEXT,
      caption TEXT,
      hashtags TEXT,
      image_urls TEXT,
      scheduled_at TEXT,
      status TEXT DEFAULT 'pending_approval',
      approved_by TEXT,
      approved_at TEXT,
      image_prompt TEXT,
      rejection_feedback TEXT,
      generation_count INTEGER DEFAULT 0,
      ig_media_id TEXT,
      published_at TEXT,
      error_message TEXT,
      post_label TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Instagram image generation columns
  if (!(await colExists('ig_scheduled_posts', 'image_prompt'))) {
    await pool.query('ALTER TABLE ig_scheduled_posts ADD COLUMN image_prompt TEXT');
  }
  if (!(await colExists('ig_scheduled_posts', 'rejection_feedback'))) {
    await pool.query('ALTER TABLE ig_scheduled_posts ADD COLUMN rejection_feedback TEXT');
  }
  if (!(await colExists('ig_scheduled_posts', 'generation_count'))) {
    await pool.query('ALTER TABLE ig_scheduled_posts ADD COLUMN generation_count INTEGER DEFAULT 0');
  }

  // Normalize order statuses to lowercase (fix mixed-case data)
  await pool.query("UPDATE orders SET status = LOWER(status) WHERE status IS NOT NULL AND status != LOWER(status)");

  // === SEED: Specialties, Services, and EG Regional Prices ===
  await seedPricingData();
}

async function seedPricingData() {
  // Only seed if table is empty
  var existingCount = 0;
  try {
    var row = await queryOne('SELECT COUNT(*) as c FROM service_regional_prices');
    existingCount = row ? row.c : 0;
  } catch (_) {}
  if (existingCount > 0) return;

  logMajor('Seeding regional pricing data...');

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

  try {
    await withTransaction(async function(client) {
      // 1. Ensure specialties
      for (const s of specialties) {
        await client.query('INSERT INTO specialties (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [s.id, s.name]);
      }

      // 2. Ensure services
      for (const s of services) {
        await client.query('INSERT INTO services (id, specialty_id, code, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [s.id, s.specialty_id, s.id, s.name]);
      }

      // 3. Insert EG prices
      var egCount = 0;
      var placeholderCount = 0;

      for (const svc of services) {
        var p = egPricing[svc.id];
        if (!p) continue;

        var hc = p.cost;
        var tp = (hc !== null) ? Math.ceil(hc * 1.15) : null;
        var dc = (tp !== null) ? Math.ceil(tp * 0.20) : null;

        await client.query(
          'INSERT INTO service_regional_prices (id, service_id, country_code, currency, hospital_cost, tashkheesa_price, doctor_commission, status, notes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (service_id, country_code) DO NOTHING',
          [nextId(), svc.id, 'EG', 'EGP', hc, tp, dc, p.status, null, now, now]
        );
        egCount++;

        // 4. Insert placeholder rows for SA, AE, GB, US
        for (const r of otherRegions) {
          await client.query(
            'INSERT INTO service_regional_prices (id, service_id, country_code, currency, hospital_cost, tashkheesa_price, doctor_commission, status, notes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (service_id, country_code) DO NOTHING',
            [nextId(), svc.id, r.code, r.currency, null, null, null, 'pending_pricing', 'Awaiting regional pricing', now, now]
          );
          placeholderCount++;
        }
      }

      logMajor('Seeded ' + egCount + ' EG prices + ' + placeholderCount + ' regional placeholders (' + otherRegions.length + ' regions x ' + egCount + ' services)');
    });
  } catch (e) {
    logMajor('Pricing seed failed (may already exist): ' + e.message);
  }
}
async function acceptOrder(orderId, doctorId) {
  return await withTransaction(async (client) => {
    // 1. Fetch order and ensure it is still new
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = rows[0] || null;

    if (!order) {
      throw new Error('ORDER_NOT_FOUND');
    }

    if (order.status !== 'new') {
      throw new Error('ORDER_ALREADY_ACCEPTED');
    }

    const now = new Date().toISOString();

    // 2. Assign doctor + mark accepted
    await client.query(
      `UPDATE orders
       SET doctor_id = $1, status = 'review', accepted_at = $2, updated_at = $3
       WHERE id = $4`,
      [doctorId, now, now, orderId]
    );

    // 3. Audit event
    await client.query(
      `INSERT INTO order_events (id, order_id, label, actor_user_id, actor_role)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        orderId,
        'doctor_accepted',
        doctorId,
        'doctor'
      ]
    );

    return true;
  });
}

async function getActiveCasesForDoctor(doctorId) {
  return await queryAll(
    `SELECT *
     FROM orders
     WHERE doctor_id = $1
       AND status IN ('review')
       AND completed_at IS NULL
     ORDER BY accepted_at DESC`,
    [doctorId]
  );
}

async function getOrdersColumns() {
  try {
    const rows = await queryAll(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'"
    );
    return rows.map((r) => r.column_name);
  } catch (e) {
    return [];
  }
}

async function getOrderEventsColumns() {
  try {
    const rows = await queryAll(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='order_events'"
    );
    return rows.map((r) => r.column_name);
  } catch (e) {
    return [];
  }
}

async function markOrderCompleted({ orderId, doctorId, reportUrl }) {
  if (!orderId) throw new Error('orderId is required');

  const now = new Date().toISOString();
  const ordersCols = await getOrdersColumns();

  return await withTransaction(async (client) => {
    const sets = ["status = 'completed'"];
    const params = [];
    let paramIdx = 0;

    // timestamps (schema-safe)
    if (ordersCols.includes('completed_at')) {
      paramIdx++;
      sets.push(`completed_at = COALESCE(completed_at, $${paramIdx})`);
      params.push(now);
    }
    if (ordersCols.includes('updated_at')) {
      paramIdx++;
      sets.push(`updated_at = $${paramIdx}`);
      params.push(now);
    }

    // doctor assignment (if supported)
    if (doctorId && ordersCols.includes('doctor_id')) {
      paramIdx++;
      sets.push(`doctor_id = COALESCE(doctor_id, $${paramIdx})`);
      params.push(doctorId);
    }

    // persist report URL (if supported)
    if (ordersCols.includes('report_url')) {
      paramIdx++;
      sets.push(`report_url = $${paramIdx}`);
      params.push(reportUrl || null);
    }

    // run update
    paramIdx++;
    params.push(orderId);
    await client.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $${paramIdx}`, params);

    // optional audit event (schema-safe)
    const evCols = await getOrderEventsColumns();
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

      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      await client.query(`INSERT INTO order_events (${cols.join(', ')}) VALUES (${placeholders})`, vals);
    }

    return true;
  });
}

module.exports = {
  pool,
  migrate,
  acceptOrder,
  getActiveCasesForDoctor,
  markOrderCompleted,
  queryOne,
  queryAll,
  execute,
  withTransaction
};
