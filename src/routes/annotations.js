/**
 * Annotation routes — save / load / export doctor annotations on case images.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { queryOne, queryAll, execute } = require('../pg');
const { requireRole, requireAuth } = require('../middleware');
const { major: logMajor } = require('../logger');
// A4 (FIX PLAN 2026-09-15) — assignment is not acceptance; see the two access
// helpers below.
const { doctorHasAcceptedCase } = require('../services/doctor_case_access');

const router = express.Router();

// ── Helpers ─────────────────────────────────────────────

async function safeGet(sql, params, fallback) {
  try {
    return await queryOne(sql, Array.isArray(params) ? params : [params]);
  } catch (e) {
    logMajor('annotations safeGet error: ' + e.message);
    return fallback !== undefined ? fallback : null;
  }
}

async function safeAll(sql, params) {
  try {
    return await queryAll(sql, Array.isArray(params) ? params : [params]);
  } catch (e) {
    logMajor('annotations safeAll error: ' + e.message);
    return [];
  }
}

// Verify the doctor may work on a specific case.
//
// A4 (FIX PLAN 2026-09-15): this asked `doctor_id = $2` — assignment, not
// acceptance — so a doctor who had accepted nothing could WRITE markup onto
// the patient's scan. `status` is selected so the shared rule can answer.
async function doctorOwnsCase(doctorId, caseId) {
  const row = await safeGet(
    'SELECT id, doctor_id, status FROM orders_active WHERE id = $1 AND doctor_id = $2',
    [caseId, doctorId],
    null
  );
  return doctorHasAcceptedCase(row, doctorId);
}

// Verify the user (patient/doctor/admin) can view a case
//
// A4 (FIX PLAN 2026-09-15): the doctor arm was `order.doctor_id === user.id`,
// and three GETs ride this helper — including /api/annotations/:imageId/image,
// which returns annotated_image_data: the patient's actual scan with the
// previous doctor's markup on it. case_lifecycle's REASSIGNED -> ASSIGNED
// transition sets the new doctor_id with accepted_at = null, and the
// case_annotations rows are not deleted on reassignment, so the replacement
// doctor could pull the images before deciding whether to take the case.
async function userCanViewCase(user, caseId) {
  if (!user) return false;
  const role = String(user.role || '').toLowerCase();

  if (role === 'superadmin' || role === 'admin') return true;

  const order = await safeGet(
    'SELECT id, patient_id, doctor_id, status FROM orders_active WHERE id = $1 LIMIT 1',
    [caseId],
    null
  );
  if (!order) return false;

  if (role === 'doctor') return doctorHasAcceptedCase(order, user.id);
  if (role === 'patient') return order.patient_id === user.id;

  return false;
}

// ── GET /api/annotations/:imageId/source ────────────────
//
// Launch eve 2026-09-24 (T8). The ORIGINAL image bytes, served from our own
// origin, for public/annotator.html.
//
// The annotator used to load /files/:fileId, which 302s to an R2 signed URL.
// fabric loads that with crossOrigin:'anonymous', so unless the bucket carries
// a CORS rule the image never appears; drop crossOrigin and the canvas is
// tainted, so toDataURL() — the save — throws. Streaming the bytes same-origin
// removes the dependency on bucket CORS entirely.
//
// Authorisation is EXACTLY /files/:fileId's: services/file_access is the one
// implementation both routes call (doctor assigned AND accepted_at set;
// patient owns the order; admin/superadmin always; message files by
// conversation membership). Rate-limited by the same fileDownloadLimiter
// (src/middleware.js).
//
// Raster images only. This route puts PHI bytes on our origin, so it refuses
// anything a browser could execute there (SVG, HTML, …) and sends nosniff +
// a sandboxing CSP in case a stored key lies about its type.
// The set lives in services/file_access.js, shared with the Annotate button.
const ANNOTATABLE_MIME = new Set(require('../services/file_access').ANNOTATABLE_MIME);

function makeAnnotationSourceHandler(deps) {
  const d = deps || {};
  return async function annotationSourceHandler(req, res) {
    const imageId = String((req.params && req.params.imageId) || '').trim();
    if (!imageId) return res.status(400).json({ ok: false, error: 'Missing imageId' });

    const fileAccess = d.fileAccess || require('../services/file_access');
    const access = await fileAccess.resolveFileAccess(imageId, req.user);
    if (access.status === 404) return res.status(404).json({ ok: false, error: 'Not found' });
    if (access.status !== 200) {
      logMajor('[annotations/source] blocked role=' + String((req.user && req.user.role) || '') +
        ' user=' + String((req.user && req.user.id) || '') + ' file=' + imageId);
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    let buf;
    try {
      const url = String(access.fileUrl || '');
      if (/^https?:\/\//i.test(url)) {
        // Legacy Uploadcare-era row: fetch it server-side, but only from our
        // own file hosts — the same allowlist /files enforces before its 302.
        const { isAllowedFileUrl } = require('../services/file_url_allowlist');
        if (!isAllowedFileUrl(url)) return res.status(404).json({ ok: false, error: 'Not found' });
        const fetchFn = d.fetch || fetch;
        const r = await fetchFn(url, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error('upstream ' + r.status);
        buf = Buffer.from(await r.arrayBuffer());
      } else {
        const key = access.fileKey || url;
        if (!key) return res.status(404).json({ ok: false, error: 'File missing' });
        const storage = d.storage || require('../storage');
        buf = await storage.getFileBuffer(key);
      }
    } catch (err) {
      logMajor('[annotations/source] read failed file=' + imageId + ' err=' + (err && err.message));
      return res.status(502).json({ ok: false, error: 'File temporarily unavailable' });
    }

    // Type from the BYTES only. Every format in ANNOTATABLE_MIME has a magic
    // number, so a file that does not sniff as one is refused — a stored key
    // ending in .png is not evidence the object is a PNG.
    const type = fileAccess.mimeFromBytes(buf);
    if (!ANNOTATABLE_MIME.has(type)) {
      return res.status(415).json({ ok: false, error: 'Not an annotatable image' });
    }

    res.set({
      'Content-Type': type,
      'Content-Length': String(buf.length),
      // PHI: never in a shared cache; the browser may keep it briefly.
      'Cache-Control': 'private, max-age=300',
      'Vary': 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline'
    });
    return res.status(200).end(buf);
  };
}

router.get('/api/annotations/:imageId/source', requireAuth(), makeAnnotationSourceHandler());

// ── POST /api/annotations/save ──────────────────────────
// Save or update annotation data for a specific image in a case
router.post(
  '/api/annotations/save',
  requireRole('doctor'),
  async (req, res) => {
    try {
      const { imageId, caseId, annotationState, annotatedImage, objectCount } = req.body;
      const doctorId = req.user.id;

      if (!imageId || !caseId) {
        return res.status(400).json({ ok: false, error: 'Missing imageId or caseId' });
      }

      // Verify doctor owns this case
      if (!(await doctorOwnsCase(doctorId, caseId))) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }

      // Check if annotation already exists for this image+doctor
      const existing = await safeGet(
        'SELECT id FROM case_annotations WHERE image_id = $1 AND doctor_id = $2 LIMIT 1',
        [imageId, doctorId],
        null
      );

      let annotationId;

      if (existing) {
        // Update existing annotation
        annotationId = existing.id;
        await execute(
          `UPDATE case_annotations
           SET annotation_data = $1,
               annotated_image_data = $2,
               annotations_count = $3,
               updated_at = NOW()
           WHERE id = $4`,
          [
            JSON.stringify(annotationState || {}),
            annotatedImage || null,
            objectCount || 0,
            annotationId
          ]
        );
      } else {
        // Create new annotation
        annotationId = randomUUID();
        await execute(
          `INSERT INTO case_annotations (
            id, case_id, image_id, doctor_id,
            annotation_data, annotated_image_data, annotations_count,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
          [
            annotationId,
            caseId,
            imageId,
            doctorId,
            JSON.stringify(annotationState || {}),
            annotatedImage || null,
            objectCount || 0
          ]
        );
      }

      res.json({
        ok: true,
        annotationId: annotationId,
        message: 'Annotations saved'
      });
    } catch (err) {
      logMajor('Annotation save error: ' + err.message);
      res.status(500).json({ ok: false, error: 'Failed to save annotations' });
    }
  }
);

// ── GET /api/annotations/:imageId ───────────────────────
// Load the most recent annotation for a specific image
router.get(
  '/api/annotations/:imageId',
  requireAuth(),
  async (req, res) => {
    try {
      const imageId = req.params.imageId;
      if (!imageId) {
        return res.status(400).json({ ok: false, error: 'Missing imageId' });
      }

      const annotation = await safeGet(
        `SELECT ca.*, u.name AS doctor_name
         FROM case_annotations ca
         LEFT JOIN users u ON u.id = ca.doctor_id
         WHERE ca.image_id = $1
         ORDER BY ca.updated_at DESC
         LIMIT 1`,
        [imageId],
        null
      );

      if (!annotation) {
        return res.json({ ok: true, annotation: null });
      }

      // Check access — user must be able to view the associated case
      if (!(await userCanViewCase(req.user, annotation.case_id))) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }

      let annotationState = null;
      try {
        annotationState = JSON.parse(annotation.annotation_data || '{}');
      } catch (_) {
        annotationState = {};
      }

      res.json({
        ok: true,
        annotation: {
          id: annotation.id,
          caseId: annotation.case_id,
          imageId: annotation.image_id,
          doctorId: annotation.doctor_id,
          doctorName: annotation.doctor_name || 'Doctor',
          annotationState: annotationState,
          annotationsCount: annotation.annotations_count || 0,
          createdAt: annotation.created_at,
          updatedAt: annotation.updated_at
        }
      });
    } catch (err) {
      logMajor('Annotation get error: ' + err.message);
      res.status(500).json({ ok: false, error: 'Failed to load annotations' });
    }
  }
);

// ── GET /api/annotations/case/:caseId ───────────────────
// List all annotations for a case (used by case detail pages)
router.get(
  '/api/annotations/case/:caseId',
  requireAuth(),
  async (req, res) => {
    try {
      const caseId = req.params.caseId;

      if (!(await userCanViewCase(req.user, caseId))) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }

      const annotations = await safeAll(
        `SELECT ca.id, ca.image_id, ca.doctor_id, ca.annotations_count,
                ca.created_at, ca.updated_at,
                u.name AS doctor_name
         FROM case_annotations ca
         LEFT JOIN users u ON u.id = ca.doctor_id
         WHERE ca.case_id = $1
         ORDER BY ca.updated_at DESC`,
        [caseId]
      );

      res.json({
        ok: true,
        annotations: annotations.map(function (a) {
          return {
            id: a.id,
            imageId: a.image_id,
            doctorId: a.doctor_id,
            doctorName: a.doctor_name || 'Doctor',
            annotationsCount: a.annotations_count || 0,
            createdAt: a.created_at,
            updatedAt: a.updated_at
          };
        })
      });
    } catch (err) {
      logMajor('Annotation list error: ' + err.message);
      res.status(500).json({ ok: false, error: 'Failed to list annotations' });
    }
  }
);

// ── GET /api/annotations/:imageId/image ─────────────────
// Serve the flattened annotated image (PNG data URL decoded)
router.get(
  '/api/annotations/:imageId/image',
  requireAuth(),
  async (req, res) => {
    try {
      const imageId = req.params.imageId;

      const annotation = await safeGet(
        'SELECT case_id, annotated_image_data FROM case_annotations WHERE image_id = $1 ORDER BY updated_at DESC LIMIT 1',
        [imageId],
        null
      );

      if (!annotation || !annotation.annotated_image_data) {
        return res.status(404).json({ ok: false, error: 'Annotated image not found' });
      }

      if (!(await userCanViewCase(req.user, annotation.case_id))) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }

      // Data URL format: data:image/png;base64,iVBOR...
      var data = annotation.annotated_image_data;
      var match = data.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) {
        return res.status(500).json({ ok: false, error: 'Invalid image data' });
      }

      var ext = match[1];
      var buf = Buffer.from(match[2], 'base64');
      res.set('Content-Type', 'image/' + ext);
      res.set('Content-Length', buf.length);
      res.set('Cache-Control', 'private, max-age=300');
      res.send(buf);
    } catch (err) {
      logMajor('Annotation image serve error: ' + err.message);
      res.status(500).json({ ok: false, error: 'Failed to serve annotated image' });
    }
  }
);

// ── DELETE /api/annotations/:annotationId ───────────────
// Delete a specific annotation (doctor only, must own it)
router.delete(
  '/api/annotations/:annotationId',
  requireRole('doctor'),
  async (req, res) => {
    try {
      const annotationId = req.params.annotationId;
      const doctorId = req.user.id;

      const annotation = await safeGet(
        'SELECT id, doctor_id FROM case_annotations WHERE id = $1',
        [annotationId],
        null
      );

      if (!annotation) {
        return res.status(404).json({ ok: false, error: 'Annotation not found' });
      }

      if (annotation.doctor_id !== doctorId) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }

      await execute('DELETE FROM case_annotations WHERE id = $1', [annotationId]);

      res.json({ ok: true, message: 'Annotation deleted' });
    } catch (err) {
      logMajor('Annotation delete error: ' + err.message);
      res.status(500).json({ ok: false, error: 'Failed to delete annotation' });
    }
  }
);

module.exports = router;
module.exports.makeAnnotationSourceHandler = makeAnnotationSourceHandler;
