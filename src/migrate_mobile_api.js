/**
 * Mobile API Database Migration (PostgreSQL)
 *
 * Adds tables and columns needed by the patient mobile app.
 * Safe to run multiple times (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 *
 * @param {import('pg').Pool} pool - PostgreSQL pool instance
 */

async function migrateForMobileApi(pool) {
  console.log('[migrate] Running mobile API migrations...');

  // ─── Helper: safe column add ───────────────────────────────
  async function safeAddColumn(table, column, type) {
    try {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
    } catch (err) {
      console.warn(`[migrate] Could not add ${table}.${column}: ${err.message}`);
    }
  }

  // ─── Users table additions ─────────────────────────────────
  await safeAddColumn('users', 'push_token', 'TEXT');
  await safeAddColumn('users', 'refresh_token', 'TEXT');
  await safeAddColumn('users', 'refresh_token_expires_at', 'TIMESTAMP');
  await safeAddColumn('users', 'reset_token', 'TEXT');
  await safeAddColumn('users', 'reset_token_expires', 'TIMESTAMP');

  // ─── Orders table additions ────────────────────────────────
  // Note: medical_history, completed_at already exist from portal migrations
  await safeAddColumn('orders', 'reference_id', 'TEXT');
  await safeAddColumn('orders', 'clinical_question', 'TEXT');
  await safeAddColumn('orders', 'country', 'TEXT');
  await safeAddColumn('orders', 'base_price', 'DOUBLE PRECISION');
  await safeAddColumn('orders', 'currency', "TEXT DEFAULT 'EGP'");
  await safeAddColumn('orders', 'sla_deadline', 'TIMESTAMP');
  await safeAddColumn('orders', 'urgent', 'BOOLEAN DEFAULT false');

  // ─── Notifications table additions ─────────────────────────
  // The portal notifications table has: id, order_id, to_user_id, channel, template, status, response, at
  // The mobile API also needs these columns for in-app notifications:
  await safeAddColumn('notifications', 'type', 'TEXT');
  await safeAddColumn('notifications', 'title', 'TEXT');
  await safeAddColumn('notifications', 'message', 'TEXT');
  await safeAddColumn('notifications', 'is_read', 'BOOLEAN DEFAULT false');
  await safeAddColumn('notifications', 'data', 'TEXT');

  // ─── Order files table additions ───────────────────────────
  // The portal order_files table has: id, order_id, url, label, created_at
  // The mobile API also needs these columns for Uploadcare files:
  await safeAddColumn('order_files', 'uploadcare_uuid', 'TEXT');
  await safeAddColumn('order_files', 'filename', 'TEXT');
  await safeAddColumn('order_files', 'mime_type', 'TEXT');
  await safeAddColumn('order_files', 'size', 'INTEGER');
  await safeAddColumn('order_files', 'ai_quality_status', 'TEXT');
  await safeAddColumn('order_files', 'ai_quality_note', 'TEXT');

  // ─── OTP codes table ───────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ─── Order timeline table ──────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_timeline (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT,
      actor TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ─── Payments table ────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      amount DOUBLE PRECISION,
      currency TEXT DEFAULT 'EGP',
      status TEXT DEFAULT 'pending',
      method TEXT,
      payment_link TEXT,
      paid_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ─── Doctor specialties junction table ─────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doctor_specialties (
      id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL,
      specialty_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ─── Indexes for performance ───────────────────────────────
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_orders_ref ON orders(reference_id)',
    'CREATE INDEX IF NOT EXISTS idx_order_timeline ON order_timeline(order_id)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(to_user_id, is_read)',
    'CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id)',
    'CREATE INDEX IF NOT EXISTS idx_doctor_specialties_doctor ON doctor_specialties(doctor_id)',
  ];

  for (const idx of indexes) {
    try { await pool.query(idx); } catch { /* Index might already exist */ }
  }

  console.log('[migrate] Mobile API migrations complete.');
}

module.exports = { migrateForMobileApi };
