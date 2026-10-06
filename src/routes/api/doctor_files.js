'use strict';

/**
 * Tashkheesa — the doctor app's file surface: /api/v1/doctor/*
 *
 *   GET /files/:fileId/link        a short-lived link to one case file
 *   GET /cases/:id/report-link     a short-lived link to the case's report PDF
 *
 * WHY THIS EXISTS. /files/:fileId — the route the web case page uses — reads
 * the cookie session and answers with a 302 to a signed URL. The app has a
 * bearer token and no cookie, so every file it listed was a path it could not
 * open: the viewer drew an empty frame with the file's name on it. These two
 * routes hand the app the signed URL as JSON instead.
 *
 * NO SECOND ACCESS RULE. The file link is authorised by
 * services/file_access.resolveFileAccess — the same call /files/:fileId and
 * the annotator's byte route make — so "may this doctor see this file" has one
 * answer on the web and in the app (assigned AND accepted, or a member of the
 * conversation the attachment belongs to). "Not mine" and "does not exist" are
 * the same 404, like every other doctor route.
 *
 * The links live 15 minutes: long enough to read a scan, short enough that a
 * link copied out of the app is dead by the time it is found.
 */

const express = require('express');
const path = require('path');
const { requireJWT, requireRole } = require('../../middleware/requireJWT');
const fileAccess = require('../../services/file_access');

const LINK_TTL_SECONDS = 15 * 60;

function isHttpUrl(v) { return /^https?:\/\//i.test(String(v || '')); }

// What the app can do with the type. 'image' renders in the viewer and can be
// marked up — exactly the web annotator's set (file_access.ANNOTATABLE_MIME),
// so a file is annotatable in both places or in neither. 'pdf' opens in the
// phone's document viewer. Everything else (DICOM, HEIC, TIFF, Word) is
// 'other': the app offers to open or save it, as the web page does.
function viewableKind(mime) {
  const m = String(mime || '').trim().toLowerCase().split(';')[0];
  if (fileAccess.ANNOTATABLE_MIME.indexOf(m) !== -1) return 'image';
  if (m === 'application/pdf') return 'pdf';
  return 'other';
}

function safeName(v) {
  return String(v || '').replace(/["\r\n\\/]/g, '').trim() || 'file';
}

module.exports = function (db, helpers) {
  const { safeGet } = helpers || {};
  const router = express.Router();

  router.use(requireJWT);
  router.use(requireRole('doctor'));

  const meId = (req) => (req.user && req.user.id ? String(req.user.id) : '');
  const storage = () => require('../../storage');

  router.get('/files/:fileId/link', async (req, res) => {
    const me = meId(req);
    const fileId = String(req.params.fileId || '').trim();
    if (!me || !fileId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    try {
      // The role is pinned to 'doctor' rather than read off the token: this
      // router is doctor-only, and resolveFileAccess must never be asked the
      // admin question from here.
      const access = await fileAccess.resolveFileAccess(fileId, { id: me, role: 'doctor' }, { safeGet });
      if (access.status !== 200) return res.fail('File not available', 404, 'FILE_NOT_AVAILABLE');

      const name = safeName(access.fileLabel || path.basename(access.fileKey || access.fileUrl || ''));
      const mime = access.mimeType
        || fileAccess.mimeFromName(name)
        || fileAccess.mimeFromName(access.fileKey || access.fileUrl);
      const kind = viewableKind(mime);

      // Legacy rows hold a full CDN URL. Same sink-side allowlist as /files.
      if (access.fileUrl && isHttpUrl(access.fileUrl)) {
        const { isAllowedFileUrl } = require('../../services/file_url_allowlist');
        if (!isAllowedFileUrl(access.fileUrl)) return res.fail('File not available', 404, 'FILE_NOT_AVAILABLE');
        return res.ok({ url: access.fileUrl, mime: mime || null, name, kind, expires_in: null });
      }

      const key = access.fileKey || access.fileUrl;
      if (!key) return res.fail('File not available', 404, 'FILE_NOT_AVAILABLE');

      const signOpts = { downloadName: name };
      if (fileAccess.isInlineViewableMime(mime)) { signOpts.inline = true; signOpts.contentType = mime; }
      const url = await storage().getSignedDownloadUrl(key, LINK_TTL_SECONDS, signOpts);
      return res.ok({ url, mime: mime || null, name, kind, expires_in: LINK_TTL_SECONDS });
    } catch (e) {
      console.warn('[doctor_files] link failed:', e && e.message);
      return res.fail('File temporarily unavailable', 500, 'FILE_LINK_FAILED');
    }
  });

  // The report PDF of a case this doctor holds or delivered. Same lookup as
  // routes/reports.js: orders.report_url first, then the newest report_exports
  // row. A doctor reads their own report before AND after delivery (the web
  // route lets the assigned doctor check the PDF they are about to submit).
  router.get('/cases/:id/report-link', async (req, res) => {
    const me = meId(req);
    const caseId = String(req.params.id || '').trim();
    if (!me || !caseId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    try {
      const order = await safeGet(
        'SELECT id, doctor_id, report_url FROM orders_active WHERE id = $1 AND doctor_id = $2 LIMIT 1',
        [caseId, me], null
      );
      if (!order) return res.fail('Case not available', 404, 'CASE_NOT_AVAILABLE');

      let reportPath = String(order.report_url || '').trim();
      if (!reportPath) {
        const exported = await safeGet(
          'SELECT file_path FROM report_exports WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1',
          [caseId], null
        );
        if (exported && exported.file_path) reportPath = String(exported.file_path).trim();
      }
      if (!reportPath) return res.fail('No report yet', 404, 'REPORT_NOT_READY');

      const name = 'Report-' + caseId + '.pdf';
      if (isHttpUrl(reportPath)) {
        return res.ok({ url: reportPath, mime: 'application/pdf', name, kind: 'pdf', expires_in: null });
      }
      const url = await storage().getSignedDownloadUrl(reportPath, LINK_TTL_SECONDS, {
        downloadName: name, inline: true, contentType: 'application/pdf'
      });
      return res.ok({ url, mime: 'application/pdf', name, kind: 'pdf', expires_in: LINK_TTL_SECONDS });
    } catch (e) {
      console.warn('[doctor_files] report link failed:', e && e.message);
      return res.fail('Report temporarily unavailable', 500, 'REPORT_LINK_FAILED');
    }
  });

  return router;
};

module.exports.viewableKind = viewableKind;
