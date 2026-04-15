// src/notify/broadcast.js
// Broadcasts a paid order to eligible doctors in the matching specialty.

const { queryOne, queryAll, execute } = require('../pg');
const { queueNotification } = require('../notify');
const { TEMPLATES } = require('./templates');

// Tier definitions: acceptance window in minutes
const TIER_CONFIG = {
  urgent:     { acceptanceMinutes: 10,  template: TEMPLATES.NEW_CASE_URGENT },
  fast_track: { acceptanceMinutes: 60,  template: TEMPLATES.NEW_CASE_FASTTRACK },
  standard:   { acceptanceMinutes: 240, template: TEMPLATES.NEW_CASE_STANDARD },
};

function determineTier(order) {
  if (order.urgency_flag) return 'urgent';
  if (order.sla_24hr_selected) return 'fast_track';
  return 'standard';
}

async function broadcastOrderToSpecialty(orderId) {
  // 1. Load order
  const order = await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!order) {
    console.warn('[broadcast] order not found:', orderId);
    return { ok: false, reason: 'order_not_found' };
  }

  // 2. Confirm paid
  const paymentStatus = String(order.payment_status || '').toLowerCase();
  if (paymentStatus !== 'paid' && paymentStatus !== 'captured') {
    console.warn('[broadcast] order not paid, skipping:', orderId, paymentStatus);
    return { ok: false, reason: 'not_paid' };
  }

  // 3. Determine tier
  const tier = determineTier(order);
  const config = TIER_CONFIG[tier];

  // 4. Save tier + broadcast metadata
  const now = new Date();
  const acceptanceDeadline = new Date(now.getTime() + config.acceptanceMinutes * 60 * 1000);

  await execute(
    `UPDATE orders
     SET tier = $1,
         broadcast_sent_at = $2,
         broadcast_count = COALESCE(broadcast_count, 0) + 1,
         acceptance_deadline_at = $3,
         updated_at = $2
     WHERE id = $4`,
    [tier, now.toISOString(), acceptanceDeadline.toISOString(), orderId]
  );

  // 5. Resolve specialty
  let specialtyId = order.specialty_id;
  if (!specialtyId && order.service_id) {
    const svc = await queryOne('SELECT specialty_id FROM services WHERE id = $1', [order.service_id]);
    specialtyId = svc ? svc.specialty_id : null;
  }
  if (!specialtyId) {
    console.warn('[broadcast] no specialty for order:', orderId);
    return { ok: false, reason: 'no_specialty' };
  }

  // 6. Query eligible doctors
  let eligibleDoctors;
  if (tier === 'urgent') {
    // Urgent: notify ALL available doctors regardless of cap
    eligibleDoctors = await queryAll(`
      SELECT DISTINCT u.id, u.name, u.phone
      FROM users u
      JOIN doctor_specialties ds ON ds.doctor_id = u.id
      WHERE ds.specialty_id = $1
        AND u.role = 'doctor'
        AND COALESCE(u.is_active, true) = true
        AND COALESCE(u.is_available, true) = true
        AND COALESCE(u.notify_whatsapp, false) = true
        AND u.phone IS NOT NULL AND u.phone != ''
      ORDER BY (
        SELECT COUNT(*) FROM orders o
        WHERE o.doctor_id = u.id
          AND LOWER(o.status) NOT IN ('completed', 'cancelled')
      ) ASC
    `, [specialtyId]);
  } else {
    // Standard/fast_track: enforce cap
    var capColumn = tier === 'fast_track' ? 'max_active_cases_urgent' : 'max_active_cases';
    var defaultCap = tier === 'fast_track' ? 8 : 5;
    eligibleDoctors = await queryAll(`
      SELECT DISTINCT u.id, u.name, u.phone
      FROM users u
      JOIN doctor_specialties ds ON ds.doctor_id = u.id
      WHERE ds.specialty_id = $1
        AND u.role = 'doctor'
        AND COALESCE(u.is_active, true) = true
        AND COALESCE(u.is_available, true) = true
        AND COALESCE(u.notify_whatsapp, false) = true
        AND u.phone IS NOT NULL AND u.phone != ''
        AND (
          SELECT COUNT(*) FROM orders o
          WHERE o.doctor_id = u.id
            AND LOWER(o.status) NOT IN ('completed', 'cancelled')
        ) < COALESCE(u.` + capColumn + `, ` + defaultCap + `)
      ORDER BY (
        SELECT COUNT(*) FROM orders o
        WHERE o.doctor_id = u.id
          AND LOWER(o.status) NOT IN ('completed', 'cancelled')
      ) ASC
    `, [specialtyId]);
  }

  // 7. Send notifications with deduplication
  var sentCount = 0;
  for (const doctor of eligibleDoctors) {
    const result = await queueNotification({
      orderId: orderId,
      toUserId: doctor.id,
      channel: 'whatsapp',
      template: config.template,
      response: {
        case_ref: order.reference_id || String(orderId).slice(0, 12).toUpperCase(),
        specialty: specialtyId,
        tier: tier,
        sla_hours: order.sla_hours || 72,
      },
      dedupe_key: 'broadcast:' + orderId + ':' + doctor.id,
    });
    if (result && result.ok && !result.skipped) {
      sentCount++;
    }
  }

  console.log('[broadcast] order ' + orderId + ' tier=' + tier + ' specialty=' + specialtyId + ' eligible=' + eligibleDoctors.length + ' sent=' + sentCount);
  return { ok: true, tier: tier, eligible: eligibleDoctors.length, sent: sentCount };
}

module.exports = { broadcastOrderToSpecialty, determineTier, TIER_CONFIG };
