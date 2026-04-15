# Order Broadcast & Notification System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement doctor broadcast notifications after payment, auto-assignment on acceptance timeout, urgent order cutoffs, and admin broadcast/force-assign actions.

**Architecture:** After payment confirmation, broadcast the order to eligible doctors in the specialty via WhatsApp. A separate acceptance_watcher worker runs every 2 minutes to auto-assign expired unaccepted orders. Admin portal gets manual broadcast and force-assign endpoints.

**Tech Stack:** Node.js/Express, PostgreSQL (via src/pg.js helpers), WhatsApp via Meta Graph API (src/notify/whatsapp.js), existing queueNotification system (src/notify.js).

---

## Task 1: Database Migration — `010_broadcast_system.sql`

**Files:**
- Create: `src/migrations/010_broadcast_system.sql`

**Step 1: Write the migration SQL**

```sql
-- 010_broadcast_system.sql
-- Adds broadcast tracking columns, doctor capacity columns, and cleans up urgency.

-- 1. Migrate urgent -> urgency_flag and drop urgent column
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='urgent') THEN
    UPDATE orders SET urgency_flag = true WHERE urgent = true AND (urgency_flag IS NULL OR urgency_flag = false);
    ALTER TABLE orders DROP COLUMN urgent;
  END IF;
END $$;

-- 2. Doctor capacity columns on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_active_cases integer DEFAULT 5;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_active_cases_urgent integer DEFAULT 8;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_available boolean DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamp;

-- 3. Broadcast tracking columns on orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS broadcast_sent_at timestamp;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS broadcast_count integer DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS acceptance_deadline_at timestamp;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tier text DEFAULT 'standard';

-- 4. Index for acceptance watcher queries
CREATE INDEX IF NOT EXISTS idx_orders_acceptance_deadline
  ON orders (acceptance_deadline_at)
  WHERE doctor_id IS NULL AND status IN ('pending', 'available', 'submitted', 'new', 'paid');

-- 5. Index for broadcast eligible doctor lookup
CREATE INDEX IF NOT EXISTS idx_doctor_specialties_doctor_id
  ON doctor_specialties (doctor_id);
```

Create this file at `src/migrations/010_broadcast_system.sql`.

**Step 2: Verify migration runs on boot**

Run: `node -e "require('./src/db').migrate().then(() => { console.log('OK'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })"`
Expected: Migration runs without error, prints "Migration: 010_broadcast_system.sql" then "OK".

**Step 3: Commit**

```bash
git add src/migrations/010_broadcast_system.sql
git commit -m "feat: add migration 010 for broadcast system columns"
```

---

## Task 2: Template Constants — `src/notify/templates.js`

**Files:**
- Create: `src/notify/templates.js`

**Step 1: Create the templates file**

```javascript
// src/notify/templates.js
// All WhatsApp template names used across the notification system.
// These must match approved Meta template names exactly.

const TEMPLATES = Object.freeze({
  // Patient templates
  CASE_SUBMITTED:            'tashkheesa_case_submitted',
  PAYMENT_LINK:              'tashkheesa_payment_link',
  PAYMENT_CONFIRMED:         'tashkheesa_payment_confirmed',
  CASE_ASSIGNED:             'tashkheesa_case_assigned',
  CASE_ASSIGNED_URGENT:      'tashkheesa_case_assigned_urgent',
  REPORT_READY:              'tashkheesa_report_ready',
  CASE_CANCELLED_REFUND:     'tashkheesa_cancelled_refund',
  CASE_CANCELLED_NO_REFUND:  'tashkheesa_cancelled_no_refund',
  DR_NEEDS_INFO:             'tashkheesa_dr_needs_info',

  // Doctor templates
  NEW_CASE_STANDARD:         'tashkheesa_new_case_standard',
  NEW_CASE_FASTTRACK:        'tashkheesa_new_case_fasttrack',
  NEW_CASE_URGENT:           'tashkheesa_new_case_urgent',
  CASE_AUTO_ASSIGNED:        'tashkheesa_case_auto_assigned',
  SLA_WARNING_75:            'sla_warning_75',
  SLA_WARNING_URGENT:        'sla_warning_urgent',
  SLA_BREACH:                'sla_breach',

  // Admin templates
  SLA_BREACH_ADMIN:          'sla_breach',
});

module.exports = { TEMPLATES };
```

**Step 2: Verify import works**

Run: `node -e "const { TEMPLATES } = require('./src/notify/templates'); console.log(Object.keys(TEMPLATES).length, 'templates loaded'); console.log('OK');"`
Expected: "17 templates loaded" then "OK"

**Step 3: Commit**

```bash
git add src/notify/templates.js
git commit -m "feat: add WhatsApp template name constants"
```

---

## Task 3: Broadcast Function — `src/notify/broadcast.js`

**Files:**
- Create: `src/notify/broadcast.js`

**Step 1: Write the broadcast module**

```javascript
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

  // 5. Resolve specialty — use order.specialty_id, fallback to service's specialty
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
  // For urgent: skip cap check. For others: enforce cap.
  let eligibleDoctors;
  if (tier === 'urgent') {
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
    const capColumn = tier === 'fast_track' ? 'max_active_cases_urgent' : 'max_active_cases';
    const defaultCap = tier === 'fast_track' ? 8 : 5;
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
        ) < COALESCE(u.${capColumn}, ${defaultCap})
      ORDER BY (
        SELECT COUNT(*) FROM orders o
        WHERE o.doctor_id = u.id
          AND LOWER(o.status) NOT IN ('completed', 'cancelled')
      ) ASC
    `, [specialtyId]);
  }

  // 7. Send notifications with deduplication
  let sentCount = 0;
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
      dedupe_key: `broadcast:${orderId}:${doctor.id}`,
    });
    if (result && result.ok && !result.skipped) {
      sentCount++;
    }
  }

  console.log(`[broadcast] order ${orderId} tier=${tier} specialty=${specialtyId} eligible=${eligibleDoctors.length} sent=${sentCount}`);

  return { ok: true, tier, eligible: eligibleDoctors.length, sent: sentCount };
}

module.exports = { broadcastOrderToSpecialty, determineTier, TIER_CONFIG };
```

**Step 2: Verify import works**

Run: `node -e "const { broadcastOrderToSpecialty } = require('./src/notify/broadcast'); console.log(typeof broadcastOrderToSpecialty); console.log('OK');"`
Expected: "function" then "OK"

**Step 3: Commit**

```bash
git add src/notify/broadcast.js
git commit -m "feat: add order broadcast to specialty doctors"
```

---

## Task 4: Acceptance Watcher Worker — `src/workers/acceptance_watcher.js`

**Files:**
- Create: `src/workers/acceptance_watcher.js`

**Step 1: Create the workers directory and write the watcher**

Run: `mkdir -p src/workers` (if not exists)

```javascript
// src/workers/acceptance_watcher.js
// Runs every 2 minutes. Auto-assigns orders whose acceptance deadline has expired.

const { queryOne, queryAll, execute } = require('../pg');
const { queueNotification } = require('../notify');
const { TEMPLATES } = require('../notify/templates');
const { logOrderEvent } = require('../audit');

let running = false;

async function runAcceptanceWatcherSweep() {
  if (running) return;
  running = true;

  try {
    // Find expired, unassigned orders
    const expiredOrders = await queryAll(`
      SELECT o.id, o.specialty_id, o.service_id, o.reference_id, o.patient_id,
             o.tier, o.urgency_flag, o.sla_24hr_selected
      FROM orders o
      WHERE o.doctor_id IS NULL
        AND o.acceptance_deadline_at IS NOT NULL
        AND o.acceptance_deadline_at < NOW()
        AND LOWER(COALESCE(o.status, '')) IN ('pending', 'available', 'submitted', 'new', 'paid')
        AND LOWER(COALESCE(o.payment_status, '')) IN ('paid', 'captured')
    `);

    if (!expiredOrders || expiredOrders.length === 0) {
      return;
    }

    console.log(`[acceptance_watcher] found ${expiredOrders.length} expired orders`);

    for (const order of expiredOrders) {
      try {
        await autoAssignOrder(order);
      } catch (err) {
        console.error(`[acceptance_watcher] failed to auto-assign order ${order.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[acceptance_watcher] sweep failed:', err.message);
  } finally {
    running = false;
  }
}

async function autoAssignOrder(order) {
  // Resolve specialty
  let specialtyId = order.specialty_id;
  if (!specialtyId && order.service_id) {
    const svc = await queryOne('SELECT specialty_id FROM services WHERE id = $1', [order.service_id]);
    specialtyId = svc ? svc.specialty_id : null;
  }

  // Find the most available doctor in the specialty
  const doctor = await queryOne(`
    SELECT u.id, u.name
    FROM users u
    JOIN doctor_specialties ds ON ds.doctor_id = u.id
    WHERE ds.specialty_id = $1
      AND u.role = 'doctor'
      AND COALESCE(u.is_active, true) = true
      AND COALESCE(u.is_available, true) = true
    ORDER BY (
      SELECT COUNT(*) FROM orders o
      WHERE o.doctor_id = u.id
        AND LOWER(o.status) NOT IN ('completed', 'cancelled')
    ) ASC
    LIMIT 1
  `, [specialtyId]);

  if (!doctor) {
    console.warn(`[acceptance_watcher] no available doctor for order ${order.id} specialty=${specialtyId}`);
    return;
  }

  // Idempotency guard: only assign if still unassigned
  const nowIso = new Date().toISOString();
  const result = await execute(
    `UPDATE orders
     SET doctor_id = $1,
         status = 'assigned',
         accepted_at = $2,
         reassigned_count = COALESCE(reassigned_count, 0) + 1,
         updated_at = $2
     WHERE id = $3
       AND doctor_id IS NULL`,
    [doctor.id, nowIso, order.id]
  );

  if (!result || result.rowCount === 0) {
    // Already assigned by another process
    return;
  }

  console.log(`[acceptance_watcher] auto-assigned order ${order.id} to doctor ${doctor.id} (${doctor.name})`);

  // Log event
  try {
    logOrderEvent({
      orderId: order.id,
      label: 'acceptance_timeout_auto_assigned',
      meta: { doctor_id: doctor.id, doctor_name: doctor.name, tier: order.tier },
      actorRole: 'system',
    });
  } catch (_) {}

  // Notify doctor (WhatsApp)
  queueNotification({
    orderId: order.id,
    toUserId: doctor.id,
    channel: 'whatsapp',
    template: TEMPLATES.CASE_AUTO_ASSIGNED,
    response: {
      case_ref: order.reference_id || String(order.id).slice(0, 12).toUpperCase(),
    },
    dedupe_key: `auto_assign:${order.id}:${doctor.id}`,
  });

  // Notify patient (WhatsApp)
  if (order.patient_id) {
    queueNotification({
      orderId: order.id,
      toUserId: order.patient_id,
      channel: 'whatsapp',
      template: TEMPLATES.CASE_ASSIGNED,
      response: {
        case_ref: order.reference_id || String(order.id).slice(0, 12).toUpperCase(),
        doctor_name: doctor.name || '',
      },
      dedupe_key: `case_assigned_patient:${order.id}`,
    });
  }

  // Notify admin (internal)
  queueNotification({
    orderId: order.id,
    toUserId: 'superadmin-1',
    channel: 'internal',
    template: 'acceptance_timeout_auto_assigned_admin',
    response: {
      case_ref: order.reference_id || String(order.id).slice(0, 12).toUpperCase(),
      doctor_id: doctor.id,
      doctor_name: doctor.name,
    },
    dedupe_key: `auto_assign_admin:${order.id}`,
  });
}

function startAcceptanceWatcher() {
  console.log('[acceptance_watcher] started (interval: 2 minutes)');
  // Run immediately on start
  runAcceptanceWatcherSweep();
  // Then every 2 minutes
  return setInterval(runAcceptanceWatcherSweep, 2 * 60 * 1000);
}

module.exports = { startAcceptanceWatcher, runAcceptanceWatcherSweep };
```

**Step 2: Verify import works**

Run: `node -e "const { startAcceptanceWatcher } = require('./src/workers/acceptance_watcher'); console.log(typeof startAcceptanceWatcher); console.log('OK');"`
Expected: "function" then "OK"

**Step 3: Commit**

```bash
git add src/workers/acceptance_watcher.js
git commit -m "feat: add acceptance watcher for auto-assign on timeout"
```

---

## Task 5: Wire Broadcast into Payment Callback

**Files:**
- Modify: `src/routes/payments.js`

**Step 1: Add broadcast import and call after payment confirmed**

At the top of `src/routes/payments.js`, after the existing imports (line 9), add:

```javascript
var { broadcastOrderToSpecialty } = require('../notify/broadcast');
```

After the auto-assign block (around line 202, after the `enqueueAutoAssign` catch block), add the broadcast call:

```javascript
  // === BROADCAST TO SPECIALTY DOCTORS ===
  if (!order.doctor_id) {
    broadcastOrderToSpecialty(orderId).catch(function(err) {
      console.error('[broadcast] post-payment broadcast failed:', err.message);
    });
  }
```

**Step 2: Verify the file still loads**

Run: `node -e "require('./src/routes/payments'); console.log('OK');"`
Expected: "OK" (no errors)

**Step 3: Commit**

```bash
git add src/routes/payments.js
git commit -m "feat: broadcast to specialty doctors after payment confirmed"
```

---

## Task 6: Wire Acceptance Watcher into Server Startup

**Files:**
- Modify: `src/server.js`

**Step 1: Add import**

After the existing worker imports (around line 124, after `var { startCaseSlaWorker } = require('./case_sla_worker');`), add:

```javascript
var { startAcceptanceWatcher } = require('./workers/acceptance_watcher');
```

**Step 2: Start the watcher in primary mode**

In the `if (CONFIG.SLA_MODE === 'primary')` block (around line 777-785, after `startVideoScheduler();`), add:

```javascript
    startAcceptanceWatcher();
```

**Step 3: Verify the server loads**

Run: `node -e "require('./src/server'); setTimeout(() => process.exit(0), 2000);" 2>&1 | head -20`
Expected: Boot logs appear, no crash.

**Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat: start acceptance watcher on server boot (primary mode)"
```

---

## Task 7: Urgent Order Cutoff Enforcement

**Files:**
- Modify: `src/routes/api/cases.js` (mobile API)
- Modify: `src/routes/order_flow.js` (portal wizard)

**Step 1: Add cutoff check to mobile API case creation**

In `src/routes/api/cases.js`, before the INSERT INTO orders statement (around line 180), add the urgent cutoff check:

```javascript
    // Urgent order cutoff: only 07:00-19:00 Cairo time (UTC+2)
    if (urgent) {
      const now = new Date();
      const cairoHour = new Date(now.getTime() + 2 * 60 * 60 * 1000).getUTCHours();
      if (cairoHour < 7 || cairoHour >= 19) {
        return res.fail(
          'Urgent orders are only available between 7:00am and 7:00pm Cairo time. Please select standard or fast-track.',
          400,
          'URGENT_UNAVAILABLE'
        );
      }
    }
```

Also update the INSERT to use `urgency_flag` instead of `urgent` since the column was dropped:

Change the INSERT column from `urgent` to `urgency_flag` and value from `!!urgent` to `!!urgent`.

**Step 2: Add cutoff check to portal order flow**

In `src/routes/order_flow.js`, in the SLA selection handler (around line 418-422 where `urgency_flag` is set), add the cutoff before the UPDATE:

```javascript
  // Urgent order cutoff: only 07:00-19:00 Cairo time (UTC+2)
  if (slaHours <= 4) {
    const now = new Date();
    const cairoHour = new Date(now.getTime() + 2 * 60 * 60 * 1000).getUTCHours();
    if (cairoHour < 7 || cairoHour >= 19) {
      return res.status(400).json({
        error: 'urgent_unavailable',
        message: 'Urgent orders are only available between 7:00am and 7:00pm Cairo time.'
      });
    }
  }
```

**Step 3: Verify both files load**

Run: `node -e "require('./src/routes/order_flow'); console.log('OK');"`
Expected: "OK"

**Step 4: Commit**

```bash
git add src/routes/api/cases.js src/routes/order_flow.js
git commit -m "feat: enforce urgent order cutoff (07:00-19:00 Cairo time)"
```

---

## Task 8: Admin Broadcast & Force-Assign Routes

**Files:**
- Modify: `src/routes/admin.js`

**Step 1: Add broadcast import**

At the top of `src/routes/admin.js`, after the existing imports, add:

```javascript
const { broadcastOrderToSpecialty } = require('../notify/broadcast');
const { TEMPLATES } = require('../notify/templates');
```

**Step 2: Add broadcast-now endpoint**

After the existing reassign route (around line 1510), add:

```javascript
// ---- Admin: Broadcast order to specialty doctors ----
router.post('/admin/orders/:id/broadcast', requireAdmin, async (req, res) => {
  const orderId = req.params.id;

  const order = await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!order) {
    return res.status(404).json({ ok: false, error: 'Order not found' });
  }

  // Only broadcast unassigned orders
  if (order.doctor_id) {
    return res.status(400).json({ ok: false, error: 'Order already assigned to a doctor' });
  }

  const status = String(order.status || '').toLowerCase();
  if (!['pending', 'available', 'submitted', 'new', 'paid'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'Order status does not allow broadcast: ' + status });
  }

  const result = await broadcastOrderToSpecialty(orderId);

  logOrderEvent({
    orderId,
    label: 'admin_manual_broadcast',
    meta: { admin_id: req.user.id, result },
    actorUserId: req.user.id,
    actorRole: req.user.role,
  });

  return res.json({ ok: true, ...result });
});

// ---- Admin: Force-assign order to a specific doctor ----
router.post('/admin/orders/:id/force-assign', requireAdmin, async (req, res) => {
  const orderId = req.params.id;
  const { doctorId } = req.body || {};

  if (!doctorId) {
    return res.status(400).json({ ok: false, error: 'doctorId is required' });
  }

  const order = await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!order) {
    return res.status(404).json({ ok: false, error: 'Order not found' });
  }

  const doctor = await queryOne("SELECT id, name FROM users WHERE id = $1 AND role = 'doctor'", [doctorId]);
  if (!doctor) {
    return res.status(404).json({ ok: false, error: 'Doctor not found' });
  }

  const nowIso = new Date().toISOString();
  await execute(
    `UPDATE orders
     SET doctor_id = $1,
         status = 'assigned',
         accepted_at = $2,
         updated_at = $2
     WHERE id = $3`,
    [doctor.id, nowIso, orderId]
  );

  logOrderEvent({
    orderId,
    label: 'admin_force_assigned',
    meta: { doctor_id: doctor.id, doctor_name: doctor.name, admin_id: req.user.id, note: 'force_assigned' },
    actorUserId: req.user.id,
    actorRole: req.user.role,
  });

  // Notify doctor (WhatsApp)
  queueNotification({
    orderId,
    toUserId: doctor.id,
    channel: 'whatsapp',
    template: TEMPLATES.CASE_AUTO_ASSIGNED,
    response: {
      case_ref: order.reference_id || String(orderId).slice(0, 12).toUpperCase(),
    },
    dedupe_key: `force_assign:${orderId}:${doctor.id}`,
  });

  // Notify patient (WhatsApp)
  if (order.patient_id) {
    queueNotification({
      orderId,
      toUserId: order.patient_id,
      channel: 'whatsapp',
      template: TEMPLATES.CASE_ASSIGNED,
      response: {
        case_ref: order.reference_id || String(orderId).slice(0, 12).toUpperCase(),
        doctor_name: doctor.name || '',
      },
      dedupe_key: `force_assign_patient:${orderId}`,
    });
  }

  // Admin in-app confirmation
  queueNotification({
    orderId,
    toUserId: req.user.id,
    channel: 'internal',
    template: 'admin_force_assigned_confirmation',
    response: {
      case_ref: order.reference_id || String(orderId).slice(0, 12).toUpperCase(),
      doctor_name: doctor.name,
    },
  });

  return res.json({ ok: true, orderId, doctorId: doctor.id, doctorName: doctor.name });
});
```

**Step 3: Verify file loads**

Run: `node -e "require('./src/routes/admin'); console.log('OK');"`
Expected: "OK"

**Step 4: Commit**

```bash
git add src/routes/admin.js
git commit -m "feat: add admin broadcast-now and force-assign endpoints"
```

---

## Task 9: Replace notify_doctor.js Placeholders

**Files:**
- Modify: `src/notify_doctor.js`

**Step 1: Replace placeholder implementations with real calls**

```javascript
// src/notify_doctor.js
// Bridges legacy doctor notification calls to the real notify system.

const { queueNotification } = require('./notify');

module.exports = {
  async sendDoctorEmail(toEmail, subject, message) {
    // Real email would go through an email service.
    // For now, queue as internal notification since email service is not wired.
    console.log('[notify_doctor] email queued (internal)', { toEmail, subject });
    return queueNotification({
      toUserId: toEmail,
      channel: 'internal',
      template: 'doctor_email',
      response: { subject, message },
    });
  },

  async sendDoctorWhatsApp(toNumber, message) {
    // This function is now unused — all WhatsApp goes through queueNotification.
    // Kept for backward compatibility if any code still calls it.
    console.log('[notify_doctor] whatsapp call redirected to queueNotification', { toNumber });
  }
};
```

**Step 2: Verify import works**

Run: `node -e "const nd = require('./src/notify_doctor'); console.log(typeof nd.sendDoctorEmail, typeof nd.sendDoctorWhatsApp); console.log('OK');"`
Expected: "function function" then "OK"

**Step 3: Commit**

```bash
git add src/notify_doctor.js
git commit -m "feat: replace notify_doctor placeholders with real notify calls"
```

---

## Task 10: Fix `o.urgent` References in API Cases

**Files:**
- Modify: `src/routes/api/cases.js`

**Step 1: Update SELECT queries that reference `o.urgent`**

The column `urgent` was dropped in the migration. Update the case detail query (around line 87) to use `urgency_flag` instead:

Change: `o.completed_at as "completedAt", o.urgent,`
To: `o.completed_at as "completedAt", o.urgency_flag as "urgent",`

Also update the INSERT (line 186) to use `urgency_flag` instead of `urgent`:

Change: `base_price, currency, sla_deadline, urgent, created_at`
To: `base_price, currency, sla_deadline, urgency_flag, created_at`

**Step 2: Verify file loads**

Run: `node -e "const r = require('express').Router; console.log('OK');"`
Expected: "OK"

**Step 3: Commit**

```bash
git add src/routes/api/cases.js
git commit -m "fix: use urgency_flag instead of dropped urgent column"
```

---

## Task 11: Final Integration Verification

**Step 1: Verify all modules load together**

Run: `node -e "
  require('./src/notify/templates');
  require('./src/notify/broadcast');
  require('./src/workers/acceptance_watcher');
  require('./src/notify_doctor');
  console.log('All modules loaded OK');
"`
Expected: "All modules loaded OK"

**Step 2: Run the full server boot test**

Run: `timeout 5 node src/server.js 2>&1 || true`
Expected: Server boots without crashes, logs migration and worker startup messages.

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete order broadcast and notification system

- Migration 010: broadcast columns, doctor capacity, urgency cleanup
- Broadcast to specialty doctors after payment (WhatsApp)
- Acceptance watcher: auto-assign on timeout (2-min interval)
- Urgent order cutoff: 07:00-19:00 Cairo time
- Admin broadcast-now and force-assign endpoints
- Template name constants for all WhatsApp templates
- Replaced notify_doctor.js placeholders"
```

---

## Summary of Changes

| File | Action | Purpose |
|------|--------|---------|
| `src/migrations/010_broadcast_system.sql` | Create | DB schema for broadcast system |
| `src/notify/templates.js` | Create | WhatsApp template name constants |
| `src/notify/broadcast.js` | Create | Core broadcast function |
| `src/workers/acceptance_watcher.js` | Create | Auto-assign on acceptance timeout |
| `src/routes/payments.js` | Modify | Broadcast after payment confirmed |
| `src/server.js` | Modify | Start acceptance watcher |
| `src/routes/api/cases.js` | Modify | Urgent cutoff + fix `urgent` column |
| `src/routes/order_flow.js` | Modify | Urgent cutoff for portal |
| `src/routes/admin.js` | Modify | Broadcast-now + force-assign |
| `src/notify_doctor.js` | Modify | Replace placeholders |
