/**
 * Tashkheesa API v1 — Files (mobile direct-to-R2 upload)
 *
 * Theme 13 Sub-issue D — mobile-API equivalent of src/routes/patient_files.js.
 *
 * Mounted by src/routes/api_v1.js AFTER requireJWT + requireRole('patient'),
 * so this router never sees an unauthenticated request. CSRF doesn't apply on
 * /api/v1/* (csrf middleware exempts the prefix at src/middleware/csrf.js:80).
 *
 * Wire format:
 *   POST /api/v1/files
 *   Content-Type: multipart/form-data
 *   Field: file (single file per request)
 *   Returns: { ok: true, data: { key, filename, mimeType, size } }
 *         or { ok: false, error: '<reason>', code: '<CODE>' }
 *
 * The endpoint does NOT insert into order_files. It uploads the bytes to R2
 * under `orders/draft/<patientId>/<uuid>.<ext>` and returns the key. The
 * mobile client then sends `{ files: [{ fileId: <key>, filename, mimeType,
 * size }] }` to POST /api/v1/cases — the dual-mode handler in cases.js (also
 * shipped in Sub-issue D) accepts this alongside the legacy uploadcareUuid
 * shape. Orphan drafts are swept by an R2 lifecycle rule on orders/draft/
 * (7-day expiry, R2-side config — see THEME_13_R2_MIGRATION_FIX_PLAN.md §8 Q5).
 *
 * Rate limit: the parent router (api_v1.js) applies apiLimiter (100/15min/IP)
 * to every authenticated route. Per-user limit is not added here — mobile NAT
 * traffic patterns make per-IP the right cap; revisit if abuse surfaces.
 */

const express = require('express');
const upload = require('../../middleware/upload');
const { uploadFile } = require('../../storage');
const { logErrorToDb } = require('../../logger');

const router = express.Router();

router.post('/', function (req, res) {
  // Wrap multer manually so its rejection becomes a typed JSON 400 instead of
  // the default 500. Mirrors src/routes/patient_files.js (Sub-issue A) and
  // src/routes/doctor.js photo upload (the canonical pattern in this codebase).
  upload.single('file')(req, res, async function (uploadErr) {
    if (uploadErr) {
      // THEME8-LINT-EXEMPT-HELPER: multer error callback parameter, not a
      // try/catch. uploadErr here is user-input validation failure (wrong
      // mime, file too large, etc.) — typed JSON response is the correct
      // surface, not /ops/errors.
      console.warn('[api-files] multer error for user ' + req.user.id + ':', uploadErr.message);
      return res.fail(uploadErr.message || 'Upload rejected', 400, 'UPLOAD_REJECTED');
    }
    if (!req.file || !req.file.buffer) {
      return res.fail('No file provided', 400, 'NO_FILE');
    }

    const folder = 'orders/draft/' + req.user.id;
    try {
      const key = await uploadFile({
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        folder: folder
      });
      return res.ok({
        key: key,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size
      });
    } catch (err) {
      logErrorToDb(err, {
        context: 'api.file_upload',
        userId: req.user && req.user.id,
        url: req.originalUrl,
        method: req.method,
        category: 'patient_upload'
      });
      console.error('[api-files] R2 upload failed for user ' + req.user.id + ':', err && err.message ? err.message : err);
      return res.fail('Upload failed. Please try again.', 500, 'UPLOAD_FAILED');
    }
  });
});

module.exports = router;
