# TASHKHEESA — Notification System Overhaul (Claude Code Prompt)
## Execute ALL sections in order. Commit after each section.

**Project root:** `/Users/ziadelwahsh/Desktop/tashkheesa-portal`

---

## CONTEXT

Tashkheesa has a notification system with three channels: internal (in-app), WhatsApp, and email.

**What exists:**
- `src/notify.js` — `queueNotification()` and `queueMultiChannelNotification()` for inserting notifications
- `src/notify/whatsapp.js` — Meta Cloud API WhatsApp sender
- `src/services/emailService.js` — Nodemailer SMTP email sender with Handlebars templates
- `src/notification_worker.js` — Worker that polls `status='queued'` notifications and dispatches them
- `src/notify/whatsappTemplateMap.js` — Maps event names to Meta HSM template names
- `src/notify/notification_titles.js` — Bilingual titles for notification events
- `src/templates/email/en/*.hbs` and `src/templates/email/ar/*.hbs` — 14 email templates

**The problems:**
1. `runNotificationWorker()` is NEVER started — it's defined and exported in `notification_worker.js` but no cron/interval calls it from `server.js`
2. Most notification triggers use `queueNotification()` with `channel: 'internal'` only — patients and doctors never get WhatsApp or email for critical events
3. Several important case lifecycle events have no notification triggers at all
4. Missing email templates for: additional files request, prescription uploaded, new message, case completed
5. Missing WhatsApp template map entries for: additional files request, prescription uploaded, new message, case completed

---

## SECTION 1: START THE NOTIFICATION WORKER

The notification worker needs to run on an interval to process queued email and WhatsApp notifications.

In `src/server.js`, find where other workers are started (look for `startSlaWorker`, `startCaseSlaWorker`, `startVideoScheduler`, `InstagramScheduler` — they're near the end of the file after `app.listen`).

Add after the other worker starts:

```javascript
const { runNotificationWorker } = require('./notification_worker');

// Process queued email + WhatsApp notifications every 30 seconds
setInterval(async () => {
  try {
    await runNotificationWorker(50);
  } catch (err) {
    console.error('[notify-worker] interval error', err);
  }
}, 30000);

// Also run once on startup after a 5-second delay
setTimeout(async () => {
  try {
    await runNotificationWorker(50);
    console.log('[notify-worker] initial run complete');
  } catch (err) {
    console.error('[notify-worker] initial run error', err);
  }
}, 5000);
```

**Verification:** Start the server and check logs for `[notify-worker]` messages after 30 seconds.

---

## SECTION 2: UPGRADE CRITICAL EVENTS TO MULTI-CHANNEL

Find every `queueNotification()` call that uses `channel: 'internal'` for a critical patient or doctor event and upgrade it to `queueMultiChannelNotification()` with `channels: ['internal', 'email', 'whatsapp']`.

### 2A. Search all route files for `queueNotification(` calls:

```bash
grep -rn "queueNotification(" src/routes/ src/case_lifecycle.js src/assign.js src/sla_worker.js src/sla.js --include="*.js"
```

### 2B. For each call found, determine if it should be multi-channel.

**These events MUST be multi-channel (internal + email + WhatsApp):**

| Template | Who gets it | Why it matters |
|----------|-------------|---------------|
| `order_created_patient` | Patient | Confirmation their case was submitted |
| `order_status_accepted_patient` | Patient | Doctor accepted their case |
| `order_assigned_doctor` | Doctor | New case assigned to them |
| `order_auto_assigned_doctor` | Doctor | Auto-assigned case |
| `report_ready_patient` | Patient | Their diagnosis is ready |
| `payment_success_patient` | Patient | Payment confirmed |
| `payment_failed_patient` | Patient | Payment failed, action needed |
| `order_reassigned_patient` | Patient | Their case was reassigned |
| `order_reassigned_doctor` | Doctor (old) | Case taken from them |
| `order_reassigned_to_doctor` | Doctor (new) | Case assigned to them |
| `welcome_patient` | Patient | Welcome after registration |
| `doctor_approved` | Doctor | Account approved, can start |
| `appointment_booked` | Both | Appointment confirmed |
| `appointment_reminder` | Both | Upcoming appointment |

**For each of the above**, find the `queueNotification()` call and replace with:

```javascript
// BEFORE (internal only):
queueNotification({
  orderId: order.id,
  toUserId: patient.id,
  channel: 'internal',
  template: 'order_created_patient',
  response: { case_id: order.id }
});

// AFTER (multi-channel):
queueMultiChannelNotification({
  orderId: order.id,
  toUserId: patient.id,
  channels: ['internal', 'email', 'whatsapp'],
  template: 'order_created_patient',
  response: { case_id: order.id, caseReference: order.id.slice(0, 12).toUpperCase(), specialty: serviceName || '' },
  dedupe_key: 'order_created:' + order.id + ':patient'
});
```

Make sure `queueMultiChannelNotification` is imported at the top of each file where it's used:
```javascript
const { queueNotification, queueMultiChannelNotification } = require('../notify');
```

**These events should stay internal-only** (no spam):
- SLA warnings (already on WhatsApp via `sendSlaReminder()`)
- Smoke tests
- Admin-only events like `public_order_created_superadmin`

---

## SECTION 3: ADD MISSING NOTIFICATION TRIGGERS

### 3A. Additional files requested by doctor → Notify patient

Find where the doctor requests additional files (likely in `src/routes/doctor.js` — search for `additional_files` or `request_files` or `file_request`).

After the file request is created/approved, add:

```javascript
queueMultiChannelNotification({
  orderId: order.id,
  toUserId: order.patient_id,
  channels: ['internal', 'email', 'whatsapp'],
  template: 'additional_files_requested_patient',
  response: {
    case_id: order.id,
    caseReference: order.id.slice(0, 12).toUpperCase(),
    doctorName: doctor.name || 'Your doctor',
    reason: reason || 'Additional files needed'
  },
  dedupe_key: 'additional_files_request:' + order.id + ':' + Date.now()
});
```

### 3B. Patient uploaded additional files → Notify doctor

Find where patient uploads additional files (likely in `src/routes/patient.js` — search for `additional` or `upload`).

After successful upload, add:

```javascript
queueMultiChannelNotification({
  orderId: order.id,
  toUserId: order.doctor_id,
  channels: ['internal', 'email', 'whatsapp'],
  template: 'patient_uploaded_files_doctor',
  response: {
    case_id: order.id,
    caseReference: order.id.slice(0, 12).toUpperCase(),
    patientName: patient.name || 'Patient'
  },
  dedupe_key: 'patient_uploaded:' + order.id + ':' + Date.now()
});
```

### 3C. Prescription uploaded → Notify patient

Find where doctor uploads prescription (in `src/routes/prescriptions.js`, the POST handler for `/portal/doctor/case/:caseId/prescribe`).

After successful prescription creation, add:

```javascript
queueMultiChannelNotification({
  orderId: caseId,
  toUserId: order.patient_id,
  channels: ['internal', 'email', 'whatsapp'],
  template: 'prescription_uploaded_patient',
  response: {
    case_id: caseId,
    caseReference: caseId.slice(0, 12).toUpperCase(),
    doctorName: req.user.name || 'Your doctor'
  },
  dedupe_key: 'prescription:' + caseId + ':' + prescriptionId
});
```

### 3D. Case completed (report submitted) → Notify patient

Find where case status changes to 'completed' (likely in `src/routes/doctor.js` when submitting report). This may already trigger `report_ready_patient` — verify. If not, add:

```javascript
queueMultiChannelNotification({
  orderId: order.id,
  toUserId: order.patient_id,
  channels: ['internal', 'email', 'whatsapp'],
  template: 'report_ready_patient',
  response: {
    case_id: order.id,
    caseReference: order.id.slice(0, 12).toUpperCase(),
    doctorName: doctor.name || '',
    reportUrl: order.report_url || ''
  },
  dedupe_key: 'report_ready:' + order.id
});
```

### 3E. New message → Notify recipient (delayed)

In `src/routes/messaging.js`, find the POST handler that sends a message. After inserting the message into the DB, queue a notification to the OTHER party. Use a dedupe key scoped to conversation + a time window so they don't get spammed:

```javascript
// Notify recipient of new message (at most once per conversation per 10 minutes)
var recipientId = (req.user.id === conversation.patient_id) ? conversation.doctor_id : conversation.patient_id;
var dedupeWindow = Math.floor(Date.now() / (10 * 60 * 1000)); // 10-minute windows
queueMultiChannelNotification({
  orderId: conversation.order_id,
  toUserId: recipientId,
  channels: ['internal', 'email'],  // NOT WhatsApp for every message — too spammy
  template: 'new_message',
  response: {
    case_id: conversation.order_id,
    senderName: req.user.name || 'Someone',
    messagePreview: (sanitizedMessage || '').slice(0, 100)
  },
  dedupe_key: 'message:' + conversation.id + ':' + dedupeWindow
});
```

### 3F. Appointment cancelled / rescheduled → Notify both parties

Find where appointments are cancelled or rescheduled (in `src/routes/appointments.js`). Add notifications to both patient and doctor:

```javascript
// On cancel:
queueMultiChannelNotification({
  orderId: appointment.order_id,
  toUserId: appointment.patient_id,
  channels: ['internal', 'email', 'whatsapp'],
  template: 'appointment_cancelled',
  response: { appointmentDate: appointment.start_time, doctorName: doctor.name },
  dedupe_key: 'appt_cancel:' + appointment.id
});
// Same for doctor with toUserId: appointment.doctor_id

// On reschedule: (already has appointment_rescheduled template)
```

---

## SECTION 4: ADD MISSING EMAIL TEMPLATES

Create these new email templates (both EN and AR):

### 4A. `src/templates/email/en/additional-files-request.hbs`
```handlebars
<h2>Additional Files Needed</h2>
<p>Hi {{patientName}},</p>
<p>Your doctor has requested additional files for your case <strong>{{caseReference}}</strong>.</p>
<p><strong>Reason:</strong> {{reason}}</p>
<p>Please log in to your portal and upload the requested files as soon as possible.</p>
<a href="{{dashboardUrl}}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Upload Files</a>
```

### 4B. `src/templates/email/en/prescription-uploaded.hbs`
```handlebars
<h2>Prescription Available</h2>
<p>Hi {{patientName}},</p>
<p>Dr. {{doctorName}} has uploaded a prescription for your case <strong>{{caseReference}}</strong>.</p>
<p>You can view and download it from your Prescriptions page.</p>
<a href="{{dashboardUrl}}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">View Prescription</a>
```

### 4C. `src/templates/email/en/new-message.hbs`
```handlebars
<h2>New Message</h2>
<p>Hi,</p>
<p>You have a new message from <strong>{{senderName}}</strong> regarding case <strong>{{caseReference}}</strong>.</p>
<p style="background:#f1f5f9;padding:12px 16px;border-radius:8px;color:#475569;font-style:italic;">"{{messagePreview}}..."</p>
<a href="{{dashboardUrl}}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Reply Now</a>
```

### 4D. `src/templates/email/en/appointment-cancelled.hbs`
```handlebars
<h2>Appointment Cancelled</h2>
<p>Hi {{patientName}},</p>
<p>Your appointment on <strong>{{appointmentDate}}</strong> with Dr. {{doctorName}} has been cancelled.</p>
<p>Please log in to your portal to reschedule.</p>
<a href="{{dashboardUrl}}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Reschedule</a>
```

### 4E. `src/templates/email/en/patient-uploaded-files.hbs`
```handlebars
<h2>Patient Uploaded Files</h2>
<p>Hi Dr. {{doctorName}},</p>
<p>{{patientName}} has uploaded additional files for case <strong>{{caseReference}}</strong>.</p>
<p>Please review the new files at your earliest convenience.</p>
<a href="{{caseUrl}}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">View Case</a>
```

### 4F. Create Arabic versions of all the above in `src/templates/email/ar/`
Mirror the same templates but with Arabic text and `dir="rtl"` on the layout. Example for additional-files-request:

```handlebars
<h2>مطلوب ملفات إضافية</h2>
<p>مرحباً {{patientName}},</p>
<p>طلب طبيبك ملفات إضافية للحالة <strong>{{caseReference}}</strong>.</p>
<p><strong>السبب:</strong> {{reason}}</p>
<p>يرجى تسجيل الدخول إلى البوابة ورفع الملفات المطلوبة في أقرب وقت.</p>
<a href="{{dashboardUrl}}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">رفع الملفات</a>
```

---

## SECTION 5: UPDATE NOTIFICATION MAPS

### 5A. Add to `src/notification_worker.js` TEMPLATE_TO_EMAIL map:

```javascript
additional_files_requested_patient: 'additional-files-request',
additional_files_request_approved_patient: 'additional-files-request',
patient_uploaded_files_doctor: 'patient-uploaded-files',
prescription_uploaded_patient: 'prescription-uploaded',
new_message: 'new-message',
appointment_cancelled: 'appointment-cancelled',
```

### 5B. Add to `src/notify/whatsappTemplateMap.js`:

```javascript
additional_files_requested_patient: {
  templateName: 'additional_files_en',
  lang: 'en',
  paramBuilder: (data) => ({
    case_ref: data.caseReference || data.case_id || '',
    reason: data.reason || 'Additional files needed',
  }),
},

prescription_uploaded_patient: {
  templateName: 'prescription_ready_en',
  lang: 'en',
  paramBuilder: (data) => ({
    case_ref: data.caseReference || data.case_id || '',
    doctor_name: data.doctorName || '',
  }),
},

patient_uploaded_files_doctor: {
  templateName: 'patient_uploaded_files_en',
  lang: 'en',
  paramBuilder: (data) => ({
    case_ref: data.caseReference || data.case_id || '',
    patient_name: data.patientName || '',
  }),
},

appointment_cancelled: {
  templateName: 'appointment_cancelled_en',
  lang: 'en',
  paramBuilder: (data) => ({
    date_time: data.appointmentDate || '',
    doctor_name: data.doctorName || '',
  }),
},
```

### 5C. Add to `src/notify/notification_titles.js` TEMPLATE_TITLES:

```javascript
additional_files_requested_patient: { en: 'Additional files requested', ar: 'مطلوب ملفات إضافية' },
prescription_uploaded_patient: { en: 'Prescription available', ar: 'الوصفة الطبية متاحة' },
patient_uploaded_files_doctor: { en: 'Patient uploaded files', ar: 'المريض رفع ملفات' },
new_message: { en: 'New message', ar: 'رسالة جديدة' },
appointment_cancelled: { en: 'Appointment cancelled', ar: 'تم إلغاء الموعد' },
appointment_rescheduled: { en: 'Appointment rescheduled', ar: 'تم إعادة جدولة الموعد' },
```

---

## SECTION 6: PAYMENT REMINDER TRIGGERS

The payment reminder templates exist (`payment_reminder_30m`, `payment_reminder_6h`, `payment_reminder_24h`) but need to be triggered. Find `dispatchUnpaidCaseReminders` in `src/case_lifecycle.js` — verify it exists and is called from the SLA worker.

If it's not being called, add it to the SLA worker interval or create a separate interval in `server.js`:

```javascript
// Payment reminders — check every 15 minutes
setInterval(() => {
  try {
    dispatchUnpaidCaseReminders();
  } catch (err) {
    console.error('[payment-reminders] error', err);
  }
}, 15 * 60 * 1000);
```

---

## SECTION 7: VERIFICATION

After all changes, verify:

- [ ] Server starts without errors
- [ ] `[notify-worker] initial run complete` appears in logs ~5 seconds after startup
- [ ] Creating a test notification with `channel: 'email'` gets picked up by the worker
- [ ] Creating a test notification with `channel: 'whatsapp'` gets picked up by the worker
- [ ] All queueMultiChannelNotification calls import from '../notify' or '../../notify' correctly
- [ ] No duplicate notification template names across the maps
- [ ] All new email templates render without Handlebars errors (test with `renderEmail('additional-files-request', 'en', { patientName: 'Test', caseReference: 'ABC123', reason: 'Blurry scan' })`)

---

## COMMIT STRATEGY
1. `feat(notifications): start notification worker on 30s interval`
2. `feat(notifications): upgrade critical events to multi-channel (email + WhatsApp + internal)`
3. `feat(notifications): add triggers for additional files, prescriptions, messages, cancellations`
4. `feat(notifications): add email templates for new notification events (EN + AR)`
5. `feat(notifications): update template maps and notification titles`
6. `feat(notifications): wire payment reminder dispatch to interval`
