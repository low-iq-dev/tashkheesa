// src/storage.js
// Cloudflare R2 storage utility — single module for all upload/download logic.
// R2 is S3-compatible; we use the AWS SDK pointed at the R2 endpoint.

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const REQUIRED_ENV_VARS = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
const missingEnv = REQUIRED_ENV_VARS.filter(function(k) { return !process.env[k]; });

if (missingEnv.length > 0) {
  console.warn('[R2] Missing env vars: ' + missingEnv.join(', ') + ' — uploads/downloads will fail until set in Render.');
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;

/**
 * Upload a file buffer to R2.
 * @param {Object} opts
 * @param {Buffer} opts.buffer       - File contents (from multer.memoryStorage)
 * @param {string} opts.originalname - Original filename (for extension)
 * @param {string} opts.mimetype     - MIME type
 * @param {string} [opts.folder='uploads'] - R2 folder/prefix
 * @returns {Promise<string>} The R2 storage key (e.g. 'uploads/<uuid>.pdf')
 */
async function uploadFile({ buffer, originalname, mimetype, folder = 'uploads', filename = null }) {
  const ext = path.extname(originalname || '');
  // Callers can pass `filename` to force a deterministic key (e.g. the doctor
  // profile photo uses a `<timestamp>.<ext>` convention so the key itself
  // acts as a cache-bust token). Everyone else gets a UUID name.
  const key = filename
    ? folder + '/' + String(filename).replace(/^\/+/, '')
    : folder + '/' + uuidv4() + ext;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimetype,
  }));
  return key;
}

/**
 * Generate a signed URL for private file access.
 * @param {string} key - R2 storage key
 * @param {number} [expiresIn=3600] - Seconds until expiry (default 1 hour)
 * @param {Object} [options]
 * @param {string} [options.downloadName] - If set, browser will save the file with this name
 *                                           (passed via ResponseContentDisposition header).
 * @returns {Promise<string>} Signed URL
 */
async function getSignedDownloadUrl(key, expiresIn = 3600, options = {}) {
  const cmdOpts = { Bucket: BUCKET, Key: key };
  if (options && options.downloadName) {
    // Strip quotes/control chars from filename to keep header well-formed.
    const safeName = String(options.downloadName).replace(/["\r\n]/g, '');
    cmdOpts.ResponseContentDisposition = 'attachment; filename="' + safeName + '"';
  }
  return getSignedUrl(s3, new GetObjectCommand(cmdOpts), { expiresIn });
}

/**
 * Delete a file from R2.
 * @param {string} key - R2 storage key
 */
async function deleteFile(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { uploadFile, getSignedDownloadUrl, deleteFile };

// Verify R2 connection on startup. Logs but never throws — server boot must not depend on R2.
if (process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && BUCKET) {
  s3.send(new HeadBucketCommand({ Bucket: BUCKET }))
    .then(function() { console.log('[R2] Connected to ' + BUCKET + ' bucket'); })
    .catch(function(err) { console.error('[R2] Bucket connection failed:', err && err.message ? err.message : String(err)); });
}
