// src/routes/patient_files.js
//
// Theme 13 Sub-issue A — patient direct-to-R2 upload endpoint.
//
// Replaces the Uploadcare 3.x widget on src/views/patient_new_case.ejs and
// src/views/patient_order.ejs. The widget rewrite (Sub-issues B + C) lands
// in later phases; this endpoint is dormant until UPLOAD_R2_DIRECT_ENABLED
// is set to 'true' in env. See server.js mount block.
//
// Wire format
//   POST /portal/patient/files
//   Content-Type: multipart/form-data
//   Field: file (single file per request — wizard widget is single-file)
//   Auth: requirePatient (cookie session) + CSRF (mounted globally)
//   Returns 200 { ok: true,  file: { key, filename, mimeType, size } }
//        or 400 { ok: false, error: '<reason>' }
//        or 401 { ok: false, error: 'Authentication required' }
//        or 403 { ok: false, error: 'Forbidden' }
//        or 429 { ok: false, error: '<rate-limit message>' }
//        or 500 { ok: false, error: 'Upload failed. Please try again.' }
//
// The endpoint does NOT insert into order_files. It uploads bytes to R2
// under `orders/draft/<patient-id>/<uuid>.<ext>` and returns the key. The
// wizard then posts the key as a hidden field on case-create; the case-create
// handler is the one that inserts the row. Orphans (uploads without a final
// case-create) are swept by an R2 lifecycle rule on the `orders/draft/`
// prefix (see docs/audits/THEME_13_R2_MIGRATION_FIX_PLAN.md §A and §8 Q5).

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const upload = require('../middleware/upload');
const { uploadFile } = require('../storage');
const { logErrorToDb } = require('../logger');

const router = express.Router();

// Per-user rate limit. Higher than /api/cases (10/15min/IP) because a typical
// medical case has 2–10 attachments and patients may retry on transient
// failures. Keyed by user id (cookie session) with IP fallback for the auth
// failure path. The limiter is mounted AFTER requirePatient so auth failures
// don't burn quota.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  validate: false,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: function(req) {
    return (req.user && req.user.id) ? 'patient_file:' + req.user.id : req.ip;
  },
  message: { ok: false, error: 'Too many upload attempts. Please wait 15 minutes and try again.' }
});

function requirePatient(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, error: 'Authentication required' });
  }
  if (String(req.user.role || '').toLowerCase() !== 'patient') {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  return next();
}

router.post('/portal/patient/files', requirePatient, uploadLimiter, function(req, res) {
  // Wrap multer manually so its rejection becomes a typed JSON 400 instead of
  // Express's default 500. Mirrors the doctor profile photo route's pattern
  // (src/routes/doctor.js:2873).
  upload.single('file')(req, res, async function(uploadErr) {
    if (uploadErr) {
      // THEME8-LINT-EXEMPT-HELPER: multer error callback parameter, not a
      // try/catch. uploadErr here is user-input validation failure (wrong
      // mime, file too large, etc.) — the typed JSON response is the correct
      // surface, not /ops/errors.
      console.warn('[patient-files] multer error for user ' + req.user.id + ':', uploadErr.message);
      return res.status(400).json({ ok: false, error: uploadErr.message || 'Upload rejected' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: 'No file provided' });
    }

    // Theme 13 Sub-issue C2.B — optional `folder` form field. Allowlisted
    // to a finite enum so the client can never path-traverse into another
    // patient's folder or write to an unintended R2 prefix. The patient-id
    // segment is always hardcoded to req.user.id (cookie session), never
    // taken from the request body. Default ('orders/draft') preserves the
    // Sub-issue A behaviour for existing callers (the wizard JS).
    //
    // Folder semantics + R2 lifecycle policy:
    //   - 'orders/draft'    → 7-day expiry on orphans (R2 lifecycle rule
    //                          per THEME_13_R2_MIGRATION_FIX_PLAN.md §8 Q5)
    //   - 'messages-attach' → no expiry; messages persist for the
    //                          conversation's lifetime
    const ALLOWED_FOLDERS = new Set(['orders/draft', 'messages-attach']);
    const requestedFolder = String((req.body && req.body.folder) || 'orders/draft').trim();
    if (!ALLOWED_FOLDERS.has(requestedFolder)) {
      return res.status(400).json({ ok: false, error: 'Invalid folder. Allowed: orders/draft, messages-attach' });
    }
    const folder = requestedFolder + '/' + req.user.id;
    try {
      const key = await uploadFile({
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        folder: folder
      });
      return res.json({
        ok: true,
        file: {
          key: key,
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
          size: req.file.size
        }
      });
    } catch (err) {
      logErrorToDb(err, {
        context: 'patient.file_upload',
        requestId: req.requestId,
        userId: req.user && req.user.id,
        url: req.originalUrl,
        method: req.method,
        category: 'patient_upload'
      });
      console.error('[patient-files] R2 upload failed for user ' + req.user.id + ':', err && err.message ? err.message : err);
      return res.status(500).json({ ok: false, error: 'Upload failed. Please try again.' });
    }
  });
});

module.exports = router;
