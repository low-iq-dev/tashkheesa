// src/middleware/upload.js
// Multer with memory storage — files never touch disk; route handlers push the buffer to R2.
//
// Allowed file types preserve the FULL UNION of what src/routes/order_flow.js and
// src/routes/prescriptions.js accept today. Do not narrow without an explicit decision —
// patients today can upload all of these formats.

const multer = require('multer');
const path = require('path');

// Union of extensions accepted today across order_flow.js and prescriptions.js
const ALLOWED_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.tiff',
  '.pdf', '.doc', '.docx',
  '.dcm',
  '.heic',
]);

// Explicit MIME allowlist for known-good types
const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/heic',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/dicom',
]);

// Browsers often misreport these as application/octet-stream — accept that MIME for them.
// (DICOM files in particular almost always come through as octet-stream from web uploads.)
const OCTET_STREAM_TOLERANT_EXTS = new Set(['.dcm', '.doc', '.docx', '.pdf', '.heic']);

// Hard-block dangerous extensions regardless of declared MIME
const DANGEROUS_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.vbs', '.js',
  '.msi', '.com', '.scr', '.pif',
  '.php', '.py', '.rb', '.pl',
]);

// ── Extensionless DICOM (U-2, 2026-09-23) ──────────────────────────────────
//
// CD/PACS exports routinely name DICOM files with no extension at all
// ('IM_0001', 'DICOMDIR') or with a bare number ('1.2.840.113619.2.55.3', whose
// "extension" is '.3'). The extension check below rejected every one of them,
// AFTER the phone had uploaded the whole file, with a raw English error.
//
// multer's fileFilter runs before the bytes arrive, so it cannot look at them.
// The mobile upload instance therefore lets such a name through PROVISIONALLY
// (marked on the file object), and the route calls verifyDicomCandidate()
// once the buffer exists: accepted only when bytes 128..131 are 'DICM' — the
// DICOM Part 10 preamble magic — and rejected otherwise. The shared default
// instance used by the web routes is unchanged.
const DICOM_CANDIDATE_MIMES = new Set(['', 'application/octet-stream', 'application/dicom']);

function isDicomCandidateName(ext) {
  return ext === '' || /^\.\d+$/.test(ext);
}

function isDicomBuffer(buf) {
  return !!(buf && buf.length >= 132 && buf.toString('latin1', 128, 132) === 'DICM');
}

function checkFile(file, opts) {
  const original = file.originalname || '';
  const ext = path.extname(original).toLowerCase();

  if (DANGEROUS_EXTS.has(ext)) {
    return new Error('File type not allowed: ' + original);
  }

  if (!ALLOWED_EXTS.has(ext)) {
    if (opts && opts.allowDicomSniff && isDicomCandidateName(ext)
        && DICOM_CANDIDATE_MIMES.has(String(file.mimetype || '').toLowerCase())) {
      file.dicomSniffRequired = true; // verifyDicomCandidate() must pass after the read
      return null;
    }
    return new Error('File type ' + (ext || '(unknown)') + ' not allowed');
  }

  if (ALLOWED_MIMES.has(file.mimetype)) {
    return null;
  }

  // Application/octet-stream is acceptable for browser-misreported known formats
  if (file.mimetype === 'application/octet-stream' && OCTET_STREAM_TOLERANT_EXTS.has(ext)) {
    return null;
  }

  return new Error('File MIME type not allowed: ' + file.mimetype);
}

/**
 * Second half of the extensionless-DICOM gate, run by the route after multer
 * has buffered the file. Returns null when the file may proceed (it was never
 * a sniff candidate, or its bytes carry the DICM magic), else an Error.
 * On success the file is re-typed as application/dicom.
 */
function verifyDicomCandidate(file) {
  if (!file || !file.dicomSniffRequired) return null;
  if (!isDicomBuffer(file.buffer)) {
    return new Error('File type ' + (path.extname(file.originalname || '') || '(unknown)') + ' not allowed');
  }
  file.mimetype = 'application/dicom';
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max per file (matches order_flow.js today)
  fileFilter: function(req, file, cb) {
    const err = checkFile(file);
    return err ? cb(err) : cb(null, true);
  },
});

// The mobile API's instance (routes/api/files.js): same rules, plus the
// provisional extensionless-DICOM pass that verifyDicomCandidate() completes.
const uploadWithDicomSniff = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    const err = checkFile(file, { allowDicomSniff: true });
    return err ? cb(err) : cb(null, true);
  },
});

module.exports = upload;
module.exports.uploadWithDicomSniff = uploadWithDicomSniff;
module.exports.verifyDicomCandidate = verifyDicomCandidate;
module.exports.isDicomBuffer = isDicomBuffer;
