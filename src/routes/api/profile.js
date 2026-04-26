/**
 * Profile API Routes — /api/v1/profile/*
 *
 * Manages patient profile, push tokens, password change, and GDPR deletion.
 */

const router = require('express').Router();
const bcrypt = require('bcryptjs');
// Lazy-load express-validator — top-level require takes ~120s and starves DB pool on boot.
let _ev;
function ev() { if (!_ev) _ev = require('express-validator'); return _ev; }
function body(...a) { return ev().body(...a); }
function validationResult(...a) { return ev().validationResult(...a); }

module.exports = function (db, { safeGet, safeRun }) {

  // ─── GET /profile ────────────────────────────────────────

  router.get('/', async (req, res) => {
    const user = await safeGet('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.fail('User not found', 404);

    return res.ok({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      country: user.country,
      lang: user.lang || 'en',
      role: user.role,
      createdAt: user.created_at,
    });
  });

  // ─── PATCH /profile ──────────────────────────────────────

  router.patch('/', [
    body('name').optional().trim().notEmpty(),
    body('phone').optional().trim(),
    body('country').optional().trim(),
    body('lang').optional().isIn(['en', 'ar']),
  ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.fail(errors.array()[0].msg, 422);
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (req.body.name) { updates.push(`name = $${paramIndex++}`); values.push(req.body.name); }
    if (req.body.phone) { updates.push(`phone = $${paramIndex++}`); values.push(req.body.phone); }
    if (req.body.country) { updates.push(`country = $${paramIndex++}`); values.push(req.body.country); }
    if (req.body.lang) { updates.push(`lang = $${paramIndex++}`); values.push(req.body.lang); }

    if (updates.length === 0) {
      return res.fail('No fields to update', 400);
    }

    values.push(req.user.id);
    await safeRun(`UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`, values);

    const updated = await safeGet('SELECT * FROM users WHERE id = $1', [req.user.id]);
    return res.ok({
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      country: updated.country,
      lang: updated.lang,
    });
  });

  // ─── POST /profile/push-token ────────────────────────────
  // Register Expo push token for notifications

  router.post('/push-token', [
    body('token').trim().notEmpty(),
  ], async (req, res) => {
    const { token } = req.body;

    // Validate Expo push token format
    if (!token.startsWith('ExponentPushToken[') && !token.startsWith('ExpoPushToken[')) {
      return res.fail('Invalid push token format', 400);
    }

    await safeRun('UPDATE users SET push_token = $1 WHERE id = $2', [token, req.user.id]);
    return res.ok({ message: 'Push token registered' });
  });

  // ─── DELETE /profile/push-token ──────────────────────────

  router.delete('/push-token', async (req, res) => {
    await safeRun('UPDATE users SET push_token = NULL WHERE id = $1', [req.user.id]);
    return res.ok({ message: 'Push token removed' });
  });

  // ─── PATCH /profile/password ─────────────────────────────

  router.patch('/password', [
    body('currentPassword').notEmpty(),
    body('newPassword').isLength({ min: 8 }),
  ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.fail(errors.array()[0].msg, 422);
    }

    const user = await safeGet('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.fail('User not found', 404);

    const valid = await bcrypt.compare(req.body.currentPassword, user.password_hash);
    if (!valid) {
      return res.fail('Current password is incorrect', 401, 'WRONG_PASSWORD');
    }

    const hashed = await bcrypt.hash(req.body.newPassword, 10);
    await safeRun('UPDATE users SET password_hash = $1 WHERE id = $2', [hashed, req.user.id]);

    return res.ok({ message: 'Password updated successfully' });
  });

  // ─── DELETE /profile/account ─────────────────────────────
  // GDPR: Full account deletion

  router.delete('/account', async (req, res) => {
    const userId = req.user.id;

    // Delete in order to respect foreign keys
    const tables = [
      { table: 'messages', column: 'sender_id' },
      { table: 'reviews', column: 'patient_id' },
      { table: 'notifications', column: 'to_user_id' },
      { table: 'order_files', column: 'order_id', subquery: true },
      { table: 'order_timeline', column: 'order_id', subquery: true },
      { table: 'conversations', column: 'patient_id' },
      { table: 'prescriptions', column: 'patient_id' },
      { table: 'payments', column: 'order_id', subquery: true },
      { table: 'orders', column: 'patient_id' },
    ];

    for (const { table, column, subquery } of tables) {
      try {
        if (subquery) {
          await safeRun(`DELETE FROM ${table} WHERE ${column} IN (SELECT id FROM orders WHERE patient_id = $1)`, [userId]);
        } else {
          await safeRun(`DELETE FROM ${table} WHERE ${column} = $1`, [userId]);
        }
      } catch (err) {
        // Table might not exist, skip
        console.warn(`[delete-account] Skipping ${table}: ${err.message}`);
      }
    }

    // Finally delete the user
    await safeRun('DELETE FROM users WHERE id = $1', [userId]);

    return res.ok({ message: 'Account and all data permanently deleted.' });
  });

  return router;
};
