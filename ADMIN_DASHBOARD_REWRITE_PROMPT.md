# ADMIN DASHBOARD (Command Center) — Full Rewrite

**Execute AFTER** all previous prompts. This prompt fixes the admin dashboard at `/admin` which currently renders with the old doctor-portal layout (wrong sidebar, unstyled widgets, broken structure). It also reconfigures the dashboard to be **operations-focused** for staff admins.

---

## THE PROBLEM

The admin dashboard at `/admin` currently:
1. Shows the **doctor portal sidebar** (Dashboard, Case Queue, Appointments, Messages, Prescriptions, Reviews, My Analytics, Alerts, Profile) instead of the admin sidebar
2. Uses old `page-shell` / `page-inner` / `content-stack` HTML wrappers that the admin-styles.css doesn't target
3. Shows full revenue/financial KPIs that should be owner-only
4. System health section is unstyled (plain text with bullets)
5. The admin-styles.css `.admin-theme` exists but admin.ejs HTML doesn't use the correct class names

## THE FIX

Complete rewrite of `admin.ejs` to:
- Use the `admin-page` structure (matching all other admin sub-pages)
- Show the admin sidebar (NOT doctor sidebar) — this should already work via `portalRole: 'admin'` in portal.ejs, but verify
- Display operations-focused widgets per owner specification
- Hide full financials (only show order-related: refunds, add-ons)
- Show only error count + notification failures for system info

---

## WHAT THE ADMIN DASHBOARD SHOULD SHOW

### Layout (top to bottom):

```
┌──────────────────────────────────────────────────────────┐
│ PAGE HEADER                                              │
│  Title: "Operations Dashboard"                           │
│  Subtitle: "Case management and patient support"         │
│  Right: Date filter (from/to) + Specialty + Apply btn    │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ ALERT STRIP (only shows if there are items needing attn) │
│ ⚠️ 3 pending refunds · 2 open reports · 1 SLA breach    │
│ (clickable links to each section)                        │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ CASE KPIs (4 cards)                                      │
│ Total Cases | Pending | Completed | Breached SLA         │
│ (with % change vs last month)                            │
│                                                          │
│ + SLA On-Time % | Avg Turnaround (min)                   │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ PATIENT ISSUES SECTION                                   │
│ ┌─────────────────────┬──────────────────────────┐       │
│ │ Open Chat Reports   │ Pending Refund Requests  │       │
│ │ (count + link to    │ (count + link to review) │       │
│ │ moderation page)    │                          │       │
│ ├─────────────────────┼──────────────────────────┤       │
│ │ File Re-upload      │ No-Shows Today           │       │
│ │ Requests (count)    │ (patient + doctor count) │       │
│ └─────────────────────┴──────────────────────────┘       │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ DOCTOR MANAGEMENT (3 inline cards)                       │
│ Pending Approvals (X) | Active Doctors (X) |             │
│ Doctor No-Shows This Week (X)                            │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ ORDER FINANCIALS (limited — no revenue)                  │
│ Refunds This Month (EGP) | Add-ons Purchased |          │
│ Pending Payouts (EGP)                                    │
└──────────────────────────────────────────────────────────┘
┌────────────────────────────────┬─────────────────────────┐
│ RECENT CASES TABLE             │ SLA RISK (cases about   │
│ (latest 10 orders)            │ to breach in 24h)       │
│ Order|Patient|Doctor|Service| │                         │
│ Status|Amount                  │                         │
│                                ├─────────────────────────┤
│                                │ LIVE ACTIVITY FEED      │
│                                │ (audit + SLA events)    │
└────────────────────────────────┴─────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ SYSTEM STRIP (minimal)                                   │
│ Errors (24h): X | Notifications Failed: X / Queued: X    │
└──────────────────────────────────────────────────────────┘
```

---

## STEP 1: Verify the admin sidebar in portal.ejs

The admin sidebar should be the one with: Dashboard, Cases, Video Calls, Doctors, Services, Pricing, Analytics, Reviews, Chat Moderation, Campaigns, Referrals, Alerts, Error Log.

Check `portal.ejs` — the sidebar rendering logic. When `portalRole === 'admin'`, the sidebar must show admin navigation, NOT doctor navigation. If the current portal.ejs only checks for `portalRole === 'superadmin'` and falls through to the doctor sidebar for everything else, that's the bug.

Find the sidebar section and ensure there's an explicit `portalRole === 'admin'` block with admin navigation links. The admin sidebar should look similar to the superadmin sidebar but WITHOUT the owner branding:

```html
<% if (portalRole === 'admin') { %>
  <!-- Admin sidebar -->
  <div class="sidebar-brand">
    <div class="sidebar-logo">T</div>
    <div>
      <div class="sidebar-name">Tashkheesa</div>
      <small style="font-size:10px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">Admin Portal</small>
    </div>
  </div>

  <div class="sidebar-section">
    <div class="sidebar-section-label"><%= isAr ? 'نظرة عامة' : 'Overview' %></div>
    <li><a href="/admin" class="<%= portalActive === 'dashboard' ? 'active' : '' %>">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      Dashboard
    </a></li>
    <li><a href="/admin/orders" class="<%= portalActive === 'orders' ? 'active' : '' %>">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>
      Cases
    </a></li>
    <li><a href="/admin/video-calls" class="<%= portalActive === 'video-calls' ? 'active' : '' %>">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
      Video Calls
    </a></li>
  </div>

  <div class="sidebar-section">
    <div class="sidebar-section-label"><%= isAr ? 'الإدارة' : 'Management' %></div>
    <li><a href="/admin/chat-moderation" class="<%= portalActive === 'moderation' ? 'active' : '' %>">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
      Chat Moderation
    </a></li>
    <li><a href="/superadmin/doctors" class="<%= portalActive === 'doctors' ? 'active' : '' %>">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
      Doctors
    </a></li>
    <li><a href="/admin/reviews" class="<%= portalActive === 'reviews' ? 'active' : '' %>">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      Reviews
    </a></li>
  </div>

  <div class="sidebar-section">
    <div class="sidebar-section-label"><%= isAr ? 'العمليات' : 'Operations' %></div>
    <li><a href="/admin/errors" class="<%= portalActive === 'errors' ? 'active' : '' %>">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      Error Log
    </a></li>
    <li><a href="/superadmin/alerts" class="<%= portalActive === 'alerts' ? 'active' : '' %>">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
      Alerts
    </a></li>
  </div>
<% } %>
```

Make sure this block exists BEFORE the doctor/patient sidebar fallback. The check order should be:
1. `portalRole === 'superadmin'` → Glass Tower sidebar (already done)
2. `portalRole === 'admin'` → Command Center admin sidebar (ADD THIS)
3. `portalRole === 'doctor'` → Doctor sidebar
4. `portalRole === 'patient'` → Patient sidebar

---

## STEP 2: Rewrite admin.ejs

Replace the entire content between the header include and footer include. Keep the existing JS logic (formatEventDate, safe defaults, combinedEvents, etc.) but replace ALL HTML.

The page must use `admin-page` wrapper and all the admin-* CSS classes from admin-styles.css.

**IMPORTANT NOTES:**
- Do NOT show revenue, gross profit, or total revenue KPIs — those are owner-only
- DO show: refunds this month, add-ons purchased, pending payouts (order-related financials only)
- DO show: open chat reports, pending refund requests, file re-upload requests, no-shows
- DO show: pending doctor approvals, active doctors count
- System strip: ONLY error count (24h) + notification failures + notification queued — no email/WhatsApp health

**Structure:**

```html
<div class="admin-page">
  <!-- Page Header with inline filters -->
  <div class="admin-page-header">
    <div class="admin-page-header-left">
      <h1 class="admin-page-title">Operations Dashboard</h1>
      <p class="admin-page-subtitle">Case management and patient support</p>
    </div>
    <div class="admin-page-header-right">
      <form class="admin-header-filters" method="get" action="/admin">
        <!-- from/to date + specialty + apply -->
      </form>
    </div>
  </div>

  <!-- Alert Strip (conditional) -->
  <% var alertCount = (pendingRefundsCount || 0) + (openChatReports || 0) + (breachedCount || 0); %>
  <% if (alertCount > 0) { %>
  <div class="admin-alert-strip">
    <svg ...warning icon.../>
    <% if (openChatReports > 0) { %><a href="/admin/chat-moderation"><%= openChatReports %> open report<%= openChatReports > 1 ? 's' : '' %></a><% } %>
    <% if (pendingRefundsCount > 0) { %><a href="#"><%=pendingRefundsCount%> pending refund<%= pendingRefundsCount > 1 ? 's' : '' %></a><% } %>
    <% if (breachedCount > 0) { %><a href="/admin/orders?status=breached"><%= breachedCount %> SLA breach<%= breachedCount > 1 ? 'es' : '' %></a><% } %>
  </div>
  <% } %>

  <!-- Case KPIs -->
  <div class="admin-kpi-row">
    <div class="admin-kpi">
      <div class="admin-kpi-label">Total Cases</div>
      <div class="admin-kpi-value"><%= totalOrders %></div>
      <div class="admin-kpi-change ...">...% vs last month</div>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">Pending</div>
      <div class="admin-kpi-value"><%= pendingOrders %></div>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">Completed</div>
      <div class="admin-kpi-value"><%= completedCount %></div>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">Breached SLA</div>
      <div class="admin-kpi-value"><%= breachedCount %></div>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">SLA On-Time</div>
      <div class="admin-kpi-value"><%= onTimePercent %>%</div>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">Avg Turnaround</div>
      <div class="admin-kpi-value"><%= avgTatMinutes %> min</div>
    </div>
  </div>

  <!-- Patient Issues (2x2 grid) -->
  <h3 class="admin-section-title">Patient Issues</h3>
  <div class="admin-issues-grid">
    <div class="admin-card admin-issue-card">
      <div class="issue-icon red">💬</div>
      <div class="issue-count"><%= openChatReports %></div>
      <div class="issue-label">Open Chat Reports</div>
      <a href="/admin/chat-moderation" class="admin-btn admin-btn-sm admin-btn-outline">Review</a>
    </div>
    <div class="admin-card admin-issue-card">
      <div class="issue-icon amber">💰</div>
      <div class="issue-count"><%= pendingRefunds.length %></div>
      <div class="issue-label">Pending Refund Requests</div>
      <a href="#" class="admin-btn admin-btn-sm admin-btn-outline">Review</a>
    </div>
    <div class="admin-card admin-issue-card">
      <div class="issue-icon blue">📄</div>
      <div class="issue-count"><%= pendingFileRequestsCount %></div>
      <div class="issue-label">File Re-upload Requests</div>
    </div>
    <div class="admin-card admin-issue-card">
      <div class="issue-icon purple">🚫</div>
      <div class="issue-count"><%= doctorNoShowsToday || 0 %></div>
      <div class="issue-label">No-Shows Today</div>
    </div>
  </div>

  <!-- Doctor Management (3 cards) -->
  <h3 class="admin-section-title">Doctor Management</h3>
  <div class="admin-kpi-row" style="grid-template-columns: repeat(3, 1fr);">
    <div class="admin-kpi">
      <div class="admin-kpi-label">Pending Approvals</div>
      <div class="admin-kpi-value"><%= pendingDoctorsCount %></div>
      <% if (pendingDoctorsCount > 0) { %><a href="/superadmin/doctors?status=pending" class="admin-btn admin-btn-sm admin-btn-primary" style="margin-top:8px;">Review</a><% } %>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">Active Doctors</div>
      <div class="admin-kpi-value"><%= activeDoctorsCount %></div>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">Doctor No-Shows This Week</div>
      <div class="admin-kpi-value"><%= doctorNoShowsWeek || 0 %></div>
    </div>
  </div>

  <!-- Order Financials (limited) -->
  <h3 class="admin-section-title">Order Financials</h3>
  <div class="admin-kpi-row" style="grid-template-columns: repeat(3, 1fr);">
    <div class="admin-kpi">
      <div class="admin-kpi-label">Refunds This Month</div>
      <div class="admin-kpi-value"><%= Number(financials.refundsThisMonth || 0).toLocaleString() %> EGP</div>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">Add-ons Purchased</div>
      <div class="admin-kpi-value"><%= addOnsPurchased || 0 %></div>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">Pending Dr Payouts</div>
      <div class="admin-kpi-value"><%= Number(financials.pendingPayouts || 0).toLocaleString() %> EGP</div>
    </div>
  </div>

  <!-- Main Content: Cases Table + Sidebar -->
  <div class="admin-grid-main">
    <!-- Left: Recent Cases Table -->
    <div>
      <div class="admin-card">
        <div class="admin-card-header">
          <h3>Recent Cases</h3>
          <a href="/admin/orders" class="admin-btn admin-btn-sm admin-btn-outline">View All</a>
        </div>
        <table class="admin-table">
          <!-- same table as current but with admin-table classes -->
        </table>
      </div>
    </div>

    <!-- Right: SLA Risk + Activity Feed -->
    <div>
      <div class="admin-card" style="margin-bottom:16px;">
        <div class="admin-card-header"><h3>SLA Risk (24h)</h3></div>
        <div class="admin-card-body">
          <!-- SLA risk items or "No orders nearing SLA" -->
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-header"><h3>Live Activity</h3></div>
        <ul class="events-list">
          <!-- combinedEvents feed -->
        </ul>
      </div>
    </div>
  </div>

  <!-- System Strip (minimal) -->
  <div class="admin-system-strip">
    <div class="system-item">
      <span class="system-label">Errors (24h)</span>
      <span class="system-val<%= (_sh.errorsLast24h > 0) ? ' system-val--alert' : '' %>"><%= _sh.errorsLast24h || 0 %></span>
    </div>
    <div class="system-item">
      <span class="system-label">Notif. Failed</span>
      <span class="system-val<%= (notifStats.failed > 0) ? ' system-val--alert' : '' %>"><%= notifStats.failed || 0 %></span>
    </div>
    <div class="system-item">
      <span class="system-label">Notif. Queued</span>
      <span class="system-val"><%= notifStats.queued || 0 %></span>
    </div>
  </div>
</div>
```

---

## STEP 3: Add missing CSS for new admin dashboard elements

Add these to `admin-styles.css` (scoped under `.admin-theme`):

```css
/* Alert strip */
.admin-theme .admin-alert-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: #fef3c7;
  border: 1px solid #fcd34d;
  border-radius: 10px;
  margin-bottom: 20px;
  font-size: 13px;
  font-weight: 500;
  color: #92400e;
  flex-wrap: wrap;
}
.admin-theme .admin-alert-strip a {
  color: #92400e;
  font-weight: 700;
  text-decoration: underline;
}
.admin-theme .admin-alert-strip .alert-sep {
  color: #d97706;
  margin: 0 4px;
}

/* Section titles */
.admin-theme .admin-section-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--admin-text, #0c1222);
  margin: 24px 0 12px;
}

/* Issues grid (2x2) */
.admin-theme .admin-issues-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 20px;
}
.admin-theme .admin-issue-card {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.admin-theme .issue-icon {
  font-size: 20px;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.admin-theme .issue-icon.red { background: #fef2f2; }
.admin-theme .issue-icon.amber { background: #fdf6e3; }
.admin-theme .issue-icon.blue { background: #eaeffd; }
.admin-theme .issue-icon.purple { background: #f3effe; }
.admin-theme .issue-count {
  font-size: 28px;
  font-weight: 800;
  line-height: 1;
}
.admin-theme .issue-label {
  font-size: 12px;
  color: var(--admin-text-3, #8892a4);
  font-weight: 500;
}

/* Header filters (inline in page header) */
.admin-theme .admin-header-filters {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.admin-theme .admin-header-filters input,
.admin-theme .admin-header-filters select {
  padding: 6px 10px;
  border: 1px solid var(--admin-border, #e2e6ef);
  border-radius: 8px;
  font-size: 12px;
  font-family: inherit;
}
.admin-theme .admin-header-filters label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: .4px;
  color: var(--admin-text-3, #8892a4);
  font-weight: 600;
  display: block;
  margin-bottom: 2px;
}

/* System strip (bottom) */
.admin-theme .admin-system-strip {
  display: flex;
  gap: 24px;
  padding: 12px 18px;
  background: var(--admin-surface-2, #f7f8fb);
  border: 1px solid var(--admin-border, #e2e6ef);
  border-radius: 10px;
  margin-top: 24px;
}
.admin-theme .system-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.admin-theme .system-label {
  font-size: 11px;
  color: var(--admin-text-3, #8892a4);
  font-weight: 500;
}
.admin-theme .system-val {
  font-size: 14px;
  font-weight: 700;
}
.admin-theme .system-val--alert {
  color: var(--admin-red, #dc2626);
}

/* Responsive */
@media (max-width: 900px) {
  .admin-theme .admin-issues-grid { grid-template-columns: 1fr; }
  .admin-theme .admin-grid-main { grid-template-columns: 1fr; }
}
```

---

## STEP 4: Add missing queries to the admin route

In the GET /admin route handler (admin.js), add these queries if they don't already exist:

```javascript
// Doctor no-shows today
const doctorNoShowsToday = safeGet("SELECT COUNT(*) as cnt FROM appointments WHERE status = 'no_show' AND date(scheduled_at) = date('now')", [], { cnt: 0 });

// Doctor no-shows this week  
const doctorNoShowsWeek = safeGet("SELECT COUNT(*) as cnt FROM appointments WHERE status = 'no_show' AND scheduled_at > datetime('now', '-7 days')", [], { cnt: 0 });

// Add-ons purchased count (this month)
const addOnsPurchased = safeGet("SELECT COUNT(*) as cnt FROM order_addons WHERE created_at > datetime('now', 'start of month')", [], { cnt: 0 });

// Pending refunds count (not just the list)
const pendingRefundsCount = pendingRefunds ? pendingRefunds.length : 0;
```

Pass them all to the render call:
```javascript
doctorNoShowsToday: doctorNoShowsToday ? doctorNoShowsToday.cnt : 0,
doctorNoShowsWeek: doctorNoShowsWeek ? doctorNoShowsWeek.cnt : 0,
addOnsPurchased: addOnsPurchased ? addOnsPurchased.cnt : 0,
pendingRefundsCount: pendingRefunds ? pendingRefunds.length : 0,
```

Use `tableExists()` guards for tables that may not exist (appointments, order_addons, etc.).

---

## STEP 5: Ensure `portalRole: 'admin'` triggers admin sidebar

In `portal.ejs`, find the sidebar rendering section. The order of role checks MUST be:
1. superadmin → Glass Tower sidebar
2. admin → Command Center sidebar (with admin nav links)
3. doctor → Doctor sidebar
4. patient → Patient sidebar

If there is NO `portalRole === 'admin'` check, that's why the doctor sidebar shows up — the admin falls through to the doctor/default case. ADD the admin sidebar block.

---

## VERIFICATION CHECKLIST

- [ ] Navigate to /admin as admin → Operations Dashboard renders
- [ ] Admin sidebar shows (Dashboard, Cases, Video Calls, Chat Moderation, Doctors, Reviews, Error Log, Alerts)
- [ ] NOT doctor sidebar (Case Queue, Appointments, Messages, Prescriptions)
- [ ] Case KPIs show: Total, Pending, Completed, Breached, SLA %, Avg TAT
- [ ] Patient Issues grid: Chat Reports, Refund Requests, File Re-uploads, No-Shows
- [ ] Doctor Management: Pending Approvals, Active Doctors, Doctor No-Shows
- [ ] Order Financials: Refunds, Add-ons, Pending Payouts (NO revenue/profit)
- [ ] Recent Cases table with status pills
- [ ] SLA Risk + Live Activity feed
- [ ] System strip at bottom: Errors + Notif Failed + Notif Queued
- [ ] NO full financials (revenue, gross profit, avg order value)
- [ ] NO email/WhatsApp health indicators
- [ ] Navigate to /admin as SUPERADMIN → Glass Tower sidebar still shows (portalRole dynamic)
- [ ] Doctor portal unchanged
- [ ] Patient portal unchanged

---

## COMMIT

```
feat: rewrite admin dashboard as operations-focused Command Center

- Admin sidebar added to portal.ejs (was falling through to doctor sidebar)
- Admin dashboard uses admin-page structure matching all sub-pages
- Operations-focused widgets: case KPIs, patient issues grid, doctor management
- Limited financials: refunds, add-ons, pending payouts only (no revenue)
- Minimal system strip: error count + notification failures
- Alert strip for urgent items (reports, refunds, SLA breaches)
- Recent cases table + SLA risk + live activity feed
- All styled with Command Center admin-theme CSS
```
