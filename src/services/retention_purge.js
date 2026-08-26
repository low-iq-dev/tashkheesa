// src/services/retention_purge.js
//
// The retention rules privacy.ejs actually states, implemented as one
// auditable pass. There are two of them and they are not the same rule.
//
//   RULE A — abandoned drafts. An order with deleted_at set was started and
//   never paid for; migration 022 closes them automatically after 48 hours.
//   Nothing financial ever attached to them, so after a grace period they can
//   go completely, files included.
//
//   RULE B — completed cases past retention. privacy.ejs §3: "Your medical
//   data is retained for the duration of your case plus 12 months after case
//   completion." That is a promise about MEDICAL data. The same policy, §1,
//   promises the opposite for money: "We retain only transaction references
//   for accounting and refund purposes." So a case past retention is not
//   deleted — its medical payload is erased and its financial skeleton stays,
//   exactly as an account deletion does.
//
// WHY THIS SHIPS INERT. Run against production on 2026-08-26 the two rules
// select 21 rows and 0 rows respectively. Rule B cannot match anything before
// roughly February 2027: the oldest order in the database was created
// 2026-04-17 and the oldest user 2026-02-22, so no case can be twelve months
// past completion yet. A job that deletes nothing for six months, against a
// schema with no foreign keys onto users.id and a restore path that has never
// been rehearsed, is not a job that should be switched on in launch week. It
// is written, it is reviewable, and it refuses to write until someone sets
// RETENTION_PURGE_ENABLED=true and passes --apply. Both. Deliberately.
//
// Note also what "eligible" means in the policy: "After that period, data is
// ELIGIBLE for deletion." That is a retention floor we promised, not a
// deletion deadline we owe. Nothing is out of compliance while this is off.

const { withTransaction, queryAll } = require('../pg');

const ABANDONED_DRAFT_GRACE_DAYS = 90;
const COMPLETED_CASE_RETENTION_MONTHS = 12;

// Same list the erasure path blanks, for the same reason.
const { ORDER_FIELDS_TO_BLANK } = require('./account_deletion');

// Children of an abandoned draft. It never had a payment, so unlike the
// erasure path there is no financial skeleton to preserve and the order row
// itself goes too.
const DRAFT_CHILD_TABLES = [
  ['file_ai_checks', 'order_id'],
  ['order_files', 'order_id'],
  ['order_additional_files', 'order_id'],
  ['order_timeline', 'order_id'],
  ['order_events', 'order_id'],
  ['payment_events', 'order_id'],
  ['notifications', 'order_id'],
  ['referral_redemptions', 'order_id'],
  ['reviews', 'order_id'],
  ['prescriptions', 'order_id'],
  ['medical_records', 'order_id'],
];

// Medical children of a completed case past retention. Deliberately shorter:
// order_timeline, order_events and payment_events are the audit trail of a
// transaction we are keeping, so they stay.
const RETIRED_CASE_MEDICAL_TABLES = [
  ['file_ai_checks', 'order_id'],
  ['order_files', 'order_id'],
  ['order_additional_files', 'order_id'],
  ['medical_records', 'order_id'],
  ['prescriptions', 'order_id'],
];

function isStorageKey(v) {
  if (!v) return false;
  const s = String(v).trim();
  return !!s && !/^https?:\/\//i.test(s) && !s.startsWith('data:');
}

/** What the two rules select right now. Read-only; safe to call anywhere. */
async function findCandidates() {
  const abandoned = await queryAll(
    `SELECT id, reference_id, deleted_at, paid_at, payment_status
       FROM orders
      WHERE deleted_at IS NOT NULL
        AND deleted_at < NOW() - ($1 || ' days')::interval
        AND paid_at IS NULL
        AND COALESCE(payment_status, 'unpaid') = 'unpaid'
      ORDER BY deleted_at`,
    [String(ABANDONED_DRAFT_GRACE_DAYS)]
  );
  const retired = await queryAll(
    `SELECT id, reference_id, completed_at
       FROM orders
      WHERE deleted_at IS NULL
        AND completed_at IS NOT NULL
        AND completed_at < NOW() - ($1 || ' months')::interval
      ORDER BY completed_at`,
    [String(COMPLETED_CASE_RETENTION_MONTHS)]
  );
  return { abandoned, retired };
}

/**
 * Execute both rules in ONE transaction.
 *
 * Refuses unless BOTH the env flag and the explicit apply argument are set.
 * The old scripts/purge_old_deleted_orders.js needed only `--apply`, and a
 * single mistyped shell line would have hard-deleted 21 orders with no
 * transaction, best-effort child deletes that swallowed their own errors, and
 * a DELETE FROM orders that CASCADEs into refunds and order_addons.
 *
 * @returns {Promise<{applied: boolean, counts: object, storageKeys: string[]}>}
 */
async function runRetentionPurge({ apply = false } = {}) {
  const enabled = String(process.env.RETENTION_PURGE_ENABLED || '').trim().toLowerCase() === 'true';
  const candidates = await findCandidates();

  if (!apply || !enabled) {
    return {
      applied: false,
      reason: !apply ? 'dry-run (pass apply:true)' : 'RETENTION_PURGE_ENABLED is not true',
      counts: {
        abandoned_drafts: candidates.abandoned.length,
        retired_cases: candidates.retired.length,
      },
      candidates: candidates,
      storageKeys: [],
    };
  }

  const draftIds = candidates.abandoned.map((r) => r.id);
  const retiredIds = candidates.retired.map((r) => r.id);

  const result = await withTransaction(async (client) => {
    const counts = {};
    const bump = (k, n) => { counts[k] = (counts[k] || 0) + n; };
    const storageKeys = new Set();
    const addKey = (v) => { if (isStorageKey(v)) storageKeys.add(String(v).trim()); };

    const allIds = draftIds.concat(retiredIds);

    // Keys first. After the DELETEs the objects are unreachable.
    if (allIds.length) {
      for (const r of (await client.query('SELECT url FROM order_files WHERE order_id = ANY($1::text[])', [allIds])).rows) addKey(r.url);
      for (const r of (await client.query('SELECT file_key, file_url FROM order_additional_files WHERE order_id = ANY($1::text[])', [allIds])).rows) { addKey(r.file_key); addKey(r.file_url); }
      for (const r of (await client.query('SELECT pdf_url FROM prescriptions WHERE order_id = ANY($1::text[])', [allIds])).rows) addKey(r.pdf_url);
      for (const r of (await client.query('SELECT file_url FROM medical_records WHERE order_id = ANY($1::text[])', [allIds])).rows) addKey(r.file_url);
    }

    // ── Rule A: abandoned drafts go completely ───────────────────────────
    if (draftIds.length) {
      // Re-assert the safety predicate INSIDE the transaction. The candidate
      // list was read outside it; an order could have been paid in between,
      // and a paid order must never be hard-deleted.
      const stillSafe = (await client.query(
        `SELECT id FROM orders
          WHERE id = ANY($1::text[]) AND paid_at IS NULL
            AND COALESCE(payment_status,'unpaid') = 'unpaid'
            AND deleted_at IS NOT NULL
            FOR UPDATE`,
        [draftIds]
      )).rows.map((r) => r.id);
      bump('drafts_skipped_now_paid', draftIds.length - stillSafe.length);

      if (stillSafe.length) {
        const convs = (await client.query('SELECT id FROM conversations WHERE order_id = ANY($1::text[])', [stillSafe])).rows.map((r) => r.id);
        if (convs.length) {
          bump('messages', (await client.query('DELETE FROM messages WHERE conversation_id = ANY($1::text[])', [convs])).rowCount);
          bump('conversations', (await client.query('DELETE FROM conversations WHERE order_id = ANY($1::text[])', [stillSafe])).rowCount);
        }
        for (const [table, column] of DRAFT_CHILD_TABLES) {
          bump(table, (await client.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::text[])`, [stillSafe])).rowCount);
        }
        bump('orders_deleted', (await client.query('DELETE FROM orders WHERE id = ANY($1::text[])', [stillSafe])).rowCount);
      }
    }

    // ── Rule B: completed cases lose their medical payload only ──────────
    if (retiredIds.length) {
      const convs = (await client.query('SELECT id FROM conversations WHERE order_id = ANY($1::text[])', [retiredIds])).rows.map((r) => r.id);
      if (convs.length) {
        bump('messages', (await client.query('DELETE FROM messages WHERE conversation_id = ANY($1::text[])', [convs])).rowCount);
        bump('conversations', (await client.query('DELETE FROM conversations WHERE order_id = ANY($1::text[])', [retiredIds])).rowCount);
      }
      for (const [table, column] of RETIRED_CASE_MEDICAL_TABLES) {
        bump(table, (await client.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::text[])`, [retiredIds])).rowCount);
      }
      const blanks = ORDER_FIELDS_TO_BLANK.map((c) => `${c} = NULL`).join(', ');
      bump('orders_medically_blanked', (await client.query(
        `UPDATE orders SET ${blanks} WHERE id = ANY($1::text[])`, [retiredIds]
      )).rowCount);
    }

    return { counts, storageKeys: Array.from(storageKeys) };
  });

  return { applied: true, counts: result.counts, storageKeys: result.storageKeys, candidates: candidates };
}

module.exports = {
  findCandidates,
  runRetentionPurge,
  ABANDONED_DRAFT_GRACE_DAYS,
  COMPLETED_CASE_RETENTION_MONTHS,
};
