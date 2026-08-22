const dayjs = require('dayjs');
// src/routes/video.js
// Video Consultation routes: appointment booking, payment, video calls, reschedule, cancel, no-show.

const express = require('express');
const { randomUUID } = require('crypto');
const { queryOne, queryAll, execute, withTransaction } = require('../pg');
const { requireRole } = require('../middleware');
const { queueNotification } = require('../notify');
const { verifyPaymobHmac } = require('../paymob-hmac');
const { logOrderEvent } = require('../audit');
const { generateToken, getRoomName, isVideoEnabled } = require('../video_helpers');
const { sendCriticalAlert } = require('../critical-alert');
const { getAddon, safeDualWrite } = require('../services/addons/registry');
// AUDIT-2026-08-22 (M1): the SAME parser routes/payments.js uses to read the
// add-on selection + charged price locked on the order at intention time.
// Booking must not re-derive that from the catalogue — the catalogue can drift
// from what the patient was actually charged (see FIX 9 in addons/video_consult.js).
const { parseSelectedAddons } = require('../services/order_pricing');
// AUDIT-2026-08-22 (R1/R2): terminal transitions on an appointment funded by
// the case add-on must RELEASE the entitlement, not fake a refund against a
// payment row that never held any money. See the module header for why
// releasing (rather than writing a `refunds` row) is the right repair.
const { releaseVideoAddonEntitlement, ADDON_PAYMENT_METHOD } = require('../services/video_addon_entitlement');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLang(req) {
  return (req.cookies && req.cookies.lang) || (req.user && req.user.lang) || 'en';
}

function t(lang, en, ar) {
  return String(lang).toLowerCase() === 'ar' ? ar : en;
}

function nowIso() {
  return new Date().toISOString();
}

function hoursUntil(isoDate) {
  return dayjs(isoDate).diff(dayjs(), 'hour', true);
}

function minutesUntil(isoDate) {
  return dayjs(isoDate).diff(dayjs(), 'minute', true);
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Date-formatting helpers for video_appointment.ejs. Pre-format in the route
// so the template never has to call dayjs() — avoids the ReferenceError class
// where one render call site forgets to thread `dayjs` (Theme 2 Sub-issue A).
const APT_DATE_FORMAT = 'DD/MM/YYYY — hh:mm A';
const INPUT_DATETIME_FORMAT = 'YYYY-MM-DDTHH:mm';

function formatAptDate(d) {
  return d ? dayjs(d).format(APT_DATE_FORMAT) : null;
}

function inputMinFromNow(hours) {
  return dayjs().add(hours, 'hour').format(INPUT_DATETIME_FORMAT);
}

function ensureParticipant(appointment, userId) {
  return appointment.patient_id === userId || appointment.doctor_id === userId;
}

/**
 * Resolve price from a JSON prices column based on currency.
 * @param {string|null} pricesJson - JSON string like '{"EGP":200,"SAR":50,"GBP":15}'
 * @param {string} currency - Target currency code (e.g. 'EGP', 'SAR')
 * @param {number} fallbackPrice - Default price if currency not found
 * @returns {{ price: number, currency: string }}
 */
function resolvePrice(pricesJson, currency, fallbackPrice) {
  if (!pricesJson || pricesJson === '{}') {
    return { price: fallbackPrice || 0, currency: currency || 'EGP' };
  }
  try {
    const prices = JSON.parse(pricesJson);
    const cur = (currency || 'EGP').toUpperCase();
    if (prices[cur] !== undefined && prices[cur] !== null) {
      return { price: Number(prices[cur]), currency: cur };
    }
    // Fallback to EGP if available
    if (prices.EGP !== undefined) {
      return { price: Number(prices.EGP), currency: 'EGP' };
    }
    return { price: fallbackPrice || 0, currency: cur };
  } catch (_) {
    return { price: fallbackPrice || 0, currency: currency || 'EGP' };
  }
}

function getPatientCurrency(req) {
  // Check order's locked currency, then user's country, then default
  const userCountry = (req.user && req.user.country_code) || '';
  const COUNTRY_MAP = { EG: 'EGP', GB: 'GBP', SA: 'SAR', AE: 'AED', KW: 'KWD', QA: 'QAR', BH: 'BHD', OM: 'OMR' };
  const code = userCountry.toUpperCase();
  return COUNTRY_MAP[code] || 'EGP';
}

// ---------------------------------------------------------------------------
// AUDIT-2026-08-22 (M1): VIDEO ADD-ON ENTITLEMENT
//
// The video consultation add-on is priced into the CASE checkout
// (routes/payments.js create-intention, :158-197) and fulfilled by the Paymob
// webhook (:1132-1213), which persists the selection + the CHARGED price on
// orders.addons_json / orders.video_consultation_selected. Booking then
// unconditionally opened a SECOND checkout (a 'pending' appointment_payments
// row + /portal/video/pay), so the patient either paid twice for one product
// or refused and left the appointment in 'pending_payment' forever while the
// platform kept the add-on money.
//
// A paid, unconsumed add-on now funds exactly ONE appointment, with no second
// checkout. Two rules govern this code:
//
//   * Source of truth is orders.addons_json, NOT order_addons. The
//     order_addons row is written through safeDualWrite(), which is gated on
//     ADDON_SYSTEM_V2 — false by default (see services/addons/registry.js), so
//     that row is ABSENT on most paid orders. addons_json is written
//     unconditionally by the webhook and is what the refund ceiling
//     (services/refund_eligibility.js) and the earnings writer already read.
//
//   * Never fail open. Anything we cannot read with certainty (unparseable
//     addons_json, order not paid, add-on priced at zero, entitlement already
//     claimed, claim lost a race) falls through to the existing paid flow. A
//     free consultation is only ever minted by a claim that WON.
//
// Consumption is recorded as `video_consultation_consumed_by` on addons_json.
// That key is claimed by ONE conditional UPDATE (see the booking transaction),
// so a second booking against the same add-on can never mint a second free
// consultation — the same class of hole FIX 1 closed on /api/video/end.
// ---------------------------------------------------------------------------

/**
 * Parse orders.addons_json defensively. The column is TEXT holding JSON
 * (migration 002), but pg hands back an object if it is ever migrated to
 * jsonb, so handle both.
 * @returns {object|null} null = unreadable; caller MUST fall back to paying.
 */
function parseAddonsJsonSafe(order) {
  const raw = order ? order.addons_json : null;
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * Is there a PAID, UNCONSUMED video-consultation add-on on this order?
 * Read-only pre-check — the authoritative, race-proof claim is the conditional
 * UPDATE inside POST /portal/video/book.
 * @returns {{price:number, currency:string}|null}
 */
function readVideoAddonEntitlement(order) {
  if (!order) return null;
  // Only a PAID case can have paid for the add-on. The webhook writes the
  // add-on state and payment_status='paid' on the same callback.
  if (String(order.payment_status || '').toLowerCase() !== 'paid') return null;

  // Unreadable addons_json => the `::jsonb` cast in the claim would abort the
  // booking transaction. Bail to the paid flow instead.
  const rawAddons = parseAddonsJsonSafe(order);
  if (rawAddons === null) return null;

  // Already consumed by an earlier booking on this order.
  if (rawAddons.video_consultation_consumed_by) return null;

  const sel = parseSelectedAddons(order);
  if (!sel.video_consultation) return null;

  // A selected add-on priced at 0 added 0 to the Paymob intention
  // (order_pricing.owedCentsForOrder) — nothing was bought, so nothing is owed.
  const price = Number(sel.video_consultation_price) || 0;
  if (!(price > 0)) return null;

  return {
    price: price,
    currency: String(order.currency || order.locked_currency || 'EGP').toUpperCase()
  };
}

/**
 * AUDIT-2026-08-22 (M1 follow-up, P0): may the V2 `onComplete` dual-write mint
 * an addon_earnings row for this appointment?
 *
 * ONE SALE MUST NOT PAY THE DOCTOR TWICE. Since M1, POST /portal/video/book
 * can fund an appointment out of the video-consultation add-on the patient
 * already paid for at case checkout; it records that with a MARKER row —
 * appointment_payments.status='paid', method='order_addon' — and no second
 * charge behind it. On such an appointment the two payout ledgers are fed by
 * the SAME revenue line: doctor_earnings (appointment.price × commission) and
 * addon_earnings (order_addons.price_at_purchase_egp × commission). A real
 * card payment writes method='paymob' (see the Paymob callback) and still has
 * two independent revenue lines, so it keeps both.
 *
 * Detection reuses the established test — `method` lower-cased against
 * ADDON_PAYMENT_METHOD, exactly as services/video_addon_entitlement.js does
 * on the cancel / no-show release paths — resolved through
 * appointments.payment_id, the same row every other money guard here resolves.
 *
 * FAIL SAFE = DO NOT PAY. When the payment row cannot be resolved (no
 * payment_id, row missing) the funding method is unknown, and the two error
 * directions are not symmetric: suppressing wrongly under-pays a doctor by an
 * amount that is visible in addon_earnings and correctable by an operator,
 * while writing wrongly pays real money twice out of one sale and is only
 * caught by reconciliation. So an unknown method is treated as add-on funded.
 * (An unresolvable row also already fails the `paid` guards upstream, so this
 * is a backstop, not the primary gate.)
 *
 * @param {object|null} payment  appointment_payments row; must carry `method`
 * @param {object} appointment
 * @returns {boolean} true only when a second, independent payout is warranted
 */
function allowAddonEarningsWrite(payment, appointment) {
  if (!payment) {
    console.warn('[video] addon_earnings suppressed — payment row unresolved, funding method unknown', {
      appointment_id: appointment && appointment.id,
      payment_id: (appointment && appointment.payment_id) || null
    });
    return false;
  }
  if (String(payment.method || '').toLowerCase() === ADDON_PAYMENT_METHOD) {
    console.warn('[video] addon_earnings suppressed — appointment funded by the case add-on; doctor_earnings is the paying ledger', {
      appointment_id: appointment && appointment.id,
      payment_id: payment.id
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// GET /portal/video/book/:orderId — Show booking form (patient)
// ---------------------------------------------------------------------------
router.get('/portal/video/book/:orderId', requireRole('patient'), async (req, res) => {
  const lang = getLang(req);
  const { orderId } = req.params;

  const order = await queryOne('SELECT * FROM orders_active WHERE id = $1', [orderId]);
  if (!order || order.patient_id !== req.user.id) {
    return res.status(404).render('error', {
      layout: 'portal', title: 'Not Found',
      message: t(lang, 'Order not found', 'الطلب غير موجود'), lang
    });
  }

  const service = order.service_id
    ? await queryOne('SELECT * FROM services WHERE id = $1', [order.service_id])
    : null;

  const patientCurrency = order.locked_currency || getPatientCurrency(req);
  const resolved = resolvePrice(
    service && service.video_consultation_prices_json,
    patientCurrency,
    (service && service.video_consultation_price) ? service.video_consultation_price : 200
  );

  // Check for existing pending appointment on this order
  const existingAppointment = await queryOne(
    `SELECT * FROM appointments WHERE order_id = $1 AND patient_id = $2
     AND status NOT IN ('cancelled','no_show_patient','no_show_doctor')
     ORDER BY created_at DESC LIMIT 1`,
    [orderId, req.user.id]
  );

  // AUDIT-2026-08-22 (M1): the CTA read "Book & Pay — N EGP" even when the
  // patient had already bought this consultation at case checkout and POST
  // /portal/video/book will charge them nothing. Telling a patient they are
  // about to pay for something they already paid for is the visible half of
  // the double-charge bug.
  const bookEntitlement = readVideoAddonEntitlement(order);

  res.render('video_appointment', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    layout: 'portal',
    title: t(lang, 'Book Video Consultation', 'حجز استشارة فيديو'),
    lang,
    portalFrame: true,
    portalRole: 'patient',
    portalActive: 'dashboard',
    mode: 'book',
    order,
    doctor: null,
    service,
    price: bookEntitlement ? bookEntitlement.price : resolved.price,
    priceCurrency: bookEntitlement ? bookEntitlement.currency : resolved.currency,
    addonPaid: !!bookEntitlement,
    commissionPct: (service && service.video_doctor_commission_pct) ? service.video_doctor_commission_pct : 80,
    existingAppointment,
    appointment: null,
    bookMinIso: inputMinFromNow(1),
    videoEnabled: isVideoEnabled()
  });
});

// ---------------------------------------------------------------------------
// POST /portal/video/book — Patient picks preferred slot, pay, await doctor
// ---------------------------------------------------------------------------
router.post('/portal/video/book', requireRole('patient'), async (req, res) => {
  // Theme 9 Sub-issue C: kill-switch gate. When the flag is off, refuse new
  // bookings cleanly before any DB work. In-flight appointments (rows
  // already in `appointments`) are not affected — they still resolve
  // through /pay and /appointment/:id with whatever credentials they had.
  if (!isVideoEnabled()) {
    return res.status(503).json({ ok: false, error: 'video_disabled' });
  }
  const lang = getLang(req);
  const { order_id, scheduled_at } = req.body;

  if (!order_id || !scheduled_at) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  const scheduledDate = dayjs(scheduled_at);
  if (!scheduledDate.isValid() || scheduledDate.isBefore(dayjs().add(1, 'hour'))) {
    return res.status(400).json({ ok: false, error: 'Date must be at least 1 hour from now' });
  }

  const order = await queryOne('SELECT * FROM orders_active WHERE id = $1 AND patient_id = $2', [order_id, req.user.id]);
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });

  const service = order.service_id
    ? await queryOne('SELECT * FROM services WHERE id = $1', [order.service_id])
    : null;

  const patientCurrency = order.locked_currency || getPatientCurrency(req);
  const resolved = resolvePrice(
    service && service.video_consultation_prices_json,
    patientCurrency,
    (service && service.video_consultation_price) ? Number(service.video_consultation_price) : 200
  );
  const price = resolved.price;
  const priceCurrency = resolved.currency;
  const commissionPct = (service && service.video_doctor_commission_pct) ? Number(service.video_doctor_commission_pct) : 80;

  // AUDIT-2026-08-22 (M1): read-only pre-check. The binding decision is the
  // conditional UPDATE inside the transaction below — this only avoids doing
  // the JSON work twice and lets us skip the claim entirely when there is
  // plainly nothing to claim.
  const entitlement = readVideoAddonEntitlement(order);

  try {
    const result = await withTransaction(async (client) => {
      const appointmentId = `appt-${randomUUID()}`;
      const paymentId = `vpay-${randomUUID()}`;
      const videoCallId = `vcall-${randomUUID()}`;
      const now = nowIso();

      // ── AUDIT-2026-08-22 (M1): CLAIM THE ADD-ON, ATOMICALLY ──────────────
      // One statement does the whole check-and-consume: the WHERE clause
      // re-verifies (inside the transaction, under the orders row lock) that
      // the case is paid, that the add-on really is selected on it, and that
      // nobody has consumed it yet; the SET stamps THIS appointment id onto
      // addons_json as the consumer. rowCount === 1 means this request is the
      // one that won. Two concurrent bookings therefore cannot both be funded:
      // the loser sees rowCount 0 and falls through to the normal paid flow.
      // Rolling the transaction back releases the claim with it.
      //
      // The predicate mirrors order_pricing.parseSelectedAddons: the JSON flag
      // OR the legacy video_consultation_selected column. Text comparison, not
      // `::boolean` — a malformed value must not raise and abort the booking.
      let funded = false;
      if (entitlement) {
        const claim = await client.query(`
          UPDATE orders
             SET addons_json = COALESCE(addons_json, '{}')::jsonb || $3::jsonb
           WHERE id = $1
             AND patient_id = $2
             AND LOWER(COALESCE(payment_status, '')) = 'paid'
             AND (COALESCE(addons_json, '{}')::jsonb ->> 'video_consultation_consumed_by') IS NULL
             AND (
                   (COALESCE(addons_json, '{}')::jsonb ->> 'video_consultation') IN ('true', 't', '1')
                   OR COALESCE(video_consultation_selected, false) = true
                 )
        `, [order_id, req.user.id, JSON.stringify({
          video_consultation_consumed_by: appointmentId,
          video_consultation_consumed_at: now
        })]);
        funded = !!(claim && claim.rowCount === 1);
      }

      if (funded) {
        // Paid at case checkout. The appointment_payments row is written
        // 'paid' rather than skipped so that every downstream guard which
        // resolves payment through appointment.payment_id keeps working
        // unchanged: the /api/video/end earnings gate (guard 3), the no-show
        // earnings gate, the cancel/refund path and the doctor dashboard.
        // amount = the price the patient was ACTUALLY charged for the add-on,
        // read off the order — never the catalogue. method='order_addon' is
        // the marker the refund path needs to see that this consultation was
        // funded by the case order, not by a separate card payment.
        await client.query(`
          INSERT INTO appointment_payments
            (id, appointment_id, patient_id, amount, currency, status, method, reference, paid_at, created_at)
          VALUES ($1, $2, $3, $4, $5, 'paid', 'order_addon', $6, $7, $7)
        `, [paymentId, appointmentId, req.user.id, entitlement.price, entitlement.currency, `order:${order_id}`, now]);
      } else {
        await client.query(`
          INSERT INTO appointment_payments (id, appointment_id, patient_id, amount, currency, status, created_at)
          VALUES ($1, $2, $3, $4, $5, 'pending', $6)
        `, [paymentId, appointmentId, req.user.id, price, priceCurrency, now]);
      }

      // Funded by the add-on → 'pending_doctor', which is EXACTLY the state the
      // Paymob video callback leaves a freshly paid appointment in: money
      // settled, slot still to be accepted by the doctor. It is deliberately
      // not 'confirmed' — 'confirmed' is the doctor's own act (accept-slot),
      // and minting it here would put appointments on the doctor's calendar
      // that they never agreed to, then bill the platform for a doctor no-show
      // refund when they don't show. Otherwise: 'pending_payment' as before.
      const apptStatus = funded ? 'pending_doctor' : 'pending_payment';
      const apptPrice = funded ? entitlement.price : price;
      await client.query(`
        INSERT INTO appointments
          (id, order_id, patient_id, doctor_id, specialty_id, scheduled_at, status,
           video_call_id, payment_id, price, doctor_commission_pct,
           patient_requested_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $14, $7, $8, $9, $10, $11, $12, $13)
      `, [
        appointmentId, order_id,
        req.user.id,
        order.doctor_id || null,       // may be null if no doctor yet — assigned on acceptance
        order.specialty_id || null,
        scheduledDate.toISOString(),
        videoCallId, paymentId, apptPrice, commissionPct,
        now, now, now, apptStatus
      ]);

      await client.query(`
        INSERT INTO video_calls (id, appointment_id, patient_id, doctor_id, status, twilio_room_name, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
      `, [videoCallId, appointmentId, req.user.id, order.doctor_id || null, getRoomName(appointmentId), now, now]);

      return { appointmentId, paymentId, funded };
    });

    logOrderEvent({
      orderId: order_id,
      label: 'video_slot_requested',
      meta: JSON.stringify({
        appointment_id: result.appointmentId,
        preferred_slot: scheduledDate.toISOString(),
        price: result.funded ? entitlement.price : price,
        funded_by: result.funded ? 'order_addon' : 'appointment_payment'
      }),
      actorUserId: req.user.id,
      actorRole: 'patient'
    });

    if (result.funded) {
      // AUDIT-2026-08-22 (M1): money trail for the consumed entitlement —
      // reconciliation has to be able to tie the free-at-booking appointment
      // back to the add-on line the patient paid for at case checkout.
      logOrderEvent({
        orderId: order_id,
        label: 'video_addon_entitlement_consumed',
        meta: JSON.stringify({
          appointment_id: result.appointmentId,
          payment_id: result.paymentId,
          addon_price: entitlement.price,
          currency: entitlement.currency
        }),
        actorUserId: req.user.id,
        actorRole: 'patient'
      });

      // Same notifications the Paymob video callback sends once a payment
      // settles — this appointment reaches 'pending_doctor' by the same route,
      // just with the money already collected. Without the doctor's review
      // request the slot would sit untouched until the 48h stale sweep
      // auto-cancels it (video_scheduler.sweepStalePendingSlots).
      //
      // AUDIT-2026-08-22 (R6, P1): these three are FIRE-AND-FORGET and must
      // therefore be .catch()'d. queueNotification is async and awaits a
      // `users` lookup (notify.js normalizeToUserId), so any transient DB error
      // rejects the promise; nothing awaits it, and server.js's
      // `unhandledRejection` handler is fatal — it calls process.exit(1). These
      // fire immediately after the transaction that CONSUMED the entitlement
      // committed, so the crash would land after the money is spent and before
      // the patient ever sees the redirect. Same treatment routes/payments.js
      // already gives its fire-and-forget notification calls.
      queueNotification({
        orderId: order_id,
        toUserId: req.user.id,
        channel: 'internal',
        template: 'video_payment_confirmed',
        status: 'queued',
        response: JSON.stringify({
          appointment_id: result.appointmentId,
          scheduled_at: scheduledDate.toISOString()
        })
      }).catch(function (err) {
        console.error('[video] video_payment_confirmed (internal) queue failed:', err && err.message);
      });
      queueNotification({
        orderId: order_id,
        toUserId: req.user.id,
        channel: 'whatsapp',
        template: 'video_payment_confirmed',
        status: 'queued',
        response: JSON.stringify({
          appointment_id: result.appointmentId,
          scheduled_at: scheduledDate.toISOString()
        })
      }).catch(function (err) {
        console.error('[video] video_payment_confirmed (whatsapp) queue failed:', err && err.message);
      });
      if (order.doctor_id) {
        queueNotification({
          orderId: order_id,
          toUserId: order.doctor_id,
          channel: 'internal',
          template: 'video_slot_review_requested',
          status: 'queued',
          response: JSON.stringify({
            appointment_id: result.appointmentId,
            patient_preferred_slot: scheduledDate.toISOString()
          })
        }).catch(function (err) {
          console.error('[video] video_slot_review_requested queue failed:', err && err.message);
        });
      } else {
        // AUDIT-2026-08-22 (R1): the case has no doctor yet, so there is nobody
        // to ask to accept this slot. The appointment still sits in
        // 'pending_doctor' and video_scheduler.sweepStalePendingSlots will
        // auto-cancel it at 48h (the entitlement is now released when it does,
        // so the patient is no longer out of pocket — but they will rebook into
        // the same dead end). Leave a timeline marker so the 24h admin
        // escalation has something to act on. HAND-OFF: assignment should
        // notify the doctor about any pending_doctor appointment it inherits.
        logOrderEvent({
          orderId: order_id,
          label: 'video_slot_awaiting_doctor_assignment',
          meta: JSON.stringify({ appointment_id: result.appointmentId }),
          actorUserId: req.user.id,
          actorRole: 'patient'
        });
      }
      return res.redirect(`/portal/video/appointment/${result.appointmentId}`);
    }

    return res.redirect(`/portal/video/pay/${result.appointmentId}`);
  } catch (err) {
    console.error('[video] Booking failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Booking failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /portal/video/pay/:appointmentId — Video payment page (Paymob hosted)
// ---------------------------------------------------------------------------
router.get('/portal/video/pay/:appointmentId', requireRole('patient'), async (req, res) => {
  // Theme 9 Sub-issue C: kill-switch gate. Redirect rather than 503 because
  // this is a navigable GET — the patient gets a soft landing on the
  // dashboard instead of an HTTP error page.
  if (!isVideoEnabled()) {
    return res.redirect('/dashboard?msg=video_unavailable');
  }
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.appointmentId]);

  if (!appointment || appointment.patient_id !== req.user.id) {
    return res.status(404).render('error', {
      layout: 'portal', title: 'Not Found',
      message: t(lang, 'Appointment not found', 'الموعد غير موجود'), lang
    });
  }

  if (appointment.status === 'confirmed') {
    // Already paid — go straight to appointment detail
    return res.redirect(`/portal/video/appointment/${appointment.id}`);
  }

  const payment = appointment.payment_id
    ? await queryOne('SELECT * FROM appointment_payments WHERE id = $1', [appointment.payment_id])
    : null;

  if (payment && payment.status === 'paid') {
    return res.redirect(`/portal/video/appointment/${appointment.id}`);
  }

  const doctor = await queryOne('SELECT id, name FROM users WHERE id = $1', [appointment.doctor_id]);
  const PAYMOB_PUBLIC_KEY = process.env.PAYMOB_PUBLIC_KEY || '';
  const callbackUrl = `${process.env.BASE_URL || ''}/portal/video/payment/callback`;
  const returnUrl = `${process.env.BASE_URL || ''}/portal/video/appointment/${appointment.id}`;

  res.render('video_appointment', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    layout: 'portal',
    title: t(lang, 'Pay for Video Consultation', 'الدفع للاستشارة المرئية'),
    lang,
    portalFrame: true,
    portalRole: 'patient',
    portalActive: 'dashboard',
    mode: 'pay',
    appointment,
    doctor,
    payment,
    price: appointment.price,
    priceCurrency: payment ? payment.currency : 'EGP',
    paymobPublicKey: PAYMOB_PUBLIC_KEY,
    callbackUrl,
    returnUrl,
    videoEnabled: isVideoEnabled(),
    order: null,
    service: null,
    existingAppointment: null
  });
});

// ---------------------------------------------------------------------------
// POST /portal/video/payment/callback — Paymob webhook for video payment
// ---------------------------------------------------------------------------
router.post('/portal/video/payment/callback', async (req, res) => {
  const hmacSecret = process.env.PAYMOB_HMAC_SECRET;
  if (!hmacSecret) return res.status(503).json({ ok: false, error: 'webhook_not_configured' });

  const hmacResult = verifyPaymobHmac(req, hmacSecret);
  if (!hmacResult.ok) {
    console.warn('[video-callback] HMAC verification failed:', hmacResult.reason, 'ip:', req.ip);
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // Paymob wraps the transaction in body.obj; fall back to flat body for compatibility
  const body = req.body || {};
  const txn = body.obj || body;
  const { payment_id, reference } = txn;
  if (!payment_id) return res.status(400).json({ ok: false, error: 'payment_id required' });

  // ── AUDIT-P0-6: outcome from HMAC-SIGNED FIELDS ONLY ────────────────────
  //
  // This route used to read `txn.status`, which is not one of the 19 fields in
  // the HMAC subject (src/paymob-hmac.js). Combined with the total absence of
  // amount verification and per-transaction idempotency, one captured
  // (hmac, signed fields) pair could be replayed forever against freshly
  // booked appointment ids with `status:"success"` appended — unlimited free
  // video consultations. `success`, `pending` and `error_occured` ARE signed.
  const paymobTxnId = (txn && txn.id != null) ? String(txn.id) : null;
  const paymobIntentionId = (txn && txn.intention && txn.intention.id != null)
    ? String(txn.intention.id) : null;

  // ── AUDIT 2026-08-17 (FIX 2): honour the SIGNED refund / void flags ────────
  //
  // is_refunded, is_voided and has_parent_transaction are all inside the
  // HMAC-signed 19-field set (src/paymob-hmac.js HMAC_FIELDS) and neither
  // callback read them. A void or a refund is delivered as its own transaction
  // carrying `success: true` and a FRESH obj.id — so it sailed through both the
  // amount check (the amounts match; it is the same money going the other way)
  // and the per-transaction-id idempotency index (the id is new). Paymob
  // telling us "this money went back to the cardholder" was being processed as
  // "this appointment is paid".
  //
  // ── AUDIT 2026-08-17 (regression F4): has_parent_transaction is NOT a refund
  // signal and must not gate the paid path. It is equally true of a CAPTURE of
  // a prior authorisation and of a token/recurring charge — money coming IN.
  // Because it short-circuited before the amount check, such a transaction was
  // rejected outright: patient charged, appointment left unpaid, and the
  // "reconcile manually" alert is itself a no-op while
  // CRITICAL_ALERT_TEMPLATE_NAME is unset. Kept as a pure audit signal below
  // (logged + paged, never blocking) — mirrors routes/payments.js /callback.
  const isRefundOrVoid = (txn.is_refunded === true)
    || (txn.is_voided === true);
  const hasParentTxn = (txn.has_parent_transaction === true);

  const isSuccess = (txn.success === true)
    && (txn.pending !== true)
    && (txn.error_occured !== true)
    && (txn.is_refunded !== true)
    && (txn.is_voided !== true);

  // Theme 9 Sub-issue C: kill-switch gate on the webhook. ACK Paymob (200) so
  // they don't retry, but trigger a critical alert — the patient already
  // paid, ops needs to issue a manual refund out-of-band. Returning 503
  // here would cause Paymob to retry the webhook indefinitely, which
  // would not fix the underlying refund obligation.
  if (!isVideoEnabled()) {
    sendCriticalAlert(
      'Video payment received with VIDEO_CONSULTATION_ENABLED=false. ' +
      'Manual refund needed for payment_id=' + payment_id,
      'video_disabled_post_payment'
    );
    return res.json({ ok: true, note: 'video_disabled_manual_refund_required' });
  }

  const payment = await queryOne('SELECT * FROM appointment_payments WHERE id = $1', [payment_id]);
  if (!payment) return res.status(404).json({ ok: false, error: 'payment not found' });

  // A refund/void signal is a real, signed money event — audit and page, never
  // silently drop. There is no Paymob refund API integration on this platform,
  // so an inbound refund/void is by definition unexpected and needs a human.
  if (isRefundOrVoid) {
    console.warn('[video-callback] refund/void transaction received — NOT marking paid', {
      payment_id, paymobTxnId,
      is_refunded: txn.is_refunded === true,
      is_voided: txn.is_voided === true,
      has_parent_transaction: txn.has_parent_transaction === true
    });
    try {
      // Resolve the real case id so the event lands on the case timeline.
      // order_events.order_id has no FK, so an appointment id would silently
      // orphan the row. This path is rare (refund/void only) — the extra
      // lookup costs nothing on the hot path.
      const ap = payment.appointment_id
        ? await queryOne('SELECT order_id FROM appointments WHERE id = $1', [payment.appointment_id])
        : null;
      logOrderEvent({
        orderId: (ap && ap.order_id) ? String(ap.order_id) : null,
        label: 'video_paymob_refund_or_void_received',
        meta: JSON.stringify({
          payment_id,
          paymob_transaction_id: paymobTxnId,
          paymob_intention_id: paymobIntentionId,
          is_refunded: txn.is_refunded === true,
          is_voided: txn.is_voided === true,
          has_parent_transaction: txn.has_parent_transaction === true,
          amount_cents: txn.amount_cents != null ? Number(txn.amount_cents) : null,
          appointment_id: payment.appointment_id || null
        }),
        actorRole: 'system'
      });
    } catch (_) {}
    try {
      sendCriticalAlert(
        'Paymob refund/void webhook on video payment_id=' + payment_id +
        ' (txn ' + (paymobTxnId || 'n/a') + ') — appointment left UNPAID, reconcile manually',
        'video_paymob_refund_or_void'
      );
    } catch (_) {}
    // Ack 200 so Paymob stops retrying; the appointment is deliberately
    // NOT marked paid.
    return res.json({ ok: true, refund_or_void: true });
  }

  if (!isSuccess) {
    return res.json({ ok: true, note: 'non-success status' });
  }

  // FIX 4 (regression F4) — audit-only. Past the refund/void gate this is real
  // money coming in on a transaction descended from an earlier one (a capture,
  // or a token charge). Settle it normally — it still has to clear the amount
  // check below — but record and page, because this platform only mints
  // one-shot intentions and a child transaction is unexpected here.
  if (hasParentTxn) {
    console.warn('[video-callback] child transaction (has_parent_transaction) — processing normally', {
      payment_id, paymobTxnId, amount_cents: txn.amount_cents
    });
    try {
      sendCriticalAlert(
        'Paymob child transaction (has_parent_transaction=true, not a refund/void) on video payment_id=' +
        payment_id + ' (txn ' + (paymobTxnId || 'n/a') + ') — processed normally, verify it is a capture',
        'video_paymob_child_transaction'
      );
    } catch (_) {}
  }

  if (payment.status === 'paid') return res.json({ ok: true, note: 'already paid' });

  // ── AUDIT-P0-6: AMOUNT VERIFICATION ────────────────────────────────────
  // `amount_cents` IS signed. Mirrors the B5 check in /payments/callback:
  // never mark paid unless Paymob charged exactly what this appointment owes.
  // Left unpaid on mismatch, 200 so Paymob stops retrying, ops alerted.
  const owedCents = Math.round(Number(payment.amount || 0) * 100);
  const paidCents = Number(txn.amount_cents);
  if (!Number.isFinite(paidCents) || !Number.isFinite(owedCents) || owedCents <= 0 || paidCents !== owedCents) {
    try {
      sendCriticalAlert(
        'Video payment amount mismatch — left UNPAID. payment_id=' + payment_id +
        ' owed=' + owedCents + ' paid=' + (Number.isFinite(paidCents) ? paidCents : 'n/a'),
        'video_payment_amount_mismatch'
      );
    } catch (_) {}
    return res.json({ ok: true, amount_mismatch: true });
  }

  const now = nowIso();
  // ── AUDIT-P0-6: per-transaction idempotency ────────────────────────────
  // The status guard alone (`WHERE status != 'paid'`) only stops the SAME
  // appointment being paid twice; it did nothing to stop one signed
  // transaction being applied to many different appointments. Claiming the
  // signed transaction id under the unique partial index from migration 079
  // makes each Paymob transaction usable exactly once, platform-wide.
  const guard = await execute(
    `UPDATE appointment_payments
        SET status = 'paid', paid_at = $1, method = 'paymob', reference = $2,
            paymob_transaction_id = $4, paymob_intention_id = $5, hmac_verified_at = $1
      WHERE id = $3 AND status != 'paid'`,
    [now, reference || null, payment_id, paymobTxnId, paymobIntentionId]
  ).catch((err) => {
    // Unique-violation on paymob_transaction_id => this transaction was
    // already spent on another appointment. Treat as a replay, not an error.
    if (err && String(err.code) === '23505') {
      console.warn('[video-callback] paymob transaction already spent', {
        payment_id, paymobTxnId
      });
      try {
        sendCriticalAlert(
          'Video payment webhook replay blocked: transaction ' + paymobTxnId +
          ' was already applied to another appointment (attempted payment_id=' + payment_id + ')',
          'video_payment_txn_replay'
        );
      } catch (_) {}
      return { rowCount: 0 };
    }
    throw err;
  });
  if (!guard || guard.rowCount === 0) {
    return res.json({ ok: true, note: 'already paid (concurrent)' });
  }

  // Move to pending_doctor — paid, slot requested, waiting for doctor to accept/reschedule
  await execute(`
    UPDATE appointments SET status = 'pending_doctor', updated_at = $1
    WHERE id = $2
  `, [now, payment.appointment_id]);

  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [payment.appointment_id]);
  if (appointment) {
    // Notify patient: payment confirmed, doctor will review slot
    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'internal',
      template: 'video_payment_confirmed',
      status: 'queued',
      response: JSON.stringify({
        appointment_id: appointment.id,
        scheduled_at: appointment.scheduled_at
      })
    });
    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'whatsapp',
      template: 'video_payment_confirmed',
      status: 'queued',
      response: JSON.stringify({ appointment_id: appointment.id, scheduled_at: appointment.scheduled_at })
    });

    // Notify doctor (if assigned) to review the slot request
    if (appointment.doctor_id) {
      queueNotification({
        orderId: appointment.order_id,
        toUserId: appointment.doctor_id,
        channel: 'internal',
        template: 'video_slot_review_requested',
        status: 'queued',
        response: JSON.stringify({
          appointment_id: appointment.id,
          patient_preferred_slot: appointment.scheduled_at
        })
      });
    }
  }

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /portal/video/appointment/:id — View appointment detail
// ---------------------------------------------------------------------------
router.get('/portal/video/appointment/:id', requireRole('patient', 'doctor'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).render('error', {
      layout: 'portal', title: 'Not Found',
      message: t(lang, 'Appointment not found', 'الموعد غير موجود'), lang
    });
  }

  const doctor = await queryOne('SELECT id, name, email, specialty_id FROM users WHERE id = $1', [appointment.doctor_id]);
  const patient = await queryOne('SELECT id, name, email FROM users WHERE id = $1', [appointment.patient_id]);
  const payment = appointment.payment_id
    ? await queryOne('SELECT * FROM appointment_payments WHERE id = $1', [appointment.payment_id])
    : null;
  const videoCall = appointment.video_call_id
    ? await queryOne('SELECT * FROM video_calls WHERE id = $1', [appointment.video_call_id])
    : null;

  const hoursAway = hoursUntil(appointment.scheduled_at);
  const minsAway = minutesUntil(appointment.scheduled_at);
  const canJoin = minsAway <= 15 && minsAway >= -60 && ['confirmed', 'started'].includes(appointment.status);
  const canReschedule = hoursAway > 24 && ['pending_doctor', 'confirmed'].includes(appointment.status);
  const canCancel = ['pending_payment', 'pending_doctor', 'confirmed'].includes(appointment.status);
  const refundEligible = hoursAway > 24;

  const isDoctor = req.user.role === 'doctor';
  const earnings = isDoctor
    ? await queryOne('SELECT * FROM doctor_earnings WHERE appointment_id = $1', [appointment.id])
    : null;

  appointment.scheduled_at_formatted = formatAptDate(appointment.scheduled_at);
  appointment.rescheduled_from_formatted = formatAptDate(appointment.rescheduled_from);
  appointment.doctor_proposed_time_formatted = formatAptDate(appointment.doctor_proposed_time);

  res.render('video_appointment', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    layout: 'portal',
    title: t(lang, 'Video Consultation', 'استشارة فيديو'),
    lang,
    portalFrame: true,
    portalRole: isDoctor ? 'doctor' : 'patient',
    portalActive: 'dashboard',
    mode: 'view',
    appointment,
    doctor,
    patient,
    payment,
    videoCall,
    canJoin,
    canReschedule,
    canCancel,
    refundEligible,
    hoursAway,
    earnings,
    videoEnabled: isVideoEnabled(),
    order: null,
    service: null,
    price: appointment.price,
    existingAppointment: null,
    bookMinIso: inputMinFromNow(1),
    rescheduleMinIso: inputMinFromNow(25)
  });
});

// ---------------------------------------------------------------------------
// POST /portal/video/appointment/:id/reschedule — Reschedule appointment
// ---------------------------------------------------------------------------
router.post('/portal/video/appointment/:id/reschedule', requireRole('patient', 'doctor'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }

  if (!['pending_doctor', 'confirmed'].includes(appointment.status)) {
    return res.status(400).json({ ok: false, error: 'Cannot reschedule this appointment' });
  }

  if (hoursUntil(appointment.scheduled_at) < 24) {
    return res.status(400).json({ ok: false, error: 'Cannot reschedule within 24 hours of appointment' });
  }

  const { new_scheduled_at } = req.body;
  const newDate = dayjs(new_scheduled_at);
  if (!newDate.isValid() || newDate.isBefore(dayjs())) {
    return res.status(400).json({ ok: false, error: 'Invalid or past date' });
  }

  // Validate new time falls within doctor's availability
  const newDayOfWeek = newDate.day();
  const newTimeStr = newDate.format('HH:mm');
  const doctorAvail = await queryOne(`
    SELECT * FROM doctor_availability
    WHERE doctor_id = $1 AND day_of_week = $2 AND is_active = true
    AND start_time <= $3 AND end_time > $4
  `, [appointment.doctor_id, newDayOfWeek, newTimeStr, newTimeStr]);

  if (!doctorAvail) {
    return res.status(400).json({ ok: false, error: t(lang, 'Selected time is outside doctor availability', 'الوقت المحدد خارج أوقات عمل الطبيب') });
  }

  // Check for SLA conflict on linked order
  if (appointment.order_id) {
    const order = await queryOne('SELECT * FROM orders_active WHERE id = $1', [appointment.order_id]);
    if (order && order.sla_24hr_deadline) {
      const slaDeadline = dayjs(order.sla_24hr_deadline);
      if (newDate.isAfter(slaDeadline)) {
        return res.status(400).json({
          ok: false,
          error: t(lang, 'New time exceeds the 24h SLA deadline for this case', 'الوقت الجديد يتجاوز الموعد النهائي لاتفاقية 24 ساعة')
        });
      }
    }
  }

  // Check for conflicting appointments at the same time
  const conflict = await queryOne(`
    SELECT id FROM appointments
    WHERE doctor_id = $1 AND id != $2
    AND status IN ('pending', 'confirmed')
    AND scheduled_at = $3
  `, [appointment.doctor_id, appointment.id, newDate.toISOString()]);

  if (conflict) {
    return res.status(400).json({ ok: false, error: t(lang, 'Doctor already has an appointment at this time', 'الطبيب لديه موعد آخر في هذا الوقت') });
  }

  const now = nowIso();
  const oldScheduledAt = appointment.scheduled_at;

  await execute(`
    UPDATE appointments
    SET scheduled_at = $1, rescheduled_from = $2, rescheduled_at = $3, updated_at = $4
    WHERE id = $5
  `, [newDate.toISOString(), oldScheduledAt, now, now, appointment.id]);

  // Notify both participants
  const otherUserId = req.user.id === appointment.patient_id ? appointment.doctor_id : appointment.patient_id;
  queueNotification({
    orderId: appointment.order_id,
    toUserId: otherUserId,
    channel: 'internal',
    template: 'video_appointment_rescheduled',
    status: 'queued',
    response: JSON.stringify({
      appointment_id: appointment.id,
      old_time: oldScheduledAt,
      new_time: newDate.toISOString()
    })
  });
  queueNotification({
    orderId: appointment.order_id,
    toUserId: otherUserId,
    channel: 'whatsapp',
    template: 'video_appointment_rescheduled',
    status: 'queued',
    response: JSON.stringify({
      appointment_id: appointment.id,
      new_time: newDate.toISOString()
    })
  });

  logOrderEvent({
    orderId: appointment.order_id,
    label: 'video_appointment_rescheduled',
    meta: JSON.stringify({ appointment_id: appointment.id, from: oldScheduledAt, to: newDate.toISOString() }),
    actorUserId: req.user.id,
    actorRole: req.user.role
  });

  return res.redirect(`/portal/video/appointment/${appointment.id}`);
});

// ---------------------------------------------------------------------------
// POST /portal/video/appointment/:id/cancel — Cancel appointment
// ---------------------------------------------------------------------------
router.post('/portal/video/appointment/:id/cancel', requireRole('patient', 'doctor'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }

  if (!['pending_payment', 'pending_doctor', 'confirmed'].includes(appointment.status)) {
    return res.status(400).json({ ok: false, error: 'Cannot cancel this appointment' });
  }

  // Pre-payment: hard delete — nothing was charged, nothing to record
  if (appointment.status === 'pending_payment') {
    const now = nowIso();
    if (appointment.video_call_id) {
      await execute(`DELETE FROM video_calls WHERE id = $1`, [appointment.video_call_id]);
    }
    if (appointment.payment_id) {
      await execute(`DELETE FROM appointment_payments WHERE id = $1`, [appointment.payment_id]);
    }
    await execute(`DELETE FROM appointments WHERE id = $1`, [appointment.id]);
    logOrderEvent({
      orderId: appointment.order_id,
      label: 'video_slot_cancelled_pre_payment',
      meta: JSON.stringify({ appointment_id: appointment.id }),
      actorUserId: req.user.id,
      actorRole: req.user.role
    });
    return res.redirect('/portal/video/appointments');
  }

  const now = nowIso();
  const hoursAway = hoursUntil(appointment.scheduled_at);
  const reason = req.body.reason || '';
  const isDoctor = req.user.role === 'doctor';

  // Doctors cannot cancel pending_doctor or reschedule_proposed — they must accept or propose
  if (isDoctor && ['pending_doctor', 'reschedule_proposed'].includes(appointment.status)) {
    return res.status(403).json({ ok: false, error: 'Use accept or propose to respond to this appointment' });
  }

  // Determine refund eligibility
  // Doctor-initiated cancellations always get full refund for the patient
  const isDoctorCancel = req.user.role === 'doctor';
  let refundStatus = 'no_refund';
  if (isDoctorCancel || hoursAway > 24) {
    refundStatus = 'full_refund';
    const refundReason = isDoctorCancel
      ? 'Cancelled by doctor'
      : 'Cancelled 24h+ before appointment';
    if (appointment.payment_id) {
      // ── AUDIT-2026-08-22 (R2, P0): "full refund" on an add-on-funded
      // appointment refunded nothing ────────────────────────────────────────
      //
      // When POST /portal/video/book funds a booking out of the case add-on it
      // writes appointment_payments with method='order_addon' — a marker row,
      // not a charge. Flipping it to 'refunded' moves no money, writes no
      // `refunds` row, and leaves
      // orders.addons_json.video_consultation_consumed_by pointing at this
      // appointment, so readVideoAddonEntitlement returns null forever and the
      // patient is quoted the add-on price again to rebook. Meanwhile both
      // notifications below told them refund_status='full_refund'.
      //
      // Release hands the consultation back instead — the patient paid for one
      // consultation and has not had one. refundStatus follows so the message
      // stops promising money that is not coming.
      const addonRelease = await releaseVideoAddonEntitlement({
        appointmentId: appointment.id,
        orderId: appointment.order_id,
        paymentId: appointment.payment_id,
        reason: refundReason + ' — consultation entitlement returned'
      });
      if (addonRelease.addonFunded) {
        refundStatus = 'entitlement_released';
      } else {
        await execute(`UPDATE appointment_payments SET status = 'refunded', refund_reason = $1, refunded_at = $2 WHERE id = $3`,
          [refundReason, now, appointment.payment_id]);
      }
    }
  }

  // Cancel appointment
  await execute(`UPDATE appointments SET status = 'cancelled', cancel_reason = $1, updated_at = $2 WHERE id = $3`,
    [reason || `Cancelled by ${req.user.role}`, now, appointment.id]);

  // Cancel video call
  if (appointment.video_call_id) {
    await execute(`UPDATE video_calls SET status = 'cancelled', updated_at = $1 WHERE id = $2`,
      [now, appointment.video_call_id]);
  }

  // ── AUDIT-2026-08-22 (P2): notify the party who did NOT cancel, on BOTH
  // channels. The bell went to `otherUserId` while the WhatsApp always went to
  // `patient_id`, so a doctor-cancel told the patient twice and told the
  // doctor nothing, and a patient-cancel WhatsApped the patient about their own
  // click while the doctor got only a bell.
  //
  // The template has to follow the recipient too: per the registry convention
  // in notify/notification_titles.js ("patient-facing unless the name ends in
  // _doctor"), `video_appointment_cancelled` is patient-voiced ("YOUR video
  // consultation has been cancelled"). Sending it to the doctor addresses them
  // as the patient. When the recipient is the doctor we emit the doctor-facing
  // name instead — see the hand-off note for the template the notifications
  // owner must add.
  const cancelNotifyUserId = isDoctorCancel ? appointment.patient_id : appointment.doctor_id;
  const cancelTemplate = isDoctorCancel ? 'video_appointment_cancelled' : 'video_appointment_cancelled_doctor';
  // A patient can cancel an appointment on a case that has no doctor yet
  // (appointments.doctor_id is nullable — see the booking insert). Queuing to a
  // null recipient is not an error, but notify.js records it as a dropped
  // notification in /ops; there is genuinely nobody to tell, so skip.
  if (cancelNotifyUserId) {
    queueNotification({
      orderId: appointment.order_id,
      toUserId: cancelNotifyUserId,
      channel: 'internal',
      template: cancelTemplate,
      status: 'queued',
      response: JSON.stringify({
        appointment_id: appointment.id,
        refund_status: refundStatus,
        cancelled_by: req.user.role
      })
    });
    queueNotification({
      orderId: appointment.order_id,
      toUserId: cancelNotifyUserId,
      channel: 'whatsapp',
      template: cancelTemplate,
      status: 'queued',
      response: JSON.stringify({
        appointment_id: appointment.id,
        refund_status: refundStatus,
        cancelled_by: req.user.role
      })
    });
  }

  logOrderEvent({
    orderId: appointment.order_id,
    label: 'video_appointment_cancelled',
    meta: JSON.stringify({ appointment_id: appointment.id, refund_status: refundStatus, reason }),
    actorUserId: req.user.id,
    actorRole: req.user.role
  });

  return res.redirect(`/portal/video/appointment/${appointment.id}`);
});

// ---------------------------------------------------------------------------
// GET /portal/video/call/:appointmentId — Render video call room
// ---------------------------------------------------------------------------
router.get('/portal/video/call/:appointmentId', requireRole('patient', 'doctor'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.appointmentId]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).render('error', {
      layout: 'portal', title: 'Not Found',
      message: t(lang, 'Appointment not found', 'الموعد غير موجود'), lang
    });
  }

  if (!['confirmed', 'started'].includes(appointment.status)) {
    return res.redirect(`/portal/video/appointment/${appointment.id}`);
  }

  // Check if within join window (5 min before to 60 min after)
  const minsAway = minutesUntil(appointment.scheduled_at);
  if (minsAway > 15) {
    return res.redirect(`/portal/video/appointment/${appointment.id}`);
  }

  const doctor = await queryOne('SELECT id, name, email FROM users WHERE id = $1', [appointment.doctor_id]);
  const patient = await queryOne('SELECT id, name, email FROM users WHERE id = $1', [appointment.patient_id]);
  const videoCall = appointment.video_call_id
    ? await queryOne('SELECT * FROM video_calls WHERE id = $1', [appointment.video_call_id])
    : null;

  const isDoctor = req.user.role === 'doctor';
  const roomName = getRoomName(appointment.id);

  res.render('video_call_room', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    layout: 'portal',
    title: t(lang, 'Video Call', 'مكالمة فيديو'),
    lang,
    portalFrame: false,
    showFooter: false,
    showNav: false,
    appointment,
    doctor,
    patient,
    videoCall,
    roomName,
    isDoctor,
    participantName: isDoctor ? (doctor && doctor.name) : (patient && patient.name),
    otherName: isDoctor ? (patient && patient.name) : (doctor && doctor.name)
  });
});

// ---------------------------------------------------------------------------
// POST /api/video/token/:appointmentId — Generate Twilio access token (JSON)
// ---------------------------------------------------------------------------
router.post('/api/video/token/:appointmentId', requireRole('patient', 'doctor'), async (req, res) => {
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.appointmentId]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }

  if (!['confirmed', 'started'].includes(appointment.status)) {
    return res.status(400).json({ ok: false, error: 'Appointment not in joinable state' });
  }

  if (!isVideoEnabled()) {
    return res.status(503).json({ ok: false, error: 'Video consultation is not configured. Set TWILIO credentials in .env' });
  }

  try {
    const roomName = getRoomName(appointment.id);
    const identity = `${req.user.role}-${req.user.id}`;
    const result = generateToken(roomName, identity);

    // Mark appointment as started if first join
    const now = nowIso();
    if (appointment.status === 'confirmed') {
      await execute(`UPDATE appointments SET status = 'started', updated_at = $1 WHERE id = $2`, [now, appointment.id]);
    }

    // Update video call
    if (appointment.video_call_id) {
      const vc = await queryOne('SELECT * FROM video_calls WHERE id = $1', [appointment.video_call_id]);
      if (vc && vc.status === 'pending') {
        await execute(`UPDATE video_calls SET status = 'active', initiated_by = $1, started_at = $2, updated_at = $3 WHERE id = $4`,
          [req.user.id, now, now, appointment.video_call_id]);
      }
    }

    // Notify other participant
    const otherUserId = req.user.id === appointment.patient_id ? appointment.doctor_id : appointment.patient_id;
    queueNotification({
      orderId: appointment.order_id,
      toUserId: otherUserId,
      channel: 'internal',
      template: 'video_call_started',
      status: 'queued',
      response: JSON.stringify({
        appointment_id: appointment.id,
        joined_by: req.user.role,
        joined_name: req.user.name || req.user.email
      }),
      dedupe_key: `video:joined:${appointment.id}:${req.user.id}`
    });

    return res.json({
      ok: true,
      token: result.token,
      roomName: result.roomName,
      identity
    });
  } catch (err) {
    console.error('[video] Token generation failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to generate video token' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/video/end/:appointmentId — End call, calc duration, create earnings
// ---------------------------------------------------------------------------
// ── AUDIT-2026-08-17 (FIX 1): this endpoint minted unlimited doctor earnings ──
//
// Before this fix the route was gated only on requireRole('patient','doctor') +
// ensureParticipant, the appointment UPDATE carried no from-state predicate,
// nothing checked the appointment had EVER been paid, and the doctor_earnings
// INSERT used a fresh randomUUID() every call with no unique constraint behind
// it. Net effect: a PATIENT could POST this endpoint in a loop and mint an
// unbounded number of `pending` payout rows against the doctor's ledger, on an
// appointment nobody paid for. Four independent guards now stand between a
// request and a payout row:
//
//   1. role/ownership — only the appointment's OWN doctor writes earnings.
//      A patient may still END the call (that is a legitimate participant
//      action); it just no longer moves money.
//   2. from-state predicate on the appointments UPDATE + rowCount bail, so a
//      completed / cancelled / no-show / never-confirmed appointment cannot be
//      re-"ended".
//   3. paid check against appointment_payments.status, the same resolution the
//      pay page and the Paymob webhook use (appointment.payment_id → row).
//   4. ON CONFLICT DO NOTHING against the unique index on
//      doctor_earnings(appointment_id) — see migration 082 (owned by another
//      worker; the code is written as if it already exists, and degrades to
//      guard 1-3 plus the explicit pre-check if it is not yet applied).
//
// Statuses: the in-call state in this codebase is 'started' (set on join, see
// /api/video/token above), NOT 'in_progress' — that string appears nowhere in
// the appointment lifecycle. The endable set is therefore
// ('confirmed','started').
const ENDABLE_APPOINTMENT_STATUSES = ['confirmed', 'started'];

router.post('/api/video/end/:appointmentId', requireRole('patient', 'doctor'), async (req, res) => {
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.appointmentId]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }

  // Guard 1 — earnings are the DOCTOR's payout; only the assigned doctor's own
  // request may create them.
  const isOwningDoctor = req.user.role === 'doctor'
    && appointment.doctor_id != null
    && String(appointment.doctor_id) === String(req.user.id);

  // Guard 3 — the appointment must actually have been paid for.
  // AUDIT-2026-08-22 (M1 follow-up, P0): `method` joins the projection so the
  // V2 dual-write below can tell an add-on-funded booking from a real card
  // payment without a second round trip. `method` is on the base table
  // (migration 004), so this cannot break an un-migrated deploy.
  const payment = appointment.payment_id
    ? await queryOne('SELECT id, status, method FROM appointment_payments WHERE id = $1', [appointment.payment_id])
    : null;
  const isPaid = !!(payment && String(payment.status || '').toLowerCase() === 'paid');

  const now = nowIso();
  const videoCall = appointment.video_call_id
    ? await queryOne('SELECT * FROM video_calls WHERE id = $1', [appointment.video_call_id])
    : null;

  let durationSeconds = 0;
  if (videoCall && videoCall.started_at) {
    durationSeconds = Math.max(0, Math.round(dayjs(now).diff(dayjs(videoCall.started_at), 'second')));
  }

  try {
    const result = await withTransaction(async (client) => {
      // Lock the row and re-read the status INSIDE the transaction so the
      // decisions below can't race a concurrent end / cancel / no-show.
      const locked = (await client.query(
        `SELECT status FROM appointments WHERE id = $1 FOR UPDATE`,
        [appointment.id]
      )).rows[0];
      const currentStatus = String((locked && locked.status) || '');

      // Guard 2 — from-state predicate. rowCount === 0 means the appointment
      // was not in an endable state; we do NOT complete it and we do NOT touch
      // the video_calls row.
      const completed = await client.query(
        `UPDATE appointments SET status = 'completed', updated_at = $1
          WHERE id = $2 AND status = ANY($3::text[])`,
        [now, appointment.id, ENDABLE_APPOINTMENT_STATUSES]
      );
      const didComplete = !!(completed && completed.rowCount > 0);

      // Earnings stay writable on an ALREADY-completed appointment so the
      // doctor is still paid when the PATIENT was the one who clicked End
      // (guard 2 would otherwise silently swallow the doctor's only payout
      // trigger). Idempotency is guard 4's job, not the state machine's.
      const earningsEligible = isOwningDoctor && isPaid
        && (didComplete || currentStatus === 'completed');

      if (!didComplete && !earningsEligible) {
        return {
          noop: true,
          notEndableStatus: currentStatus,
          durationSeconds: videoCall && videoCall.duration_seconds != null
            ? Number(videoCall.duration_seconds) || 0
            : 0,
          earnedAmount: 0,
          earningsId: null
        };
      }

      // End video call (only alongside a real completion).
      if (didComplete && videoCall && videoCall.status === 'active') {
        await client.query(`
          UPDATE video_calls SET status = 'ended', ended_at = $1, duration_seconds = $2, updated_at = $3
          WHERE id = $4
        `, [now, durationSeconds, now, videoCall.id]);
      }

      // Create doctor earnings — gated by guards 1 + 3, deduped by guard 4.
      let earnedAmount = 0;
      let earningsId = null;
      if (earningsEligible) {
        const grossAmount = Number(appointment.price) || 0;
        const commissionPct = Number(appointment.doctor_commission_pct) || 0;
        earnedAmount = Math.round(grossAmount * (commissionPct / 100) * 100) / 100;
        const candidateId = `earn-${randomUUID()}`;
        // Explicit pre-check so the behaviour is correct even before migration
        // 082 lands; ON CONFLICT DO NOTHING is the race-proof backstop once it
        // does. Untargeted (no conflict_target) so it matches migration 082
        // whether the unique index is total or partial — a targeted
        // `ON CONFLICT (appointment_id)` fails to infer a PARTIAL index and
        // would raise at runtime.
        const ins = await client.query(`
          INSERT INTO doctor_earnings (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, created_at)
          SELECT $1, $2, $3, $4, $5, $6, 'pending', $7
           WHERE NOT EXISTS (
                 SELECT 1 FROM doctor_earnings WHERE appointment_id = $3
           )
          ON CONFLICT DO NOTHING
        `, [candidateId, appointment.doctor_id, appointment.id, grossAmount, commissionPct, earnedAmount, now]);
        if (ins && ins.rowCount > 0) {
          earningsId = candidateId;
        } else {
          // Already had an earnings row — report it, don't mint a second.
          earnedAmount = 0;
        }
      }

      return { didComplete, earningsEligible, durationSeconds, earnedAmount, earningsId };
    });

    if (result.noop) {
      // Nothing to do: the appointment was not endable and no payout was owed.
      // 200 (not 4xx) so a double-click / back-button on the call UI lands on
      // the summary page instead of an error.
      return res.json({
        ok: true,
        already_ended: true,
        duration_seconds: result.durationSeconds,
        duration_formatted: formatDuration(result.durationSeconds),
        earned_amount: 0,
        redirect: `/portal/video/ended/${appointment.id}`
      });
    }

    // ---- V2 dual-write (gated by ADDON_SYSTEM_V2) ----
    // Fires onFulfill → onComplete on the matching order_addons row. If
    // no row exists (e.g. flag was off at case-payment time so onPurchase
    // never wrote the V2 row), this is a no-op. Errors are swallowed
    // by safeDualWrite — V1 has already committed above.
    await safeDualWrite('video_consult', 'onFulfill', appointment.order_id, async () => {
      const existing = await queryOne(
        `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'video_consult'`,
        [appointment.order_id]
      );
      if (!existing) return null;
      if (existing.status === 'fulfilled') return existing;  // idempotent
      const svc = getAddon('video_consult');
      const doctor = { id: appointment.doctor_id };
      return svc.onFulfill({
        order: { id: appointment.order_id },
        addon: existing,
        doctor,
        payload: { appointment_id: appointment.id, call_duration_seconds: result.durationSeconds }
      });
    });
    // FIX 1 — onComplete writes addon_earnings, i.e. a second doctor payout on
    // the SAME request. It carries the same guards as the doctor_earnings
    // insert above: owning doctor + paid appointment. onFulfill above is a
    // pure state transition (the call did happen) and stays ungated.
    //
    // ── AUDIT-2026-08-22 (M1 follow-up, P0 — RESOLVED) ─────────────────────
    // ADDON_SYSTEM_V2 is TRUE in the live Render environment (Phase 3 has
    // happened — see services/addons/registry.isEnabled), so this block runs
    // in production. Since M1, an appointment funded by the case add-on
    // (appointment_payments.method='order_addon') carries no second charge,
    // and doctor_earnings above (appointment.price × commission) plus
    // addon_earnings here (order_addons.price_at_purchase_egp × commission)
    // would both be paid out of the SAME add-on line the patient paid once at
    // checkout.
    //
    // DECISION: doctor_earnings keeps the payout, addon_earnings is suppressed
    // on add-on-funded appointments. doctor_earnings is the ledger the money
    // actually flows through — the doctor's video dashboard below reads it
    // alone, and the superadmin finance "owed" figure and payout basis are
    // SUM(doctor_earnings.earned_amount) WHERE status='pending' (routes/
    // admin.js, routes/api/admin.js). /portal/doctor/earnings sums BOTH
    // ledgers, which is precisely where the duplicate was visible to the
    // doctor. Suppressing the other direction would have meant rewriting the
    // payout basis.
    //
    // Only the earnings write is suppressed. onFulfill above stays ungated —
    // the call did happen, so the order_addons row must still reach
    // 'fulfilled'; its lifecycle is untouched by this gate (onComplete writes
    // addon_earnings and stamps the derived doctor_commission_amount_egp,
    // nothing else). The V1 doctor_earnings path above is unchanged.
    if (result.earningsEligible && allowAddonEarningsWrite(payment, appointment)) {
      await safeDualWrite('video_consult', 'onComplete', appointment.order_id, async () => {
        const existing = await queryOne(
          `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'video_consult'`,
          [appointment.order_id]
        );
        if (!existing || existing.status !== 'fulfilled') return null;
        const svc = getAddon('video_consult');
        return svc.onComplete({ order: { id: appointment.order_id }, addon: existing, doctorId: appointment.doctor_id });
      });
    }

    // Notify both participants — only on the request that ACTUALLY ended the
    // call. When the doctor follows the patient in purely to claim earnings
    // (didComplete === false, earningsEligible === true) the "call ended"
    // notifications were already sent by the patient's request; re-sending
    // would double-notify both parties.
    if (result.didComplete) {
    for (const uid of [appointment.patient_id, appointment.doctor_id]) {
      queueNotification({
        orderId: appointment.order_id,
        toUserId: uid,
        channel: 'internal',
        template: 'video_call_ended',
        status: 'queued',
        response: JSON.stringify({
          appointment_id: appointment.id,
          duration_seconds: result.durationSeconds,
          duration_formatted: formatDuration(result.durationSeconds)
        })
      });
    }

    // WhatsApp to patient
    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'whatsapp',
      template: 'video_call_ended',
      status: 'queued',
      response: JSON.stringify({
        appointment_id: appointment.id,
        duration: formatDuration(result.durationSeconds)
      })
    });
    }  // end if (result.didComplete) — notifications

    logOrderEvent({
      orderId: appointment.order_id,
      label: result.didComplete ? 'video_call_ended' : 'video_call_earnings_claimed',
      meta: JSON.stringify({
        appointment_id: appointment.id,
        duration_seconds: result.durationSeconds,
        earned: result.earnedAmount
      }),
      actorUserId: req.user.id,
      actorRole: req.user.role
    });

    return res.json({
      ok: true,
      duration_seconds: result.durationSeconds,
      duration_formatted: formatDuration(result.durationSeconds),
      earned_amount: result.earnedAmount,
      redirect: `/portal/video/ended/${appointment.id}`
    });
  } catch (err) {
    console.error('[video] End call failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to end call' });
  }
});

// ---------------------------------------------------------------------------
// GET /portal/video/ended/:appointmentId — Post-call summary
// ---------------------------------------------------------------------------
router.get('/portal/video/ended/:appointmentId', requireRole('patient', 'doctor'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.appointmentId]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).render('error', {
      layout: 'portal', title: 'Not Found',
      message: t(lang, 'Appointment not found', 'الموعد غير موجود'), lang
    });
  }

  const doctor = await queryOne('SELECT id, name, email FROM users WHERE id = $1', [appointment.doctor_id]);
  const patient = await queryOne('SELECT id, name, email FROM users WHERE id = $1', [appointment.patient_id]);
  const videoCall = appointment.video_call_id
    ? await queryOne('SELECT * FROM video_calls WHERE id = $1', [appointment.video_call_id])
    : null;

  const isDoctor = req.user.role === 'doctor';
  const earnings = isDoctor
    ? await queryOne('SELECT * FROM doctor_earnings WHERE appointment_id = $1', [appointment.id])
    : null;

  res.render('video_call_ended', {
    layout: 'portal',
    title: t(lang, 'Call Ended', 'انتهت المكالمة'),
    lang,
    portalFrame: true,
    portalRole: isDoctor ? 'doctor' : 'patient',
    portalActive: 'dashboard',
    appointment,
    doctor,
    patient,
    videoCall,
    earnings,
    isDoctor,
    durationFormatted: videoCall ? formatDuration(videoCall.duration_seconds || 0) : '0s'
  });
});

// ---------------------------------------------------------------------------
// POST /portal/video/appointment/:id/no-show — Mark no-show
// ---------------------------------------------------------------------------
router.post('/portal/video/appointment/:id/no-show', requireRole('doctor', 'superadmin'), async (req, res) => {
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);

  if (!appointment) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }

  // Only a participant doctor (or a superadmin) may mark this appointment no-show.
  if (req.user.role !== 'superadmin' && !ensureParticipant(appointment, req.user.id)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  if (!ENDABLE_APPOINTMENT_STATUSES.includes(appointment.status)) {
    return res.status(400).json({ ok: false, error: 'Cannot mark no-show for this appointment' });
  }

  const { no_show_type } = req.body;
  const now = nowIso();

  // FIX 1 (no-show variant) — the patient-no-show branch below writes a doctor
  // payout, so it needs the same money guards as /api/video/end: the
  // appointment must have been PAID, the status transition must carry a
  // from-state predicate (the check above is a read-then-write and races two
  // concurrent submits), and the earnings INSERT must be idempotent.
  // AUDIT-2026-08-22 (M1 follow-up, P0): `method` joins the projection for the
  // add-on-funding test on the V2 onComplete block below — same reason as the
  // guard-3 read in /api/video/end.
  const nsPayment = appointment.payment_id
    ? await queryOne('SELECT id, status, method FROM appointment_payments WHERE id = $1', [appointment.payment_id])
    : null;
  const nsIsPaid = !!(nsPayment && String(nsPayment.status || '').toLowerCase() === 'paid');

  if (no_show_type === 'doctor') {
    // Doctor no-show: full refund to patient
    const flipped = await execute(
      `UPDATE appointments SET status = 'no_show_doctor', updated_at = $1
        WHERE id = $2 AND status = ANY($3::text[])`,
      [now, appointment.id, ENDABLE_APPOINTMENT_STATUSES]
    );
    if (!flipped || flipped.rowCount === 0) {
      return res.status(409).json({ ok: false, error: 'Appointment is no longer in a markable state' });
    }

    // ── AUDIT-2026-08-22 (R2, P0): the same empty refund as the cancel path.
    // method='order_addon' means there is no separate payment to reverse; the
    // honest remedy is to hand the consultation back so the patient the doctor
    // stood up can rebook at no cost. See services/video_addon_entitlement.js.
    let nsAddonRelease = { addonFunded: false };
    if (appointment.payment_id) {
      nsAddonRelease = await releaseVideoAddonEntitlement({
        appointmentId: appointment.id,
        orderId: appointment.order_id,
        paymentId: appointment.payment_id,
        reason: 'Doctor no-show — consultation entitlement returned'
      });
      if (!nsAddonRelease.addonFunded) {
        await execute(`UPDATE appointment_payments SET status = 'refunded', refund_reason = 'Doctor no-show', refunded_at = $1 WHERE id = $2`,
          [now, appointment.payment_id]);
      }
    }

    // ── AUDIT-2026-08-22 (N2): the DOCTOR no-showed; tell the PATIENT so.
    // These two sends addressed the patient with `video_no_show_doctor`, whose
    // suffix the registry reads as the RECIPIENT role, not the party at fault:
    // its title is "Patient did not join the video consultation" and its
    // OpenClaw body says the patient did not join, with a doctor-portal deep
    // link. A patient who was stood up by their doctor was told they were the
    // no-show. `video_no_show_doctor` / `video_no_show_patient` are the
    // PATIENT-no-show pair; the doctor-no-show event needs its own
    // patient-facing name — see the hand-off note.
    //
    // AUDIT-2026-08-22 (R2): `refund:'full'` was hard-coded, and the OpenClaw
    // body says "You have been refunded in full" because of it. That is false
    // on an add-on-funded appointment. HAND-OFF: the notifications owner must
    // branch video_doctor_no_show_patient on this value ("your paid
    // consultation is still yours — book a new time at no extra cost");
    // until then the payload at least carries the truth.
    const nsRefundOutcome = nsAddonRelease.addonFunded ? 'entitlement_released' : 'full';
    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'internal',
      template: 'video_doctor_no_show_patient',
      status: 'queued',
      response: JSON.stringify({ appointment_id: appointment.id, refund: nsRefundOutcome })
    });
    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'whatsapp',
      template: 'video_doctor_no_show_patient',
      status: 'queued',
      response: JSON.stringify({ appointment_id: appointment.id, refund: nsRefundOutcome })
    });
  } else {
    // Patient no-show: no refund, doctor keeps payment.
    //
    // AUDIT-2026-08-22 (R2): deliberately NOT released. The consultation WAS
    // delivered as far as the platform and the doctor are concerned — the
    // doctor showed up and is paid below — so the entitlement is legitimately
    // spent, exactly as a card payment on this branch is legitimately kept.
    // Same reasoning applies to the completion path in /api/video/end.
    const flipped = await execute(
      `UPDATE appointments SET status = 'no_show_patient', updated_at = $1
        WHERE id = $2 AND status = ANY($3::text[])`,
      [now, appointment.id, ENDABLE_APPOINTMENT_STATUSES]
    );
    if (!flipped || flipped.rowCount === 0) {
      return res.status(409).json({ ok: false, error: 'Appointment is no longer in a markable state' });
    }

    // Create doctor earnings even for no-show — but ONLY if the patient
    // actually paid, and only once (see the FIX 1 block above /api/video/end
    // for the full rationale and the migration-082 dependency).
    if (!nsIsPaid) {
      console.warn('[video] patient no-show on UNPAID appointment — no earnings written', {
        appointment_id: appointment.id, payment_id: appointment.payment_id || null
      });
    } else {
      const grossAmount = Number(appointment.price) || 0;
      const commissionPct = Number(appointment.doctor_commission_pct) || 0;
      const earnedAmount = Math.round(grossAmount * (commissionPct / 100) * 100) / 100;
      await execute(`
        INSERT INTO doctor_earnings (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, created_at)
        SELECT $1, $2, $3, $4, $5, $6, 'pending', $7
         WHERE NOT EXISTS (
               SELECT 1 FROM doctor_earnings WHERE appointment_id = $3
         )
        ON CONFLICT DO NOTHING
      `, [`earn-${randomUUID()}`, appointment.doctor_id, appointment.id, grossAmount, commissionPct, earnedAmount, now]);
    }

    // ---- V2 dual-write (gated by ADDON_SYSTEM_V2, patient-no-show variant) ----
    await safeDualWrite('video_consult', 'onFulfill', appointment.order_id, async () => {
      const existing = await queryOne(
        `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'video_consult'`,
        [appointment.order_id]
      );
      if (!existing) return null;
      if (existing.status === 'fulfilled') return existing;
      const svc = getAddon('video_consult');
      const doctor = { id: appointment.doctor_id };
      return svc.onFulfill({
        order: { id: appointment.order_id },
        addon: existing,
        doctor,
        payload: { appointment_id: appointment.id, call_duration_seconds: 0, no_show: 'patient' }
      });
    });
    // Same money guard as the V1 insert above: onComplete writes addon_earnings.
    // AUDIT-2026-08-22 (M1 follow-up, P0): plus the add-on-funding gate — an
    // appointment paid for out of the case add-on has one revenue line, so the
    // doctor_earnings row written above is the whole payout. Full rationale on
    // the identical block in /api/video/end. onFulfill above stays ungated.
    if (nsIsPaid && allowAddonEarningsWrite(nsPayment, appointment)) {
      await safeDualWrite('video_consult', 'onComplete', appointment.order_id, async () => {
        const existing = await queryOne(
          `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'video_consult'`,
          [appointment.order_id]
        );
        if (!existing || existing.status !== 'fulfilled') return null;
        const svc = getAddon('video_consult');
        return svc.onComplete({ order: { id: appointment.order_id }, addon: existing, doctorId: appointment.doctor_id });
      });
    }

    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'internal',
      template: 'video_no_show_patient',
      status: 'queued',
      response: JSON.stringify({ appointment_id: appointment.id, charged: appointment.price })
    });
    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'whatsapp',
      template: 'video_no_show_patient',
      status: 'queued',
      response: JSON.stringify({ appointment_id: appointment.id })
    });
  }

  if (appointment.video_call_id) {
    await execute(`UPDATE video_calls SET status = 'cancelled', updated_at = $1 WHERE id = $2`, [now, appointment.video_call_id]);
  }

  logOrderEvent({
    orderId: appointment.order_id,
    label: `video_no_show_${no_show_type || 'patient'}`,
    meta: JSON.stringify({ appointment_id: appointment.id }),
    actorUserId: req.user.id,
    actorRole: req.user.role
  });

  return res.redirect(`/portal/video/appointment/${appointment.id}`);
});

// ---------------------------------------------------------------------------
// POST /portal/video/appointment/:id/accept-slot — Doctor accepts patient's slot
// ---------------------------------------------------------------------------
router.post('/portal/video/appointment/:id/accept-slot', requireRole('doctor'), async (req, res) => {
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
  if (!appointment || appointment.doctor_id !== req.user.id) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }
  if (appointment.status !== 'pending_doctor') {
    return res.status(400).json({ ok: false, error: 'Appointment is not awaiting doctor confirmation' });
  }

  const now = nowIso();
  await execute(`
    UPDATE appointments SET status = 'confirmed', updated_at = $1 WHERE id = $2
  `, [now, appointment.id]);

  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.patient_id,
    channel: 'internal',
    template: 'video_slot_accepted',
    status: 'queued',
    response: JSON.stringify({ appointment_id: appointment.id, scheduled_at: appointment.scheduled_at })
  });
  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.patient_id,
    channel: 'whatsapp',
    template: 'video_slot_accepted',
    status: 'queued',
    response: JSON.stringify({ appointment_id: appointment.id, scheduled_at: appointment.scheduled_at })
  });

  logOrderEvent({
    orderId: appointment.order_id,
    label: 'video_slot_accepted_by_doctor',
    meta: JSON.stringify({ appointment_id: appointment.id, scheduled_at: appointment.scheduled_at }),
    actorUserId: req.user.id,
    actorRole: 'doctor'
  });

  return res.redirect(`/portal/video/appointment/${appointment.id}`);
});

// ---------------------------------------------------------------------------
// POST /portal/video/appointment/:id/propose-slot — Doctor proposes alternate time
// ---------------------------------------------------------------------------
router.post('/portal/video/appointment/:id/propose-slot', requireRole('doctor'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
  if (!appointment || appointment.doctor_id !== req.user.id) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }
  if (appointment.status !== 'pending_doctor') {
    return res.status(400).json({ ok: false, error: 'Appointment is not awaiting doctor confirmation' });
  }

  const { proposed_time, slot_notes } = req.body;
  const proposed = dayjs(proposed_time);
  if (!proposed.isValid() || proposed.isBefore(dayjs().add(1, 'hour'))) {
    return res.status(400).json({ ok: false, error: 'Proposed time must be at least 1 hour from now' });
  }

  const now = nowIso();
  await execute(`
    UPDATE appointments
    SET status = 'reschedule_proposed', doctor_proposed_time = $1, doctor_proposed_at = $2,
        slot_notes = $3, updated_at = $4
    WHERE id = $5
  `, [proposed.toISOString(), now, slot_notes || null, now, appointment.id]);

  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.patient_id,
    channel: 'internal',
    template: 'video_slot_proposed',
    status: 'queued',
    response: JSON.stringify({
      appointment_id: appointment.id,
      original_slot: appointment.scheduled_at,
      proposed_slot: proposed.toISOString(),
      notes: slot_notes || ''
    })
  });
  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.patient_id,
    channel: 'whatsapp',
    template: 'video_slot_proposed',
    status: 'queued',
    response: JSON.stringify({
      appointment_id: appointment.id,
      proposed_slot: proposed.toISOString()
    })
  });

  logOrderEvent({
    orderId: appointment.order_id,
    label: 'video_slot_proposed_by_doctor',
    meta: JSON.stringify({ appointment_id: appointment.id, proposed: proposed.toISOString() }),
    actorUserId: req.user.id,
    actorRole: 'doctor'
  });

  return res.redirect(`/portal/video/appointment/${appointment.id}`);
});

// ---------------------------------------------------------------------------
// POST /portal/video/appointment/:id/confirm-slot — Patient confirms doctor's proposal
// ---------------------------------------------------------------------------
router.post('/portal/video/appointment/:id/confirm-slot', requireRole('patient'), async (req, res) => {
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
  if (!appointment || appointment.patient_id !== req.user.id) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }
  if (appointment.status !== 'reschedule_proposed') {
    return res.status(400).json({ ok: false, error: 'No pending proposal to confirm' });
  }

  const now = nowIso();
  await execute(`
    UPDATE appointments
    SET status = 'confirmed',
        scheduled_at = doctor_proposed_time,
        rescheduled_from = scheduled_at,
        rescheduled_at = $1,
        patient_confirmed_at = $2,
        updated_at = $3
    WHERE id = $4
  `, [now, now, now, appointment.id]);

  // ── AUDIT-2026-08-22 (P2): the PATIENT performed this action (confirming the
  // doctor's proposed time), so both channels go to the DOCTOR — the party who
  // did not act and does not yet know. The bell already did; the WhatsApp went
  // to the patient, telling them about their own click.
  // `video_slot_confirmed` is patient-voiced ("YOUR video consultation is
  // confirmed ... Join from"), so the doctor gets the doctor-facing name per
  // the registry's _doctor convention — see the hand-off note.
  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.doctor_id,
    channel: 'internal',
    template: 'video_slot_confirmed_doctor',
    status: 'queued',
    response: JSON.stringify({
      appointment_id: appointment.id,
      confirmed_slot: appointment.doctor_proposed_time
    })
  });
  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.doctor_id,
    channel: 'whatsapp',
    template: 'video_slot_confirmed_doctor',
    status: 'queued',
    response: JSON.stringify({ appointment_id: appointment.id, confirmed_slot: appointment.doctor_proposed_time })
  });

  logOrderEvent({
    orderId: appointment.order_id,
    label: 'video_slot_confirmed_by_patient',
    meta: JSON.stringify({ appointment_id: appointment.id }),
    actorUserId: req.user.id,
    actorRole: 'patient'
  });

  return res.redirect(`/portal/video/appointment/${appointment.id}`);
});

// ---------------------------------------------------------------------------
// GET /portal/video/appointments — List all appointments for current user
// ---------------------------------------------------------------------------
router.get('/portal/video/appointments', requireRole('patient', 'doctor'), async (req, res) => {
  const lang = getLang(req);
  const isDoctor = req.user.role === 'doctor';
  const col = isDoctor ? 'doctor_id' : 'patient_id';
  const joinCol = isDoctor ? 'a.patient_id' : 'a.doctor_id';

  let appointments = [];
  try {
    appointments = await queryAll(`
      SELECT a.*, u.name AS other_name
      FROM appointments a
      LEFT JOIN users u ON u.id = ${joinCol}
      WHERE a.${col} = $1
      ORDER BY a.scheduled_at DESC
      LIMIT 50
    `, [req.user.id]);
  } catch (e) {
    // appointments table may not have data yet — continue with empty list
  }

  // Patients get the portal-shell version
  if (!isDoctor) {
    // Enrich with doctor/specialty names for the patient view
    var enriched = [];
    for (var i = 0; i < appointments.length; i++) {
      var a = appointments[i];
      enriched.push({
        id: a.id,
        status: a.status,
        scheduled_at: a.scheduled_at,
        price: a.price,
        currency: a.currency,
        doctor_name: a.other_name || null,
        specialty_name: a.specialty_name || null
      });
    }
    return res.render('patient_appointments_list', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      lang: lang,
      isAr: String(lang).toLowerCase() === 'ar',
      brand: 'Tashkheesa',
      user: req.user,
      appointments: enriched,
      activePage: 'appointments'
    });
  }

  // Doctors get the video_appointment view
  const ACTION_REQUIRED_STATUSES = ['pending_doctor', 'reschedule_proposed'];
  const UPCOMING_STATUSES = ['confirmed'];

  const actionRequired = appointments.filter(a => ACTION_REQUIRED_STATUSES.includes(a.status));
  const upcoming = appointments.filter(a => UPCOMING_STATUSES.includes(a.status) && dayjs(a.scheduled_at).isAfter(dayjs()));
  const past = appointments.filter(a =>
    !ACTION_REQUIRED_STATUSES.includes(a.status) &&
    (!UPCOMING_STATUSES.includes(a.status) || dayjs(a.scheduled_at).isBefore(dayjs()))
  );

  const decorate = (a) => Object.assign({}, a, { scheduled_at_formatted: formatAptDate(a.scheduled_at) });

  res.render('video_appointment', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    layout: 'portal',
    title: t(lang, 'Video Consultations', 'استشارات الفيديو'),
    lang,
    portalFrame: true,
    portalRole: 'doctor',
    portalActive: 'appointments',
    mode: 'list',
    upcoming: upcoming.map(decorate),
    past: past.map(decorate),
    actionRequired: actionRequired.map(decorate),
    appointment: null,
    order: null,
    doctor: null,
    patient: null,
    service: null,
    payment: null,
    videoCall: null,
    canJoin: false,
    canReschedule: false,
    canCancel: false,
    refundEligible: false,
    hoursAway: 0,
    earnings: null,
    videoEnabled: isVideoEnabled(),
    price: 0,
    existingAppointment: null
  });
});

// ---------------------------------------------------------------------------
// GET /portal/doctor/appointments — Doctor appointments dashboard
// ---------------------------------------------------------------------------
router.get('/portal/doctor/appointments', requireRole('doctor'), async (req, res) => {
  const lang = getLang(req);
  const isAr = String(lang).toLowerCase() === 'ar';
  const doctorId = req.user.id;

  // Parse filters from query string
  const filterStatus = req.query.status || 'all';
  const filterPeriod = req.query.period || 'all';

  // Build date range based on period filter
  let dateFrom = null;
  let dateTo = null;
  const now = dayjs();

  if (filterPeriod === 'today') {
    dateFrom = now.startOf('day').toISOString();
    dateTo = now.endOf('day').toISOString();
  } else if (filterPeriod === 'week') {
    dateFrom = now.startOf('week').toISOString();
    dateTo = now.endOf('week').toISOString();
  } else if (filterPeriod === 'month') {
    dateFrom = now.startOf('month').toISOString();
    dateTo = now.endOf('month').toISOString();
  }

  // Build query with filters — use numbered placeholders
  let whereClauses = ['a.doctor_id = $1'];
  let params = [doctorId];
  let paramIdx = 2;

  if (filterStatus !== 'all') {
    whereClauses.push(`a.status = $${paramIdx}`);
    params.push(filterStatus);
    paramIdx++;
  }

  if (dateFrom && dateTo) {
    whereClauses.push(`a.scheduled_at >= $${paramIdx} AND a.scheduled_at <= $${paramIdx + 1}`);
    params.push(dateFrom, dateTo);
    paramIdx += 2;
  }

  const allAppointments = await queryAll(`
    SELECT a.*,
           u_pat.name AS patient_name,
           u_pat.email AS patient_email,
           s.name AS service_name,
           vc.status AS vc_status,
           ap.status AS payment_status,
           ap.amount AS payment_amount,
           ap.currency AS currency
    FROM appointments a
    LEFT JOIN users u_pat ON u_pat.id = a.patient_id
    LEFT JOIN services s ON s.id = a.specialty_id
    LEFT JOIN video_calls vc ON vc.id = a.video_call_id
    LEFT JOIN appointment_payments ap ON ap.id = a.payment_id
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY a.scheduled_at ASC
    LIMIT 100
  `, params);

  // Separate into categories
  const upcoming = allAppointments.filter(a =>
    ['pending', 'confirmed'].includes(a.status) && dayjs(a.scheduled_at).isAfter(now)
  );
  const todayAppts = allAppointments.filter(a =>
    ['pending', 'confirmed', 'started'].includes(a.status) &&
    dayjs(a.scheduled_at).isSame(now, 'day')
  );
  const past = allAppointments.filter(a =>
    ['completed', 'cancelled', 'no_show_patient', 'no_show_doctor'].includes(a.status)
  );

  // Compute stats
  const totalEarnings = await queryOne(`
    SELECT COALESCE(SUM(earned_amount), 0) as total
    FROM doctor_earnings
    WHERE doctor_id = $1 AND status IN ('pending', 'paid')
  `, [doctorId]);

  const monthEarnings = await queryOne(`
    SELECT COALESCE(SUM(earned_amount), 0) as total
    FROM doctor_earnings
    WHERE doctor_id = $1 AND created_at >= $2
  `, [doctorId, now.startOf('month').toISOString()]);

  const completedCount = await queryOne(`
    SELECT COUNT(*) as count FROM appointments
    WHERE doctor_id = $1 AND status = 'completed'
  `, [doctorId]);

  const noShowCount = await queryOne(`
    SELECT COUNT(*) as count FROM appointments
    WHERE doctor_id = $1 AND status IN ('no_show_patient', 'no_show_doctor')
  `, [doctorId]);

  // For each appointment, compute join eligibility
  const appointmentsWithMeta = allAppointments.map(a => {
    const minsAway = minutesUntil(a.scheduled_at);
    const hrsAway = hoursUntil(a.scheduled_at);
    return {
      ...a,
      canJoin: minsAway <= 10 && minsAway >= -60 && ['confirmed', 'started'].includes(a.status),
      canReschedule: hrsAway > 24 && ['pending', 'confirmed'].includes(a.status),
      canCancel: ['pending', 'confirmed'].includes(a.status),
      canMarkNoShow: ['confirmed', 'started'].includes(a.status) && minsAway < -30,
      minsAway: Math.round(minsAway),
      hrsAway: Math.round(hrsAway * 10) / 10,
      isToday: dayjs(a.scheduled_at).isSame(now, 'day'),
      isPast: dayjs(a.scheduled_at).isBefore(now)
    };
  });

  res.render('doctor_appointments', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    layout: 'portal',
    title: isAr ? 'مواعيد الاستشارات' : 'Video Consultations',
    lang,
    isAr,
    portalFrame: true,
    portalRole: 'doctor',
    portalActive: 'appointments',
    user: req.user,
    appointments: appointmentsWithMeta,
    upcoming,
    todayAppts,
    past,
    filters: { status: filterStatus, period: filterPeriod },
    stats: {
      totalEarnings: totalEarnings.total,
      monthEarnings: monthEarnings.total,
      completedCount: completedCount.count,
      noShowCount: noShowCount.count
    }
  });
});

module.exports = router;
