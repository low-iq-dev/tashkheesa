// src/services/account_deletion.js
//
// PDPL Article 2(e) erasure, done in one transaction.
//
// WHAT WAS HERE BEFORE. DELETE /api/v1/profile/account looped over eight
// tables calling `safeRun`, which is a bare pool.query — so every statement
// autocommitted on its own. A failure four tables in left the account
// half-erased with no way to resume, and the loop swallowed the error as
// "table might not exist" and still answered "Account and all data
// permanently deleted." It also:
//
//   * required no re-authentication, so a stolen JWT erased a medical history;
//   * checked no role, so a doctor tapping the button in the app would have
//     taken every case they ever reviewed down with them;
//   * deleted messages by sender_id only, leaving the specialist's clinical
//     replies orphaned in a conversation whose patient no longer existed;
//   * missed medical_records, appointments, video_calls, appointment_payments,
//     order_events, order_additional_files, referral rows and password reset
//     tokens entirely;
//   * left every uploaded file sitting in Cloudflare R2 — and, by deleting the
//     rows that held the keys, made those objects permanently unfindable;
//   * ran DELETE FROM orders, which CASCADEs onto `refunds` and
//     `order_addons` (confdeltype 'c', verified in production). Those are the
//     financial records privacy.ejs §1 promises to keep "for accounting and
//     refund purposes". Erasing an account silently destroyed the evidence of
//     money we had taken and money we had returned.
//
// HOW THIS ONE DIFFERS. Orders are ANONYMISED, not deleted: every clinical and
// free-text field is blanked, patient_id is detached, and the financial
// skeleton — reference, amounts, currency, payment references, timestamps —
// survives. That is what the published policy already says we do, and it is
// what stops the CASCADE. Everything genuinely personal is deleted outright.
//
// Every finance query that touches orders → users is a LEFT JOIN with a
// COALESCE fallback (checked across routes/analytics.js, reports.js,
// exports.js), so a NULL patient_id degrades to 'Patient' rather than dropping
// the row out of a revenue total.

const { withTransaction } = require('../pg');
const { major: logMajor } = require('../logger');

/** Free-text and clinical columns on `orders` that must not survive erasure. */
const ORDER_FIELDS_TO_BLANK = [
  'clinical_question', 'medical_history', 'current_medications', 'notes',
  'diagnosis_text', 'impression_text', 'recommendation_text',
  'report_url', 'case_files_url', 'payment_link',
];

/**
 * Child rows keyed off the patient's orders. Ordered so that nothing is
 * removed before the rows that point at it.
 *
 * `refunds` and `order_addons` are deliberately absent — they hang off the
 * order, which we keep.
 */
// Two of these carry their own CASCADE, verified against production
// pg_constraint (there are only seven foreign keys in the whole public schema):
//   payment_events        → payment_event_reviews   ON DELETE CASCADE
//   prescriptions         → prescribed_medications_log ON DELETE CASCADE
// Both are correct to lose. payment_events.payload_json is the raw Paymob
// webhook and carries the patient's billing name, email and phone, so it
// cannot survive an erasure request; the "transaction reference" the privacy
// policy promises to keep lives on the order row, which we keep.
//
// The two cascades we are NOT firing are the important ones:
//   orders → refunds        ON DELETE CASCADE
//   orders → order_addons   ON DELETE CASCADE → addon_earnings ON DELETE CASCADE
// The old DELETE FROM orders went two levels deep and took the doctor's
// earnings rows with it.
const ORDER_CHILD_DELETES = [
  ['file_ai_checks', 'order_id'],
  // ── The case_* family ────────────────────────────────────────────────
  // These are keyed on case_id, and case_id IS orders.id — the same case,
  // reached by a second name. Every enumeration written against
  // patient_id/user_id/order_id misses all of them, which is how the
  // original endpoint came to leave, per production counts on 2026-08-26:
  //   case_files             4 rows, every one holding an R2 storage_path
  //   case_extractions       9 rows of patient_info parsed OUT of the uploads
  //   case_events           81 rows, 70 with an event_payload
  //   specialty_classifications  6 rows of free-text reasoning about the case
  // And crucially these were not orphaned: the order row survives by design,
  // so they stayed joinable to a record that still carries payment_reference.
  ['case_files', 'case_id'],
  ['case_extractions', 'case_id'],
  ['case_annotations', 'case_id'],
  ['case_context', 'case_id'],
  ['case_events', 'case_id'],
  ['specialty_classifications', 'case_id'],
  ['specialty_classification_overrides', 'case_id'],
  ['report_exports', 'case_id'],
  ['order_files', 'order_id'],
  ['order_additional_files', 'order_id'],
  ['order_timeline', 'order_id'],
  ['order_events', 'order_id'],
  ['payment_events', 'order_id'],
  ['prescriptions', 'order_id'],
  ['reviews', 'order_id'],
  ['medical_records', 'order_id'],
  ['referral_redemptions', 'order_id'],
];

/** Rows keyed directly off the user. */
const USER_CHILD_DELETES = [
  ['notifications', 'to_user_id'],
  ['reviews', 'patient_id'],
  ['prescriptions', 'patient_id'],
  ['medical_records', 'patient_id'],
  ['appointment_payments', 'patient_id'],
  ['video_calls', 'patient_id'],
  ['appointments', 'patient_id'],
  ['password_reset_tokens', 'user_id'],
  ['campaign_recipients', 'user_id'],
  ['referral_codes', 'user_id'],
  ['error_logs', 'user_id'],
];

// Tables that exist in some environments and not others. Checked with
// to_regclass at run time rather than assumed either way.
const OPTIONAL_USER_TABLES = [
  { table: 'notify_whatsapp_migration_062_backup', column: 'user_id' },
];

class AccountDeletionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountDeletionError';
    this.code = code;
  }
}

/**
 * Erase one patient account.
 *
 * Returns the R2 object keys that belonged to the account. Storage deletion is
 * deliberately NOT done inside the transaction: an R2 timeout must not roll
 * back a committed erasure, and an erasure that rolls back must not have
 * already destroyed the files. The caller deletes the objects after commit,
 * and any key that fails is logged so it can be swept later — by then the
 * database no longer holds it.
 *
 * @param {string} userId
 * @returns {Promise<{ orderIds: string[], storageKeys: string[], counts: Record<string, number> }>}
 */
async function deleteAccount(userId) {
  if (!userId) throw new AccountDeletionError('NO_USER', 'A user id is required');

  return withTransaction(async (client) => {
    // Serialise against a concurrent second click. Without this two requests
    // can both read the order list, both collect keys, and both try to delete.
    const userRes = await client.query(
      'SELECT id, role FROM users WHERE id = $1 FOR UPDATE', [userId]
    );
    if (userRes.rowCount === 0) {
      throw new AccountDeletionError('NOT_FOUND', 'User not found');
    }
    const role = String(userRes.rows[0].role || '').toLowerCase();
    // A doctor's account is load-bearing for every case they reviewed and
    // every earnings row we owe them. Erasure for staff is a manual,
    // supervised operation, not a button.
    if (role !== 'patient') {
      throw new AccountDeletionError(
        'ROLE_NOT_ERASABLE',
        'Only patient accounts can be deleted through this route'
      );
    }

    // include-deleted-ok: an abandoned draft still holds uploaded files.
    const orderRes = await client.query(
      'SELECT id, reference_id, status, doctor_id, paid_at, deadline_at FROM orders WHERE patient_id = $1', [userId]
    );
    const orderIds = orderRes.rows.map((r) => r.id);

    // Cases that are PAID and still running when the patient erases. PDPL does
    // not let us refuse erasure to finish a job, so this does not block — but
    // the doctor is about to find a case with no images and no message thread,
    // and an SLA clock still ticking that they will be recorded as breaching.
    // Somebody has to know. Reported back to the caller, which notifies.
    const inFlight = orderRes.rows.filter((r) => {
      if (!r.paid_at) return false;
      const st = String(r.status || '').toLowerCase();
      return st !== 'completed' && st !== 'cancelled' && st !== 'refunded';
    }).map((r) => ({ id: r.id, reference: r.reference_id, status: r.status, doctorId: r.doctor_id, deadlineAt: r.deadline_at }));

    const convRes = await client.query(
      'SELECT id FROM conversations WHERE patient_id = $1', [userId]
    );
    const convIds = convRes.rows.map((r) => r.id);

    // ── Collect storage keys BEFORE anything is deleted ──────────────────
    // Once these rows are gone the objects are unreachable forever. This is
    // the single ordering constraint that the previous implementation got
    // backwards.
    const storageKeys = new Set();
    // Absolute URLs in these columns are NOT third-party assets we can ignore.
    // order_files.url and order_additional_files.file_url still hold legacy
    // Uploadcare CDN links from before the R2 cutover, and those objects are
    // publicly addressable. deleteFile() cannot remove them — that needs
    // Uploadcare's own API and the uploadcare_uuid — so they are collected
    // separately and logged loudly rather than dropped on the floor. Zero rows
    // match today; the point is that the day one does, it is not silent.
    const externalUrls = new Set();
    const uploadcareUuids = new Set();
    const addKey = (v) => {
      if (!v) return;
      const s = String(v).trim();
      if (!s || s.startsWith('data:')) return;
      if (/^https?:\/\//i.test(s)) { externalUrls.add(s); return; }
      storageKeys.add(s);
    };

    if (orderIds.length) {
      const q = async (sql) => (await client.query(sql, [orderIds])).rows;
      for (const r of await q('SELECT url, uploadcare_uuid FROM order_files WHERE order_id = ANY($1::text[])')) {
        addKey(r.url);
        if (r.uploadcare_uuid) uploadcareUuids.add(String(r.uploadcare_uuid).trim());
      }
      for (const r of await q('SELECT file_key, file_url FROM order_additional_files WHERE order_id = ANY($1::text[])')) { addKey(r.file_key); addKey(r.file_url); }
      for (const r of await q('SELECT pdf_url FROM prescriptions WHERE order_id = ANY($1::text[])')) addKey(r.pdf_url);
      // case_files.storage_path and report_exports.file_path are R2 keys too.
      // report_exports.file_path is the finished clinical PDF, which prints the
      // patient's name — the single most sensitive object we hold for them.
      for (const r of await q('SELECT storage_path FROM case_files WHERE case_id = ANY($1::text[])')) addKey(r.storage_path);
      for (const r of await q('SELECT file_path FROM report_exports WHERE case_id = ANY($1::text[])')) addKey(r.file_path);
      // orders.report_url likewise holds a bare key (report-generator.js
      // returns uploadFile()'s key and routes/reports.js writes it verbatim).
      // It is NULL for every row today only because no report has been
      // generated yet; it will not stay that way after launch.
      for (const r of await q('SELECT report_url FROM orders WHERE id = ANY($1::text[])')) addKey(r.report_url);
    }
    for (const r of (await client.query('SELECT file_url FROM medical_records WHERE patient_id = $1', [userId])).rows) addKey(r.file_url);
    for (const r of (await client.query('SELECT pdf_url FROM prescriptions WHERE patient_id = $1', [userId])).rows) addKey(r.pdf_url);
    if (convIds.length) {
      for (const r of (await client.query('SELECT file_key, file_url FROM messages WHERE conversation_id = ANY($1::text[])', [convIds])).rows) { addKey(r.file_key); addKey(r.file_url); }
    }
    for (const r of (await client.query('SELECT profile_photo_url FROM users WHERE id = $1', [userId])).rows) addKey(r.profile_photo_url);

    const counts = {};
    const bump = (k, n) => { counts[k] = (counts[k] || 0) + n; };

    // ── Conversations: delete BOTH sides ─────────────────────────────────
    // The old code deleted messages WHERE sender_id = the patient, which left
    // the specialist's replies behind — the clinically sensitive half — inside
    // a conversation nobody could open.
    if (convIds.length) {
      bump('messages', (await client.query('DELETE FROM messages WHERE conversation_id = ANY($1::text[])', [convIds])).rowCount);
    }
    bump('messages', (await client.query('DELETE FROM messages WHERE sender_id = $1', [userId])).rowCount);
    // chat_reports outlives the conversation it points at, and `details` is
    // free text the patient wrote. Keyed on conversation_id and reported_by,
    // neither of which any patient_id sweep would have found.
    if (convIds.length) {
      bump('chat_reports', (await client.query('DELETE FROM chat_reports WHERE conversation_id = ANY($1::text[])', [convIds])).rowCount);
    }
    bump('chat_reports', (await client.query('DELETE FROM chat_reports WHERE reported_by = $1', [userId])).rowCount);
    bump('conversations', (await client.query('DELETE FROM conversations WHERE patient_id = $1', [userId])).rowCount);

    if (orderIds.length) {
      for (const [table, column] of ORDER_CHILD_DELETES) {
        bump(table, (await client.query(
          `DELETE FROM ${table} WHERE ${column} = ANY($1::text[])`, [orderIds]
        )).rowCount);
      }
    }
    for (const [table, column] of USER_CHILD_DELETES) {
      bump(table, (await client.query(
        `DELETE FROM ${table} WHERE ${column} = $1`, [userId]
      )).rowCount);
    }
    // Only the rows where THIS user was the one referred. A row where they
    // were the referrer belongs to a different patient — it records that
    // someone else redeemed a code and got a discount on their own payment,
    // and orders.referral_code keeps a text copy of that code on that other
    // person's order. Deleting it would leave a discount on a stranger's
    // invoice with nothing explaining it, which is the same class of financial
    // record the anonymise-don't-delete design exists to protect. The dangling
    // referrer_id is harmless: there are no foreign keys onto users.id, and
    // the id it points at is now a tombstone.
    bump('referral_redemptions', (await client.query(
      'DELETE FROM referral_redemptions WHERE referred_id = $1', [userId]
    )).rowCount);

    // ── Tables that may or may not exist in a given environment ──────────
    // notify_whatsapp_migration_062_backup holds (user_id, original_value) for
    // every patient whose WhatsApp preference migration 062 flipped. Migration
    // 062 is recorded as applied in production but the table has since been
    // dropped by hand, so it is absent there — and present in any environment
    // built from the migrations, including a restore from backup.
    //
    // The existence check is an explicit to_regclass lookup, NOT a try/catch.
    // The old handler wrapped every statement in "table might not exist" and
    // that is precisely how it came to swallow nine real failures while
    // reporting success. If a DELETE here throws, the transaction must roll
    // back and the caller must hear about it.
    for (const optional of OPTIONAL_USER_TABLES) {
      const present = await client.query('SELECT to_regclass($1) AS oid', ['public.' + optional.table]);
      if (!present.rows[0] || present.rows[0].oid === null) continue;
      bump(optional.table, (await client.query(
        `DELETE FROM ${optional.table} WHERE ${optional.column} = $1`, [userId]
      )).rowCount);
    }

    // ── Orders: anonymise, do not delete ─────────────────────────────────
    if (orderIds.length) {
      const blanks = ORDER_FIELDS_TO_BLANK.map((c) => `${c} = NULL`).join(', ');
      bump('orders_anonymised', (await client.query(
        `UPDATE orders SET patient_id = NULL, ${blanks} WHERE id = ANY($1::text[])`,
        [orderIds]
      )).rowCount);
    }

    bump('users', (await client.query('DELETE FROM users WHERE id = $1', [userId])).rowCount);

    // Tombstone, in the same transaction. src/middleware.js builds req.user
    // from the JWT with no database lookup, so without this a session on a
    // second device stays valid for up to seven days after the account is
    // gone — and can still POST, creating rows keyed to a user that no longer
    // exists. See migration 096 and the check in requireRole().
    await client.query(
      `INSERT INTO deleted_users (user_id, role, source) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, role, 'self_service']
    );

    return {
      orderIds,
      inFlight,
      storageKeys: Array.from(storageKeys),
      externalUrls: Array.from(externalUrls),
      uploadcareUuids: Array.from(uploadcareUuids),
      counts,
    };
  });
}

/**
 * Best-effort R2 cleanup, run AFTER the transaction has committed.
 * Never throws: the erasure is already durable and must not be reported as
 * failed because a storage call timed out. Failures are logged with the key
 * so they can be swept by hand — the database no longer knows about them.
 */
async function purgeStorageKeys(keys, meta, extra) {
  // Anything we cannot delete ourselves is shouted about here rather than
  // dropped. Both lists are empty against today's data; they exist so that the
  // first row that is not is visible in the logs instead of invisible forever.
  if (extra && extra.externalUrls && extra.externalUrls.length) {
    logMajor('[account-deletion] ' + extra.externalUrls.length + ' file(s) are absolute URLs (legacy Uploadcare) and were NOT deleted — they need Uploadcare\'s API, not R2', {
      urls: extra.externalUrls, uploadcareUuids: (extra.uploadcareUuids || []), meta: meta
    });
  }
  const failed = [];
  if (!keys || !keys.length) return { deleted: 0, failed: failed };
  let deleteFile;
  try {
    ({ deleteFile } = require('../storage'));
  } catch (err) {
    logMajor('[account-deletion] storage module unavailable; ' + keys.length + ' object(s) left in R2', { keys: keys, meta: meta });
    return { deleted: 0, failed: keys.slice() };
  }
  let deleted = 0;
  for (const key of keys) {
    try {
      await deleteFile(key);
      deleted++;
    } catch (err) {
      failed.push(key);
    }
  }
  if (failed.length) {
    logMajor('[account-deletion] ' + failed.length + ' R2 object(s) could not be deleted and are now unreferenced', {
      keys: failed, meta: meta
    });
  }
  return { deleted: deleted, failed: failed };
}

module.exports = { deleteAccount, purgeStorageKeys, AccountDeletionError, ORDER_FIELDS_TO_BLANK };
