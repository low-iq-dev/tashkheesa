# SUPERADMIN (OWNER) DASHBOARD REDESIGN — "Glass Tower" Theme

**Execute AFTER** `ADMIN_REDESIGN_PROMPT.md` and `ADMIN_REDESIGN_ADDENDUM.md`.

This redesign applies ONLY to the superadmin/owner dashboard. The admin theme ("Command Center") applies to regular admin pages. The superadmin gets an elevated, premium "Glass Tower" look that visually distinguishes the owner experience from the admin experience.

---

## DESIGN SYSTEM: GLASS TOWER

**Fonts:** Plus Jakarta Sans (headings/body) + Space Mono (numbers/IDs/monospace)
**Google Fonts link:** Add to portal.ejs alongside existing fonts:
```
Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=Space+Mono:wght@400;700
```

**Color Palette:**
```css
--owner-bg: #f0f2f8;
--owner-surface: #fff;
--owner-surface-2: #f7f8fc;
--owner-surface-glass: rgba(255,255,255,.72);
--owner-border: #dfe3ed;
--owner-border-light: #eaecf4;
--owner-text: #0b1120;
--owner-text-2: #3e4c63;
--owner-text-3: #8591a6;
--owner-primary: #1746a2;
--owner-primary-light: #eaeffd;
--owner-primary-dark: #0f3178;
--owner-green: #0a8a5f;
--owner-green-light: #e8f8f2;
--owner-amber: #c2850c;
--owner-amber-light: #fdf6e3;
--owner-red: #b42318;
--owner-red-light: #fef3f1;
--owner-purple: #6d3fc0;
--owner-purple-light: #f3effe;
--owner-teal: #0a7d78;
--owner-teal-light: #e6f7f6;
--owner-gradient: linear-gradient(135deg, #1746a2 0%, #2563eb 50%, #3b82f6 100%);
```

**Key Visual Distinctions from Admin Theme:**
- Deep navy sidebar (not white) — `background: var(--owner-primary-dark)`
- Blue gradient hero header with health indicators embedded
- Financial KPI cards float above hero with frosted glass (`backdrop-filter: blur(16px)`)
- Space Mono for ALL numbers, IDs, and monetary values
- Double-outline feed dots (border + outline technique)
- Slightly larger border-radius (16px cards vs 14px admin)
- Subtle rise animation on load

---

## SCOPING: HOW TO APPLY ONLY TO SUPERADMIN

### Step 1: Add body class

In `portal.ejs`, update the body tag. The admin theme already adds `.admin-theme` for `isSuperadminFrame`. We need to add `.owner-theme` specifically for superadmin role (NOT regular admin):

```html
<body class="layout layout-portal<% if (isSuperadminFrame) { %> admin-theme<% } %><% if (typeof portalRole !== 'undefined' && portalRole === 'superadmin') { %> owner-theme<% } %>">
```

This means:
- Admin pages get: `admin-theme` (Command Center)
- Superadmin pages get: `admin-theme owner-theme` (Glass Tower overrides on top)
- Doctor/patient pages: neither class

### Step 2: Create owner-styles.css

Create `public/css/owner-styles.css`. This file ONLY activates when `.owner-theme` is on the body. It overrides admin-theme styles where needed.

Include it in portal.ejs AFTER admin-styles.css:
```html
<% if (typeof portalRole !== 'undefined' && portalRole === 'superadmin') { %>
  <link rel="stylesheet" href="/css/owner-styles.css" />
<% } %>
```

---

## STEP-BY-STEP IMPLEMENTATION

### Step 1: owner-styles.css — Complete CSS

Create `public/css/owner-styles.css` with the following. ALL selectors must be scoped under `.owner-theme`:

```css
/* ============================================
   GLASS TOWER — Owner/Superadmin Theme
   Scoped under .owner-theme on <body>
   ============================================ */

/* --- VARIABLES --- */
.owner-theme {
  --owner-bg: #f0f2f8;
  --owner-surface: #fff;
  --owner-surface-2: #f7f8fc;
  --owner-surface-glass: rgba(255, 255, 255, .72);
  --owner-border: #dfe3ed;
  --owner-border-light: #eaecf4;
  --owner-text: #0b1120;
  --owner-text-2: #3e4c63;
  --owner-text-3: #8591a6;
  --owner-primary: #1746a2;
  --owner-primary-light: #eaeffd;
  --owner-primary-dark: #0f3178;
  --owner-green: #0a8a5f;
  --owner-green-light: #e8f8f2;
  --owner-amber: #c2850c;
  --owner-amber-light: #fdf6e3;
  --owner-red: #b42318;
  --owner-red-light: #fef3f1;
  --owner-purple: #6d3fc0;
  --owner-purple-light: #f3effe;
  --owner-teal: #0a7d78;
  --owner-teal-light: #e6f7f6;
  font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
  background: var(--owner-bg);
}

/* --- SIDEBAR OVERRIDE: Deep Navy --- */
.owner-theme .portal-sidebar,
.owner-theme .sidebar {
  background: var(--owner-primary-dark);
  border-right-color: rgba(255,255,255,.06);
  color: #fff;
}
.owner-theme .portal-sidebar::before,
.owner-theme .sidebar::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(23,70,162,.95), rgba(15,49,120,.98));
  z-index: -1;
  pointer-events: none;
}

/* Sidebar brand area */
.owner-theme .sidebar-brand .sidebar-logo,
.owner-theme .portal-sidebar .sidebar-logo {
  background: rgba(255,255,255,.12);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,.1);
  color: #fff;
}
.owner-theme .sidebar-brand .sidebar-name {
  color: #fff;
  font-weight: 800;
}

/* Owner role chip */
.owner-theme .sidebar-role-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  background: rgba(255,255,255,.1);
  border: 1px solid rgba(255,255,255,.08);
  color: #fff;
}
.owner-theme .sidebar-role-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #3bef80;
  display: inline-block;
}

/* Sidebar section labels */
.owner-theme .sidebar-section-label,
.owner-theme .sb-section-label {
  color: rgba(255,255,255,.3);
}

/* Sidebar links */
.owner-theme .sidebar-link,
.owner-theme .portal-sidebar a,
.owner-theme .sb-link {
  color: rgba(255,255,255,.55);
  border-radius: 10px;
}
.owner-theme .sidebar-link:hover,
.owner-theme .portal-sidebar a:hover,
.owner-theme .sb-link:hover {
  background: rgba(255,255,255,.06);
  color: rgba(255,255,255,.85);
}
.owner-theme .sidebar-link.active,
.owner-theme .portal-sidebar a.active,
.owner-theme .sb-link.active {
  background: rgba(255,255,255,.1);
  color: #fff;
  font-weight: 600;
  border: 1px solid rgba(255,255,255,.08);
}
/* Remove the blue left accent bar from admin theme, replace with subtle border */
.owner-theme .sidebar-link.active::before,
.owner-theme .sb-link.active::before {
  display: none;
}

/* Sidebar badges */
.owner-theme .sidebar-link .badge,
.owner-theme .sb-badge {
  background: rgba(255,255,255,.12);
  color: #fff;
}
.owner-theme .sidebar-link .badge.alert,
.owner-theme .sb-badge.alert {
  background: rgba(239,68,68,.3);
  color: #fca5a5;
}

/* Sidebar footer/user */
.owner-theme .sidebar-footer,
.owner-theme .sb-footer {
  border-top-color: rgba(255,255,255,.06);
}
.owner-theme .sidebar-avatar,
.owner-theme .sb-avatar {
  background: rgba(255,255,255,.12);
  border: 1px solid rgba(255,255,255,.08);
  color: #fff;
}
.owner-theme .sidebar-username { color: #fff; }
.owner-theme .sidebar-email { color: rgba(255,255,255,.4); }

/* --- HERO HEADER --- */
.owner-theme .owner-hero {
  background: var(--owner-gradient, linear-gradient(135deg, #1746a2 0%, #2563eb 50%, #3b82f6 100%));
  padding: 28px 36px 24px;
  position: relative;
  overflow: hidden;
}
.owner-theme .owner-hero::after {
  content: '';
  position: absolute;
  right: -60px;
  top: -60px;
  width: 300px;
  height: 300px;
  background: radial-gradient(circle, rgba(255,255,255,.06), transparent);
  border-radius: 50%;
  pointer-events: none;
}
.owner-theme .owner-hero h1 {
  font-size: 24px;
  font-weight: 800;
  color: #fff;
  letter-spacing: -.3px;
}
.owner-theme .owner-hero .hero-sub {
  font-size: 13px;
  color: rgba(255,255,255,.6);
  margin-top: 2px;
}
.owner-theme .owner-hero .hero-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  position: relative;
  z-index: 1;
}
.owner-theme .hero-btn {
  padding: 8px 16px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all .15s;
  border: 1px solid rgba(255,255,255,.2);
  background: rgba(255,255,255,.1);
  color: #fff;
  backdrop-filter: blur(4px);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.owner-theme .hero-btn:hover { background: rgba(255,255,255,.18); }
.owner-theme .hero-btn.solid {
  background: #fff;
  color: var(--owner-primary);
  border-color: #fff;
}
.owner-theme .hero-btn.solid:hover { background: #f0f4ff; }

/* Health indicators in hero */
.owner-theme .hero-health {
  display: flex;
  gap: 16px;
  margin-top: 16px;
  position: relative;
  z-index: 1;
  flex-wrap: wrap;
}
.owner-theme .hero-health-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: rgba(255,255,255,.5);
  font-weight: 500;
}
.owner-theme .hero-health-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.owner-theme .hero-health-dot.ok {
  background: #3bef80;
  box-shadow: 0 0 6px rgba(59,239,128,.4);
}
.owner-theme .hero-health-dot.warn {
  background: #fbbf24;
  box-shadow: 0 0 6px rgba(251,191,36,.4);
}
.owner-theme .hero-health-dot.err {
  background: #f87171;
  box-shadow: 0 0 6px rgba(248,113,113,.4);
}
.owner-theme .hero-health-val {
  color: rgba(255,255,255,.8);
  font-weight: 600;
}

/* --- FINANCIAL KPI CARDS (frosted glass, float above hero) --- */
.owner-theme .owner-finance-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 14px;
  margin-top: -36px;
  margin-bottom: 24px;
  position: relative;
  z-index: 2;
}
.owner-theme .owner-fin-card {
  background: var(--owner-surface-glass);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--owner-border-light);
  border-radius: 16px;
  padding: 20px;
  box-shadow: 0 4px 24px rgba(0,0,0,.04);
  transition: all .25s;
  animation: ownerRise .35s ease both;
}
.owner-theme .owner-fin-card:nth-child(2) { animation-delay: .04s; }
.owner-theme .owner-fin-card:nth-child(3) { animation-delay: .08s; }
.owner-theme .owner-fin-card:nth-child(4) { animation-delay: .12s; }
.owner-theme .owner-fin-card:nth-child(5) { animation-delay: .16s; }
.owner-theme .owner-fin-card:nth-child(6) { animation-delay: .20s; }
.owner-theme .owner-fin-card:hover {
  box-shadow: 0 8px 32px rgba(0,0,0,.08);
  transform: translateY(-2px);
}
.owner-theme .fin-label {
  font-size: 11.5px;
  color: var(--owner-text-3);
  font-weight: 500;
  margin-bottom: 6px;
}
.owner-theme .fin-val {
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -.5px;
  line-height: 1.1;
  font-family: 'Space Mono', monospace;
}
.owner-theme .fin-sub {
  font-size: 11px;
  font-weight: 600;
  margin-top: 6px;
}
.owner-theme .fin-sub.up { color: var(--owner-green); }
.owner-theme .fin-sub.down { color: var(--owner-red); }
.owner-theme .fin-sub.flat { color: var(--owner-text-3); }

/* --- OPS KPI ROW --- */
.owner-theme .owner-ops-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 24px;
}
.owner-theme .owner-ops-card {
  background: var(--owner-surface);
  border: 1px solid var(--owner-border-light);
  border-radius: 16px;
  padding: 16px 20px;
  display: flex;
  align-items: center;
  gap: 14px;
  animation: ownerRise .35s ease both;
}
.owner-theme .ops-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 800;
  flex-shrink: 0;
}
.owner-theme .ops-icon.blue { background: var(--owner-primary-light); color: var(--owner-primary); }
.owner-theme .ops-icon.green { background: var(--owner-green-light); color: var(--owner-green); }
.owner-theme .ops-icon.amber { background: var(--owner-amber-light); color: var(--owner-amber); }
.owner-theme .ops-icon.red { background: var(--owner-red-light); color: var(--owner-red); }
.owner-theme .ops-val {
  font-size: 24px;
  font-weight: 800;
  line-height: 1;
  font-family: 'Space Mono', monospace;
}
.owner-theme .ops-label {
  font-size: 11.5px;
  color: var(--owner-text-3);
  font-weight: 500;
  margin-top: 1px;
}

/* --- CARDS --- */
.owner-theme .portal-card,
.owner-theme .card {
  background: var(--owner-surface);
  border: 1px solid var(--owner-border-light);
  border-radius: 16px;
  overflow: hidden;
  animation: ownerRise .35s ease both;
}
.owner-theme .card-header,
.owner-theme .card-h {
  padding: 15px 22px;
  border-bottom: 1px solid var(--owner-border-light);
}
.owner-theme .card-header h3,
.owner-theme .card-h h3 {
  font-size: 14px;
  font-weight: 700;
  font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
}

/* --- TABLES --- */
.owner-theme table th {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .6px;
  color: var(--owner-text-3);
  padding: 9px 18px;
  background: var(--owner-surface-2);
  font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
}
.owner-theme table td {
  padding: 11px 18px;
  font-size: 12.5px;
  border-bottom-color: var(--owner-border-light);
  color: var(--owner-text-2);
}
.owner-theme table tr:hover td { background: #fafbff; }

/* Monospace IDs */
.owner-theme .t-id,
.owner-theme .order-id {
  font-family: 'Space Mono', monospace;
  font-size: 10.5px;
  color: var(--owner-primary);
  font-weight: 500;
}

/* --- STATUS PILLS --- */
.owner-theme .status-pill,
.owner-theme .pill {
  border-radius: 6px;
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .2px;
}
.owner-theme .status-pill--new, .owner-theme .pill.new { background: var(--owner-primary-light); color: var(--owner-primary); }
.owner-theme .status-pill--accepted, .owner-theme .pill.accepted { background: var(--owner-teal-light); color: var(--owner-teal); }
.owner-theme .status-pill--in_review, .owner-theme .pill.review { background: var(--owner-amber-light); color: var(--owner-amber); }
.owner-theme .status-pill--completed, .owner-theme .pill.completed { background: var(--owner-green-light); color: var(--owner-green); }
.owner-theme .status-pill--breached, .owner-theme .pill.breached { background: var(--owner-red-light); color: var(--owner-red); }

/* --- ATTENTION CARD (red left border) --- */
.owner-theme .attn-card {
  border: 1px solid var(--owner-red-light);
  border-left: 4px solid var(--owner-red);
}

/* --- FEED / ACTIVITY --- */
.owner-theme .fi-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 2px solid var(--owner-surface);
}
.owner-theme .fi-dot.green { outline: 2px solid var(--owner-green); background: var(--owner-green); }
.owner-theme .fi-dot.amber { outline: 2px solid var(--owner-amber); background: var(--owner-amber); }
.owner-theme .fi-dot.red { outline: 2px solid var(--owner-red); background: var(--owner-red); }
.owner-theme .fi-dot.blue { outline: 2px solid var(--owner-primary); background: var(--owner-primary); }

/* --- SLA RISK --- */
.owner-theme .sla-time {
  font-family: 'Space Mono', monospace;
  font-weight: 700;
}

/* --- ANIMATION --- */
@keyframes ownerRise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

/* --- RESPONSIVE --- */
@media (max-width: 1200px) {
  .owner-theme .owner-finance-grid { grid-template-columns: repeat(3, 1fr); }
}
@media (max-width: 900px) {
  .owner-theme .owner-finance-grid { grid-template-columns: repeat(2, 1fr); }
  .owner-theme .owner-ops-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 768px) {
  .owner-theme .owner-finance-grid { grid-template-columns: 1fr; }
  .owner-theme .owner-ops-grid { grid-template-columns: 1fr; }
  .owner-theme .owner-hero { padding: 20px 16px 18px; }
  .owner-theme .hero-row { flex-direction: column; gap: 12px; align-items: flex-start; }
}
```

---

### Step 2: Rewrite superadmin.ejs

Completely rewrite `src/views/superadmin.ejs` with the Glass Tower layout. Keep ALL the existing JS logic (formatEventDate, safe defaults for KPIs, combinedEvents, etc.) but replace the HTML structure.

**IMPORTANT:** Keep the existing `<%-include('partials/header'...)%>` and `<%- include('partials/footer'...)%>` — just change the HTML between them.

**Layout structure (top to bottom):**

```
┌──────────────────────────────────────────────────────────┐
│ HERO HEADER (gradient blue)                              │
│  ┌─ Title: "Owner Dashboard"                             │
│  ├─ Subtitle: dynamic date range                         │
│  ├─ Buttons: Date range, Specialty filter, Export, +Order│
│  └─ Health strip: Email, WhatsApp, SLA, Paymob, Errors,  │
│     Uptime (inline in hero)                              │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ FINANCIAL KPIs (6 frosted glass cards, floating)         │
│ Revenue | Gross Profit | Dr Payouts | Refunds |          │
│ Video Rev | Avg Order Value                              │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ QUICK ACTIONS ROW                                        │
│ [+ Create Order] [+ Add Doctor] [Send Campaign] [Run SLA]│
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ OPS KPIs (4 cards)                                       │
│ Total Cases | Completed | Pending | Breached             │
│ + SLA Compliance % | Avg Turnaround | Payment Fail Rate  │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ PEOPLE STRIP (3 small cards inline)                      │
│ Pending Dr Approvals (X) | Total Patients (X new) |     │
│ Doctor Utilization (X busy / Y idle)                     │
└──────────────────────────────────────────────────────────┘
┌────────────────────────────────┬─────────────────────────┐
│ RECENT CASES TABLE             │ ⚡ NEEDS ATTENTION       │
│ (latest 10 orders)            │ (chat reports, refunds,  │
│ Order|Patient|Doctor|Service|  │  no-shows, approvals)   │
│ Status|Amount                  │                         │
│                                ├─────────────────────────┤
│                                │ SLA RISK                │
│                                │ (cases about to breach) │
│                                ├─────────────────────────┤
│                                │ LIVE FEED               │
│                                │ (real-time events)      │
└────────────────────────────────┴─────────────────────────┘
┌────────────────────────────────┬─────────────────────────┐
│ REVENUE BY SPECIALTY           │ NOTIFICATION STATS       │
│ (table with share bars)        │ Total|Delivered|Failed|  │
│                                │ Queued (4-column grid)   │
├────────────────────────────────┼─────────────────────────┤
│ BREACHED ORDERS                │ REFERRAL STATS           │
│ (list with timestamps)         │ Codes used | Rev from    │
│                                │ referrals this month     │
└────────────────────────────────┴─────────────────────────┘
```

---

### Step 3: Update the superadmin route to supply ALL needed data

In the route handler for `GET /superadmin` (likely in `src/routes/superadmin.js`), ensure these queries exist and are passed to the template. Add any that are missing:

```javascript
// === FINANCIAL ===
const revenue = safeGet(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'paid' ${dateFilter}`, filterParams);
const grossProfit = safeGet(`SELECT COALESCE(SUM(amount - COALESCE(doctor_fee, 0)), 0) as total FROM payments WHERE status = 'paid' ${dateFilter}`, filterParams);
const doctorPayoutsPending = safeGet(`SELECT COALESCE(SUM(earned_amount), 0) as total FROM doctor_earnings WHERE status = 'pending'`, []);
const doctorPayoutsPaid = safeGet(`SELECT COALESCE(SUM(earned_amount), 0) as total FROM doctor_earnings WHERE status = 'paid' ${dateFilter}`, filterParams);
const refundCount = safeGet(`SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'refunded' ${dateFilter}`, filterParams);
const videoRevenue = safeGet(`SELECT COALESCE(SUM(amount), 0) as total FROM appointment_payments WHERE status = 'paid' ${dateFilter}`, filterParams);
const avgOrderValue = safeGet(`SELECT COALESCE(AVG(amount), 0) as avg FROM payments WHERE status = 'paid' ${dateFilter}`, filterParams);
const paymentFailures = safeGet(`SELECT COUNT(*) as cnt FROM payments WHERE status = 'failed' ${dateFilter}`, filterParams);
const totalPayments = safeGet(`SELECT COUNT(*) as cnt FROM payments ${dateFilter ? 'WHERE ' + dateFilter.replace('AND', '') : ''}`, filterParams);

// === OPERATIONAL ===
// totalOrders, completedCount, breachedCount already exist
const slaCompliancePercent = /* already exists as onTimePercent */;
const avgTurnaround = /* already exists as avgTatMinutes */;

// === PEOPLE ===
const pendingDoctorsCount = safeGet(`SELECT COUNT(*) as cnt FROM users WHERE role = 'doctor' AND (status = 'pending' OR pending_approval = 1)`, []);
const totalPatients = safeGet(`SELECT COUNT(*) as cnt FROM users WHERE role = 'patient'`, []);
const newPatientsThisMonth = safeGet(`SELECT COUNT(*) as cnt FROM users WHERE role = 'patient' AND created_at > datetime('now', 'start of month')`, []);
const busyDoctors = safeGet(`SELECT COUNT(DISTINCT doctor_id) as cnt FROM orders WHERE status IN ('assigned', 'accepted', 'in_review') AND doctor_id IS NOT NULL`, []);
const totalActiveDoctors = safeGet(`SELECT COUNT(*) as cnt FROM users WHERE role = 'doctor' AND status = 'active'`, []);

// === SYSTEM HEALTH ===
const lastEmailSent = safeGet(`SELECT MAX(sent_at) as ts FROM notifications WHERE channel = 'email' AND status = 'sent'`, []);
const lastWhatsAppSent = safeGet(`SELECT MAX(sent_at) as ts FROM notifications WHERE channel = 'whatsapp' AND status = 'sent'`, []);
const errorsLast24h = safeGet(`SELECT COUNT(*) as cnt FROM error_log WHERE created_at > datetime('now', '-1 day')`, []);

// === NOTIFICATIONS ===
const notifTotal = safeGet(`SELECT COUNT(*) as cnt FROM notifications ${dateFilter ? 'WHERE ' + dateFilter.replace('AND', '') : ''}`, filterParams);
const notifDelivered = safeGet(`SELECT COUNT(*) as cnt FROM notifications WHERE status = 'sent' ${dateFilter}`, filterParams);
const notifFailed = safeGet(`SELECT COUNT(*) as cnt FROM notifications WHERE status = 'failed' ${dateFilter}`, filterParams);
const notifQueued = safeGet(`SELECT COUNT(*) as cnt FROM notifications WHERE status IN ('pending', 'queued') ${dateFilter}`, filterParams);

// === ATTENTION ITEMS ===
const pendingRefunds = safeAll(`SELECT ap.*, a.scheduled_at, p.name as patient_name, d.name as doctor_name
  FROM appointment_payments ap JOIN appointments a ON ap.appointment_id = a.id
  LEFT JOIN users p ON a.patient_id = p.id LEFT JOIN users d ON a.doctor_id = d.id
  WHERE ap.refund_status = 'requested' ORDER BY ap.created_at DESC LIMIT 5`, []);
const openChatReports = safeGet(`SELECT COUNT(*) as cnt FROM chat_reports WHERE status = 'open'`, []);
const doctorNoShowsToday = safeGet(`SELECT COUNT(*) as cnt FROM appointments WHERE status = 'no_show' AND date(scheduled_at) = date('now')`, []);

// === REFERRALS ===
const referralCodesUsed = safeGet(`SELECT COUNT(*) as cnt FROM referral_uses ${dateFilter ? 'WHERE ' + dateFilter.replace('AND', '') : ''}`, filterParams);
const referralRevenue = safeGet(`SELECT COALESCE(SUM(p.amount), 0) as total FROM payments p JOIN orders o ON p.order_id = o.id WHERE o.referral_code IS NOT NULL AND p.status = 'paid' ${dateFilter}`, filterParams);

// === BREACHED ORDERS ===
// breachedOrders already exists — ensure it's passed

// Pass ALL to template
res.render('superadmin', {
  // ...existing vars...
  revenue: revenue ? revenue.total : 0,
  grossProfit: grossProfit ? grossProfit.total : 0,
  doctorPayoutsPending: doctorPayoutsPending ? doctorPayoutsPending.total : 0,
  doctorPayoutsPaid: doctorPayoutsPaid ? doctorPayoutsPaid.total : 0,
  refundCount: refundCount ? refundCount.cnt : 0,
  refundTotal: refundCount ? refundCount.total : 0,
  videoRevenue: videoRevenue ? videoRevenue.total : 0,
  avgOrderValue: avgOrderValue ? Math.round(avgOrderValue.avg) : 0,
  paymentFailRate: (totalPayments && totalPayments.cnt > 0 && paymentFailures)
    ? Math.round((paymentFailures.cnt / totalPayments.cnt) * 100) : 0,
  pendingDoctorsCount: pendingDoctorsCount ? pendingDoctorsCount.cnt : 0,
  totalPatients: totalPatients ? totalPatients.cnt : 0,
  newPatientsThisMonth: newPatientsThisMonth ? newPatientsThisMonth.cnt : 0,
  busyDoctors: busyDoctors ? busyDoctors.cnt : 0,
  idleDoctors: (totalActiveDoctors ? totalActiveDoctors.cnt : 0) - (busyDoctors ? busyDoctors.cnt : 0),
  lastEmailSent: lastEmailSent ? lastEmailSent.ts : null,
  lastWhatsAppSent: lastWhatsAppSent ? lastWhatsAppSent.ts : null,
  errorsLast24h: errorsLast24h ? errorsLast24h.cnt : 0,
  notifTotal: notifTotal ? notifTotal.cnt : 0,
  notifDelivered: notifDelivered ? notifDelivered.cnt : 0,
  notifFailed: notifFailed ? notifFailed.cnt : 0,
  notifQueued: notifQueued ? notifQueued.cnt : 0,
  pendingRefunds: pendingRefunds || [],
  openChatReports: openChatReports ? openChatReports.cnt : 0,
  doctorNoShowsToday: doctorNoShowsToday ? doctorNoShowsToday.cnt : 0,
  referralCodesUsed: referralCodesUsed ? referralCodesUsed.cnt : 0,
  referralRevenue: referralRevenue ? referralRevenue.total : 0,
  // ...existing vars continue...
});
```

**IMPORTANT:** Some of these queries reference tables that may not exist yet (chat_reports, referral_uses, appointment_payments, doctor_earnings, error_log). Wrap each in a try/catch that defaults to 0/empty if the table doesn't exist:

```javascript
function safeCount(sql, params) {
  try {
    const r = db.prepare(sql).get(...(params || []));
    return r ? (r.cnt || r.total || 0) : 0;
  } catch(e) { return 0; }
}
```

---

### Step 4: Update the sidebar in portal.ejs for superadmin

The sidebar for superadmin should show the FULL navigation with grouped sections. In `portal.ejs`, find the superadmin sidebar section and update it to include role chip + grouped nav:

```html
<% if (portalRole === 'superadmin') { %>
  <!-- Brand -->
  <div class="sidebar-brand">
    <div class="sidebar-logo">T</div>
    <div>
      <div class="sidebar-name">Tashkheesa</div>
      <div class="sidebar-role-chip"><span class="sidebar-role-dot"></span> Owner</div>
    </div>
  </div>

  <!-- Nav grouped -->
  <div class="sidebar-section">
    <div class="sidebar-section-label"><%= isAr ? 'نظرة عامة' : 'Overview' %></div>
    <a href="/superadmin" class="sidebar-link <%= portalActive === 'dashboard' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'لوحة التحكم' : 'Dashboard' %>
    </a>
    <a href="/admin/orders" class="sidebar-link <%= portalActive === 'orders' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'الحالات' : 'Cases' %>
    </a>
    <a href="/admin/video-calls" class="sidebar-link <%= portalActive === 'video-calls' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'مكالمات الفيديو' : 'Video Calls' %>
    </a>
  </div>

  <div class="sidebar-section">
    <div class="sidebar-section-label"><%= isAr ? 'الأشخاص' : 'People' %></div>
    <a href="/superadmin/doctors" class="sidebar-link <%= portalActive === 'doctors' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'الأطباء' : 'Doctors' %>
    </a>
  </div>

  <div class="sidebar-section">
    <div class="sidebar-section-label"><%= isAr ? 'الأعمال' : 'Business' %></div>
    <a href="/superadmin/services" class="sidebar-link <%= portalActive === 'services' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'الخدمات' : 'Services' %>
    </a>
    <a href="/admin/pricing" class="sidebar-link <%= portalActive === 'pricing' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'التسعير' : 'Pricing' %>
    </a>
    <a href="/portal/admin/analytics" class="sidebar-link <%= portalActive === 'analytics' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'التحليلات' : 'Analytics' %>
    </a>
    <a href="/admin/reviews" class="sidebar-link <%= portalActive === 'reviews' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'التقييمات' : 'Reviews' %>
    </a>
  </div>

  <div class="sidebar-section">
    <div class="sidebar-section-label"><%= isAr ? 'العمليات' : 'Operations' %></div>
    <a href="/admin/chat-moderation" class="sidebar-link <%= portalActive === 'moderation' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'إدارة المحادثات' : 'Chat Moderation' %>
    </a>
    <a href="/portal/admin/campaigns" class="sidebar-link <%= portalActive === 'campaigns' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'الحملات' : 'Campaigns' %>
    </a>
    <a href="/portal/admin/referrals" class="sidebar-link <%= portalActive === 'referrals' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'الإحالات' : 'Referrals' %>
    </a>
    <a href="/superadmin/alerts" class="sidebar-link <%= portalActive === 'alerts' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'التنبيهات' : 'Alerts' %>
    </a>
    <a href="/superadmin/events" class="sidebar-link <%= portalActive === 'events' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'سجل التدقيق' : 'Audit Log' %>
    </a>
    <a href="/admin/errors" class="sidebar-link <%= portalActive === 'errors' ? 'active' : '' %>">
      <svg>...</svg> <%= isAr ? 'سجل الأخطاء' : 'Error Log' %>
    </a>
  </div>

  <!-- Footer: User -->
  <div class="sidebar-footer">
    <div class="sidebar-user">
      <div class="sidebar-avatar"><%= user && user.name ? user.name.charAt(0).toUpperCase() : 'Z' %></div>
      <div>
        <div class="sidebar-username"><%= user ? user.name : 'Owner' %></div>
        <div class="sidebar-email"><%= user ? user.email : '' %></div>
      </div>
    </div>
  </div>
<% } %>
```

Add SVG icons to each link (use Feather/Lucide style icons — 24x24 viewBox, stroke-width 2, no fill). Use the same icons shown in the Glass Tower render:
- Dashboard: grid (4 squares)
- Cases: clipboard
- Video Calls: video camera
- Doctors: users
- Services: clock
- Pricing: dollar sign
- Analytics: activity pulse
- Reviews: star
- Chat Moderation: message square
- Campaigns: mail
- Referrals: user-plus
- Alerts: bell
- Audit Log: file-text
- Error Log: alert-circle

---

### Step 5: Ensure all superadmin pages inherit the owner-theme

All pages rendered with `portalRole: 'superadmin'` will automatically get the `.owner-theme` class. The owner-styles.css overrides the sidebar, cards, tables, and pills to match Glass Tower.

Check these pages all pass `portalRole: 'superadmin'`:
- `superadmin.ejs` (dashboard)
- `superadmin_order_detail.ejs`
- `superadmin_order_new.ejs`
- `superadmin_order_payment.ejs`
- `superadmin_doctors.ejs`
- `superadmin_doctor_detail.ejs`
- `superadmin_doctor_form.ejs`
- `superadmin_services.ejs`
- `superadmin_service_form.ejs`
- `superadmin_events.ejs`
- `superadmin_alerts.ejs`
- `superadmin_profile.ejs`

Pages that use `portalRole: 'admin'` (like admin_orders, admin_analytics, admin_chat_moderation, admin_video_calls etc.) will get the Command Center theme instead — this is correct. As the superadmin/owner, when you navigate to those pages, they should ALSO show the owner-theme sidebar. To handle this:

In the route handlers for admin pages, check if the user is superadmin and set portalRole accordingly:
```javascript
portalRole: req.user.role === 'superadmin' ? 'superadmin' : 'admin'
```

This way the superadmin always sees the Glass Tower sidebar even on admin sub-pages.

---

### Step 6: Remove old top-tabs nav from superadmin.ejs

The current superadmin.ejs has a `<nav class="portal-top-tabs">` with Dashboard / Doctors / Services / Audit Log / Alerts links. REMOVE this entirely — those links now live in the sidebar. The hero header replaces the top area.

---

### Step 7: Add Plus Jakarta Sans + Space Mono to portal.ejs fonts

In portal.ejs, find the Google Fonts `<link>` tag. Add the new fonts:
```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet"/>
```

---

## VERIFICATION CHECKLIST

After implementation:
- [ ] Restart server
- [ ] Login as superadmin → Dashboard renders with Glass Tower theme
- [ ] Deep navy sidebar with "Owner" chip and green dot visible
- [ ] Blue gradient hero header with health indicators
- [ ] 6 frosted glass financial KPI cards floating above hero
- [ ] Quick action buttons row works (links correct)
- [ ] 4 operational KPI cards showing real data
- [ ] People strip showing pending doctors, total patients, utilization
- [ ] Recent cases table with Space Mono IDs and status pills
- [ ] "Needs Attention" card with red left border
- [ ] SLA Risk items with progress bars
- [ ] Live activity feed
- [ ] Revenue by specialty table
- [ ] Notification stats grid (4 columns)
- [ ] Breached orders list
- [ ] Referral stats card
- [ ] Date range filter works (from/to + specialty)
- [ ] CSV export works with filters
- [ ] Navigate to /superadmin/doctors → still has Glass Tower sidebar
- [ ] Navigate to /admin/orders as superadmin → still has Glass Tower sidebar
- [ ] Login as doctor → NO owner theme (unchanged)
- [ ] Login as patient → NO owner theme (unchanged)
- [ ] Test responsive at 768px → cards stack, hero collapses

---

## COMMIT

```
feat: superadmin Glass Tower dashboard redesign

- Premium owner-exclusive theme with deep navy sidebar, gradient hero header
- Frosted glass financial KPIs (revenue, profit, payouts, refunds, video rev, avg order)
- Operational KPIs (cases, SLA compliance, turnaround, payment fail rate)
- People metrics (pending approvals, patient count, doctor utilization)
- System health strip (email, WhatsApp, SLA worker, Paymob, errors, uptime)
- Needs Attention card, SLA Risk, Live Feed, Breached Orders
- Revenue by specialty, notification stats, referral stats
- Quick action buttons, date range + specialty filtering
- All superadmin pages inherit Glass Tower sidebar via portalRole check
- Responsive breakpoints for tablet/mobile
- Does NOT affect admin, doctor, or patient portal themes
```
