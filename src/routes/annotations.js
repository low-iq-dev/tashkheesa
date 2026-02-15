/**
 * Annotation routes — save / load / export doctor annotations on case images.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { requireRole, requireAuth } = require('../middleware');
const { major: logMajor } = require('../logger');

const router = express.Router();

// ── Helpers ─────────────────────────────────────────────

function safeGet(sql, params, fallback) {
  try {
    return db.prepare(sql).get(...(Array.isArray(params) ? params : [params]));
  } catch (e) {
    logMajor('annotations safeGet error: ' + e.message);
    return fallback !== undefined ? fallback : null;
  }
}

function safeAll(sql, params) {
  try {
    return db.prepare(sql).all(...(Array.isArray(params) ? params : [params]));
  } catch (e) {
    logMajor('annotations safeAll error: ' + e.message);
    return [];
  }
}

// Verify the doctor has access to a specific case (must be assigned/accepted)
function doctorOwnsCase(doctorId, caseId) {
  const row = safeGet(
    'SELECT id FROM orders WHERE id = ? AND doctor_id = ?',
    [caseId, doctorId],
    null
  );
  return !!row;
}

// Verify the user (patient/doctor/admin) can view a case
function userCanViewCase(user, caseId) {
  if (!user) return false;
  const role = String(user.role || '').toLowerCase();

  if (role === 'superadmin' || role === 'admin') return true;

  const order = safeGet(
    'SELECT id, patient_id, doctor_id FROM orders WHERE id = ? LIMIT 1',
    [caseId],
    null
  );
  if (!order) return false;

  if (role === 'doctor') return order.doctor_id === user.id;
  if (role === 'patient') return order.patient_id === user.id;

  return false;
}

// ── POST /api/annotations/save ──────────────────────────
// Save or update annotation data for a specific image in a case
router.post(
  '/api/annotations/save',
  requireRole('doctor'),
  (req, res) => {
    try {
      const { imageId, caseId, annotationState, annotatedImage, objectCount } = req.body;
      const doctorId = req.user.id;

      if (!imageId || !caseId) {
        return res.status(400).json({ ok: false, error: 'Missing imageId or caseId' });
      }

      // Verify doctor owns this case
      if (!doctorOwnsCase(doctorId, caseId)) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }

      // Check if annotation already exists for this image+doctor
      const existing = safeGet(
        'SELECT id FROM case_annotations WHERE image_id = ? AND doctor_id = ? LIMIT 1',
        [imageId, doctorId],
        null
      );

      let annotationId;

      if (existing) {
        // Update existing annotation
        annotationId = existing.id;
        db.prepare(`
          UPDATE case_annotations
          SET annotation_data = ?,
              annotated_image_data = ?,
              annotations_count = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(
          JSON.stringify(annotationState || {}),
          annotatedImage || null,
          objectCount || 0,
          annotationId
        );
      } else {
        // Create new annotation
        annotationId = randomUUID();
        db.prepare(`
          INSERT INTO case_annotations (
            id, case_id, image_id, doctor_id,
            annotation_data, annotated_image_data, annotations_count,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          annotationId,
          caseId,
          imageId,
          doctorId,
          JSON.stringify(annotationState || {}),
          annotatedImage || null,
          objectCount || 0
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
  (req, res) => {
    try {
      const imageId = req.params.imageId;
      if (!imageId) {
        return res.status(400).json({ ok: false, error: 'Missing imageId' });
      }

      const annotation = safeGet(
        `SELECT ca.*, u.name AS doctor_name
         FROM case_annotations ca
         LEFT JOIN users u ON u.id = ca.doctor_id
         WHERE ca.image_id = ?
         ORDER BY ca.updated_at DESC
         LIMIT 1`,
        [imageId],
        null
      );

      if (!annotation) {
        return res.json({ ok: true, annotation: null });
      }

      // Check access — user must be able to view the associated case
      if (!userCanViewCase(req.user, annotation.case_id)) {
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
  (req, res) => {
    try {
      const caseId = req.params.caseId;

      if (!userCanViewCase(req.user, caseId)) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }

      const annotations = safeAll(
        `SELECT ca.id, ca.image_id, ca.doctor_id, ca.annotations_count,
                ca.created_at, ca.updated_at,
                u.name AS doctor_name
         FROM case_annotations ca
         LEFT JOIN users u ON u.id = ca.doctor_id
         WHERE ca.case_id = ?
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
  (req, res) => {
    try {
      const imageId = req.params.imageId;

      const annotation = safeGet(
        'SELECT case_id, annotated_image_data FROM case_annotations WHERE image_id = ? ORDER BY updated_at DESC LIMIT 1',
        [imageId],
        null
      );

      if (!annotation || !annotation.annotated_image_data) {
        return res.status(404).json({ ok: false, error: 'Annotated image not found' });
      }

      if (!userCanViewCase(req.user, annotation.case_id)) {
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
  (req, res) => {
    try {
      const annotationId = req.params.annotationId;
      const doctorId = req.user.id;

      const annotation = safeGet(
        'SELECT id, doctor_id FROM case_annotations WHERE id = ?',
        [annotationId],
        null
      );

      if (!annotation) {
        return res.status(404).json({ ok: false, error: 'Annotation not found' });
      }

      if (annotation.doctor_id !== doctorId) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }

      db.prepare('DELETE FROM case_annotations WHERE id = ?').run(annotationId);

      res.json({ ok: true, message: 'Annotation deleted' });
    } catch (err) {
      logMajor('Annotation delete error: ' + err.message);
      res.status(500).json({ ok: false, error: 'Failed to delete annotation' });
    }
  }
);

module.exports = router;
