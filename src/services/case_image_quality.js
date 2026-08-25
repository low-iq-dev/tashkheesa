'use strict';

// services/case_image_quality.js — fire-and-forget AI quality check on a case's
// images.
//
// CASE-FLOW REBUILD 2026-08-25. Lifted verbatim out of the POST /api/v1/cases
// handler so the draft-submit path runs the SAME check rather than a second
// copy that drifts. No behavioural change: same statuses, same note precedence,
// same swallow-everything posture.
//
// WHY FIRE-AND-FORGET. The HTTP response must not wait on a per-image model
// call — the patient goes straight to payment, and the app polls
// GET /cases/:id for the results. A failure here downgrades a file's badge; it
// must never fail the submission of a case.
//
// Non-images are marked 'skipped' at INSERT time and never reach this worker.

const { execute } = require('../pg');
const { validateImageFromUrl } = require('../ai_image_check');
const { getSignedDownloadUrl } = require('../storage');

// Legacy Uploadcare rows carry a CDN uuid; post-Theme-13 rows carry an R2 key
// in `url` and need a signed URL. The signed URL is minted inside the worker,
// which fires within milliseconds of the INSERT, so a 1h expiry is ample.
const SIGNED_URL_TTL_SECONDS = 3600;

async function markFile(fileId, status, note) {
  await execute(
    'UPDATE order_files SET ai_quality_status = $1, ai_quality_note = $2 WHERE id = $3',
    [status, note == null ? null : String(note).slice(0, 500), fileId]
  );
}

function statusFromResult(result) {
  if (result && result.skipped) return 'skipped';
  if (result && result.is_medical_image === false) return 'not_medical';
  if (result && result.image_quality === 'poor') return 'poor_quality';
  if (result && result.image_quality === 'acceptable') return 'acceptable';
  if (result && result.matches_expected === false) return 'wrong_type';
  return 'ok';
}

function noteFromResult(result) {
  return (
    (result && result.skipped && result.reason) ||
    (result && result.recommendation) ||
    (result && Array.isArray(result.quality_issues) && result.quality_issues.join('; ')) ||
    null
  );
}

/**
 * Queue the quality check for a case's image files. Returns immediately.
 *
 * @param {Array<object>} files  order_files rows. Each needs id, filename and
 *                               EITHER url (R2 key) OR uploadcare_uuid (legacy).
 * @param {object|null} service  the services row, for "does this image match
 *                               what the patient booked" — name only.
 */
function scheduleImageQualityChecks(files, service) {
  const { isImageExtension } = require('../ai_image_check');
  const targets = (files || []).filter(f =>
    isImageExtension(f.filename) || /^image\//i.test(f.mime_type || f.mimeType || '')
  );
  if (targets.length === 0) return;

  setImmediate(() => {
    (async () => {
      for (const f of targets) {
        try {
          let imageUrl = null;
          if (f.uploadcare_uuid) {
            imageUrl = 'https://ucarecdn.com/' + f.uploadcare_uuid + '/';
          } else if (f.url) {
            try {
              imageUrl = await getSignedDownloadUrl(f.url, SIGNED_URL_TTL_SECONDS);
            } catch (signErr) {
              // Recorded rather than swallowed: a file stuck on 'pending'
              // forever is indistinguishable from one still being checked.
              await markFile(
                f.id, 'error',
                'signed-url-failed: ' + String((signErr && signErr.message) || signErr)
              );
              continue;
            }
          }
          if (!imageUrl) continue;

          const result = await validateImageFromUrl(imageUrl, (service && service.name) || null);
          await markFile(f.id, statusFromResult(result), noteFromResult(result));
        } catch (err) {
          try {
            await markFile(f.id, 'error', String((err && err.message) || err));
          } catch (_) { /* best effort — the case is already submitted */ }
        }
      }
    })().catch(() => { /* swallow — fire-and-forget by design */ });
  });
}

module.exports = { scheduleImageQualityChecks, _statusFromResult: statusFromResult };
