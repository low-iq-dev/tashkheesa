/**
 * Report routes — generate, view, and download case diagnosis reports.
 * Uses the existing report-generator.js for PDF creation.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { requireRole, requireAuth } = require('../middleware');
const { generateMedicalReportPdf } = require('../report-generator');
const { major: logMajor } = require('../logger');

const router = express.Router();

// ── Helpers ─────────────────────────────────────────────

function safeGet(sql, params, fallback) {
  try {
    return db.prepare(sql).get(...(Array.isArray(params) ? params : []));
  } catch (e) {
    logMajor('reports safeGet: ' + e.message);
    return fallback !== undefined ? fallback : null;
  }
}

function safeAll(sql, params) {
  try {
    return db.prepare(sql).all(...(Array.isArray(params) ? params : []));
  } catch (e) {
    logMajor('reports safeAll: ' + e.message);
    return [];
  }
}

function userCanViewCase(user, caseRow) {
  if (!user || !caseRow) return false;
  var role = String(user.role || '').toLowerCase();
  if (role === 'superadmin' || role === 'admin') return true;
  if (role === 'doctor') return caseRow.doctor_id === user.id;
  if (role === 'patient') return caseRow.patient_id === user.id;
  return false;
}

// ── GET /portal/case/:caseId/report ─────────────────────
// View report in browser (HTML) — accessible to doctor, patient, admin
router.get(
  '/portal/case/:caseId/report',
  requireAuth(),
  (req, res) => {
    try {
      var caseId = req.params.caseId;
      var lang = (req.user && req.user.lang) || 'en';
      var isAr = lang === 'ar';

      var order = safeGet(
        'SELECT * FROM orders WHERE id = ?',
        [caseId], null
      );

      if (!order) {
        return res.status(404).render('error', {
          message: isAr ? 'الحالة غير موجودة' : 'Case not found',
          status: 404
        });
      }

      if (!userCanViewCase(req.user, order)) {
        return res.status(403).render('error', {
          message: isAr ? 'غير مصرح' : 'Access denied',
          status: 403
        });
      }

      // Only show report for completed/delivered cases
      var completedStatuses = ['completed', 'done', 'delivered', 'report_ready', 'report-ready', 'finalized'];
      if (!completedStatuses.includes(String(order.status || '').toLowerCase())) {
        return res.status(400).render('error', {
          message: isAr ? 'التقرير غير متاح بعد' : 'Report is not yet available',
          status: 400
        });
      }

      // Fetch related data
      var patient = safeGet(
        'SELECT id, name, email, phone FROM users WHERE id = ?',
        [order.patient_id], {}
      );

      var doctor = safeGet(
        'SELECT id, name, specialty_id FROM users WHERE id = ?',
        [order.doctor_id], {}
      );

      var specialty = doctor && doctor.specialty_id
        ? safeGet('SELECT name FROM specialties WHERE id = ?', [doctor.specialty_id], {})
        : {};

      var service = order.service_id
        ? safeGet('SELECT name FROM services WHERE id = ?', [order.service_id], {})
        : {};

      // Fetch files
      var files = safeAll(
        'SELECT id, url, label, created_at FROM order_files WHERE order_id = ?',
        [caseId]
      );

      // Fetch annotations
      var annotations = safeAll(
        "SELECT ca.id, ca.image_id, ca.annotations_count, ca.updated_at, u.name as doctor_name FROM case_annotations ca LEFT JOIN users u ON u.id = ca.doctor_id WHERE ca.case_id = ? ORDER BY ca.updated_at DESC",
        [caseId]
      );

      // Check if PDF already exists
      var existingReport = safeGet(
        'SELECT id, file_path, created_at FROM report_exports WHERE case_id = ? ORDER BY created_at DESC LIMIT 1',
        [caseId], null
      );

      // Report export history
      var reportHistory = safeAll(
        "SELECT re.id, re.file_path, re.created_at, COALESCE(u.name, 'System') as created_by_name FROM report_exports re LEFT JOIN users u ON u.id = re.created_by WHERE re.case_id = ? ORDER BY re.created_at DESC LIMIT 10",
        [caseId]
      );

      res.render('patient_case_report', {
        user: req.user,
        lang: lang,
        isAr: isAr,
        order: order,
        patient: patient || {},
        doctor: doctor || {},
        specialty: specialty || {},
        service: service || {},
        files: files,
        annotations: annotations,
        existingReport: existingReport,
        reportHistory: reportHistory,
        isDoctor: String(req.user.role || '').toLowerCase() === 'doctor',
        isAdmin: ['admin', 'superadmin'].includes(String(req.user.role || '').toLowerCase()),
        isPatient: String(req.user.role || '').toLowerCase() === 'patient'
      });
    } catch (err) {
      logMajor('Report view error: ' + err.message);
      res.status(500).send('Error loading report');
    }
  }
);

// ── POST /portal/case/:caseId/generate-pdf ──────────────
// Generate PDF using existing report-generator
router.post(
  '/portal/case/:caseId/generate-pdf',
  requireRole('doctor', 'admin', 'superadmin'),
  async (req, res) => {
    try {
      var caseId = req.params.caseId;

      var order = safeGet('SELECT * FROM orders WHERE id = ?', [caseId], null);
      if (!order) {
        return res.status(404).json({ ok: false, error: 'Case not found' });
      }

      if (!userCanViewCase(req.user, order)) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }

      var patient = safeGet('SELECT name FROM users WHERE id = ?', [order.patient_id], {});
      var doctor = safeGet('SELECT name, specialty_id FROM users WHERE id = ?', [order.doctor_id], {});
      var specialty = doctor && doctor.specialty_id
        ? safeGet('SELECT name FROM specialties WHERE id = ?', [doctor.specialty_id], {})
        : {};

      // Build payload for the existing generator
      var pdfPayload = {
        caseId: caseId,
        doctorName: (doctor && doctor.name) || 'Doctor',
        specialty: (specialty && specialty.name) || '',
        createdAt: order.created_at,
        notes: order.notes || '',
        findings: order.diagnosis_text || order.impression_text || '',
        impression: order.impression_text || '',
        recommendations: order.recommendation_text || '',
        patient: {
          name: (patient && patient.name) || 'Patient',
          age: '—',
          gender: '—'
        }
      };

      var reportUrl = await generateMedicalReportPdf(pdfPayload);

      // Save export record
      var exportId = randomUUID();
      try {
        db.prepare(`
          INSERT INTO report_exports (id, case_id, file_path, created_by, created_at)
          VALUES (?, ?, ?, ?, datetime('now'))
        `).run(exportId, caseId, reportUrl, req.user.id);
      } catch (_) {
        // Table may not exist yet — non-critical
      }

      // Update order with report URL if not set
      if (!order.report_url) {
        try {
          db.prepare('UPDATE orders SET report_url = ? WHERE id = ?').run(reportUrl, caseId);
        } catch (_) {}
      }

      res.json({
        ok: true,
        reportUrl: reportUrl,
        exportId: exportId
      });
    } catch (err) {
      logMajor('PDF generation error: ' + err.message);
      res.status(500).json({ ok: false, error: 'Failed to generate PDF: ' + err.message });
    }
  }
);

// ── GET /portal/case/:caseId/download-report ────────────
// Download the latest PDF for a case
router.get(
  '/portal/case/:caseId/download-report',
  requireAuth(),
  (req, res) => {
    try {
      var caseId = req.params.caseId;

      var order = safeGet('SELECT * FROM orders WHERE id = ?', [caseId], null);
      if (!order) return res.status(404).send('Case not found');

      if (!userCanViewCase(req.user, order)) {
        return res.status(403).send('Access denied');
      }

      // Check for report URL on order
      var reportPath = order.report_url;

      // Check report_exports table
      if (!reportPath) {
        var exported = safeGet(
          'SELECT file_path FROM report_exports WHERE case_id = ? ORDER BY created_at DESC LIMIT 1',
          [caseId], null
        );
        if (exported) reportPath = exported.file_path;
      }

      if (!reportPath) {
        return res.status(404).send('No report generated yet');
      }

      // If it's a relative URL like /reports/file.pdf, resolve to disk
      if (reportPath.startsWith('/reports/')) {
        var diskPath = path.join(process.cwd(), 'public', reportPath);
        if (fs.existsSync(diskPath)) {
          return res.download(diskPath, 'Report-' + caseId + '.pdf');
        }
      }

      // If it's an absolute path on disk
      if (fs.existsSync(reportPath)) {
        return res.download(reportPath, 'Report-' + caseId + '.pdf');
      }

      // Redirect to URL if external
      return res.redirect(reportPath);
    } catch (err) {
      logMajor('Report download error: ' + err.message);
      res.status(500).send('Error downloading report');
    }
  }
);

// ── POST /portal/case/:caseId/email-report ──────────────
// Email report link to patient — doctor/admin only
router.post(
  '/portal/case/:caseId/email-report',
  requireRole('doctor', 'admin', 'superadmin'),
  async (req, res) => {
    try {
      var caseId = req.params.caseId;
      var order = safeGet('SELECT * FROM orders WHERE id = ?', [caseId], null);
      if (!order) return res.status(404).json({ ok: false, error: 'Case not found' });

      if (!userCanViewCase(req.user, order)) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }

      var patient = safeGet('SELECT id, name, email, lang FROM users WHERE id = ?', [order.patient_id], null);
      if (!patient || !patient.email) {
        return res.status(400).json({ ok: false, error: 'Patient email not found' });
      }

      var doctor = safeGet('SELECT name, specialty_id FROM users WHERE id = ?', [order.doctor_id], {});
      var specialty = doctor && doctor.specialty_id
        ? safeGet('SELECT name FROM specialties WHERE id = ?', [doctor.specialty_id], {})
        : {};

      var reportUrl = (process.env.APP_URL || 'https://tashkheesa.com') + '/portal/case/' + caseId + '/report';

      // Use existing email service
      var emailService;
      try {
        emailService = require('../services/emailService');
      } catch (_) {
        return res.status(500).json({ ok: false, error: 'Email service not available' });
      }

      var patientLang = (patient.lang || 'en').toLowerCase();
      await emailService.sendEmail({
        to: patient.email,
        subject: patientLang === 'ar' ? 'تقريرك الطبي جاهز' : 'Your Medical Report is Ready',
        template: 'report-ready',
        lang: patientLang,
        data: {
          patientName: patient.name || 'Patient',
          caseReference: String(caseId).slice(0, 12).toUpperCase(),
          specialty: (specialty && specialty.name) || '',
          doctorName: (doctor && doctor.name) || '',
          reportUrl: reportUrl
        }
      });

      res.json({ ok: true, message: 'Report email sent to ' + patient.email });
    } catch (err) {
      logMajor('Email report error: ' + err.message);
      res.status(500).json({ ok: false, error: 'Failed to send email: ' + err.message });
    }
  }
);

module.exports = router;
