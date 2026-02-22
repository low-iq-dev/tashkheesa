const express = require('express');
const { randomUUID, randomBytes } = require('crypto');
const { queryOne, queryAll, execute } = require('../pg');
const { hash } = require('../auth');

const router = express.Router();

async function getLoggedInPatient(req) {
  try {
    // Prefer whatever auth middleware already attached.
    if (req.user && req.user.role === 'patient') return req.user;

    // Fallback: session-based user id.
    const userId = req.session && (req.session.userId || req.session.user_id || req.session.uid);
    if (!userId) return null;

    const u = await queryOne("SELECT * FROM users WHERE id = $1 AND role = 'patient'", [userId]);
    return u || null;
  } catch (e) {
    return null;
  }
}

function roleHome(role) {
  switch (String(role || '').toLowerCase()) {
    case 'doctor':
      return '/portal/doctor';
    case 'admin':
      return '/admin';
    case 'superadmin':
      return '/superadmin';
    case 'patient':
      return '/dashboard';
    default:
      return '/';
  }
}

function denyOrRedirect(req, res, target) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return res.status(403).type('text/plain').send('Forbidden');
  }
  return res.redirect(target);
}

async function requirePatientLogin(req, res) {
  // If a non-patient is logged in (doctor/admin/superadmin), fail fast on non-GET.
  // For GET, send them to their home instead of rendering the patient intake.
  if (req.user && req.user.role && String(req.user.role).toLowerCase() !== 'patient') {
    denyOrRedirect(req, res, roleHome(req.user.role));
    return null;
  }

  const patient = await getLoggedInPatient(req);
  if (!patient) {
    const nextUrl = encodeURIComponent(req.originalUrl || '/intake');
    denyOrRedirect(req, res, `/login?next=${nextUrl}`);
    return null;
  }

  return patient;
}

// Best-effort audit logger. Intake should never 500 if audit logging is unavailable.
async function logOrderEvent({ orderId, label, meta, actorUserId, actorRole }) {
  try {
    const id = randomUUID();
    const nowIso = new Date().toISOString();

    // This table/column set is expected in the portal schema. If it differs locally,
    // we swallow the error to avoid breaking intake.
    await execute(
      `INSERT INTO order_events (
         id,
         order_id,
         label,
         meta,
         actor_user_id,
         actor_role,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, orderId, label, meta || null, actorUserId || null, actorRole || null, nowIso]
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('logOrderEvent skipped:', e && e.message ? e.message : e);
  }
}

function generateTempPassword() {
  // Simple, predictable complexity: includes uppercase, lowercase, digit, and symbol.
  // Example: Tk!a1b2c37aA
  const hex = randomBytes(6).toString('hex'); // 12 chars
  return `Tk!${hex}7aA`;
}

async function fetchServices() {
  return await queryAll(
    `SELECT sv.id,
            sv.name AS service_name,
            sv.base_price,
            sv.currency,
            sv.doctor_fee,
            sv.payment_link,
            s.id AS specialty_id,
            s.name AS specialty_name
     FROM services sv
     LEFT JOIN specialties s ON sv.specialty_id = s.id
     ORDER BY s.name ASC, sv.name ASC`
  );
}

async function findOrCreatePatient({ fullName, email, phone, preferredLang }) {
  const existing = await queryOne(
    "SELECT * FROM users WHERE email = $1 AND role = 'patient'",
    [email]
  );

  if (existing) {
    return { patient: existing, created: false, tempPassword: null };
  }

  const id = randomUUID();
  const nowIso = new Date().toISOString();
  const tempPassword = generateTempPassword();

  await execute(
    `INSERT INTO users (id, email, password_hash, name, role, phone, lang, is_active, created_at)
     VALUES ($1, $2, $3, $4, 'patient', $5, $6, true, $7)`,
    [id, email, hash(tempPassword), fullName || 'New Patient', phone || null, preferredLang === 'ar' ? 'ar' : 'en', nowIso]
  );

  const patient = await queryOne('SELECT * FROM users WHERE id = $1', [id]);
  return { patient, created: true, tempPassword };
}

function mapSlaHours(slaType) {
  if (slaType === 'vip') return 24;
  return 72;
}

router.get('/intake', async (req, res) => {
  const patient = await requirePatientLogin(req, res);
  if (!patient) return; // redirected/forbidden

  const services = await fetchServices();
  res.render('intake_form', {
    services,
    error: null,
    form: {
      full_name: patient.name || '',
      email: patient.email || '',
      phone: patient.phone || '',
      preferred_lang: patient.lang || 'en'
    }
  });
});

router.post('/intake', async (req, res) => {
  const patient = await requirePatientLogin(req, res);
  if (!patient) return; // redirected/forbidden

  const body = req.body || {};

  // Only allow selecting service/SLA/notes from the form.
  // Identity comes from the logged-in patient.
  const fullName = (patient.name || '').trim() || 'Patient';
  const email = (patient.email || '').trim().toLowerCase();
  const phone = (body.phone || '').trim() || patient.phone || null;
  const preferredLang = (body.preferred_lang || patient.lang || 'en').trim().toLowerCase() === 'ar' ? 'ar' : 'en';

  const serviceId = body.service_id || '';
  const slaType = body.sla_type === 'vip' ? 'vip' : 'standard';
  const notes = (body.notes || '').trim() || null;

  const services = await fetchServices();

  if (!serviceId) {
    return res.status(400).render('intake_form', {
      services,
      error: 'Please choose a service.',
      form: {
        full_name: fullName,
        email,
        phone,
        preferred_lang: preferredLang,
        service_id: serviceId,
        sla_type: slaType,
        notes
      }
    });
  }

  const service = await queryOne(
    `SELECT sv.*, s.id AS specialty_id
     FROM services sv
     LEFT JOIN specialties s ON s.id = sv.specialty_id
     WHERE sv.id = $1`,
    [serviceId]
  );

  if (!service) {
    return res.status(400).render('intake_form', {
      services,
      error: 'Service not found.',
      form: {
        full_name: fullName,
        email,
        phone,
        preferred_lang: preferredLang,
        service_id: serviceId,
        sla_type: slaType,
        notes
      }
    });
  }

  const slaHours = mapSlaHours(slaType);
  const nowIso = new Date().toISOString();
  const orderId = randomUUID();
  const price = service.base_price != null ? service.base_price : 0;
  const doctorFee = service.doctor_fee != null ? service.doctor_fee : 0;
  const deadlineAt =
    slaHours != null
      ? new Date(new Date(nowIso).getTime() + Number(slaHours) * 60 * 60 * 1000).toISOString()
      : null;

  // Optional: keep patient phone/lang in sync
  try {
    await execute(
      `UPDATE users SET phone = COALESCE($1, phone), lang = $2, updated_at = $3 WHERE id = $4`,
      [phone, preferredLang, nowIso, patient.id]
    );
  } catch (e) {
    // ignore; not critical
  }

  await execute(
    `INSERT INTO orders (
       id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
       price, doctor_fee, created_at, updated_at, accepted_at, deadline_at,
       completed_at, breached_at, reassigned_count, report_url, notes,
       uploads_locked, additional_files_requested, payment_status, payment_method,
       payment_reference, payment_link
     ) VALUES (
       $1, $2, NULL, $3, $4, $5, 'new',
       $6, $7, $8, $9, NULL, $10,
       NULL, NULL, 0, NULL, $11,
       false, false, 'unpaid', NULL,
       NULL, $12
     )`,
    [
      orderId,
      patient.id,
      service.specialty_id,
      service.id,
      slaHours,
      price,
      doctorFee,
      nowIso,
      nowIso,
      deadlineAt,
      notes,
      service.payment_link || null
    ]
  );

  await logOrderEvent({
    orderId,
    label: 'Order created by patient',
    meta: JSON.stringify({ email, service_name: service.name }),
    actorUserId: patient.id,
    actorRole: 'patient'
  });

  const qs = new URLSearchParams({ email });
  return res.redirect(`/intake/thank-you?${qs.toString()}`);
});

router.get('/intake/thank-you', (req, res) => {
  const email = (req.query && req.query.email) || '';
  const pw = req.query && req.query.pw ? String(req.query.pw) : null;
  const showTemp = Boolean(pw) && req.query && req.query.temp === '1';
  res.render('intake_thank_you', { email, showTemp, tempPassword: pw });
});

module.exports = router;
