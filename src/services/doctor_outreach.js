// src/services/doctor_outreach.js
//
// Doctor outreach, segmented by what the doctor actually needs.
//
// WHAT THIS REPLACES. /superadmin/doctors/bulk-welcome selected on
// `password_hash IS NULL` and offered one button. On 2026-08-29 that meant:
//
//   * 22 doctors received a "welcome, set your password" email, and
//   * the six doctors who had logged in on 11-12 August and set a password —
//     the six closest to actually taking a case — were structurally excluded
//     from the only outreach button in the product. Their last contact was
//     18 days old and the bulk send could never reach them.
//
// The cohort was defined by an implementation detail (does this row have a
// password hash) rather than by the thing an operator cares about (how far
// through onboarding is this person, and what do they need next).
//
// THE SEGMENTS. Ordered by how close the doctor is to being useful:
//
//   confirmed   — done. Nothing to send. Listed so the page shows progress.
//   needs_tiers — logged in, has a password, has NOT confirmed service tiers.
//                 Sending them the welcome email is wrong; they get
//                 doctor_confirm_services instead.
//   never_opened— invited, never logged in. Welcome email, re-mints the
//                 7-day magic link.
//   dormant     — no invite has ever been sent.
//   inactive    — deactivated or pending approval. Shown, never sent to.

const { queryAll } = require('../pg');

const SEGMENTS = ['confirmed', 'needs_tiers', 'never_opened', 'dormant', 'inactive'];

// Which email each segment gets. `null` means the segment is not sendable.
const SEGMENT_TEMPLATE = Object.freeze({
  confirmed: null,
  needs_tiers: 'doctor_confirm_services',
  never_opened: 'doctor_approved',
  dormant: 'doctor_approved',
  inactive: null,
});

function segmentOf(row) {
  const active = row.is_active !== false;
  const pending = row.pending_approval === true;
  if (!active || pending) return 'inactive';
  if (row.sla_tiers_confirmed_at) return 'confirmed';
  if (row.first_login_at) return 'needs_tiers';
  if (row.welcome_email_last_sent_at) return 'never_opened';
  return 'dormant';
}

/**
 * Every doctor, with the segment and the facts an operator needs to decide.
 * Read-only.
 */
async function loadDoctorOutreach(opts) {
  const cooldownHours = Number((opts && opts.cooldownHours) || 24);
  const rows = await queryAll(
    `SELECT u.id, u.name, u.name_ar, u.email, u.phone, u.lang,
            u.is_active, u.pending_approval, u.is_paused,
            u.first_login_at, u.welcome_email_last_sent_at, u.sla_tiers_confirmed_at,
            u.password_hash IS NOT NULL AS has_password,
            s.name AS specialty, s.name_ar AS specialty_ar,
            COALESCE(s.is_visible, true) AS specialty_visible,
            (SELECT count(*) FROM doctor_services ds WHERE ds.doctor_id = u.id)::int AS services_ticked
       FROM users u
       LEFT JOIN specialties s ON s.id = u.specialty_id
      WHERE u.role = 'doctor'
      ORDER BY u.name ASC`,
    []
  );

  const now = Date.now();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;

  const doctors = rows.map((r) => {
    const seg = segmentOf(r);
    const lastSent = r.welcome_email_last_sent_at ? new Date(r.welcome_email_last_sent_at).getTime() : null;
    const coolingUntil = lastSent ? lastSent + cooldownMs : null;
    return {
      id: r.id,
      name: r.name || '',
      nameAr: r.name_ar || '',
      email: r.email || '',
      phone: r.phone || '',
      lang: r.lang === 'ar' ? 'ar' : 'en',
      specialty: r.specialty || '',
      specialtyAr: r.specialty_ar || '',
      specialtyVisible: r.specialty_visible !== false,
      servicesTicked: r.services_ticked || 0,
      hasPassword: !!r.has_password,
      isPaused: r.is_paused === true,
      isActive: r.is_active !== false,
      pendingApproval: r.pending_approval === true,
      firstLoginAt: r.first_login_at,
      lastSentAt: r.welcome_email_last_sent_at,
      confirmedAt: r.sla_tiers_confirmed_at,
      segment: seg,
      template: SEGMENT_TEMPLATE[seg],
      sendable: !!SEGMENT_TEMPLATE[seg],
      // Cooling is advisory in the UI. The send path enforces it.
      cooling: !!(coolingUntil && coolingUntil > now),
      coolingUntil: coolingUntil ? new Date(coolingUntil).toISOString() : null,
    };
  });

  const bySegment = {};
  for (const key of SEGMENTS) bySegment[key] = [];
  for (const d of doctors) bySegment[d.segment].push(d);

  // Coverage: which BOOKABLE specialty has nobody who has confirmed. This is
  // the number that decides whether the platform can take an order, and it is
  // not derivable from a flat list of doctors.
  const coverage = {};
  for (const d of doctors) {
    if (!d.specialty || !d.specialtyVisible) continue;
    if (!coverage[d.specialty]) coverage[d.specialty] = { specialty: d.specialty, doctors: 0, loggedIn: 0, confirmed: 0 };
    const c = coverage[d.specialty];
    if (d.isActive && !d.pendingApproval) {
      c.doctors++;
      if (d.firstLoginAt) c.loggedIn++;
      if (d.confirmedAt) c.confirmed++;
    }
  }

  return {
    doctors,
    bySegment,
    coverage: Object.values(coverage).sort((a, b) => a.confirmed - b.confirmed || b.doctors - a.doctors),
    counts: SEGMENTS.reduce((acc, k) => { acc[k] = bySegment[k].length; return acc; }, {}),
    cooldownHours,
  };
}

/**
 * The WhatsApp body for a doctor, as a wa.me URL.
 *
 * WhatsApp dispatch has been returning oc_env_misconfigured on every send, so
 * every invite this week went out email-only and nobody could tell from the
 * UI. Until that is fixed the operator needs a way to send the same message by
 * hand; this builds the link that does it. Returns null when there is no
 * usable phone number rather than a link that opens an empty chat.
 */
function waLink(doctor, template) {
  const phone = String((doctor && doctor.phone) || '').replace(/[^0-9]/g, '');
  if (!phone || phone.length < 8) return null;
  let body = '';
  try {
    // Same builder the automatic WhatsApp path uses, so the message the
    // operator sends by hand is byte-identical to the one that would have
    // gone automatically. Deliberately not a second copy of the copy.
    const { getOpenClawBody } = require('../notify/openclawTemplates');
    body = String(getOpenClawBody(template, doctor.lang, { doctorName: doctor.name }) || '');
  } catch (_) { body = ''; }
  if (!body) return null;
  return 'https://wa.me/' + phone + '?text=' + encodeURIComponent(body);
}

module.exports = { loadDoctorOutreach, waLink, SEGMENTS, SEGMENT_TEMPLATE, segmentOf };
