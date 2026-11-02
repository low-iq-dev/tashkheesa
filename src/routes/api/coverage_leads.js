'use strict';

// src/routes/api/coverage_leads.js — Part C for the app (patient recovery,
// 2 Nov 2026). Mounted at /api/v1/cases/draft behind requireJWT +
// requireRole('patient') (routes/api_v1.js). Additive: two new paths, nothing
// existing changes shape. The app's own screen is a follow-up; this is the
// contract it will use.
//
//   GET  /cases/draft/:id/coverage
//     { notListedOption: true, trigger, lead, hiddenSpecialties, openSpecialties,
//       reportReadOffers: [{ serviceId, specialtyId, name, nameAr, price, currency }],
//       copy: { en, ar } }       — copy carries {specialty} for the app to fill
//   POST /cases/draft/:id/coverage-lead   { wantedSpecialtyId?, wantedText? }
//     201 { created: true, lead } | 200 { created: false, lead }
//     404 NOT_FOUND · 409 NOT_DRAFT · 409 SPECIALTY_OPEN · 400 UNKNOWN_SPECIALTY

const router = require('express').Router();
const coverage = require('../../services/coverage_leads');
const { queryOne } = require('../../pg');
const { logErrorToDb } = require('../../logger');

router.use(require('express').json());

const COPY = Object.freeze({
  en: 'We don’t open {specialty} yet. Leave your number and we’ll tell you first — or choose a related specialty that is open.',
  ar: 'لسه ما فتحناش تخصص {specialty}. سيب رقمك وهنبلغك أول ما يفتح — أو اختار تخصص قريب متاح.',
});

function leadOut(l) {
  return l ? { id: l.id, wantedSpecialtyId: l.wanted_specialty_id || null, wantedText: l.wanted_text || null, createdAt: l.created_at, notifiedAt: l.notified_at || null } : null;
}
function spOut(sp) { return { id: sp.id, name: sp.name, nameAr: sp.name_ar || null }; }

async function ownDraft(req) {
  // practice-ok: by id, the caller's own draft.
  const d = await queryOne(
    "SELECT id, patient_id, status FROM orders WHERE id = $1 AND deleted_at IS NULL", [String(req.params.id)]);
  if (!d || String(d.patient_id) !== String(req.user.id)) return null;
  return d;
}

router.get('/:id/coverage', async (req, res) => {
  try {
    const d = await ownDraft(req);
    if (!d) return res.fail('Draft not found', 404, 'NOT_FOUND');
    const classification = await queryOne(
      'SELECT specialty_id, confidence FROM specialty_classifications WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1', [d.id]);
    const thresholds = await require('../../services/admin_settings').getThresholds();
    const open = await coverage.openSpecialties();
    const [hidden, lead, offers] = await Promise.all([
      coverage.hiddenSpecialties(), coverage.leadForOrder(d.id), coverage.reportReadOffers({ userId: req.user.id }),
    ]);
    const trigger = coverage.coverageTrigger({ classification, thresholds, visibleSpecialtyIds: open.map((s) => s.id) });
    return res.ok({
      notListedOption: true,
      trigger,
      lead: leadOut(lead),
      hiddenSpecialties: hidden.map(spOut),
      openSpecialties: open.map(spOut),
      reportReadOffers: offers,
      copy: COPY,
    });
  } catch (err) {
    logErrorToDb(err, { context: 'api.coverage.get', category: 'patient_action', userId: req.user && req.user.id });
    return res.fail('Could not load the specialty options', 500, 'SERVER_ERROR');
  }
});

router.post('/:id/coverage-lead', async (req, res) => {
  const b = req.body || {};
  try {
    const user = await queryOne('SELECT lang FROM users WHERE id = $1', [req.user.id]);
    const r = await coverage.createLead({
      patientId: req.user.id, orderId: String(req.params.id),
      wantedSpecialtyId: b.wantedSpecialtyId || null, wantedText: b.wantedText || null,
      source: 'api', lang: String((user && user.lang) || '').toLowerCase() === 'ar' ? 'ar' : 'en',
    });
    if (r.created) { res.status(201); return res.ok({ created: true, lead: leadOut(r.lead) }); }
    return res.ok({ created: false, lead: leadOut(r.lead) });
  } catch (err) {
    if (err && err.code && err.status) return res.fail(err.message, err.status, err.code);
    logErrorToDb(err, { context: 'api.coverage.post', category: 'patient_action', userId: req.user && req.user.id });
    return res.fail('Could not save your request', 500, 'SERVER_ERROR');
  }
});

module.exports = router;
