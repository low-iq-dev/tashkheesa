'use strict';

// Decrypts a doctor's national ID from users.national_id_encrypted, which is
// written at signup by src/routes/auth.js using pgcrypto's pgp_sym_encrypt()
// with the symmetric key in NATIONAL_ID_ENCRYPTION_KEY. This module is the
// only intended consumer for reading those rows back — admin review flows
// must go through getDecryptedNationalId() so the access path stays
// auditable in one place.

const { queryOne } = require('../pg');

/**
 * Decrypt and return the doctor's national ID.
 *
 * @param {string} userId - The user's id (UUID/text PK).
 * @returns {Promise<string|null>} Decrypted national-ID string, or null when
 *   no such user row exists or the user has no encrypted ID stored.
 * @throws {Error} If NATIONAL_ID_ENCRYPTION_KEY is not configured, if userId
 *   is missing/invalid, if the user exists but is not a doctor, or if the
 *   underlying pg query fails (errors are wrapped with context).
 */
async function getDecryptedNationalId(userId) {
  const key = String(process.env.NATIONAL_ID_ENCRYPTION_KEY || '').trim();
  if (!key) {
    throw new Error('NATIONAL_ID_ENCRYPTION_KEY env var is not set');
  }
  if (!userId || typeof userId !== 'string') {
    throw new Error('getDecryptedNationalId: userId is required');
  }

  // Lookup role first so "user exists but is not a doctor" can throw
  // distinctly from "no such user" (which returns null per spec).
  let roleRow;
  try {
    roleRow = await queryOne('SELECT role FROM users WHERE id = $1', [userId]);
  } catch (err) {
    throw new Error(
      'Failed to look up user role for national-ID decryption (userId=' +
        userId + '): ' + err.message
    );
  }

  if (!roleRow) return null;
  if (roleRow.role !== 'doctor') {
    throw new Error(
      'User ' + userId + ' is not a doctor (role=' + String(roleRow.role) + ')'
    );
  }

  let row;
  try {
    row = await queryOne(
      `SELECT pgp_sym_decrypt(national_id_encrypted, $1) AS nid
         FROM users
        WHERE id = $2 AND role = 'doctor'`,
      [key, userId]
    );
  } catch (err) {
    throw new Error(
      'Failed to decrypt national_id for doctor ' + userId + ': ' + err.message
    );
  }

  if (!row) return null;
  if (row.nid === null || row.nid === undefined) return null;
  return String(row.nid);
}

module.exports = { getDecryptedNationalId };
