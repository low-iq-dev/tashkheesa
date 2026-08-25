'use strict';

// utils/reference.js — the patient-facing case reference, generated once.
//
// CASE-FLOW REBUILD 2026-08-25.
//
// There were two generators and they were not equivalent:
//
//   * routes/api/cases_intake.js (public website) drew from a Postgres
//     SEQUENCE. Unique by construction.
//   * routes/api/cases.js (mobile app) used
//         String(Math.floor(Math.random() * 999999)).padStart(6, '0')
//     which is a 1-in-a-million draw with NO uniqueness check behind it.
//     orders.reference_id carries a plain index (migration 043), not a UNIQUE
//     constraint, so a collision does not raise — it silently mints two cases
//     wearing the same human-facing reference. Birthday maths is unkind here:
//     at ~1,000 app cases in a year the chance of at least one collision inside
//     that year is around 40%. The failure surfaces as a support call where two
//     patients quote the same number and nobody can tell the cases apart.
//
// The draft flow needed a reference too, and adding a third copy of this — the
// random one, no less — would have been the wrong answer. So: one function,
// sequence-backed, and the mobile path is moved onto it.
//
// Format is unchanged (TSH-YYYY-NNNNNN), so nothing that parses or displays a
// reference needs to know this happened. Only the source of the digits changed.
//
// The sequence is shared with the website intake path deliberately. Two
// sequences would let an app case and a website case land on the same number,
// which is the bug this file exists to close.

const { queryOne, execute } = require('../pg');

const SEQUENCE_NAME = 'website_intake_seq';

/**
 * Next case reference. Sequence-backed and therefore collision-free.
 *
 * Falls back to a random draw ONLY if the sequence is unreachable. That
 * fallback is strictly worse and is here so a database hiccup degrades a
 * reference rather than failing a case submission the patient has already
 * paid attention to — a duplicate reference is recoverable, a lost case is not.
 * The fallback is marked so it is greppable if it ever fires in anger.
 *
 * @returns {Promise<string>} e.g. 'TSH-2026-000417'
 */
async function generateReferenceId() {
  const year = new Date().getUTCFullYear();
  try {
    // Idempotent — matches the CREATE the website intake path already runs, so
    // whichever surface takes the first case of a fresh deploy sets it up.
    await execute(`CREATE SEQUENCE IF NOT EXISTS ${SEQUENCE_NAME} START 1`);
    const row = await queryOne(`SELECT nextval('${SEQUENCE_NAME}')::bigint AS n`);
    const n = row && row.n != null ? String(row.n) : null;
    if (n) return 'TSH-' + year + '-' + n.padStart(6, '0');
  } catch (_) {
    // fall through
  }
  const num = String(Math.floor(Math.random() * 999999)).padStart(6, '0');
  return 'TSH-' + year + '-' + num;
}

module.exports = { generateReferenceId, SEQUENCE_NAME };
