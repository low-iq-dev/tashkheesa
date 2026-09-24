'use strict';

/**
 * Tashkheesa — the doctor app's "me" surface: /api/v1/doctor/*
 *
 * Profile, appearance, availability, services, signature, phrase library,
 * feedback and account requests. Everything here is a SECOND CLIENT onto the
 * same users row and the same helpers the web portal already uses:
 *
 *   - availability is the existing is_paused mechanism the accept gate
 *     (services/doctor_eligibility) and auto_assign already respect;
 *   - services reuse services/doctor_service_catalog + the exact transaction
 *     body of POST /portal/doctor/services;
 *   - tiers reuse the whitelist and the UPDATE of POST /portal/doctor/turnaround;
 *   - the signature reuses storage.uploadFile / deleteFile with the web's
 *     PNG/JPG <= 2MB rule;
 *   - feedback / ops tickets / closure requests land in contact_submissions,
 *     the same queue the public contact form writes to.
 *
 * Every portal module is read at CALL time (module.property inside the
 * handler) rather than destructured at require time, so the hermetic tests
 * can stub a function by assignment on the real module object.
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { requireJWT, requireRole } = require('../../middleware/requireJWT');

// The portal's own queue builders. Required lazily inside the handlers:
// routes/doctor.js requires this file's siblings at module load, and a
// top-level require here would close a cycle through src/server.js.
function queue() {
  return require('../doctor')._queue;
}

const BIO_MAX = 2000;
const MESSAGE_MAX = 2000;
const THEMES = ['dark', 'light', 'system'];
const SIG_MIME_OK = { 'image/png': 'png', 'image/jpeg': 'jpg' };
const SIG_MAX_BYTES = 2 * 1024 * 1024;

// The doctor's own pause. Anything else in pause_reason (auto:sla_breach…,
// an operator's free text, NULL from a legacy admin pause) was applied by
// the platform and only the platform lifts it.
const SELF_PAUSE_REASON = 'doctor_self';

function parseJsonish(v) {
  if (v == null || typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return v; }
}

function stringArray(raw) {
  if (raw == null || raw === '') return [];
  const arr = Array.isArray(raw) ? raw : parseJsonish(String(raw));
  if (!Array.isArray(arr)) return null; // present but not a list
  return arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
}

function iso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = function (db, helpers) {
  const { safeGet, safeAll, safeRun } = helpers || {};
  const router = express.Router();

  router.use(requireJWT);
  router.use(requireRole('doctor'));

  const meId = (req) => (req.user && req.user.id ? String(req.user.id) : '');

  // Everything a doctor may legitimately hold about themselves. No password /
  // otp / token columns — the list is explicit so a future column never leaks
  // by default.
  const DOCTOR_COLUMNS = `id, name, name_ar, email, phone, country_code, specialty_id,
              years_of_experience, medical_license_number, license_country,
              spoken_languages, sub_specialties, bio, bio_ar, profile_photo_url,
              signature_url, lang, appearance_preference, onboarding_complete,
              approved_at, is_paused, paused_at, pause_reason, sla_tiers_supported,
              sla_tiers_confirmed_at, max_active_cases, is_available, created_at`;

  async function liveDoctorRow(doctorId) {
    const row = await safeGet(
      `SELECT ${DOCTOR_COLUMNS} FROM users WHERE id = $1 AND role = 'doctor' LIMIT 1`,
      [doctorId], null
    );
    if (!row) return null;
    row.spoken_languages = parseJsonish(row.spoken_languages);
    row.sub_specialties = parseJsonish(row.sub_specialties);
    return row;
  }

  function logErr(err, req, context, extra) {
    try {
      require('../../logger').logErrorToDb(err, Object.assign({
        context, requestId: req.requestId, userId: meId(req),
        url: req.originalUrl, method: req.method, category: 'doctor_case',
      }, extra || {}));
    } catch (_) { /* logging must never fail the request */ }
  }

  // ─── GET /profile ─────────────────────────────────────────
  router.get('/profile', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const row = await liveDoctorRow(doctorId);
    if (!row) return res.fail('Doctor not found', 404, 'NOT_FOUND');

    let specialty = null;
    if (row.specialty_id) {
      specialty = await safeGet('SELECT id, name, name_ar FROM specialties WHERE id = $1', [row.specialty_id], null);
    }

    // Same query the web profile page runs: visible reviews only.
    let rating = null;
    const stats = await safeGet(
      'SELECT AVG(rating) AS avg_rating, COUNT(*) AS count FROM reviews WHERE doctor_id = $1 AND is_visible = true',
      [doctorId], null
    );
    if (stats && Number(stats.count) > 0) {
      rating = { avg: stats.avg_rating != null ? Number(stats.avg_rating) : null, count: Number(stats.count) || 0 };
    }

    const doctor = Object.assign({}, row);
    delete doctor.paused_at;
    delete doctor.sla_tiers_confirmed_at;
    return res.ok({
      doctor: Object.assign(doctor, {
        onboarding_complete: row.onboarding_complete === true,
        is_paused: row.is_paused === true,
        is_available: row.is_available !== false,
        approved_at: iso(row.approved_at),
        created_at: iso(row.created_at),
      }),
      specialty_name: specialty ? (specialty.name || '') : '',
      specialty_name_ar: specialty ? (specialty.name_ar || null) : null,
      rating,
      // The portal's approval IS the licence check: an operator verifies the
      // licence before approved_at is stamped, and nothing else stamps it.
      licence_verified: !!row.approved_at,
    });
  });

  // ─── PATCH /profile ───────────────────────────────────────
  // The web profile form owns the credential fields (name, specialty,
  // licence, experience). The app edits only the patient-facing text.
  const PATCHABLE = ['bio', 'bio_ar', 'spoken_languages', 'name_ar'];
  router.patch('/profile', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const keys = Object.keys(body);
    const foreign = keys.filter((k) => !PATCHABLE.includes(k));
    if (foreign.length) {
      return res.fail('Field not editable from the app: ' + foreign.join(', '), 400, 'FIELD_NOT_EDITABLE');
    }
    if (!keys.length) return res.fail('Nothing to update', 400, 'INVALID_REQUEST');

    const sets = [];
    const params = [doctorId];
    const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    const strN = (v) => { const s = v == null ? '' : String(v).trim(); return s ? s : null; };

    if ('bio' in body) { const s = strN(body.bio); push('bio', s ? s.slice(0, BIO_MAX) : null); }
    if ('bio_ar' in body) { const s = strN(body.bio_ar); push('bio_ar', s ? s.slice(0, BIO_MAX) : null); }
    if ('name_ar' in body) push('name_ar', strN(body.name_ar));
    if ('spoken_languages' in body) {
      const langs = stringArray(body.spoken_languages);
      if (langs === null) return res.fail('spoken_languages must be a list', 400, 'INVALID_REQUEST');
      params.push(JSON.stringify(langs));
      sets.push(`spoken_languages = $${params.length}::jsonb`);
    }

    try {
      await safeRun(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 AND role = 'doctor'`, params);
    } catch (err) {
      logErr(err, req, 'api.doctor_me.profile_patch');
      return res.fail('Profile could not be saved', 500, 'PROFILE_SAVE_FAILED');
    }
    return res.ok({ ok: true });
  });

  // ─── PUT /appearance ──────────────────────────────────────
  router.put('/appearance', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const theme = String((req.body && req.body.theme) || '').trim().toLowerCase();
    // Vocabulary lives here, not in a CHECK constraint (migration 111).
    if (!THEMES.includes(theme)) return res.fail('theme must be dark, light or system', 400, 'INVALID_THEME');
    try {
      await safeRun(`UPDATE users SET appearance_preference = $2 WHERE id = $1 AND role = 'doctor'`, [doctorId, theme]);
    } catch (err) {
      logErr(err, req, 'api.doctor_me.appearance');
      return res.fail('Appearance could not be saved', 500, 'APPEARANCE_SAVE_FAILED');
    }
    return res.ok({ ok: true, theme });
  });

  // ─── GET /availability ────────────────────────────────────
  router.get('/availability', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const row = await liveDoctorRow(doctorId);
    if (!row) return res.fail('Doctor not found', 404, 'NOT_FOUND');

    const q = queue();
    const lifecycle = require('../../case_lifecycle');
    const held = new Set(q.readDoctorTiers(row.sla_tiers_supported));
    const tiers = q.DOCTOR_SLA_TIERS.map((tier) => ({
      tier,
      label_hours: lifecycle.slaHoursForTier(tier),
      on: held.has(tier),
      window_note: null,
    }));

    let currentlyHeld = 0;
    try { currentlyHeld = await q.countActiveCasesForDoctor(doctorId); }
    catch (err) { logErr(err, req, 'api.doctor_me.availability_count'); }

    return res.ok({
      taking_cases: row.is_paused !== true,
      max_active: Number(row.max_active_cases) || 0,
      currently_held: currentlyHeld,
      tiers,
      away: [],                    // the portal has no away-dates concept
      self_pause_supported: true,
      away_supported: false,
      max_active_editable: false,  // caps are set by the platform
      pause_reason: row.is_paused === true ? (row.pause_reason || null) : null,
      paused_by_self: row.is_paused === true && row.pause_reason === SELF_PAUSE_REASON,
    });
  });

  // ─── PUT /availability/taking-cases ───────────────────────
  // The doctor's SELF-pause, on the existing is_paused flag. Pausing is
  // always allowed. Unpausing is allowed only when the pause is the doctor's
  // own: an admin or auto pause (any other pause_reason) stays until ops
  // lift it. services/admin_doctor_pause.setDoctorPause is not reused here —
  // it audits as an operator action and rejects a no-op with 409, and a
  // doctor toggling their own switch twice is not an error.
  router.put('/availability/taking-cases', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const on = req.body ? req.body.on : undefined;
    if (typeof on !== 'boolean') return res.fail('on must be a boolean', 400, 'INVALID_REQUEST');

    const row = await safeGet(
      `SELECT is_paused, pause_reason FROM users WHERE id = $1 AND role = 'doctor'`, [doctorId], null
    );
    if (!row) return res.fail('Doctor not found', 404, 'NOT_FOUND');

    try {
      if (!on) {
        // Idempotent: a doctor already paused by the platform keeps that
        // reason — overwriting it would let the next on=true lift it.
        if (row.is_paused !== true) {
          await safeRun(
            `UPDATE users SET is_paused = true, paused_at = NOW(), pause_reason = $2
              WHERE id = $1 AND role = 'doctor'`,
            [doctorId, SELF_PAUSE_REASON]
          );
        }
        return res.ok({ taking_cases: false });
      }
      if (row.is_paused === true) {
        if (row.pause_reason !== SELF_PAUSE_REASON) {
          return res.fail('Paused by the platform: ' + (row.pause_reason || 'admin'), 409, 'PAUSED_BY_PLATFORM');
        }
        await safeRun(
          `UPDATE users SET is_paused = false, paused_at = NULL, pause_reason = NULL
            WHERE id = $1 AND role = 'doctor' AND pause_reason = $2`,
          [doctorId, SELF_PAUSE_REASON]
        );
      }
      return res.ok({ taking_cases: true });
    } catch (err) {
      logErr(err, req, 'api.doctor_me.taking_cases');
      return res.fail('Availability could not be saved', 500, 'AVAILABILITY_SAVE_FAILED');
    }
  });

  // ─── PUT /availability/tiers ──────────────────────────────
  // Same whitelist, same floor and same UPDATE as POST /portal/doctor/turnaround.
  router.put('/availability/tiers', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    let posted = req.body ? req.body.tiers : undefined;
    if (posted == null) posted = [];
    else if (!Array.isArray(posted)) posted = [posted];
    const wanted = new Set(posted.map((x) => String(x).trim().toLowerCase()));
    // Empty cannot mean "no tiers": that doctor is invisible to assignment at
    // every speed. Standard is the floor, exactly as the web does.
    let tiers = queue().DOCTOR_SLA_TIERS.filter((t) => wanted.has(t));
    if (!tiers.length) tiers = ['standard'];
    try {
      await safeRun(
        `UPDATE users
            SET sla_tiers_supported    = $2::jsonb,
                sla_tiers_confirmed_at = NOW()
          WHERE id = $1 AND role = 'doctor'`,
        [doctorId, JSON.stringify(tiers)]
      );
    } catch (err) {
      logErr(err, req, 'api.doctor_me.tiers');
      return res.fail('Turnaround tiers could not be saved', 500, 'TIERS_SAVE_FAILED');
    }
    return res.ok({ tiers });
  });

  // Caps are set by the platform (users.max_active_cases is admin-managed).
  router.put('/availability/max-active', (req, res) => res.fail('Not supported', 501, 'NOT_SUPPORTED'));
  // The portal has no away-dates concept; self-pause is the only switch.
  router.post('/availability/away', (req, res) => res.fail('Not supported', 501, 'NOT_SUPPORTED'));

  // ─── GET /services ────────────────────────────────────────
  router.get('/services', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const row = await safeGet(`SELECT specialty_id FROM users WHERE id = $1 AND role = 'doctor'`, [doctorId], null);
    if (!row) return res.fail('Doctor not found', 404, 'NOT_FOUND');
    const specialtyId = row.specialty_id ? String(row.specialty_id) : '';

    let catalog;
    try {
      catalog = await require('../../pg').withTransaction((client) =>
        require('../../services/doctor_service_catalog').loadDoctorServiceCatalog(client, { doctorId, specialtyId })
      );
    } catch (err) {
      logErr(err, req, 'api.doctor_me.services_load');
      return res.fail('Services could not be loaded', 500, 'SERVICES_LOAD_FAILED');
    }

    let onCount = 0, total = 0;
    const specialties = (catalog.groups || []).map((g) => ({
      id: g.specialtyId,
      name: g.specialtyName || '',
      name_ar: g.specialtyNameAr || null,
      services: (g.services || []).map((s) => {
        total += 1;
        if (s.ticked) onCount += 1;
        return {
          service_id: s.id,
          name: s.name,
          name_ar: s.name_ar,
          doctor_fee: s.doctor_fee != null ? Number(s.doctor_fee) : null,
          sla_hours: s.sla_hours != null ? Number(s.sla_hours) : null,
          on: !!s.ticked,
          coming_soon: !s.is_visible,
        };
      }),
    }));
    return res.ok({ specialties, on_count: onCount, total_count: total, union_note: catalog.isEmpty ? 'empty_catalog' : null });
  });

  // ─── PUT /services ────────────────────────────────────────
  // service_ids is the FULL set that should be on (set-replace, as the web).
  router.put('/services', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    let ticked = req.body ? req.body.service_ids : undefined;
    if (ticked == null) ticked = [];
    else if (!Array.isArray(ticked)) ticked = [ticked];
    ticked = ticked.map((x) => String(x)).filter(Boolean);
    const confirmEmpty = !!(req.body && req.body.confirm_empty === true);
    if (!ticked.length && !confirmEmpty) return res.fail('Confirm an empty selection', 400, 'CONFIRM_EMPTY');

    const row = await safeGet(`SELECT specialty_id FROM users WHERE id = $1 AND role = 'doctor'`, [doctorId], null);
    if (!row) return res.fail('Doctor not found', 404, 'NOT_FOUND');
    const specialtyId = row.specialty_id ? String(row.specialty_id) : '';

    const catalogMod = require('../../services/doctor_service_catalog');
    const sync = require('../../services/services_coming_soon_sync');
    try {
      const onCount = await require('../../pg').withTransaction(async (client) => {
        // Same body as POST /portal/doctor/services.
        const cat = await catalogMod.loadDoctorServiceCatalog(client, { doctorId, specialtyId });
        const held = (await client.query('SELECT service_id FROM doctor_services WHERE doctor_id = $1', [doctorId]))
          .rows.map((r) => String(r.service_id));
        const diff = catalogMod.diffServiceSelection(cat.allowedIds, held, ticked);
        if (diff.rejected.length) {
          const err = new Error('SERVICE_NOT_ALLOWED');
          err.kind = 'rejected';
          err.rejected = diff.rejected;
          throw err;
        }
        for (const id of diff.toInsert) {
          await client.query(
            'INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [doctorId, id]
          );
        }
        if (diff.toDelete.length) {
          await client.query(
            'DELETE FROM doctor_services WHERE doctor_id = $1 AND service_id = ANY($2)',
            [doctorId, diff.toDelete]
          );
        }
        // Any explicit save (incl. confirmed-empty) marks onboarding complete.
        await client.query('UPDATE users SET onboarding_complete = true WHERE id = $1', [doctorId]);
        // Re-sync coming_soon in the SAME txn (contract: resyncComingSoon(client)).
        await sync.resyncComingSoon(client);
        return new Set(ticked.filter((id) => cat.allowedIds.has(id))).size;
      });
      return res.ok({ on_count: onCount });
    } catch (err) {
      if (err && err.kind === 'rejected') {
        return res.fail('Service not available to you: ' + err.rejected.join(', '), 400, 'SERVICE_NOT_ALLOWED');
      }
      logErr(err, req, 'api.doctor_me.services_save');
      return res.fail('Services could not be saved', 500, 'SERVICES_SAVE_FAILED');
    }
  });

  // ─── PUT /signature ───────────────────────────────────────
  // Body { data } is a data-URL or raw base64 PNG/JPG. Same rules as the web
  // upload: PNG/JPG only, <= 2MB, must parse as an image.
  router.put('/signature', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const raw = req.body && typeof req.body.data === 'string' ? req.body.data.trim() : '';
    if (!raw) return res.fail('No image data', 400, 'INVALID_IMAGE');

    let declaredMime = null;
    let b64 = raw;
    const m = /^data:([a-z0-9.+/-]+);base64,(.*)$/is.exec(raw);
    if (m) { declaredMime = m[1].toLowerCase(); b64 = m[2]; }
    else if (req.body.mime_type) declaredMime = String(req.body.mime_type).toLowerCase();
    b64 = b64.replace(/\s+/g, '');
    // 4 base64 chars per 3 bytes: refuse before decoding what cannot fit.
    if (b64.length > Math.ceil(SIG_MAX_BYTES / 3) * 4 + 4) return res.fail('Signature is too large (max 2 MB)', 413, 'IMAGE_TOO_LARGE');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return res.fail('Image data is not valid base64', 400, 'INVALID_IMAGE');
    const buffer = Buffer.from(b64, 'base64');
    if (!buffer.length) return res.fail('Image data is empty', 400, 'INVALID_IMAGE');
    if (buffer.length > SIG_MAX_BYTES) return res.fail('Signature is too large (max 2 MB)', 413, 'IMAGE_TOO_LARGE');

    // The bytes decide the type, not the header the client sent.
    let dims = null;
    try { dims = require('image-size').imageSize(buffer); } catch (_) { dims = null; }
    if (!dims || !dims.width || !dims.height) return res.fail('Could not read the image', 400, 'INVALID_IMAGE');
    const sniffed = dims.type === 'png' ? 'image/png' : (dims.type === 'jpg' || dims.type === 'jpeg') ? 'image/jpeg' : null;
    const declaredOk = !declaredMime || declaredMime === sniffed || (declaredMime === 'image/jpg' && sniffed === 'image/jpeg');
    if (!sniffed || !declaredOk) return res.fail('Use a PNG or JPG image', 400, 'INVALID_IMAGE');
    const ext = SIG_MIME_OK[sniffed];

    const storage = require('../../storage');
    const tsName = Date.now() + '.' + ext;
    const folder = 'doctor-signatures/' + doctorId;
    try {
      const key = await storage.uploadFile({ buffer, originalname: tsName, mimetype: sniffed, folder, filename: tsName });
      // Best-effort cleanup of the previous signature, as the web does.
      const prev = await safeGet('SELECT signature_url FROM users WHERE id = $1', [doctorId], null);
      const prevKey = prev && prev.signature_url;
      if (prevKey && String(prevKey).indexOf('doctor-signatures/') === 0 && prevKey !== key) {
        try { await storage.deleteFile(prevKey); } catch (_) { /* best-effort */ }
      }
      await safeRun('UPDATE users SET signature_url = $1 WHERE id = $2', [key, doctorId]);
      return res.ok({ ok: true, signature_url: key });
    } catch (err) {
      logErr(err, req, 'api.doctor_me.signature_upload', { category: 'doctor_upload' });
      return res.fail('Signature could not be saved', 500, 'SIGNATURE_SAVE_FAILED');
    }
  });

  // ─── DELETE /signature ────────────────────────────────────
  router.delete('/signature', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    try {
      const prev = await safeGet('SELECT signature_url FROM users WHERE id = $1', [doctorId], null);
      const prevKey = prev && prev.signature_url;
      if (prevKey && String(prevKey).indexOf('doctor-signatures/') === 0) {
        try { await require('../../storage').deleteFile(prevKey); } catch (_) { /* best-effort */ }
      }
      await safeRun('UPDATE users SET signature_url = NULL WHERE id = $1', [doctorId]);
      return res.ok({ ok: true });
    } catch (err) {
      logErr(err, req, 'api.doctor_me.signature_remove', { category: 'doctor_upload' });
      return res.fail('Signature could not be removed', 500, 'SIGNATURE_REMOVE_FAILED');
    }
  });

  // ─── Phrase library ───────────────────────────────────────
  // doctor_phrases has RLS enabled; the portal connects as the owner role, so
  // the doctor_id predicate here is the access rule.
  const PHRASE_COLUMNS = 'id, text_en, text_ar, category, times_used, created_at';

  function phraseOut(r) {
    return {
      id: r.id, text_en: r.text_en, text_ar: r.text_ar || null,
      category: r.category || 'mine', times_used: Number(r.times_used) || 0, created_at: iso(r.created_at),
    };
  }

  router.get('/phrases', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const rows = await safeAll(
      `SELECT ${PHRASE_COLUMNS} FROM doctor_phrases WHERE doctor_id = $1 ORDER BY created_at DESC, id DESC`,
      [doctorId], []
    );
    return res.ok({ phrases: (rows || []).map(phraseOut) });
  });

  router.post('/phrases', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const body = req.body || {};
    const textEn = String(body.text_en || '').trim();
    if (!textEn) return res.fail('Phrase text is required', 400, 'EMPTY_PHRASE');
    const textAr = String(body.text_ar || '').trim() || null;
    const category = String(body.category || '').trim() || 'mine';
    try {
      const r = await safeRun(
        `INSERT INTO doctor_phrases (id, doctor_id, text_en, text_ar, category)
         VALUES ('phrase-' || gen_random_uuid(), $1, $2, $3, $4)
         RETURNING ${PHRASE_COLUMNS}`,
        [doctorId, textEn.slice(0, MESSAGE_MAX), textAr ? textAr.slice(0, MESSAGE_MAX) : null, category.slice(0, 64)]
      );
      const row = r && r.rows && r.rows[0];
      if (!row) throw new Error('phrase insert returned no row');
      return res.ok({ phrase: phraseOut(row) });
    } catch (err) {
      logErr(err, req, 'api.doctor_me.phrase_insert');
      return res.fail('Phrase could not be saved', 500, 'PHRASE_SAVE_FAILED');
    }
  });

  router.post('/phrases/:id/used', async (req, res) => {
    const doctorId = meId(req);
    const id = String((req.params && req.params.id) || '');
    if (!doctorId || !id) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    try {
      const r = await safeRun(
        `UPDATE doctor_phrases SET times_used = times_used + 1, updated_at = NOW()
          WHERE id = $1 AND doctor_id = $2`,
        [id, doctorId]
      );
      // Another doctor's phrase and a missing phrase look the same.
      if (!r || !r.rowCount) return res.fail('Phrase not found', 404, 'PHRASE_NOT_FOUND');
      return res.ok({ ok: true });
    } catch (err) {
      logErr(err, req, 'api.doctor_me.phrase_used');
      return res.fail('Phrase could not be updated', 500, 'PHRASE_SAVE_FAILED');
    }
  });

  // ─── Feedback / tickets / closure → contact_submissions ───
  // One row per submission in the same queue the public contact form fills,
  // so ops works app feedback from the same list. Fail-loud: unlike the
  // public form there is no second mail path, so a failed INSERT is a 500.
  async function insertSubmission(req, doctor, { subject, message, source }) {
    const id = randomUUID();
    await safeRun(
      'INSERT INTO contact_submissions ' +
      '(id, name, email, subject, message, status, source, lang, ip_address, user_agent, request_id) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        id, doctor.name || doctor.id, doctor.email || '', subject, message, 'new', source,
        doctor.lang === 'ar' ? 'ar' : 'en',
        req.ip || null,
        String((typeof req.get === 'function' && req.get('user-agent')) || (req.headers && req.headers['user-agent']) || '').slice(0, 500) || null,
        req.requestId || null,
      ]
    );
    return id;
  }

  async function doctorIdentity(doctorId) {
    return await safeGet(`SELECT id, name, email, lang FROM users WHERE id = $1 AND role = 'doctor'`, [doctorId], null);
  }

  const FEEDBACK_KINDS = ['bug', 'idea', 'case', 'other'];
  router.post('/feedback', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const body = req.body || {};
    const message = String(body.message || '').trim();
    if (message.length < 3) return res.fail('Message is too short', 400, 'EMPTY_MESSAGE');
    const kind = FEEDBACK_KINDS.includes(String(body.kind)) ? String(body.kind) : 'other';
    const doctor = await doctorIdentity(doctorId);
    if (!doctor) return res.fail('Doctor not found', 404, 'NOT_FOUND');

    const meta = {
      from_route: body.from_route == null ? null : String(body.from_route).slice(0, 200),
      client: body.client && typeof body.client === 'object' ? body.client : null,
      doctor_id: doctorId,
    };
    let id;
    try {
      id = await insertSubmission(req, doctor, {
        subject: 'Doctor app · ' + kind,
        message: message.slice(0, MESSAGE_MAX) + '\n\n' + JSON.stringify(meta),
        source: 'doctor_app',
      });
    } catch (err) {
      logErr(err, req, 'api.doctor_me.feedback');
      return res.fail('Feedback could not be saved', 500, 'FEEDBACK_SAVE_FAILED');
    }
    // Best-effort: the row is the record; a push failure never fails the request.
    try {
      await require('../../services/ops_push').pushOpsEvent({
        kind: 'doctor_app_feedback',
        dedupeKey: 'doctor_feedback:' + id,
        title: 'Doctor app feedback (' + kind + ') — ' + (doctor.name || doctorId),
        body: message.slice(0, 200),
        data: { submissionId: id, doctorId, kind },
      });
    } catch (err) {
      console.error('[doctor_me.feedback] ops push failed:', err && err.message);
    }
    return res.ok({ ok: true, id });
  });

  router.post('/ops-ticket', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const body = req.body || {};
    const subject = String(body.subject || '').trim();
    if (subject.length < 3) return res.fail('Subject is too short', 400, 'EMPTY_MESSAGE');
    const orderId = body.order_id ? String(body.order_id).slice(0, 80) : null;
    const doctor = await doctorIdentity(doctorId);
    if (!doctor) return res.fail('Doctor not found', 404, 'NOT_FOUND');

    let id;
    try {
      id = await insertSubmission(req, doctor, {
        subject: 'Ops · ' + subject.slice(0, 200),
        message: (String(body.message || '').trim().slice(0, MESSAGE_MAX) || subject.slice(0, MESSAGE_MAX)) +
                 '\n\n' + JSON.stringify({ order_id: orderId, doctor_id: doctorId }),
        source: 'doctor_app_ops',
      });
    } catch (err) {
      logErr(err, req, 'api.doctor_me.ops_ticket');
      return res.fail('Ticket could not be saved', 500, 'TICKET_SAVE_FAILED');
    }
    // notify.js does not validate template names on the internal channel: an
    // unregistered one falls through to humanizeTemplate() in
    // notify/notification_titles.js ("Admin Doctor Ops Ticket"). Registering a
    // proper title there is a one-line follow-up outside this file; the
    // closest registered admin template is admin_additional_files_requested.
    try {
      await require('../../notify').notifyAdmins({
        template: 'admin_doctor_ops_ticket',
        payload: { submission_id: id, doctor_id: doctorId, doctor_name: doctor.name || null, subject, order_id: orderId },
        dedupeKey: 'ops_ticket:' + id,
        orderId: orderId || undefined,
      });
    } catch (err) {
      console.error('[doctor_me.ops_ticket] notifyAdmins failed:', err && err.message);
    }
    return res.ok({ ok: true, id });
  });

  // A request only. Nothing is deleted here — erasure runs from the admin
  // tools after a human confirms, the same path /delete-account takes.
  router.post('/account/closure', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const note = String((req.body && (req.body.note || req.body.message)) || '').trim().slice(0, MESSAGE_MAX);
    const doctor = await doctorIdentity(doctorId);
    if (!doctor) return res.fail('Doctor not found', 404, 'NOT_FOUND');

    let id;
    try {
      id = await insertSubmission(req, doctor, {
        subject: 'Account closure request',
        message: (note || 'Account closure requested from the doctor app.') +
                 '\n\n' + JSON.stringify({ doctor_id: doctorId }),
        source: 'doctor_app_closure',
      });
    } catch (err) {
      logErr(err, req, 'api.doctor_me.closure');
      return res.fail('Request could not be saved', 500, 'CLOSURE_SAVE_FAILED');
    }

    // Same durable record + privacy mailbox as POST /delete-account.
    try {
      await require('../../logger').logErrorToDb(new Error('account deletion request (doctor app)'), {
        level: 'info',
        category: 'account_deletion_request',
        requestId: req.requestId,
        userId: doctorId,
        url: req.originalUrl,
        method: req.method,
        requestEmail: doctor.email || 'none',
        requestNote: note || 'none',
        submissionId: id,
      });
    } catch (e) {
      console.error('[doctor_me.closure] failed to persist request:', e && e.message);
    }
    try {
      await require('../../services/emailService').sendMail({
        to: process.env.PRIVACY_NOTIFY_EMAIL || 'privacy@tashkheesa.com',
        subject: 'Account closure request (doctor app) — verify before acting',
        text: 'A doctor requested account closure from the app.\n\n' +
              'Doctor: ' + (doctor.name || doctorId) + ' (' + doctorId + ')\n' +
              'Email: ' + (doctor.email || 'not given') + '\n' +
              'Note: ' + (note || 'none') + '\n\n' +
              'DO NOT delete on the strength of this request alone. Confirm with the doctor, ' +
              'check for live cases, then run the erasure from the admin tools.',
      });
    } catch (err) {
      console.error('[doctor_me.closure] email send failed:', err && err.message);
    }
    return res.ok({ ok: true, id });
  });

  // No notification-preference or quiet-hours columns exist on users.
  router.get('/notification-prefs', (req, res) => res.fail('Not supported', 501, 'NOT_SUPPORTED'));
  router.put('/notification-prefs', (req, res) => res.fail('Not supported', 501, 'NOT_SUPPORTED'));

  return router;
};
