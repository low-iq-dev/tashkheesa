// src/notify.js

const { randomUUID, createHash } = require('crypto');
const { queryOne, queryAll, execute } = require('./pg');
const { logErrorToDb } = require('./logger');
const { sendWhatsApp } = require('./notify/whatsapp');
const { getNotificationTitles } = require('./notify/notification_titles');
// AUDIT-PAY-1 — one locale table for the whole product (ar-EG / en-GB).
// utils/formatNumber has no requires of its own, so this cannot cycle.
const { pickLocale } = require('./utils/formatNumber');

// ---------------------------------------------------------------------------
// Theme 8 Phase 3 (§3-C) — emit a NOTIFICATION_DROPPED case_event whenever
// queueNotification / queueMultiChannelNotification silently drops a
// notification on a skip path. Surfaced on /ops/silent-failures (Phase 5)
// and registered in case_lifecycle.SILENT_FAILURE_EVENTS.
//
// Two guardrails:
//   (a) orderId-gated — system notifications without an order context
//       (e.g. admin-only fan-outs) don't emit, to avoid unbounded
//       event spam on case_events for non-case-tied notifications.
//   (b) Lazy-required to avoid circular dep (case_lifecycle requires
//       notify, so a top-level `require('./case_lifecycle')` here would
//       create a load-order race).
//   (c) Fire-and-forget — never blocks the surrounding return shape.
//       logCaseEvent has its own internal try/catch; this outer wrap
//       protects against `require()` failures only.
// ---------------------------------------------------------------------------
function emitNotificationDropped({ orderId, reason, channel, template, toUserId }) {
  if (!orderId) return;
  try {
    const { logCaseEvent } = require('./case_lifecycle');
    // Intentionally not awaited — emit is fire-and-forget. Floating
    // promise is safe because logCaseEvent swallows its own errors.
    logCaseEvent(orderId, 'NOTIFICATION_DROPPED', {
      reason: reason || 'unknown',
      channel: channel || null,
      template: template || null,
      toUserId: toUserId || null
    });
  } catch (_) {
    // THEME8-LINT-EXEMPT-HELPER: silent-failure emit failure must not
    // cascade. The require itself can fail at boot if the module graph
    // loads in an unexpected order; queueNotification must remain
    // callable in every environment.
  }
}

const WHATSAPP_ENABLED = String(process.env.WHATSAPP_ENABLED || 'false') === 'true';
const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || 'false') === 'true';

// === PHASE 2: FIX #7 - CACHE FOR N+1 QUERY PREVENTION ===
// Cache email->id resolutions within a sweep to avoid repeated queries
// Cleared after each notification batch to prevent stale data
const emailToIdCache = new Map();

function clearEmailCache() {
  emailToIdCache.clear();
}

async function getCachedUserId(email) {
  const normalized = String(email || '').toLowerCase().trim();
  if (!normalized) return null;

  // Check cache first
  if (emailToIdCache.has(normalized)) {
    return emailToIdCache.get(normalized);
  }

  // Query if not in cache
  try {
    const row = await queryOne(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [normalized]
    );
    const userId = row ? row.id : null;

    // Store result in cache (even null, to avoid repeated failed queries)
    emailToIdCache.set(normalized, userId);

    return userId;
  } catch (e) {
    console.error('[notify] Error querying user by email:', e.message);
    return null;
  }
}

const PAYMENT_REMINDER_TEMPLATES = Object.freeze({
  payment_reminder_30m: true,
  payment_reminder_6h: true,
  payment_reminder_24h: true
});

// ---------------------------------------------------------------------------
// AUDIT-2026-08-22 (N7) — default dedupe keys for the money path.
//
// queueNotification auto-generated a dedupe key for exactly two families
// (sla_reminder_* and PAYMENT_REMINDER_TEMPLATES). Everything else that
// omitted one could be delivered twice: a Paymob webhook retry, a double-
// clicked mark-paid button, or a re-entered admin form re-sent
// "Payment received" / "Your report is ready" / "Case cancelled" to a
// patient — the messages where a duplicate reads as a second charge, a second
// report, or a contradiction.
//
// WHY AN ALLOWLIST AND NOT A BLANKET DEFAULT
//
// The brief's preferred fix was a default derived from (template, orderId,
// recipient) for every caller. That cannot be applied blindly: a great many
// templates are LEGITIMATELY repeatable within one case, and for those the
// triple is constant, so a default key would suppress the second and every
// later send permanently. `new_message` is the clearest example — every chat
// message on a case shares the triple, so the patient would be told about the
// first message on a case and never again. `patient_uploaded_files_doctor`,
// `patient_reply_info` and the additional-files requests are the same shape;
// superadmin.js:2919 already documents this by DELIBERATELY defeating its own
// key with Date.now(). Silently never sending is a far worse failure than
// occasionally sending twice, so the default is opt-in per template.
//
// Membership rule: a template belongs here only if it can fire at most ONCE
// per (order, recipient) in the product's own terms. A case is paid once,
// cancelled once, and each add-on is bought once.
//
// The four deliberately-defeated resend paths (doctor_welcome_resend,
// doctor_bulk_welcome, doctor_invite, patient_uploaded) are untouched by this:
// they PASS an explicit key, and the auto-generation below only runs when the
// caller passed none. None of their templates appear in this set either.
const DEFAULT_DEDUPE_TEMPLATES = Object.freeze({
  // Paymob webhook retries + stub/admin/superadmin mark-paid double-submits.
  payment_success_patient: true,
  payment_success_doctor: true,
  payment_marked_paid_patient: true,
  payment_marked_paid: true,
  // A failed attempt notice. Retried webhook deliveries of the SAME failure
  // carry the same payload and collapse; a genuine SECOND attempt that also
  // fails carries a different transaction/amount in its payload and therefore
  // a different fingerprint, so the patient still hears about it.
  payment_failed_patient: true,
  // One add-on of each kind per order.
  addon_purchased_urgency: true,
  addon_purchased_video: true,
  addon_purchased_prescription: true,
  // AUDIT-2026-08-22 (AUDIT-DEDUPE-AMEND-1) — report_ready_patient REMOVED.
  //
  // It was admitted on the claim that "an amended re-upload carries different
  // payload content and is not suppressed". It does not. The ONLY call site is
  // src/routes/doctor.js's report upload, and it passes exactly
  //   { caseReference, doctorName, specialty, reportUrl }
  // — caseReference is derived from the order id, doctorName/specialty from the
  // same doctor and order, and reportUrl is `${APP_URL}/portal/case/${orderId}
  // /report`. Every field is deterministic from (order, doctor), so an amended
  // re-upload produces a BYTE-IDENTICAL payload, an identical payloadFingerprint
  // and therefore an identical auto-key — and migration 082's unique index
  // suppresses email, WhatsApp and the in-app bell on all three channels.
  //
  // A doctor uploading a corrected report after a clinical error and the patient
  // never being told is not a dedupe win; it is the worst outcome this file can
  // produce. It also fails the membership rule stated above ("at most ONCE per
  // (order, recipient) in the product's own terms") — a report can legitimately
  // be re-issued.
  //
  // To re-admit it, the call site must first include something that actually
  // varies per issuance (a report version, the report row id, or the upload
  // timestamp) in the payload. That call site is in src/routes/doctor.js, which
  // this agent does not own — see the hand-off note in the audit report.
  // A case is cancelled once.
  case_cancelled_patient: true
});

// The payload fingerprint is what keeps the allowlist honest. Keying purely on
// (template, orderId, recipient) would make a repeat impossible FOREVER; adding
// a short hash of the queued payload means only a byte-identical event —
// which is precisely what a webhook retry or a double-click produces — is
// treated as the same event. sha1 is a fingerprint here, not a security
// primitive; 10 hex chars is ample for collisions scoped to one triple.
function payloadFingerprint(responseJson) {
  try {
    return createHash('sha1').update(String(responseJson || '')).digest('hex').slice(0, 10);
  } catch (_) {
    return 'nofp';
  }
}

function buildPaymentReminderPayload({ caseId, paymentUrl }) {
  return {
    case_id: caseId || null,
    payment_url: paymentUrl || null
  };
}

// AUDIT-2026-08-22: mirrors notification_worker.stripDrPrefix and
// openclawTemplates.stripDr. Doctor names are stored ALREADY prefixed
// ("Dr. Ahmed Hassan" — see src/create_test_doctor.js), and both the title
// registry ("Dr. {doctorName} has accepted your case" / "د. {doctorName} قبل
// حالتك") and the bodies below prepend the honorific themselves. The email
// path and both OpenClaw composers already strip; the BELL was the one
// surface that did not, so the in-app title read "Dr. Dr. Ahmed Hassan".
// Kept local rather than exported from one of those files: notify.js is
// required by case_lifecycle which is lazily required back here, and a new
// cross-module edge in that cycle is not worth deduplicating a one-line regex.
function stripDrPrefix(name) {
  return String(name == null ? '' : name).replace(/^\s*(?:Dr\.?|د\.?)\s+/i, '').trim();
}

/**
 * Resolve the recipient's UI language for in-app copy.
 *
 * AUDIT-2026-08-22 (N5): the bell used to take its language from
 * `response.lang` / `response.language`, and exactly ONE of ~110 call sites
 * passes that (case_lifecycle.js queueSlaReminder). Everywhere else the value
 * was '' and the title fell through to `title_en` unconditionally — so the
 * complete `title_ar` half of the registry was dead code and Arabic patients,
 * the primary market, read an English notification list inside an Arabic app.
 *
 * Resolved here, once, against `users.lang`, rather than by asking 110 call
 * sites to start passing a field. One indexed primary-key lookup per queued
 * notification, and only on the paths that actually reach the insert (the
 * dedupe pre-check returns before this).
 *
 * AUDIT-2026-08-22 (AUDIT-LANG-NPLUS1-1) — callers that ALREADY hold the row
 * must not pay for a second lookup. queueNotification now takes an optional
 * `recipientLang`, and the two fan-out helpers in this file pass it:
 *   * queueMultiChannelNotification already SELECTs the user for the phone /
 *     email / notify_whatsapp checks, and fired THREE of these per event on top
 *     of that one lookup;
 *   * notifyAdmins fans one notification per active superadmin per event.
 * Both now select `lang` in the query they were making anyway. This function
 * remains the fallback for the ~110 call sites that hold no user row.
 *
 * Never throws: a failed lookup degrades to 'en', which is exactly the
 * behaviour every call site has today.
 *
 * @param {string} uid Resolved users.id
 * @returns {Promise<'ar'|'en'>}
 */
async function resolveRecipientLang(uid) {
  try {
    const row = await queryOne('SELECT lang FROM users WHERE id = $1 LIMIT 1', [uid]);
    return String((row && row.lang) || '').toLowerCase() === 'ar' ? 'ar' : 'en';
  } catch (e) {
    console.error('[notify] recipient lang lookup failed; defaulting to en', { uid, error: e && e.message });
    return 'en';
  }
}

/**
 * Hard rule:
 * notifications.to_user_id must ALWAYS be users.id (NOT email).
 * If an email is passed, resolve to users.id. If not resolvable, skip insert.
 * === PHASE 2: Now uses cache to prevent N+1 queries ===
 */
async function normalizeToUserId(toUserId) {
  const raw = String(toUserId == null ? '' : toUserId).trim();
  if (!raw) return null;

  // If it's an email, resolve to the user's id using cache
  if (raw.includes('@')) {
    return await getCachedUserId(raw);
  }

  return raw;
}

/**
 * === PHASE 3: FIX #17 - JSDOC DOCUMENTATION ===
 * Queue a notification to be stored and sent to a user.
 *
 * Core responsibility: Insert notification record into database.
 * Secondary: Dispatch to external channels (WhatsApp) if configured.
 *
 * @param {Object} options - Notification options
 * @param {string} [options.id] - Notification ID (auto-generated if omitted)
 * @param {string} [options.orderId] - Related order ID (for filtering/context)
 * @param {string} options.toUserId - User ID or email to send to (required)
 * @param {string} [options.channel='internal'] - Channel: 'internal', 'whatsapp', 'email'
 * @param {string} options.template - Notification template name (e.g., 'sla_reminder_doctor')
 * @param {string} [options.status='queued'] - Initial status: 'queued', 'sent', 'failed'
 * @param {Object|string} [options.response] - Response/metadata payload (stored as JSON)
 * @param {string} [options.dedupe_key] - Deduplication key to prevent duplicate notifications
 * @param {string} [options.dedupeKey] - Alias for dedupe_key (for API flexibility)
 *
 * @returns {Promise<Object>} Result object
 *
 * Behavior:
 * - Normalizes toUserId (resolves emails to user IDs via cache)
 * - Auto-generates dedupe keys for SLA and payment reminders if missing
 * - Prevents duplicates via unique dedupe_key constraint
 * - Stores response payload as JSON in database
 * - For WhatsApp: Dispatches immediately (fire-and-forget)
 * - All failures are logged; no exceptions thrown
 */
/**
 * Format an ISO timestamp as a Cairo-local date + time for patient-facing copy.
 *
 * AUDIT-PAY-1 needs to state a concrete deadline, and the stored value is a UTC
 * ISO string while every patient reads it as a Cairo wall clock. Africa/Cairo is
 * pinned explicitly (Egypt observes DST again since 2023, so a fixed +2 offset
 * would be wrong for half the year). Returns '' on any bad input so the caller
 * can degrade to copy without a timestamp rather than printing "Invalid Date".
 *
 * Locale comes from utils/formatNumber.pickLocale so this matches the rest of
 * the product (ar-EG → Arabic-Indic numerals, en-GB → "18 August"); a private
 * locale table here would be the fourth one in the codebase.
 *
 * @param {string} iso
 * @param {string} [lang='en']
 * @returns {string}
 */
function formatCairoDateTime(iso, lang) {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return new Intl.DateTimeFormat(pickLocale(lang), {
      timeZone: 'Africa/Cairo',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(d);
  } catch (_) {
    return '';
  }
}

/**
 * Render a short in-app notification body for the given template + payload.
 * The mobile app shows this directly as the notification's message line.
 * Kept intentionally terse — titles carry the primary meaning; messages
 * just add the one piece of context the user cares about (which case,
 * which doctor, etc.). Falls back to null when nothing meaningful can be
 * said, and the mobile app will show title alone.
 *
 * @param {string} template
 * @param {Object|null} payload
 * @param {string} [lang='en'] - Recipient language.
 *
 * AUDIT-2026-08-22 (N5): every body is now bilingual. Previously 37 of 38 were
 * hardcoded English (only urgent_case_window_deferred_patient branched), which
 * meant an Arabic patient got an Arabic title over an English sentence — and
 * on the templates where the body carries the actual decision (payment held,
 * case removed, deadline moved), the only explanation was in a language they
 * may not read.
 *
 * Translation policy: the Arabic is Modern Standard Arabic in a
 * medical-professional register, and the terminology is taken VERBATIM from
 * the two reviewed registries rather than newly coined — notification_titles.js
 * ("رأيك الطبي الثاني", "تمت إعادة تعيين الحالة", "تم تجاوز مهلة المراجعة",
 * "الوصفة الطبية", "موعد تسليم الحالة") and openclawTemplates.js. A body and
 * its title sit on the same bell row, so they have to name the same things the
 * same way. The English strings are unchanged, so this is additive.
 */
function renderNotificationMessage(template, payload, lang) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  // AUDIT-2026-08-22: `caseReference` added to the alias list. It is the key
  // the title registry interpolates and the key payments.js queues on the
  // money templates, so without it the freshly-translated body for a payment
  // confirmation fell back to the anonymous "your case" / "حالتك" directly
  // under a title that had just named the case reference.
  const ref = p.reference_id || p.reference_code || p.case_ref || p.caseReference || null;
  const caseLabel = ref ? `Case ${ref}` : (p.case_id ? 'Your case' : null);
  // AUDIT-2026-08-22: the honorific is prepended by the copy below, and stored
  // doctor names already carry it — without stripping, "Dr. Ahmed" rendered as
  // "Dr. Dr. Ahmed" / "د. Dr. Ahmed".
  const doctor = stripDrPrefix(p.doctor_name || p.doctorName || '') || null;
  const service = p.service_name || null;
  const isAr = String(lang || 'en').toLowerCase() === 'ar';

  // Arabic case labels, in two voices. Two are needed because Arabic cannot
  // reuse one noun phrase the way "Your case" / "the case" do in English:
  //   arCase  — PATIENT voice: "حالة ABC123" or "حالتك" (your case).
  //   arCaseN — DOCTOR / SYSTEM voice: "حالة ABC123" or "الحالة" (the case).
  // Addressing a doctor with "حالتك" would tell them the case is theirs
  // personally, which is what the English "Your case" fallback accidentally
  // says today and what a literal translation would make worse.
  //
  // Both patient-voice values begin with ح, so the prepositional proclitics
  // used below fuse correctly ("ل" + "حالتك" → "لحالتك", "ل" + "حالة ABC" →
  // "لحالة ABC"). The neutral fallback "الحالة" carries the definite article,
  // so it is only ever used with a SEPARATE preposition ("على"، "بخصوص") —
  // "ل" + "الحالة" would produce the malformed "لالحالة".
  const arCase = ref ? `حالة ${ref}` : (p.case_id ? 'حالتك' : null);
  const arCaseN = ref ? `حالة ${ref}` : (p.case_id ? 'الحالة' : null);

  switch (template) {
    case 'order_created_patient':
    case 'public_order_created_patient':
      if (isAr) {
        return arCase
          ? `تم استلام ${arCase}. سنبلغك فور إسناد الحالة إلى طبيب.`
          : 'تم استلام الحالة.';
      }
      return caseLabel ? `${caseLabel} submitted. We'll notify you once a doctor is assigned.` : "Case submitted.";

    case 'order_status_accepted_patient':
    case 'order_assigned_patient':
      if (isAr) {
        return doctor
          ? `د. ${doctor} قبل ${arCase || 'حالتك'}.`
          : `تم إسناد ${arCase || 'حالتك'} إلى طبيب.`;
      }
      return doctor
        ? `Dr. ${doctor} has accepted ${caseLabel || 'your case'}.`
        : `${caseLabel || 'Your case'} has been assigned to a doctor.`;

    case 'order_assigned_doctor':
    case 'order_auto_assigned_doctor':
    case 'public_order_assigned_doctor':
      if (isAr) {
        return arCaseN ? `${arCaseN} جاهزة للمراجعة.` : 'حالة جديدة جاهزة للمراجعة.';
      }
      return caseLabel ? `${caseLabel} is ready for your review.` : "A new case is ready for your review.";

    case 'order_reassigned_doctor':
    case 'order_reassigned_to_doctor':
      if (isAr) {
        return arCaseN
          ? `تمت إعادة تعيين ${arCaseN} إليك.`
          : 'تمت إعادة تعيين إحدى الحالات إليك.';
      }
      return caseLabel ? `${caseLabel} has been reassigned to you.` : "A case has been reassigned to you.";

    case 'order_reassigned_from_doctor':
      if (isAr) {
        return arCaseN
          ? `تمت إعادة تعيين ${arCaseN} إلى طبيب آخر.`
          : 'تمت إعادة تعيين إحدى الحالات إلى طبيب آخر.';
      }
      return caseLabel ? `${caseLabel} has been reassigned to another doctor.` : "A case has been reassigned.";

    case 'order_reassigned_patient':
      if (isAr) return `تم إسناد ${arCase || 'حالتك'} إلى طبيب آخر.`;
      return `${caseLabel || 'Your case'} has been assigned to a different doctor.`;

    case 'report_ready_patient':
      // "رأيك الطبي الثاني" is the registry's term for a second opinion
      // (notification_titles.report_ready_patient).
      if (isAr) return `تقرير الرأي الطبي الثاني ل${arCase || 'حالتك'} جاهز للاطلاع.`;
      return `Your second-opinion report for ${caseLabel || 'your case'} is ready to view.`;

    case 'additional_files_requested_patient':
    case 'additional_files_request_approved_patient':
      if (isAr) return `الطبيب يحتاج ملفات إضافية ل${arCase || 'حالتك'}. برجاء رفعها في أقرب وقت.`;
      return `The doctor needs additional files for ${caseLabel || 'your case'}. Please upload them when you can.`;

    case 'patient_uploaded_files_doctor':
      if (isAr) return `المريض رفع ملفات إضافية على ${arCaseN || 'الحالة'}.`;
      return `Patient uploaded additional files for ${caseLabel || 'the case'}.`;

    case 'patient_reply_info':
      if (isAr) return `المريض أرسل معلومات إضافية بخصوص ${arCaseN || 'الحالة'}.`;
      return `Patient sent additional information on ${caseLabel || 'the case'}.`;

    case 'payment_success_patient':
    case 'payment_marked_paid_patient':
    case 'payment_marked_paid':
      if (isAr) return `تم استلام الدفع ل${arCase || 'حالتك'}.`;
      return `Payment received for ${caseLabel || 'your case'}.`;

    case 'payment_success_doctor':
      // Doctor voice: "الحالة" carries the article, so no "ل" proclitic here.
      if (isAr) return `تم تأكيد الدفع — ${arCaseN || 'الحالة'} جاهزة للمراجعة.`;
      return `Payment received for ${caseLabel || 'the case'}.`;

    case 'payment_reminder_30m':
      if (isAr) return `تذكير: إكمال الدفع ل${arCase || 'حالتك'} يبدأ مراجعة الرأي الطبي الثاني.`;
      return `Reminder: complete payment for ${caseLabel || 'your case'} to start your second-opinion review.`;

    case 'payment_reminder_6h':
      if (isAr) return `${arCase || 'حالتك'} لا تزال في انتظار الدفع. بإتمام الدفع يبدأ الطبيب المراجعة فورًا.`;
      return `${caseLabel || 'Your case'} is still awaiting payment. Complete it now so a doctor can begin.`;

    case 'payment_reminder_24h':
      // #66: the spot will be released soon if not paid — informational
      // framing, not punitive (see email template tone). The Arabic keeps that
      // register: a statement of what happens, with no blame and no deadline
      // theatre.
      if (isAr) return `${arCase || 'حالتك'} محفوظة منذ 24 ساعة. سيتم إخلاء المكان قريبًا إذا لم يكتمل الدفع.`;
      return `${caseLabel || 'Your case'} has been held for 24 hours. The spot will be released soon if payment isn't completed.`;

    case 'case_auto_deleted_unpaid_patient':
      if (isAr) return `تم حذف ${arCase || 'حالتك'} لعدم إتمام الدفع خلال 48 ساعة. يمكنك تقديم حالة جديدة في أي وقت.`;
      return `${caseLabel || 'Your case'} was removed because payment wasn't completed within 48 hours. You can submit a new case anytime.`;

    // AUDIT-PAY-1 (regression F2) — urgent case confirmed outside the Cairo
    // urgent window (07:00–19:00). This body is the ONLY thing that explains to
    // someone who paid an urgency premium at 19:02 why their deadline reads as
    // tomorrow. It previously did not exist: the template was queued but never
    // registered, so the bell showed the humanized slug over an empty message.
    //
    // Three things it must do, in order: name the hours so the deferral looks
    // like a policy and not a fault, give the concrete deadline so the patient
    // can stop calculating, and say plainly that the turnaround they paid for
    // is unchanged — otherwise this reads as a downgrade of a paid upgrade.
    case 'urgent_case_window_deferred_patient': {
      const when = formatCairoDateTime(p.deadline_at, isAr ? 'ar' : 'en');
      if (isAr) {
        return when
          ? `المراجعة العاجلة بتشتغل من 7 الصبح لـ 7 بالليل بتوقيت القاهرة. الدفع تم بعد المواعيد دي، فالطبيب هيبدأ 7 الصبح وتقريرك موعده ${when}. مدة المراجعة العاجلة اللي دفعتها زي ما هي.`
          : 'المراجعة العاجلة بتشتغل من 7 الصبح لـ 7 بالليل بتوقيت القاهرة. الدفع تم بعد المواعيد دي، فالطبيب هيبدأ 7 الصبح. مدة المراجعة العاجلة اللي دفعتها زي ما هي.';
      }
      return when
        ? `Urgent reviews run 7 AM–7 PM Cairo time. Your payment came in after hours, so your specialist starts at 7 AM and your report is due by ${when}. The urgent turnaround you paid for is unchanged.`
        : 'Urgent reviews run 7 AM–7 PM Cairo time. Your payment came in after hours, so your specialist starts at 7 AM. The urgent turnaround you paid for is unchanged.';
    }

    // ══════════════════════════════════════════════════════════════════════
    // AUDIT-2026-08-22 (N5) — sla_reminder_24h / _6h / _1h had NO case here.
    //
    // These are the SLA reminder tiers that go live at launch
    // (case_lifecycle.dispatchSlaReminders). They were registered in the title
    // registry and in openclawTemplates, but the renderer had no branch — so
    // the bell showed "Case due within 6 hours" over a completely EMPTY body,
    // on the reminder series that exists to prevent a missed medical deadline.
    //
    // The payload carries `role`; `role === 'doctor'` is the doctor copy and
    // anything else is the patient copy — the same split openclawTemplates.js
    // uses, and defaulting to the patient side for the same reason: a doctor
    // shown patient copy loses an action prompt, whereas a patient shown
    // doctor copy is told they are late on something they cannot do.
    //
    // The countdown is the fixed tier wording rather than an interpolated
    // remaining-time value. The title on the same bell row already states the
    // tier ("Case due within 6 hours" / "موعد تسليم الحالة خلال 6 ساعات"), and
    // a second, differently-rounded number one line below it would read as a
    // contradiction. The precise countdown lives on the WhatsApp and email
    // surfaces, which render it through notify/duration.formatTimeRemaining.
    // ══════════════════════════════════════════════════════════════════════
    case 'sla_reminder_24h':
      if (String(p.role || '').toLowerCase() === 'doctor') {
        if (isAr) return `موعد تسليم ${arCaseN || 'الحالة'} خلال 24 ساعة. برجاء إكمال المراجعة.`;
        return `${caseLabel || 'A case'} is due in about 24 hours. Please complete your review.`;
      }
      if (isAr) return `موعد تسليم ${arCase || 'حالتك'} خلال 24 ساعة. لا يلزم أي إجراء منك، وسنبلغك فور أن يصبح التقرير جاهزًا.`;
      return `${caseLabel || 'Your case'} is due within about 24 hours. Nothing is needed from you — we'll notify you the moment it's ready.`;

    case 'sla_reminder_6h':
      if (String(p.role || '').toLowerCase() === 'doctor') {
        if (isAr) return `موعد تسليم ${arCaseN || 'الحالة'} خلال 6 ساعات. برجاء إكمال المراجعة.`;
        return `${caseLabel || 'A case'} is due in about 6 hours. Please complete your review.`;
      }
      if (isAr) return `موعد تسليم ${arCase || 'حالتك'} خلال 6 ساعات. الطبيب المختص يعمل عليها وسنرسل التقرير فور جهوزه.`;
      return `${caseLabel || 'Your case'} is due in about 6 hours. Your specialist is working on it and we'll send the report as soon as it's ready.`;

    case 'sla_reminder_1h':
      if (String(p.role || '').toLowerCase() === 'doctor') {
        if (isAr) return `عاجل — موعد تسليم ${arCaseN || 'الحالة'} خلال ساعة. برجاء إرسال المراجعة الآن.`;
        return `URGENT — ${caseLabel || 'a case'} is due within the hour. Please submit your review now.`;
      }
      if (isAr) return `موعد تسليم ${arCase || 'حالتك'} خلال ساعة. الطبيب المختص ينهي المراجعة الآن.`;
      return `${caseLabel || 'Your case'} is due within the hour. Your specialist is finalising it now.`;

    case 'sla_reminder_doctor':
    case 'order_sla_pre_breach':
    case 'order_sla_pre_breach_doctor':
      if (isAr) return `${arCaseN || 'إحدى الحالات'} تقترب من الموعد النهائي للمراجعة. برجاء إكمال المراجعة قريبًا.`;
      return `${caseLabel || 'A case'} is approaching its SLA deadline. Please review soon.`;

    case 'sla_breached_doctor':
    case 'order_breached_doctor':
      if (isAr) return `${arCaseN || 'إحدى الحالات'} تجاوزت مهلة المراجعة.`;
      return `${caseLabel || 'A case'} has passed its SLA deadline.`;

    case 'order_breached_patient':
      if (isAr) return `نعتذر — ${arCase || 'حالتك'} تستغرق وقتًا أطول من المتوقع، ونحن نتابع الأمر.`;
      return `We're sorry — ${caseLabel || 'your case'} is taking longer than expected. We're on it.`;

    case 'order_breached_superadmin':
      if (isAr) return `تم تجاوز مهلة المراجعة على ${arCaseN || 'إحدى الحالات'}.`;
      return `SLA breached on ${caseLabel || 'a case'}.`;

    case 'prescription_uploaded_patient':
      // "الوصفة الطبية" per notification_titles.prescription_uploaded_patient
      // (the OpenClaw body says "روشتة", but that is the WhatsApp surface's
      // colloquial voice; the bell follows the bell registry).
      if (isAr) return `الوصفة الطبية متاحة الآن ل${arCase || 'حالتك'}.`;
      return `A new prescription is available for ${caseLabel || 'your case'}.`;

    case 'new_message':
      if (isAr) {
        return arCase ? `وصلتك رسالة جديدة بخصوص ${arCase}.` : 'وصلتك رسالة جديدة.';
      }
      return caseLabel ? `You have a new message about ${caseLabel}.` : "You have a new message.";

    case 'appointment_cancelled':
      if (isAr) return 'تم إلغاء موعدك.';
      return "Your appointment has been cancelled.";

    case 'appointment_rescheduled':
      if (isAr) return 'تم تغيير موعدك.';
      return "Your appointment has been rescheduled.";

    case 'doctor_signup_pending':
      if (isAr) return 'يوجد تسجيل طبيب جديد بانتظار المراجعة.';
      return "A new doctor signup is awaiting review.";

    case 'doctor_approved':
      if (isAr) return 'تم اعتماد حسابك كطبيب.';
      return "Your doctor account has been approved.";

    case 'doctor_rejected':
      if (isAr) return 'لم يتم اعتماد طلب انضمامك كطبيب في الوقت الحالي.';
      return "Your doctor application was not approved at this time.";

    default:
      return null;
  }
}

async function queueNotification({
  id,
  orderId = null,
  toUserId,
  channel = 'internal',
  template,
  status = 'queued',
  response = null,
  dedupe_key = null,
  dedupeKey = null,
  // AUDIT-2026-08-22 (AUDIT-LANG-NPLUS1-1) — optional 'ar' | 'en' from a caller
  // that has already read the users row. Skips resolveRecipientLang's extra
  // SELECT. Anything else is ignored and the lookup happens as before.
  recipientLang = null
}) {
  const uid = await normalizeToUserId(toUserId);

  // If uid can't be resolved, do NOT insert (prevents trigger abort + bad data)
  if (!uid) {
    emitNotificationDropped({ orderId, reason: 'invalid_to_user_id', channel, template, toUserId });
    return { ok: false, skipped: true, reason: 'invalid_to_user_id', toUserId };
  }

  let normalizedDedupeKey = dedupe_key || dedupeKey || null;

  // AUDIT-2026-08-22 (N7): hoisted above the dedupe blocks (it used to be
  // computed just before the INSERT) because the default-key fingerprint needs
  // the serialized payload, and the dedupe pre-check runs first. Pure move —
  // same expression, same value, still the single source for the stored column.
  const responseJson = (typeof response === 'string')
    ? response
    : JSON.stringify(response ?? null);

  // Guardrail: auto-generate a dedupe key for SLA reminder templates if caller forgot to pass one.
  // This prevents duplicate spam and fixes prior missing-dedupe inserts.
  if (!normalizedDedupeKey && typeof template === 'string' && template.startsWith('sla_reminder_')) {
    let payload = null;
    try {
      if (response && typeof response === 'object') {
        payload = response;
      } else if (typeof response === 'string' && response.trim()) {
        payload = JSON.parse(response);
      }
    } catch (e) {
      payload = null;
    }

    const caseId = payload && payload.case_id ? String(payload.case_id) : (orderId ? String(orderId) : null);
    if (caseId) {
      normalizedDedupeKey = `sla:${template}:${channel}:${caseId}:${uid}`;
      console.warn('[notify] missing dedupe_key for sla reminder; auto-generated', { template, channel, to: uid, caseId });
    }
  }

  // Guardrail: auto-generate a dedupe key for payment reminders if caller forgot to pass one.
  if (!normalizedDedupeKey && PAYMENT_REMINDER_TEMPLATES && PAYMENT_REMINDER_TEMPLATES[template]) {
    let payload = null;
    try {
      if (response && typeof response === 'object') {
        payload = response;
      } else if (typeof response === 'string' && response.trim()) {
        payload = JSON.parse(response);
      }
    } catch (e) {
      payload = null;
    }

    const caseId = payload && payload.case_id ? String(payload.case_id) : (orderId ? String(orderId) : null);
    if (caseId) {
      normalizedDedupeKey = `payment:${template}:${channel}:${caseId}:${uid}`;
      console.warn('[notify] missing dedupe_key for payment reminder; auto-generated', { template, channel, to: uid, caseId });
    }
  }

  // AUDIT-2026-08-22 (N7): default dedupe key for the once-per-order money
  // templates — see DEFAULT_DEDUPE_TEMPLATES above for the membership rule and
  // for why this is an allowlist rather than a blanket default. Doing it here
  // rather than at each call site covers payments.js, doctor.js and
  // superadmin.js (none of which this agent owns) in one place, and cannot be
  // forgotten by the next caller.
  //
  // Guarded on `!normalizedDedupeKey`, so an explicit key — including the four
  // resend paths that deliberately embed Date.now() to DEFEAT dedupe — always
  // wins and nothing here can suppress an intentional repeat.
  //
  // Requires an order context: without one there is no stable scope and a key
  // built from (template, recipient) alone would collide across unrelated
  // cases. No order id → no default key → today's behaviour, unchanged.
  // `=== true` rather than a bare truthiness test: a template named
  // 'constructor' or 'toString' would otherwise match Object.prototype.
  if (!normalizedDedupeKey && DEFAULT_DEDUPE_TEMPLATES[template] === true) {
    let payload = null;
    try {
      payload = responseJson ? JSON.parse(responseJson) : null;
    } catch (e) {
      payload = null;
    }
    const caseId = (payload && (payload.case_id || payload.order_id))
      ? String(payload.case_id || payload.order_id)
      : (orderId ? String(orderId) : null);
    if (caseId) {
      normalizedDedupeKey = `auto:${template}:${channel}:${caseId}:${uid}:${payloadFingerprint(responseJson)}`;
    }
  }

  // Set when the dedupe pre-check finds an existing row that is 'failed'. The
  // event is then RE-ARMED in place (see the UPDATE below) rather than
  // re-INSERTed, because the unique index makes a second row impossible.
  let requeueRowId = null;

  if (normalizedDedupeKey) {
    // queueNotification is documented as "never throws" and is invoked
    // fire-and-forget from many callers. A transient DB error on this dedupe
    // read must NOT reject — an unhandled rejection would trip server.js's
    // process.exit(1) guard. Degrade to "skip dedupe, proceed": a possible
    // duplicate is far cheaper than a crash.
    try {
      // AUDIT — a historical 'failed' row used to suppress the event
      // permanently: the pre-check matched, queueNotification returned
      // { skipped: 'deduped' }, and that (dedupe_key, channel, to_user_id)
      // triple could never be re-queued again for the rest of the row's
      // lifetime. A doctor whose case-assigned WhatsApp failed three times
      // during a provider outage was never re-notified, for that case, ever.
      //
      // ── REGRESSION FIX (F3) ──────────────────────────────────────────────
      //
      // The first attempt at that fix was `AND status <> 'failed'` on this
      // pre-check alone. It cannot work, and it is strictly worse than the bug
      // it replaced. Skipping the failed row here just falls through to the
      // INSERT below, which carries the IDENTICAL (dedupe_key, channel,
      // to_user_id) triple — exactly what migration 082's index constrains.
      // There is no ON CONFLICT, so it raises 23505 on EVERY attempt, and the
      // catch writes both an error_logs row and a NOTIFICATION_DROPPED
      // case_event. On a 5-minute cron that is a permanent, self-renewing
      // false-positive feed into /ops/errors and /ops/silent-failures — the
      // dashboards this whole series exists to make trustworthy.
      //
      // The retry is now expressed as what it actually is: re-arming the
      // EXISTING row. Deliberately NOT `INSERT ... ON CONFLICT DO UPDATE`:
      // 082's index is PARTIAL (`WHERE dedupe_key IS NOT NULL`), so the
      // inference clause would have to repeat that predicate, and on any
      // instance where 082 has not yet run Postgres answers 42P10 ("no unique
      // or exclusion constraint matching the ON CONFLICT specification") —
      // which would break EVERY notification insert, including the ones that
      // work today. An UPDATE keyed on the row's own id is correct against
      // either index shape, so this fix is safe in both migration orders.
      const existing = await queryOne(`
        SELECT id, status FROM notifications
        WHERE dedupe_key = $1
          AND channel = $2
          AND to_user_id = $3
        ORDER BY at DESC NULLS LAST
        LIMIT 1
      `, [normalizedDedupeKey, channel, uid]);

      if (existing && String(existing.status || '').toLowerCase() !== 'failed') {
        return { ok: true, skipped: 'deduped', dedupe_key: normalizedDedupeKey };
      }
      if (existing) {
        requeueRowId = existing.id;
      }
    } catch (err) {
      logErrorToDb(err, {
        context: 'queueNotification.dedupe_check',
        category: 'notification_queue_failure',
        orderId,
        toUserId: uid,
        channel,
        template
      });
      console.error('[notify] queueNotification dedupe check failed; proceeding without dedupe', err && err.message ? err.message : err);
    }
  }

  const notifId = id || randomUUID();

  // Resolve human-readable title + message so the mobile app's notifications
  // list doesn't render empty rows. `type` mirrors `template` so the mobile
  // app can branch on it without depending on template naming stability.
  // The response payload is also used to render a one-line message body.
  const parsedResponse = (typeof response === 'object' && response !== null)
    ? response
    : (() => { try { return JSON.parse(responseJson); } catch { return null; } })();
  // AUDIT — `vars` was omitted here, so every `{caseReference}` /
  // `{doctorName}` / `{patientName}` placeholder in TEMPLATE_TITLES
  // interpolated to '' and interpolate() then stripped the dangling
  // punctuation: the bell showed "New case in your specialty" with the
  // reference gone. `parsedResponse` is the same payload the email path
  // feeds getNotificationTitles (notification_worker.js:235), so titles
  // now render identically on both surfaces.
  // AUDIT-2026-08-22 — the raw payload used to be handed to
  // getNotificationTitles unmodified, so "{doctorName}" interpolated a stored
  // name that already carries the honorific and the bell read "Dr. Dr. Ahmed
  // Hassan". The email path (notification_worker.processEmail) and both
  // OpenClaw composers strip; this was the only surface that did not.
  // `doctor_name` is aliased in at the same time because a good half of the
  // call sites queue snake_case, and the titles only read {doctorName}.
  const titleVars = (parsedResponse && typeof parsedResponse === 'object')
    ? Object.assign({}, parsedResponse, {
        doctorName: stripDrPrefix(parsedResponse.doctorName || parsedResponse.doctor_name || '')
      })
    : parsedResponse;
  const titles = getNotificationTitles(template, titleVars);
  // AUDIT-APP — was hardcoded to title_en, so Arabic patients (the primary
  // market) saw English titles throughout the app's notification list, with the
  // title_ar variant never used anywhere. Resolve against the recipient's
  // language; fall back to English when there is no Arabic copy.
  //
  // AUDIT-2026-08-22 (N5) — that language came from the PAYLOAD, and no call
  // site actually passes it, so in practice it was always '' and the Arabic
  // half of the registry never rendered.
  //
  // AUDIT-2026-08-22 (AUDIT-LANG-NPLUS1-1) — the previous version of this
  // comment said case_lifecycle.queueSlaReminder passes a payload `lang`. It
  // does not: its response payload is
  // { case_id, role, level, seconds_remaining }. The payload branch is
  // therefore currently unreachable from anywhere in the repo. It is KEPT (not
  // deleted) because it is the correct precedence if a caller ever needs to
  // override the recipient's stored preference — but nothing depends on it.
  //
  // Precedence: explicit payload lang → caller-supplied recipientLang (the
  // caller already read the users row) → one indexed lookup on users.lang.
  const _payloadLang = String(
    (parsedResponse && (parsedResponse.lang || parsedResponse.language)) || ''
  ).toLowerCase();
  const _passedLang = String(recipientLang || '').toLowerCase();
  const _notifLang = (_payloadLang === 'ar' || _payloadLang === 'en')
    ? _payloadLang
    : ((_passedLang === 'ar' || _passedLang === 'en')
        ? _passedLang
        : await resolveRecipientLang(uid));
  const inAppTitle = (_notifLang === 'ar' ? (titles?.title_ar || titles?.title_en) : titles?.title_en) || null;
  // AUDIT-PAY-1 — the body is resolved against the same language as the title.
  // It was called without a language, so a bilingual body had no way to reach
  // an Arabic patient even once one existed.
  const inAppMessage = renderNotificationMessage(template, parsedResponse, _notifLang);

  // REGRESSION FIX (F3) — re-arm a previously-failed row in place.
  //
  // The unique index means the retry cannot be a second row, so it is an
  // UPDATE of the one that is already there: status back to 'queued', the
  // attempt counter cleared so the worker gets a full budget again (a fresh
  // lifecycle event deserves one; the old count belongs to the old attempt),
  // retry_after cleared so it is picked up on the next tick, and the payload /
  // title / message refreshed from THIS call rather than left stale from the
  // failed one. `at` is bumped so the bell surfaces it as new instead of
  // burying it at the original timestamp.
  if (requeueRowId) {
    try {
      await execute(
        `UPDATE notifications
            SET status = $1,
                response = $2,
                order_id = COALESCE($3, order_id),
                template = $4,
                type = $4,
                title = $5,
                message = $6,
                attempts = 0,
                retry_after = NULL,
                is_read = false,
                at = NOW()
          WHERE id = $7`,
        [status, responseJson, orderId, template, inAppTitle, inAppMessage, requeueRowId]
      );
      return { ok: true, id: requeueRowId, requeued: true, dedupe_key: normalizedDedupeKey };
    } catch (err) {
      // Same contract as the insert path: never throw, always leave a trace.
      logErrorToDb(err, {
        context: 'queueNotification.requeue_failed_row',
        category: 'notification_queue_failure',
        orderId,
        toUserId: uid,
        channel,
        template
      });
      emitNotificationDropped({ orderId, reason: 'requeue_failed', channel, template, toUserId: uid });
      console.error('[notify] queueNotification requeue of failed row failed', err);
      return {
        ok: false,
        skipped: true,
        reason: 'requeue_failed',
        error: err && err.message ? err.message : String(err)
      };
    }
  }

  try {
    await execute(
      `INSERT INTO notifications (
         id, order_id, to_user_id, channel, template, status, response, dedupe_key,
         type, title, message, is_read
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)`,
      [notifId, orderId, uid, channel, template, status, responseJson, normalizedDedupeKey,
       template, inAppTitle, inAppMessage]
    );

    // P1-NOTIF-1: WhatsApp dispatch is now WORKER-ONLY.
    //
    // Previously this branch fired sendWhatsApp inline AND the worker
    // (notification_worker.js) also picked up the same row, causing
    // every WhatsApp send to be attempted twice — once synchronously
    // here (with hardcoded lang='en' and the raw event name as the
    // Meta template name), and once asynchronously by the worker
    // (with user.lang and the same raw template name).
    //
    // Killing the inline path: (a) eliminates duplicate sends,
    // (b) drops the hardcoded English lang, (c) lets the worker be
    // the single canonical dispatch site, (d) keeps the request
    // path fast (no synchronous Meta API round-trip).
    //
    // The notifications row still gets INSERTed above (status='queued')
    // and the worker polls for it in runNotificationWorker.

    return { ok: true, id: notifId };
  } catch (err) {
    // REGRESSION FIX (F3) — a unique violation on the dedupe index is a
    // DEDUPE, not an incident. Two concurrent callers can both clear the
    // pre-check above and race to insert; the loser lands here. Logging that
    // as an error_logs row plus a NOTIFICATION_DROPPED case_event reports a
    // notification as lost when the winner has in fact queued it, which is a
    // false positive on both /ops/errors and /ops/silent-failures.
    //
    // Narrow on purpose: 23505 is claimed as benign ONLY when this row carried
    // a dedupe key, i.e. only where a conflict is the documented behaviour. A
    // 23505 on the primary key, or any other constraint, still reports.
    if (err && err.code === '23505' && normalizedDedupeKey) {
      console.warn('[notify] queueNotification lost a dedupe race; the winning row is already queued', {
        template, channel, to: uid, dedupe_key: normalizedDedupeKey
      });
      return { ok: true, skipped: 'deduped_race', dedupe_key: normalizedDedupeKey };
    }
    logErrorToDb(err, {
      context: 'queueNotification.db_insert',
      category: 'notification_queue_failure',
      orderId,
      toUserId: uid,
      channel,
      template
    });
    emitNotificationDropped({ orderId, reason: 'db_insert_failed', channel, template, toUserId: uid });
    console.error('[notify] queueNotification insert failed', err);
    // If DB trigger blocks it or anything else happens, don't crash the app.
    // Surface a clean return so routes can continue safely.
    return {
      ok: false,
      skipped: true,
      reason: 'db_insert_failed',
      error: err && err.message ? err.message : String(err)
    };
  }
}

async function sendSlaReminder({ order, level }) {
  if (!order || !order.id || !order.doctor_id || !level) return { ok: false, skipped: true };

  const templateMap = {
    '75': 'sla_warning_75',
    '90': 'sla_warning_urgent',
    'breach': 'sla_breach'
  };

  const template = templateMap[level];
  if (!template) return { ok: false, skipped: true };

  // Prevent duplicate reminders (unique by dedupe_key+channel+user index)
  const dedupeKey = `sla:${level}:${order.id}`;
  const exists = await queryOne(`
    SELECT 1 FROM notifications
    WHERE dedupe_key = $1
      AND channel = $2
      AND to_user_id = $3
    LIMIT 1
  `, [dedupeKey, 'whatsapp', order.doctor_id]);

  if (exists) return { ok: true, skipped: true };

  return await queueNotification({
    // AUDIT-2026-08-22 (N6): orderId was omitted, so notifications.order_id was
    // NULL, notification_worker's `orderIdForSend` resolved to null, and the
    // sla_breach OpenClaw body rendered a call-to-action URL ending in a bare
    // "/portal/doctor/case/" — a dead link on the most time-critical message
    // the platform sends. The identical omission was already fixed in
    // case_lifecycle.queueSlaReminder but not in either breach path.
    //
    // It also restored a second, quieter signal: emitNotificationDropped
    // early-returns on a falsy orderId, so with order_id NULL these rows could
    // exhaust their retries and still never appear on /ops/silent-failures.
    // That guard is deliberate (it stops non-case-tied fan-outs from spamming
    // case_events) — the fix is to supply the order context, not to loosen it.
    orderId: order.id,
    channel: 'whatsapp',
    toUserId: order.doctor_id,
    template,
    dedupe_key: dedupeKey,
    response: {
      case_id: order.id
    }
  });
}

/**
 * Keep this minimal + safe:
 * Always call queueNotification using doctor.id (never doctor.email).
 */
async function doctorNotify({ doctor, template, order }) {
  if (!doctor || !doctor.id || !template) return { ok: false, skipped: true };
  return await queueNotification({
    orderId: order && order.id ? order.id : null,
    toUserId: doctor.id,
    channel: 'internal',
    template,
    status: 'queued'
  });
}

// AUDIT — `processCaseEvent` was DELETED here.
//
// It queued the SLA-breach WhatsApp alert to the literal user id
// 'superadmin-1' — a demo-seed id that does not exist in production, so
// normalizeToUserId returned it verbatim, the INSERT hit the FK/trigger
// guard, and the alert went nowhere. It had zero callers repo-wide (only
// its own definition and its module.exports entry), and the live SLA-breach
// path is `dispatchSlaBreach` below, which fans out to every active
// superadmin via notifyAdmins. Keeping a dead second implementation of the
// same escalation, wired to a fake recipient, was a trap for the next
// person to grep for 'sla_breach'.

/**
 * Fan out an admin notification to every active superadmin.
 *
 * Theme 7b Phase 1 (per OQ-8): factored from two pre-existing inline
 * copies — one in `dispatchSlaBreach` below (Theme 7 Phase 2) and one
 * in `src/video_scheduler.js notifyAdmins` (Theme 6 Phase 4). Both old
 * call sites now route through this canonical helper.
 *
 * Per-recipient dedupe key suffix (`${dedupeKey}:${r.id}`) matches the
 * unique index on notifications(dedupe_key, channel, to_user_id),
 * making each (event × recipient) pair idempotent on re-fire. The
 * inline pre-INSERT SELECT used by the old dispatchSlaBreach is now
 * redundant — queueNotification's own dedupe pre-check at
 * notify.js:280-290 catches existing rows just as well.
 *
 * @param {Object} opts
 * @param {string} opts.template     - Notification template name.
 * @param {Object} [opts.payload]    - JSON-serializable response payload.
 * @param {string} opts.dedupeKey    - Base dedupe key; per-recipient suffix
 *                                     `${dedupeKey}:${r.id}` is appended
 *                                     automatically.
 * @param {string} [opts.orderId]    - Optional order id for linking.
 * @param {string} [opts.channel]    - Notification channel; defaults to
 *                                     'internal' (in-app admin queue).
 *                                     Pass 'whatsapp' for SLA-breach
 *                                     escalations.
 * @returns {Promise<Array>} - Per-recipient queueNotification results.
 */
async function notifyAdmins({ template, payload, dedupeKey, orderId, channel } = {}) {
  if (!template || !dedupeKey) return [];
  const ch = channel || 'internal';

  let recipients = [];
  try {
    // AUDIT-2026-08-22 (AUDIT-LANG-NPLUS1-1) — `lang` added to a query that was
    // already running, so the per-recipient queueNotification below no longer
    // triggers one resolveRecipientLang SELECT per superadmin per event.
    recipients = await queryAll(
      "SELECT id, lang FROM users WHERE role = 'superadmin' AND COALESCE(is_active, true) = true"
    );
  } catch (e) {
    console.error('[notify.notifyAdmins] superadmin lookup failed:', e && e.message);
    return [];
  }
  if (!recipients || recipients.length === 0) {
    return [];
  }

  const results = [];
  for (const r of recipients) {
    try {
      const result = await queueNotification({
        orderId: orderId || null,
        toUserId: r.id,
        channel: ch,
        template,
        status: 'queued',
        response: (payload && typeof payload === 'object') ? JSON.stringify(payload) : payload,
        dedupe_key: `${dedupeKey}:${r.id}`,
        recipientLang: r.lang,
      });
      results.push(result);
    } catch (e) {
      console.error('[notify.notifyAdmins] enqueue failed for', r.id, ':', e && e.message);
    }
  }
  return results;
}

/**
 * Dispatch the SLA-breach WhatsApp alert to every active superadmin.
 *
 * Theme 7 sub-issue B: queries active superadmins instead of the
 * hardcoded 'superadmin-1' placeholder. Theme 7b Phase 1: refactored
 * to delegate to the shared `notifyAdmins` helper — no behaviour
 * change for callers (return value still ignored at every callsite).
 */
async function dispatchSlaBreach(caseId) {
  if (!caseId) return;
  return notifyAdmins({
    // AUDIT-2026-08-22 (N6): `sla_breach` is DOCTOR-addressed copy ("Immediate
    // action needed", CTA into /portal/doctor/case/) and this call fans it out
    // to every active superadmin — people who cannot write the review and do
    // not use that portal. Superadmins now get sla_breach_superadmin, whose
    // copy names the action they can actually take (escalate / reassign) and
    // whose CTA points at the ops order view. sla_breach itself is unchanged
    // and still goes to the assigned doctor via sendSlaReminder.
    template: 'sla_breach_superadmin',
    payload: { case_id: caseId, status: 'breached' },
    dedupeKey: `sla:breach:${caseId}`,
    // AUDIT-2026-08-22 (N6): orderId was omitted here too — same dead
    // "/portal/doctor/case/" link and same invisibility on
    // /ops/silent-failures as sendSlaReminder above. notifyAdmins already
    // threads orderId through to queueNotification; it was simply never passed.
    orderId: caseId,
    channel: 'whatsapp',
  });
}

/**
 * Queue a notification across multiple channels simultaneously.
 * Respects user preferences: skips WhatsApp if user has no phone or notify_whatsapp=0,
 * skips email if user has no email address.
 *
 * @param {Object} options
 * @param {string} [options.orderId] - Related order ID
 * @param {string} options.toUserId - User ID or email
 * @param {string[]} options.channels - Array of channels: ['email', 'whatsapp', 'internal'] or ['both']
 * @param {string} options.template - Notification template name
 * @param {string} [options.status='queued'] - Initial status
 * @param {Object|string} [options.response] - Response/metadata payload
 * @param {string} [options.dedupe_key] - Base deduplication key (channel suffix auto-appended)
 * @returns {Promise<Object>} Result with per-channel outcomes
 */
async function queueMultiChannelNotification({
  orderId = null,
  toUserId,
  channels = ['internal'],
  template,
  status = 'queued',
  response = null,
  dedupe_key = null
}) {
  // Expand 'both' shorthand
  let resolvedChannels = channels;
  if (channels.includes('both')) {
    resolvedChannels = ['email', 'whatsapp', 'internal'];
  }

  const uid = await normalizeToUserId(toUserId);
  if (!uid) {
    emitNotificationDropped({ orderId, reason: 'invalid_to_user_id', channel: 'multi', template, toUserId });
    return { ok: false, skipped: true, reason: 'invalid_to_user_id', toUserId };
  }

  // Look up user preferences once
  let user = null;
  try {
    // AUDIT-2026-08-22 (AUDIT-LANG-NPLUS1-1) — `lang` added here. This lookup
    // already happens on every multi-channel event; without the column, the
    // three queueNotification calls below each ran their own SELECT on the same
    // row, i.e. four reads of one user per event.
    user = await queryOne(
      'SELECT id, email, phone, lang, role, notify_whatsapp FROM users WHERE id = $1 LIMIT 1',
      [uid]
    );
  } catch (e) {
    console.error('[notify] user lookup for multi-channel failed', { uid, error: e.message });
  }

  const results = {};

  // P1-NOTIF-1: dispatch channels concurrently via Promise.allSettled.
  // Previously the for-await loop ran channels sequentially, so a slow
  // WhatsApp dispatch blocked email queueing. allSettled ensures one
  // channel's failure or slowness never affects another.
  const channelTasks = resolvedChannels.map(function (ch) {
    // Channel-specific preference checks. Resolve synchronously to
    // a "skipped" result so we don't even spawn a queueNotification
    // promise for channels that can't fire.
    if (ch === 'whatsapp') {
      if (!user || !user.phone) {
        emitNotificationDropped({ orderId, reason: 'no_phone', channel: ch, template, toUserId: uid });
        return Promise.resolve([ch, { ok: true, skipped: true, reason: 'no_phone' }]);
      }
      // AUDIT-2026-08-22 (AUDIT-STAFF-OPTOUT-1) — the SECOND enforcement point
      // for notify_whatsapp (the other is notification_worker.processWhatsApp).
      // They must agree, so the same patient-only rule applies here: on this
      // database the flag is only meaningful for patients, because migration
      // 062's backfill was scoped `WHERE role='patient'` while
      // 001_initial_tables.sql defaulted the column to false. Every pre-062
      // doctor/admin row still reads false and would otherwise be silently
      // unreachable over WhatsApp. See the long note in
      // notification_worker.processWhatsApp for the full reasoning.
      const _isPatientRecipient = String((user && user.role) || '').toLowerCase() === 'patient';
      if ((user.notify_whatsapp === 0 || user.notify_whatsapp === false) && _isPatientRecipient) {
        emitNotificationDropped({ orderId, reason: 'whatsapp_opted_out', channel: ch, template, toUserId: uid });
        return Promise.resolve([ch, { ok: true, skipped: true, reason: 'whatsapp_opted_out' }]);
      }
      if ((user.notify_whatsapp === 0 || user.notify_whatsapp === false) && !_isPatientRecipient) {
        console.warn('[notify] staff recipient has notify_whatsapp=false; QUEUEING ANYWAY ' +
          '(pre-062 default, not a real opt-out — see AUDIT-STAFF-OPTOUT-1)',
          { uid, role: user.role, template });
      }
    }
    if (ch === 'email') {
      if (!user || !user.email) {
        emitNotificationDropped({ orderId, reason: 'no_email', channel: ch, template, toUserId: uid });
        return Promise.resolve([ch, { ok: true, skipped: true, reason: 'no_email' }]);
      }
    }

    const channelDedupeKey = dedupe_key ? `${dedupe_key}:${ch}` : null;
    return queueNotification({
      orderId,
      toUserId: uid,
      channel: ch,
      template,
      status,
      response,
      dedupe_key: channelDedupeKey,
      recipientLang: user ? user.lang : null,
    }).then(function (r) { return [ch, r]; });
  });

  const settled = await Promise.allSettled(channelTasks);
  settled.forEach(function (s, idx) {
    if (s.status === 'fulfilled') {
      var pair = s.value;
      results[pair[0]] = pair[1];
    } else {
      results[resolvedChannels[idx]] = { ok: false, error: s.reason && s.reason.message ? s.reason.message : String(s.reason) };
    }
  });

  return { ok: true, results };
}

module.exports = {
  queueNotification,
  queueMultiChannelNotification,
  doctorNotify,
  // `processCaseEvent` removed with its definition — see the comment above
  // dispatchSlaBreach. It had no callers and targeted the demo-seed id
  // 'superadmin-1'.
  dispatchSlaBreach,
  notifyAdmins,
  sendSlaReminder,
  PAYMENT_REMINDER_TEMPLATES,
  buildPaymentReminderPayload,
  clearEmailCache,
  // Side issue #46 — exported so notification_worker can emit the
  // NOTIFICATION_DROPPED case_event on max-retries-exceeded (the
  // enqueue-side already emits for invalid recipient / no channel /
  // db_insert_failed via the same helper).
  emitNotificationDropped
};
