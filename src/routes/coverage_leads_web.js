'use strict';

// src/routes/coverage_leads_web.js — the web wizard's "Tell me when it opens"
// (patient recovery, Part C, 2 Nov 2026). One tap: the number is the one on
// the account; the draft is kept. services/coverage_leads.createLead holds the
// rules (one lead per draft, own draft only, a hidden specialty or "other").

const express = require('express');
const { requireRole } = require('../middleware');
const coverage = require('../services/coverage_leads');
const { logErrorToDb } = require('../logger');

const router = express.Router();

function step3(draftId, extra) {
  return '/patient/new-case?step=3&id=' + encodeURIComponent(String(draftId || '')) + (extra || '') + '#coverage-panel';
}

router.post('/patient/new-case/coverage-lead', requireRole('patient'), async (req, res) => {
  const b = req.body || {};
  const draftId = String(b.draft_id || '');
  const lang = String((res.locals && res.locals.lang) || (req.user && req.user.lang) || '').toLowerCase() === 'ar' ? 'ar' : 'en';
  try {
    await coverage.createLead({
      patientId: req.user.id, orderId: draftId || null,
      wantedSpecialtyId: b.wanted_specialty_id, wantedText: b.wanted_text,
      // 'classifier' when the classifier opened the panel (wizardContext).
      source: b.via === 'classifier' ? 'classifier' : 'web', lang,
    });
    return res.redirect(step3(draftId, '&lead=1'));
  } catch (err) {
    if (err && (err.code === 'NOT_FOUND' || err.code === 'NOT_DRAFT')) return res.redirect('/dashboard');
    // SPECIALTY_OPEN: it is on the list — the step itself is the answer.
    if (err && err.code === 'SPECIALTY_OPEN') return res.redirect(step3(draftId));
    logErrorToDb(err, { context: 'coverage_leads.web_create', category: 'patient_action', userId: req.user && req.user.id, orderId: draftId });
    return res.redirect(step3(draftId));
  }
});

module.exports = router;
