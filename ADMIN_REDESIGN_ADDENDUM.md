# ADMIN DASHBOARD REDESIGN — ADDENDUM: Chat Moderation, Video Call Tracker & Missing Features

**Append to:** `ADMIN_REDESIGN_PROMPT.md` (execute AFTER the main redesign)

This addendum adds 3 major features to the admin dashboard that are currently missing:
1. Chat Moderation System (privacy-first)
2. Video Call Management Panel
3. Other missing admin features

---

## FEATURE 1: CHAT MODERATION SYSTEM

### Concept
Admin can NOT see patient-doctor conversations by default. This is a privacy-first design. Admin only gets access to a conversation when:
- A patient or doctor flags/reports a message
- The system auto-flags a conversation (e.g. inappropriate language)

### 1.1 Database: Add chat_reports table

In `src/db.js` migrate(), add:

```javascript
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_reports (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_id TEXT,
    reported_by TEXT NOT NULL,
    reporter_role TEXT NOT NULL,
    reason TEXT NOT NULL,
    details TEXT,
    status TEXT DEFAULT 'open',
    admin_notes TEXT,
    resolved_by TEXT,
    resolved_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Add indexes
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_reports_conversation ON chat_reports(conversation_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_reports_status ON chat_reports(status)');
} catch(e) {}
```

### 1.2 "Report" button in messaging UI

In the messaging view (wherever messages are rendered — likely `messages.ejs` or a messaging partial), add a small report icon next to each message that is NOT from the current user:

```html
<!-- On each received message -->
<button class="msg-report-btn" onclick="reportMessage('<%= msg.id %>', '<%= msg.conversation_id %>')" title="Report this message">
  ⚑
</button>
```

When clicked, show a modal:
```html
<div id="reportModal" class="modal" style="display:none;">
  <div class="modal-content">
    <h3>Report Message</h3>
    <form method="POST" action="/portal/messages/report">
      <input type="hidden" name="message_id" id="reportMessageId" />
      <input type="hidden" name="conversation_id" id="reportConvoId" />
      <input type="hidden" name="_csrf" value="<%= typeof csrfToken !== 'undefined' ? csrfToken : '' %>" />
      <label>Reason:</label>
      <select name="reason" required>
        <option value="">Select reason...</option>
        <option value="inappropriate">Inappropriate content</option>
        <option value="harassment">Harassment or threats</option>
        <option value="spam">Spam or irrelevant messages</option>
        <option value="unprofessional">Unprofessional conduct</option>
        <option value="privacy">Privacy concern</option>
        <option value="other">Other</option>
      </select>
      <label>Details (optional):</label>
      <textarea name="details" rows="3" placeholder="Describe the issue..."></textarea>
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button type="submit" class="btn btn-primary">Submit Report</button>
        <button type="button" class="btn btn-outline" onclick="document.getElementById('reportModal').style.display='none'">Cancel</button>
      </div>
    </form>
  </div>
</div>
```

### 1.3 Report submission route

In the messaging routes file (likely `src/routes/messaging.js` or `src/routes/messages.js`), add:

```javascript
// POST /portal/messages/report
router.post('/portal/messages/report', requireAuth, function(req, res) {
  const { message_id, conversation_id, reason, details } = req.body;
  
  // Verify the reporter is a participant in this conversation
  const convo = safeGet('SELECT * FROM conversations WHERE id = ? AND (patient_id = ? OR doctor_id = ?)', 
    [conversation_id, req.user.id, req.user.id]);
  if (!convo) return res.status(403).send('Unauthorized');
  
  const reportId = randomUUID();
  db.prepare(`
    INSERT INTO chat_reports (id, conversation_id, message_id, reported_by, reporter_role, reason, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(reportId, conversation_id, message_id || null, req.user.id, req.user.role, reason, details || null);
  
  // Log audit event
  logAuditEvent(req.user.id, 'chat_reported', { conversation_id, message_id, reason });
  
  req.flash('success', 'Report submitted. Our team will review this shortly.');
  res.redirect('/portal/messages/' + conversation_id);
});
```

### 1.4 Admin Chat Moderation Page

Create `src/views/admin_chat_moderation.ejs`:

This page shows a list of reported conversations. Admin can see:
- Reporter name + role
- Reason for report
- Status (open / reviewing / resolved / dismissed)
- Date reported

When admin clicks "Review", they see ONLY the flagged message + 5 messages before and after for context (NOT the entire chat history). This preserves privacy.

Admin actions:
- **Dismiss** — report is unfounded
- **Warn** — send warning to the reported user
- **Mute** — temporarily disable messaging for the reported user (add `muted_until` column to users table)
- **Resolve** — mark as resolved with admin notes

**Route:** `GET /admin/chat-moderation`

```javascript
router.get('/admin/chat-moderation', requireRole('superadmin'), function(req, res) {
  const reports = safeAll(`
    SELECT cr.*, 
      reporter.name as reporter_name, reporter.role as reporter_user_role,
      c.order_id, c.patient_id, c.doctor_id,
      p.name as patient_name, d.name as doctor_name,
      m.content as flagged_message_content, m.sender_id as flagged_sender_id,
      resolver.name as resolved_by_name
    FROM chat_reports cr
    JOIN conversations c ON cr.conversation_id = c.id
    LEFT JOIN users reporter ON cr.reported_by = reporter.id
    LEFT JOIN users p ON c.patient_id = p.id
    LEFT JOIN users d ON c.doctor_id = d.id
    LEFT JOIN messages m ON cr.message_id = m.id
    LEFT JOIN users resolver ON cr.resolved_by = resolver.id
    ORDER BY 
      CASE cr.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,
      cr.created_at DESC
    LIMIT 50
  `, []);
  
  const openCount = safeGet('SELECT COUNT(*) as cnt FROM chat_reports WHERE status = "open"', []);
  
  res.render('admin_chat_moderation', {
    reports,
    openCount: openCount ? openCount.cnt : 0,
    lang: res.locals.lang || 'en',
    portalFrame: true,
    portalRole: 'superadmin',
    portalActive: 'moderation'
  });
});
```

**Review route** — shows context around the flagged message:

```javascript
router.get('/admin/chat-moderation/:reportId', requireRole('superadmin'), function(req, res) {
  const report = safeGet(`
    SELECT cr.*, c.order_id, c.patient_id, c.doctor_id,
      p.name as patient_name, d.name as doctor_name,
      m.content as flagged_content, m.created_at as flagged_at
    FROM chat_reports cr
    JOIN conversations c ON cr.conversation_id = c.id
    LEFT JOIN users p ON c.patient_id = p.id
    LEFT JOIN users d ON c.doctor_id = d.id
    LEFT JOIN messages m ON cr.message_id = m.id
    WHERE cr.id = ?
  `, [req.params.reportId]);
  
  if (!report) return res.redirect('/admin/chat-moderation');
  
  // Get ONLY 5 messages before and after the flagged message for context
  // Admin does NOT see the entire conversation
  let contextMessages = [];
  if (report.message_id) {
    contextMessages = safeAll(`
      SELECT m.*, u.name as sender_name, u.role as sender_role
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = ?
      AND m.id IN (
        SELECT id FROM (
          SELECT id, created_at FROM messages 
          WHERE conversation_id = ? AND created_at <= (SELECT created_at FROM messages WHERE id = ?)
          ORDER BY created_at DESC LIMIT 6
        )
        UNION
        SELECT id FROM (
          SELECT id, created_at FROM messages 
          WHERE conversation_id = ? AND created_at > (SELECT created_at FROM messages WHERE id = ?)
          ORDER BY created_at ASC LIMIT 5
        )
      )
      ORDER BY m.created_at ASC
    `, [report.conversation_id, report.conversation_id, report.message_id, report.conversation_id, report.message_id]);
  }
  
  // Mark report as reviewing
  if (report.status === 'open') {
    db.prepare('UPDATE chat_reports SET status = "reviewing" WHERE id = ?').run(req.params.reportId);
  }
  
  res.render('admin_chat_moderation_detail', {
    report,
    contextMessages,
    flaggedMessageId: report.message_id,
    lang: res.locals.lang || 'en',
    portalFrame: true,
    portalRole: 'superadmin',
    portalActive: 'moderation'
  });
});
```

**Action routes:**

```javascript
// POST /admin/chat-moderation/:reportId/resolve
router.post('/admin/chat-moderation/:reportId/resolve', requireRole('superadmin'), function(req, res) {
  const { action, admin_notes } = req.body;
  // action: 'dismiss', 'warn', 'mute', 'resolve'
  
  db.prepare(`
    UPDATE chat_reports SET status = ?, admin_notes = ?, resolved_by = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).run(
    action === 'dismiss' ? 'dismissed' : 'resolved',
    admin_notes || null,
    req.user.id,
    req.params.reportId
  );
  
  // If action is 'warn', send notification to the reported user
  if (action === 'warn') {
    const report = safeGet('SELECT * FROM chat_reports WHERE id = ?', [req.params.reportId]);
    if (report && report.message_id) {
      const flaggedMsg = safeGet('SELECT sender_id FROM messages WHERE id = ?', [report.message_id]);
      if (flaggedMsg) {
        // Create in-app notification to the warned user
        db.prepare(`
          INSERT INTO notifications (id, user_id, type, title, message, created_at)
          VALUES (?, ?, 'chat_warning', 'Chat Conduct Warning', 'Your message was reported and reviewed by our team. Please maintain professional conduct in all communications.', datetime('now'))
        `).run(randomUUID(), flaggedMsg.sender_id);
      }
    }
  }
  
  // If action is 'mute', add muted_until to user
  if (action === 'mute') {
    const report = safeGet('SELECT message_id FROM chat_reports WHERE id = ?', [req.params.reportId]);
    if (report && report.message_id) {
      const flaggedMsg = safeGet('SELECT sender_id FROM messages WHERE id = ?', [report.message_id]);
      if (flaggedMsg) {
        // Mute for 7 days
        db.prepare('UPDATE users SET muted_until = datetime("now", "+7 days") WHERE id = ?').run(flaggedMsg.sender_id);
      }
    }
  }
  
  res.redirect('/admin/chat-moderation');
});
```

### 1.5 Add moderation link to admin sidebar

In `portal.ejs`, add to the superadmin nav (after Alerts):
```html
<li><a href="/admin/chat-moderation" class="<%= isActive('moderation') %>"><%= isAr ? 'إدارة المحادثات' : 'Chat Moderation' %></a></li>
```

### 1.6 Add `muted_until` column to users table

In `src/db.js` migrate():
```javascript
// Chat moderation
safeAddColumn('users', 'muted_until', 'TEXT');
```

In the messaging POST route (send message), check:
```javascript
// Before allowing message send
const sender = safeGet('SELECT muted_until FROM users WHERE id = ?', [req.user.id]);
if (sender && sender.muted_until && new Date(sender.muted_until) > new Date()) {
  return res.status(403).json({ error: 'Your messaging has been temporarily suspended. Please contact support.' });
}
```

---

## FEATURE 2: VIDEO CALL MANAGEMENT PANEL

### Concept
Admin needs a dedicated section to track all video consultations — who attended, who missed, call durations, no-shows, and any issues.

### 2.1 Admin Video Calls Page

Create `src/views/admin_video_calls.ejs`:

**Route:** `GET /admin/video-calls`

```javascript
router.get('/admin/video-calls', requireRole('superadmin'), function(req, res) {
  // Get all appointments with video call status
  const appointments = safeAll(`
    SELECT a.*,
      p.name as patient_name, p.email as patient_email,
      d.name as doctor_name, d.email as doctor_email,
      s.name as specialty_name,
      vc.id as call_id, vc.status as call_status, 
      vc.started_at as call_started, vc.ended_at as call_ended,
      vc.duration_minutes as call_duration,
      vc.patient_joined_at, vc.doctor_joined_at,
      ap.amount as payment_amount, ap.status as payment_status, ap.refund_status
    FROM appointments a
    LEFT JOIN users p ON a.patient_id = p.id
    LEFT JOIN users d ON a.doctor_id = d.id
    LEFT JOIN specialties s ON a.specialty_id = s.id
    LEFT JOIN video_calls vc ON vc.appointment_id = a.id
    LEFT JOIN appointment_payments ap ON ap.appointment_id = a.id
    ORDER BY a.scheduled_at DESC
    LIMIT 100
  `, []);
  
  // KPIs
  const totalAppointments = safeGet('SELECT COUNT(*) as cnt FROM appointments', []);
  const completedCalls = safeGet('SELECT COUNT(*) as cnt FROM video_calls WHERE status = "completed"', []);
  const noShows = safeGet(`SELECT COUNT(*) as cnt FROM appointments WHERE status = 'no_show'`, []);
  const cancelledCalls = safeGet(`SELECT COUNT(*) as cnt FROM appointments WHERE status = 'cancelled'`, []);
  const avgDuration = safeGet('SELECT AVG(duration_minutes) as avg FROM video_calls WHERE status = "completed"', []);
  const upcomingToday = safeAll(`
    SELECT a.*, p.name as patient_name, d.name as doctor_name
    FROM appointments a
    LEFT JOIN users p ON a.patient_id = p.id
    LEFT JOIN users d ON a.doctor_id = d.id
    WHERE date(a.scheduled_at) = date('now')
    AND a.status IN ('confirmed', 'scheduled', 'pending')
    ORDER BY a.scheduled_at ASC
  `, []);
  
  // No-show breakdown
  const patientNoShows = safeGet(`SELECT COUNT(*) as cnt FROM appointments WHERE status = 'no_show' AND no_show_party = 'patient'`, []);
  const doctorNoShows = safeGet(`SELECT COUNT(*) as cnt FROM appointments WHERE status = 'no_show' AND no_show_party = 'doctor'`, []);
  
  res.render('admin_video_calls', {
    appointments,
    totalAppointments: totalAppointments ? totalAppointments.cnt : 0,
    completedCalls: completedCalls ? completedCalls.cnt : 0,
    noShows: noShows ? noShows.cnt : 0,
    cancelledCalls: cancelledCalls ? cancelledCalls.cnt : 0,
    avgDuration: avgDuration && avgDuration.avg ? Math.round(avgDuration.avg) : 0,
    upcomingToday,
    patientNoShows: patientNoShows ? patientNoShows.cnt : 0,
    doctorNoShows: doctorNoShows ? doctorNoShows.cnt : 0,
    lang: res.locals.lang || 'en',
    portalFrame: true,
    portalRole: 'superadmin',
    portalActive: 'video-calls'
  });
});
```

### 2.2 Video Call Page Layout

The page should have:

**KPI Row:**
- Total Appointments (all time)
- Completed Calls (with avg duration)
- No-Shows (split: patient vs doctor)
- Cancelled
- Revenue from video consultations

**Today's Schedule (right panel or top section):**
- List of today's upcoming video appointments
- Time, patient name, doctor name, status
- Color code: green = confirmed, amber = pending, red = missed

**Main Table: All Appointments**
Columns:
- Date/Time
- Patient
- Doctor
- Specialty
- Status (scheduled / confirmed / in_progress / completed / no_show / cancelled / rescheduled)
- Duration (if completed)
- Payment (amount + status: paid/refunded/pending)
- Actions (View details)

**Filters:**
- Date range
- Status filter
- Doctor filter
- "No-shows only" toggle

### 2.3 Add video calls link to admin sidebar

In `portal.ejs`, add to superadmin nav (after Orders):
```html
<li><a href="/admin/video-calls" class="<%= isActive('video-calls') %>"><%= isAr ? 'مكالمات الفيديو' : 'Video Calls' %></a></li>
```

### 2.4 Add no_show_party column if missing

In `src/db.js` migrate():
```javascript
safeAddColumn('appointments', 'no_show_party', 'TEXT'); // 'patient' or 'doctor'
```

---

## FEATURE 3: OTHER MISSING ADMIN FEATURES

Based on the full platform feature set, here are admin dashboard elements that should be present but might be missing:

### 3.1 Pending Doctor Approvals Widget (Dashboard)

On the admin dashboard (`admin.ejs`), add a card showing doctors who signed up and are pending approval:

```javascript
// In the admin dashboard route, add:
const pendingDoctors = safeAll(`
  SELECT u.id, u.name, u.email, u.created_at, 
    GROUP_CONCAT(s.name) as specialties
  FROM users u
  LEFT JOIN doctor_specialties ds ON u.id = ds.doctor_id
  LEFT JOIN specialties s ON ds.specialty_id = s.id
  WHERE u.role = 'doctor' AND (u.pending_approval = 1 OR u.status = 'pending')
  GROUP BY u.id
  ORDER BY u.created_at DESC
`, []);
```

### 3.2 Refund Requests Widget (Dashboard)

Show refund requests from cancelled appointments or disputes:

```javascript
const pendingRefunds = safeAll(`
  SELECT ap.*, a.scheduled_at, 
    p.name as patient_name, d.name as doctor_name
  FROM appointment_payments ap
  JOIN appointments a ON ap.appointment_id = a.id
  LEFT JOIN users p ON a.patient_id = p.id
  LEFT JOIN users d ON a.doctor_id = d.id
  WHERE ap.refund_status = 'requested'
  ORDER BY ap.created_at DESC
`, []);
```

### 3.3 System Health Indicators (Dashboard)

Add small indicators at the top of the dashboard:
- Email service status (last successful send timestamp)
- WhatsApp service status (last successful send)
- SLA worker last run time
- Reminder worker last run time
- Total errors in last 24h

```javascript
const lastEmailSent = safeGet(`SELECT MAX(sent_at) as last FROM notifications WHERE channel = 'email' AND status = 'sent'`, []);
const lastWhatsAppSent = safeGet(`SELECT MAX(sent_at) as last FROM notifications WHERE channel = 'whatsapp' AND status = 'sent'`, []);
const errorsLast24h = safeGet(`SELECT COUNT(*) as cnt FROM error_log WHERE created_at > datetime('now', '-1 day')`, []);
```

### 3.4 Quick Actions (Dashboard)

Add a row of quick action buttons at the top of the dashboard:
- "Create Manual Order" → `/superadmin/orders/new`
- "Add Doctor" → `/superadmin/doctors/new`
- "Send Campaign" → `/portal/admin/campaigns/new`
- "View Error Log" → `/admin/errors`

### 3.5 Financial Summary Card (Dashboard)

- Total revenue this month
- Total doctor payouts pending
- Platform commission earned
- Refunds processed this month

```javascript
const financials = {
  monthRevenue: safeGet(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'paid' AND created_at > datetime('now', 'start of month')`, []),
  pendingPayouts: safeGet(`SELECT COALESCE(SUM(earned_amount), 0) as total FROM doctor_earnings WHERE status = 'pending'`, []),
  refundsThisMonth: safeGet(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'refunded' AND created_at > datetime('now', 'start of month')`, []),
};
```

---

## UPDATED ADMIN SIDEBAR (Full)

The admin sidebar in `portal.ejs` should have ALL of these links:

```html
<ul class="portal-nav">
  <!-- Overview -->
  <li><a href="/superadmin" class="<%= isActive('dashboard') %>">Dashboard</a></li>
  
  <!-- Cases & Calls -->
  <li><a href="/admin/orders" class="<%= isActive('orders') %>">Cases</a></li>
  <li><a href="/admin/video-calls" class="<%= isActive('video-calls') %>">Video Calls</a></li>
  
  <!-- People -->
  <li><a href="/superadmin/doctors" class="<%= isActive('doctors') %>">Doctors</a></li>
  <!-- Note: No dedicated patients list page exists yet — add if needed -->
  
  <!-- Services & Pricing -->
  <li><a href="/superadmin/services" class="<%= isActive('services') %>">Services</a></li>
  <li><a href="/admin/pricing" class="<%= isActive('pricing') %>">Pricing</a></li>
  
  <!-- Operations -->
  <li><a href="/portal/admin/analytics" class="<%= isActive('analytics') %>">Analytics</a></li>
  <li><a href="/admin/reviews" class="<%= isActive('reviews') %>">Reviews</a></li>
  <li><a href="/admin/chat-moderation" class="<%= isActive('moderation') %>">Chat Moderation</a></li>
  
  <!-- Marketing -->
  <li><a href="/portal/admin/referrals" class="<%= isActive('referrals') %>">Referrals</a></li>
  <li><a href="/portal/admin/campaigns" class="<%= isActive('campaigns') %>">Campaigns</a></li>
  
  <!-- System -->
  <li><a href="/admin/errors" class="<%= isActive('errors') %>">Error Log</a></li>
  <li><a href="/superadmin/events" class="<%= isActive('events') %>">Audit Log</a></li>
  <li><a href="/superadmin/alerts" class="<%= isActive('alerts') %>">Alerts</a></li>
  
  <!-- Account -->
  <li><a href="/superadmin/profile" class="<%= isActive('profile') %>">Profile</a></li>
</ul>
```

---

## CSS FOR NEW PAGES

All new pages (chat moderation, video calls) should use the same `.admin-theme` scoped CSS from the main `ADMIN_REDESIGN_PROMPT.md`. The existing card, table, pill, and KPI classes will work. No additional CSS needed — just use the existing component classes:

- `.card` + `.card-header` for sections
- `table` + `thead th` + `tbody td` for tables
- `.status-pill--*` for status badges
- `.admin-kpi-grid` + `.kpi-card` for KPI rows
- `.btn-primary`, `.btn-outline` for buttons
- `.filters` for filter bars

---

## COMMIT

```
feat: add chat moderation, video call management, and admin dashboard enhancements

- Chat moderation: report button in messaging, admin review with privacy-first context window
- Video calls: full appointment tracking page with KPIs, no-show tracking, duration stats
- Dashboard widgets: pending doctors, refund requests, system health, financial summary
- Updated admin sidebar with all navigation links
- Database: chat_reports table, muted_until column, no_show_party column
```
