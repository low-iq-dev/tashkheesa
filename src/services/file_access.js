'use strict';

// src/services/file_access.js
//
// THE lookup + authorisation for a case/message file id, shared by
//   * GET /files/:fileId                    (src/server.js — 302 to the file)
//   * GET /api/annotations/:imageId/source  (src/routes/annotations.js —
//                                            streams the bytes same-origin)
//
// Launch eve 2026-09-24 (T8). The annotator needs the original image bytes
// from our own origin: /files 302s to an R2 signed URL, and fabric loads it
// with crossOrigin:'anonymous', so without a bucket CORS rule the image never
// appears (and without crossOrigin the canvas is tainted and save fails). The
// new route must apply EXACTLY the authorisation /files applies, so the rule
// was moved here verbatim rather than copied — two copies of a PHI gate is how
// they drift.
//
// Theme 13 Sub-issue C2.E — the reader walks THREE tables in order:
//   1. order_files                — canonical case files
//   2. messages                   — message-attached files
//   3. order_additional_files     — patient additional uploads
// Per-source auth (THEME_13_C2_FIX_PLAN.md §8 Q4):
//   order_files / order_additional_files: admin/super always; patient if
//     order.patient_id === user; doctor if assigned + accepted_at IS NOT NULL.
//   messages: admin/super always; patient or doctor if member of the
//     conversation containing the message (no accepted_at gate — the
//     conversation can't exist before assignment, so the gate would never
//     reject a legitimate doctor).
//
// Response-code policy (§8 Q-B): 404 only for "id exists in none of the three
// tables"; 403 for every auth failure AND every missing parent row, so a caller
// cannot probe row existence.

async function _defaultSafeGet(sql, params, fallback) {
  try {
    const { queryOne } = require('../pg');
    return await queryOne(sql, params);
  } catch (_) {
    return fallback;
  }
}

/**
 * @param {string} fileId
 * @param {{ id?: string, role?: string }|null} user
 * @param {{ safeGet?: Function }} [deps] — safeGet(sql, params, fallback)
 * @returns {Promise<{
 *   status: 200|403|404,
 *   source: (null|'order_files'|'messages'|'order_additional_files'),
 *   fileUrl: string, fileKey: string, fileLabel: string
 * }>}
 */
async function resolveFileAccess(fileId, user, deps) {
  const safeGet = (deps && deps.safeGet) || _defaultSafeGet;
  const out = { status: 404, source: null, fileUrl: '', fileKey: '', fileLabel: '' };

  let order = null;        // order_files + order_additional_files
  let conversation = null; // messages

  // 1. order_files (canonical — highest traffic, fastest path)
  const ofRow = await safeGet('SELECT id, order_id, url, label FROM order_files WHERE id = $1 LIMIT 1', [fileId], null);
  if (ofRow) {
    out.source = 'order_files';
    out.fileUrl = String(ofRow.url || '').trim();
    out.fileLabel = ofRow.label || '';
    order = await safeGet('SELECT id, patient_id, doctor_id, accepted_at, status FROM orders_active WHERE id = $1 LIMIT 1', [ofRow.order_id], null);
  }

  // 2. messages (post-C2.A has file_key column; pre-C2.A only file_url)
  if (!out.source) {
    const msgRow = await safeGet(
      'SELECT id, conversation_id, file_url, file_key, file_name FROM messages ' +
      'WHERE id = $1 AND (file_url IS NOT NULL OR file_key IS NOT NULL) LIMIT 1',
      [fileId], null
    );
    if (msgRow) {
      out.source = 'messages';
      out.fileUrl = String(msgRow.file_url || '').trim();
      out.fileKey = String(msgRow.file_key || '').trim();
      out.fileLabel = msgRow.file_name || '';
      conversation = await safeGet('SELECT id, patient_id, doctor_id FROM conversations WHERE id = $1 LIMIT 1', [msgRow.conversation_id], null);
    }
  }

  // 3. order_additional_files (post-C2.A has file_key column; pre-C2.A only file_url)
  if (!out.source) {
    const adfRow = await safeGet('SELECT id, order_id, file_url, file_key, label FROM order_additional_files WHERE id = $1 LIMIT 1', [fileId], null);
    if (adfRow) {
      out.source = 'order_additional_files';
      out.fileUrl = String(adfRow.file_url || '').trim();
      out.fileKey = String(adfRow.file_key || '').trim();
      out.fileLabel = adfRow.label || '';
      order = await safeGet('SELECT id, patient_id, doctor_id, accepted_at, status FROM orders_active WHERE id = $1 LIMIT 1', [adfRow.order_id], null);
    }
  }

  if (!out.source) return out; // 404

  const role = String((user && user.role) || '').toLowerCase();
  const userId = String((user && user.id) || '');
  let allowed = false;

  if (role === 'superadmin' || role === 'admin') {
    allowed = true;
  } else if (out.source === 'messages') {
    // INVARIANT: conversations cannot exist before the doctor's accepted_at is
    // set (enforced by case_lifecycle.js). If pre-acceptance messaging is ever
    // added, restore an accepted_at gate here for doctor access.
    if (conversation) {
      allowed = (userId === String(conversation.patient_id || '')) || (userId === String(conversation.doctor_id || ''));
    }
  } else if (order) {
    // order_files OR order_additional_files. Missing order row → 403.
    if (role === 'patient') {
      allowed = !!order.patient_id && String(order.patient_id) === userId;
    } else if (role === 'doctor') {
      const isAssigned = !!order.doctor_id && String(order.doctor_id) === userId;
      const isAccepted = !!order.accepted_at;
      allowed = isAssigned && isAccepted;
    }
  }

  out.status = allowed ? 200 : 403;
  return out;
}

// THE annotatable set (launch-eve follow-up, 2026-09-25). The annotator's
// byte route (routes/annotations.js) serves exactly these types and 415s the
// rest (HEIC, TIFF, DICOM, PDF…); the doctor case page shows the Annotate
// button for exactly these extensions. One list, so a button can never lead to
// a file the route refuses.
const ANNOTATABLE_MIME = Object.freeze(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);
const ANNOTATABLE_EXTENSIONS = Object.freeze(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);

/** True when a file NAME has an annotatable raster extension. */
function isAnnotatableName(name) {
  const m = /\.([a-z0-9]+)\s*$/i.exec(String(name || ''));
  return !!m && ANNOTATABLE_EXTENSIONS.indexOf(m[1].toLowerCase()) !== -1;
}

/** Sniff the common raster formats from magic bytes. '' when unknown. */
function mimeFromBytes(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
  if (buf.slice(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return '';
}

module.exports = { resolveFileAccess, mimeFromBytes, isAnnotatableName, ANNOTATABLE_MIME, ANNOTATABLE_EXTENSIONS };
