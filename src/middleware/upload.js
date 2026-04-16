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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max per file (matches order_flow.js today)
  fileFilter: function(req, file, cb) {
    const original = file.originalname || '';
    const ext = path.extname(original).toLowerCase();

    if (DANGEROUS_EXTS.has(ext)) {
      return cb(new Error('File type not allowed: ' + original));
    }

    if (!ALLOWED_EXTS.has(ext)) {
      return cb(new Error('File type ' + (ext || '(unknown)') + ' not allowed'));
    }

    if (ALLOWED_MIMES.has(file.mimetype)) {
      return cb(null, true);
    }

    // Application/octet-stream is acceptable for browser-misreported known formats
    if (file.mimetype === 'application/octet-stream' && OCTET_STREAM_TOLERANT_EXTS.has(ext)) {
      return cb(null, true);
    }

    return cb(new Error('File MIME type not allowed: ' + file.mimetype));
  },
});

module.exports = upload;
