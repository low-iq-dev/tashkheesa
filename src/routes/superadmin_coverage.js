'use strict';

// src/routes/superadmin_coverage.js — "Notify waiting leads" (patient
// recovery, Part C, 2 Nov 2026).
//
//   GET  /superadmin/coverage-leads                       one row per specialty
//        with patients waiting; the action sits under the specialty's row
//   GET  /superadmin/coverage-leads/:specialtyId/notify   the dry run: how many
//        would be told, nothing sent; the confirm form asks for the specialty's
//        name to be TYPED
//   POST /superadmin/coverage-leads/:specialtyId/notify   sends, once per lead
//
// Nothing is ever sent automatically, and nothing is sent for a specialty that
// is still hidden. services/coverage_leads.notifyWaitingLeads claims each lead
// before queuing for it, so a double submit tells nobody twice.

const express = require('express');
const { requireRole } = require('../middleware');
const coverage = require('../services/coverage_leads');
const { logErrorToDb } = require('../logger');

const router = express.Router();
const requireSuperadmin = requireRole('superadmin');

function langOf(res) { return (res.locals && res.locals.lang) === 'ar' ? 'ar' : 'en'; }

router.get('/superadmin/coverage-leads', requireSuperadmin, async (req, res) => {
  try {
    const rows = await coverage.waitingBySpecialty();
    return res.render('superadmin_coverage_leads', { user: req.user, lang: langOf(res), rows, preview: null, result: null, error: null });
  } catch (err) {
    logErrorToDb(err, { context: 'superadmin.coverage_leads', category: 'superadmin', userId: req.user && req.user.id });
    return res.status(500).send('Could not load coverage leads');
  }
});

router.get('/superadmin/coverage-leads/:specialtyId/notify', requireSuperadmin, async (req, res) => {
  try {
    const rows = await coverage.waitingBySpecialty();
    const preview = await coverage.notifyWaitingLeads({ specialtyId: req.params.specialtyId, dryRun: true });
    return res.render('superadmin_coverage_leads', { user: req.user, lang: langOf(res), rows, preview, result: null, error: preview.ok ? null : preview.code });
  } catch (err) {
    logErrorToDb(err, { context: 'superadmin.coverage_leads.preview', category: 'superadmin', userId: req.user && req.user.id });
    return res.status(500).send('Could not prepare the preview');
  }
});

router.post('/superadmin/coverage-leads/:specialtyId/notify', requireSuperadmin, async (req, res) => {
  try {
    const result = await coverage.notifyWaitingLeads({ specialtyId: req.params.specialtyId, confirm: req.body && req.body.confirm });
    try {
      require('../services/admin_audit').logAdminAudit({
        req, action: 'coverage_leads_notified', target: '/superadmin/coverage-leads/' + req.params.specialtyId,
        message: result.ok
          ? 'notified ' + (result.notified || 0) + ' of ' + (result.count || 0) + ' waiting lead(s)'
          : 'refused: ' + (result.code || 'unknown'),
      });
    } catch (_) { /* the audit line is best-effort */ }
    const rows = await coverage.waitingBySpecialty();
    const preview = result.ok ? null : await coverage.notifyWaitingLeads({ specialtyId: req.params.specialtyId, dryRun: true });
    return res.render('superadmin_coverage_leads', { user: req.user, lang: langOf(res), rows, preview, result: result.ok ? result : null, error: result.ok ? null : result.code });
  } catch (err) {
    logErrorToDb(err, { context: 'superadmin.coverage_leads.notify', category: 'superadmin', userId: req.user && req.user.id });
    return res.status(500).send('Could not notify the waiting leads');
  }
});

module.exports = router;
