'use strict';

// src/services/coverage_leads.js — "we don't open this specialty yet"
// (patient recovery, Part C, 2 Nov 2026). Migration 133 has the table.
//
// A patient whose case needs a specialty we do not show used to find nothing
// that fit and leave. Now they can leave a lead — one tap, the number on the
// account — and the draft is KEPT so the lead can come back to it. Neurology is
// the case in point: hidden, 11 priced services, no doctor.
//
// TRIGGERS
//   1. the classifier. It is only ever shown the VISIBLE specialties
//      (services/classify_job.js), so it cannot name a hidden one today; what
//      it can do is be unsure (confidence under the floor, or no specialty at
//      all) — and a classification written before a specialty was hidden can
//      name one. Either opens the panel on the specialty step (coverageTrigger).
//   2. the patient picks "My specialty is not listed" on the specialty step
//      (web), or the app calls the draft API.
// WHAT THEY ARE OFFERED — a calm panel, not an error: "Tell me when it opens",
// "Choose a related specialty" (the open list), and, where one is bookable, a
// general read ("Report read — one question", Internal Medicine / Pediatrics)
// priced by services/case_intake_pricing — the same function a submit uses, so
// the price shown is the price charged.
// WHEN THE SPECIALTY OPENS — a superadmin runs "Notify waiting leads"
// (routes/superadmin_coverage.js): a dry-run count first, type-to-confirm, then
// one fixed message per lead on the Part A ladder (in-app, WhatsApp, email; the
// worker adds SMS when WhatsApp fails). Each lead is claimed before it is sent
// to, so a second run sends nothing. Nothing is ever sent automatically.

const crypto = require('crypto');

// The general reads offered in the panel, in order. Shown only when bookable.
const REPORT_READ_SERVICE_IDS = Object.freeze(['entry_read_internal-medicine', 'entry_read_pediatrics']);
const SOURCES = Object.freeze(['web', 'api', 'classifier']);
const MAX_TEXT = 200;

function _pg(deps) { return (deps && deps.pg) || require('../pg'); }

class CoverageLeadError extends Error {
  constructor(code, status, message) { super(message || code); this.code = code; this.status = status || 400; }
}

/** Hidden specialties a patient might be looking for (those with services). */
async function hiddenSpecialties(deps) {
  return (await _pg(deps).queryAll(
    `SELECT sp.id, sp.name, sp.name_ar FROM specialties sp
      WHERE COALESCE(sp.is_visible, true) = false
        AND EXISTS (SELECT 1 FROM services sv WHERE sv.specialty_id = sp.id)
      ORDER BY sp.name ASC`, [])) || [];
}

/** The open specialties: visible, with at least one bookable service. */
async function openSpecialties(deps) {
  const { serviceBookableClause } = require('./service_bookable');
  return (await _pg(deps).queryAll(
    `SELECT sp.id, sp.name, sp.name_ar FROM specialties sp
      WHERE COALESCE(sp.is_visible, true) = true
        AND EXISTS (SELECT 1 FROM services sv WHERE sv.specialty_id = sp.id AND ${serviceBookableClause('sv')})
      ORDER BY sp.name ASC`, [])) || [];
}

/**
 * The general-read offers with their REAL price for this patient, from
 * case_intake_pricing.resolveAndPriceIntake (standard tier). A service that is
 * not bookable, or cannot be priced, is simply left out.
 * @returns {Promise<Array<{serviceId, specialtyId, name, nameAr, price, currency}>>}
 */
async function reportReadOffers({ userId }, deps) {
  const pricing = (deps && deps.pricing) || require('./case_intake_pricing');
  const out = [];
  for (const serviceId of REPORT_READ_SERVICE_IDS) {
    try {
      const r = await pricing.resolveAndPriceIntake({ serviceId, urgencyTier: 'standard', userId, context: 'coverage_offer' });
      const intl = r.charge && r.charge.isIntl;
      out.push({
        serviceId: r.service.id,
        specialtyId: r.resolvedSpecialtyId || r.service.specialty_id,
        name: r.service.name,
        nameAr: r.service.name_ar || null,
        price: intl ? Number(r.charge.displayPrice) : Number(r.charge.egpBase),
        currency: intl ? String(r.charge.displayCurrency) : 'EGP',
      });
    } catch (_) { /* not bookable / not priceable here: not offered */ }
  }
  return out;
}

/**
 * Should the specialty step open the coverage panel by itself? Pure.
 * @param {{classification: object|null, thresholds?: {min:number}, visibleSpecialtyIds: string[]}} s
 * @returns {null | {reason: 'low_confidence'|'no_prediction'|'hidden_specialty', specialtyId?: string}}
 */
function coverageTrigger(s) {
  const c = s && s.classification;
  if (!c) return null; // still classifying, or failed: the plain grid + the "not listed" link
  const min = (s.thresholds && typeof s.thresholds.min === 'number') ? s.thresholds.min : 0.55;
  if (!c.specialty_id) return { reason: 'no_prediction' };
  const visible = new Set((s.visibleSpecialtyIds || []).map(String));
  if (!visible.has(String(c.specialty_id))) return { reason: 'hidden_specialty', specialtyId: String(c.specialty_id) };
  if (Number(c.confidence) < min) return { reason: 'low_confidence' };
  return null;
}

function _cleanText(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) || null;
}

/** The lead on a draft, if there is one. */
async function leadForOrder(orderId, deps) {
  if (!orderId) return null;
  return _pg(deps).queryOne('SELECT * FROM coverage_leads WHERE order_id = $1', [String(orderId)]);
}

/**
 * Record a lead — once per draft. Returns { created: boolean, lead }.
 * Throws CoverageLeadError NOT_FOUND / NOT_DRAFT / SPECIALTY_OPEN /
 * UNKNOWN_SPECIALTY / BAD_SOURCE.
 */
async function createLead(o, deps) {
  const pg = _pg(deps);
  const source = String(o.source || '');
  if (SOURCES.indexOf(source) === -1) throw new CoverageLeadError('BAD_SOURCE', 400);
  const patientId = String(o.patientId || '');
  const lang = o.lang === 'ar' ? 'ar' : 'en';
  let orderId = o.orderId ? String(o.orderId) : null;

  if (orderId) {
    // practice-ok: by id, the patient's own draft, ownership checked below.
    const order = await pg.queryOne('SELECT id, patient_id, status FROM orders WHERE id = $1 AND deleted_at IS NULL', [orderId]);
    if (!order || String(order.patient_id) !== patientId) throw new CoverageLeadError('NOT_FOUND', 404, 'Draft not found');
    if (String(order.status || '').toUpperCase() !== 'DRAFT') throw new CoverageLeadError('NOT_DRAFT', 409, 'This case has already been sent');
    const existing = await leadForOrder(orderId, deps);
    if (existing) return { created: false, lead: existing };
  }

  let wanted = o.wantedSpecialtyId ? String(o.wantedSpecialtyId) : null;
  if (wanted === 'other' || wanted === 'not_listed') wanted = null;
  if (wanted) {
    const sp = await pg.queryOne('SELECT id, is_visible FROM specialties WHERE id = $1', [wanted]);
    if (!sp) throw new CoverageLeadError('UNKNOWN_SPECIALTY', 400, 'Unknown specialty');
    if (sp.is_visible !== false) throw new CoverageLeadError('SPECIALTY_OPEN', 409, 'This specialty is open — you can choose it directly');
  }
  const text = _cleanText(o.wantedText);
  const user = await pg.queryOne('SELECT phone FROM users WHERE id = $1', [patientId]);

  const id = 'cl_' + crypto.randomBytes(9).toString('base64url');
  const inserted = await pg.queryOne(
    `INSERT INTO coverage_leads (id, patient_id, order_id, phone, wanted_specialty_id, wanted_text, lang, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [id, patientId, orderId, (user && user.phone) || null, wanted, text, lang, source]);
  if (!inserted) return { created: false, lead: await leadForOrder(orderId, deps) };

  // The draft-resume nudge stops for this draft (draft_nudges excludes it from
  // now on); one already queued is cancelled here.
  if (orderId) {
    try {
      await pg.execute(
        `UPDATE notifications SET status = 'skipped', response = $2
          WHERE dedupe_key LIKE $1 AND status IN ('queued', 'retry')`,
        ['draft_resume:' + orderId + ':%', JSON.stringify({ skipped: 'coverage_lead' })]);
    } catch (_) { /* the sweep's own exclusion still holds */ }
  }
  return { created: true, lead: inserted };
}

/** Leads waiting for this specialty: not told, not converted. */
async function waitingLeads(specialtyId, deps) {
  return (await _pg(deps).queryAll(
    `SELECT cl.*, u.email, u.phone AS user_phone, u.lang AS user_lang, u.role
       FROM coverage_leads cl LEFT JOIN users u ON u.id = cl.patient_id
      WHERE cl.wanted_specialty_id = $1 AND cl.notified_at IS NULL AND cl.converted_order_id IS NULL
      ORDER BY cl.created_at ASC`, [String(specialtyId)])) || [];
}

/** Per-specialty counts of waiting leads, for the superadmin page. */
async function waitingBySpecialty(deps) {
  return (await _pg(deps).queryAll(
    `SELECT sp.id, sp.name, sp.name_ar, COALESCE(sp.is_visible, true) AS is_visible, COUNT(cl.id)::int AS waiting
       FROM coverage_leads cl JOIN specialties sp ON sp.id = cl.wanted_specialty_id
      WHERE cl.notified_at IS NULL AND cl.converted_order_id IS NULL
      GROUP BY sp.id, sp.name, sp.name_ar, sp.is_visible
      ORDER BY waiting DESC, sp.name ASC`, [])) || [];
}

/**
 * "Notify waiting leads" for one specialty.
 *   dryRun        → { ok, dryRun: true, count, specialty } and nothing else
 *   confirm       → must be the specialty's English name, typed (any case)
 * Refuses unless the specialty is now visible. Idempotent: each lead is
 * claimed (notified_at) before anything is queued for it.
 * @returns {Promise<{ok: boolean, code?: string, count?: number, notified?: number, specialty?: object}>}
 */
async function notifyWaitingLeads(o, deps) {
  const pg = _pg(deps);
  const sp = await pg.queryOne('SELECT id, name, name_ar, COALESCE(is_visible, true) AS is_visible FROM specialties WHERE id = $1', [String(o.specialtyId || '')]);
  if (!sp) return { ok: false, code: 'UNKNOWN_SPECIALTY' };
  const leads = await waitingLeads(sp.id, deps);
  if (o.dryRun) return { ok: true, dryRun: true, count: leads.length, specialty: sp };
  if (sp.is_visible !== true) return { ok: false, code: 'NOT_OPEN', count: leads.length, specialty: sp };
  if (String(o.confirm || '').trim().toLowerCase() !== String(sp.name || '').trim().toLowerCase()) {
    return { ok: false, code: 'CONFIRM_MISMATCH', count: leads.length, specialty: sp };
  }

  const draftResume = (deps && deps.draftResume) || require('./draft_resume');
  const { queueNotification } = (deps && deps.notify) || require('../notify');
  const guard = (deps && deps.recipientGuard) || require('./recipientGuard');
  const appUrl = String(process.env.APP_URL || 'https://tashkheesa.com').replace(/\/+$/, '');
  let notified = 0;
  for (const lead of leads) {
    const claimed = await pg.queryOne(
      'UPDATE coverage_leads SET notified_at = NOW() WHERE id = $1 AND notified_at IS NULL RETURNING id', [lead.id]);
    if (!claimed) continue; // another run got there first
    if (String(lead.role || 'patient') !== 'patient') continue;
    let email = lead.email ? String(lead.email).trim() : null;
    if (email) { try { await guard.validateRecipient(email); } catch (_) { continue; } }

    const lang = lead.lang === 'ar' || lead.user_lang === 'ar' ? 'ar' : 'en';
    const payload = {
      lead_id: lead.id, lang,
      specialtyName: lang === 'ar' ? (sp.name_ar || sp.name) : sp.name,
      specialtyNameAr: sp.name_ar || null,
    };
    // The link reopens the kept draft when it is still a draft; otherwise the
    // wizard's start.
    // practice-ok: by id, the lead's own draft.
    const draft = lead.order_id
      ? await pg.queryOne("SELECT id FROM orders WHERE id = $1 AND deleted_at IS NULL AND UPPER(COALESCE(status, '')) = 'DRAFT'", [lead.order_id])
      : null;
    if (draft) {
      const tok = await draftResume.mintToken({ orderId: draft.id, patientId: lead.patient_id, level: 'lead' }, deps);
      payload.resume_token_id = tok.id;
      payload.case_id = draft.id;
    } else {
      payload.link = appUrl + '/patient/new-case';
      payload.resumeUrl = payload.link;
    }
    const key = 'coverage_lead:' + lead.id;
    const channels = ['internal'];
    if (lead.user_phone || lead.phone) channels.push('whatsapp');
    if (email) channels.push('email');
    for (const channel of channels) {
      await queueNotification({ channel, toUserId: lead.patient_id, orderId: draft ? draft.id : null,
        template: 'coverage_lead_open', dedupeKey: key, dedupe_key: key, response: payload, recipientLang: lang });
    }
    notified++;
  }
  return { ok: true, count: leads.length, notified, specialty: sp };
}

/**
 * Everything the web specialty step needs (patient.js step 3 → the
 * partials/patient/coverage_lead_panel view). Never throws past its caller's
 * try: a failure here must not cost the patient the specialty step.
 *   lead      the lead already left on this draft (the panel then says so)
 *   hidden    the specialties a patient can ask for
 *   trigger   coverageTrigger's verdict (opens the panel by itself)
 *   chosen    the specialty the panel is about: ?not_listed=<id|other>, or the
 *             hidden specialty a stale classification named
 *   offers    general reads with their real price (only once something is chosen)
 */
async function wizardContext(o, deps) {
  const lead = await leadForOrder(o.draftId, deps);
  const hidden = await hiddenSpecialties(deps);
  const trigger = coverageTrigger({ classification: o.classification, thresholds: o.thresholds, visibleSpecialtyIds: o.visibleSpecialtyIds });
  const pick = o.notListed ? String(o.notListed) : (trigger && trigger.reason === 'hidden_specialty' ? trigger.specialtyId : null);
  let chosen = null;
  if (pick === 'other') chosen = { id: 'other', name: null, name_ar: null };
  else if (pick) chosen = hidden.find((h) => String(h.id) === pick) || null;
  const leadSpecialty = lead && lead.wanted_specialty_id ? (hidden.find((h) => h.id === lead.wanted_specialty_id) || null) : null;
  const offers = (chosen && !lead) ? await reportReadOffers({ userId: o.userId }, deps) : [];
  // The panel was opened by the classifier, not by the patient's own pick:
  // a lead left from it is recorded with source 'classifier'.
  const viaClassifier = !o.notListed && !!trigger;
  return { lead, leadSpecialty, hidden, trigger, chosen, viaClassifier, wantedText: _cleanText(o.wantedText), offers, flash: o.leadFlash ? String(o.leadFlash) : null };
}

/** Leads whose draft has since been submitted: converted. Returns the count. */
async function markConverted(deps) {
  const rows = await _pg(deps).queryAll(
    `UPDATE coverage_leads cl SET converted_order_id = o.id
       FROM orders o
      WHERE cl.order_id = o.id AND cl.converted_order_id IS NULL
        AND o.deleted_at IS NULL AND o.submitted_at IS NOT NULL
        AND UPPER(COALESCE(o.status, '')) <> 'DRAFT'
    RETURNING cl.id`, []);
  return (rows || []).length;
}

module.exports = {
  CoverageLeadError, REPORT_READ_SERVICE_IDS,
  hiddenSpecialties, openSpecialties, reportReadOffers, coverageTrigger,
  leadForOrder, createLead, waitingLeads, waitingBySpecialty, notifyWaitingLeads, markConverted, wizardContext,
};
