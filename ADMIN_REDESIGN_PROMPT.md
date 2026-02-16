# ADMIN DASHBOARD REDESIGN — Option A "Command Center" Theme

**Project root:** tashkheesa-portal

This prompt reskins ALL admin/superadmin portal pages to match the Option A design:
- Clean white background (#f8f9fb)
- DM Sans + JetBrains Mono fonts
- Refined sidebar with sections, icons, badges
- Consistent card, table, pill, and KPI styling across every admin view

The approach is to replace `admin-styles.css` with a comprehensive new stylesheet and update the portal layout for admin views, WITHOUT breaking doctor or patient portal pages.

---

## STEP 1: Add DM Sans + JetBrains Mono Fonts

In `src/views/layouts/portal.ejs`, find the existing Google Fonts link:
```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
```

Replace with (keep Inter for non-admin pages, add DM Sans + JetBrains Mono):
```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
```

---

## STEP 2: Replace admin-styles.css

Replace the ENTIRE contents of `public/css/admin-styles.css` with the CSS below. This is a comprehensive stylesheet that covers:
- Admin body/layout overrides
- Redesigned sidebar for admin (sections, icons, active states)
- Top bar with breadcrumbs and filters
- KPI cards (primary + secondary rows)
- Card component (header, body, actions)
- Tables (all admin tables)
- Status pills
- Activity/event feed
- SLA risk items
- Notification stats
- Form elements (inputs, selects, buttons)
- Responsive breakpoints

```css
/* ================================================================
   ADMIN THEME — "Command Center" Design System
   Applied ONLY when body has .admin-theme class
   ================================================================ */

/* ── Base Overrides ─────────────────────────────────────── */
.admin-theme {
  --admin-bg: #f8f9fb;
  --admin-surface: #fff;
  --admin-surface-2: #f1f4f9;
  --admin-border: #e5e9f0;
  --admin-border-light: #f0f3f8;
  --admin-text: #0f172a;
  --admin-text-2: #475569;
  --admin-text-3: #94a3b8;
  --admin-blue: #2563eb;
  --admin-blue-light: #eff6ff;
  --admin-blue-dark: #1e40af;
  --admin-green: #059669;
  --admin-green-light: #ecfdf5;
  --admin-amber: #d97706;
  --admin-amber-light: #fffbeb;
  --admin-red: #dc2626;
  --admin-red-light: #fef2f2;
  --admin-purple: #7c3aed;
  --admin-purple-light: #f5f3ff;
  --admin-teal: #0d9488;
  --admin-teal-light: #f0fdfa;
  --admin-radius: 12px;
  --admin-radius-sm: 8px;
  --admin-shadow: 0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.04);
  --admin-shadow-lg: 0 4px 16px rgba(0,0,0,.08);
  font-family: 'DM Sans', 'Inter', system-ui, -apple-system, sans-serif;
}

.admin-theme .portal-content {
  background: var(--admin-bg);
}

.admin-theme .mono,
.admin-theme .cell-id,
.admin-theme .td-id {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
}

/* ── Portal Sidebar Overrides (Admin) ───────────────────── */
.admin-theme .portal-sidebar {
  background: var(--admin-surface);
  border-right: 1px solid var(--admin-border);
  padding: 0;
}

.admin-theme .portal-sidebar .portal-nav {
  list-style: none;
  padding: 16px 12px;
  margin: 0;
}

.admin-theme .portal-sidebar .portal-nav li {
  margin-bottom: 2px;
}

.admin-theme .portal-sidebar .portal-nav a {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--admin-radius-sm);
  color: var(--admin-text-2);
  font-size: 13.5px;
  font-weight: 500;
  text-decoration: none;
  transition: all 0.15s ease;
  position: relative;
}

.admin-theme .portal-sidebar .portal-nav a:hover {
  background: var(--admin-surface-2);
  color: var(--admin-text);
}

.admin-theme .portal-sidebar .portal-nav a.active {
  background: var(--admin-blue-light);
  color: var(--admin-blue);
  font-weight: 600;
}

.admin-theme .portal-sidebar .portal-nav a.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  background: var(--admin-blue);
  border-radius: 0 3px 3px 0;
}

/* ── Portal Header Override ─────────────────────────────── */
.admin-theme .portal-header {
  background: var(--admin-surface);
  border-bottom: 1px solid var(--admin-border);
  backdrop-filter: blur(10px);
}

.admin-theme .portal-logo {
  font-family: 'DM Sans', system-ui, sans-serif;
  font-weight: 700;
  font-size: 15px;
  color: var(--admin-text);
}

.admin-theme .portal-logo span {
  font-size: 11px;
  color: var(--admin-text-3);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* ── Page Structure ─────────────────────────────────────── */
.admin-theme .page-shell {
  padding: 0;
}

.admin-theme .page-inner {
  max-width: 100%;
}

.admin-theme .page-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.admin-theme .page-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--admin-text);
  letter-spacing: -0.3px;
  margin: 0;
}

.admin-theme .page-subtitle {
  font-size: 13px;
  color: var(--admin-text-3);
  margin: 2px 0 0;
}

/* ── KPI Cards ──────────────────────────────────────────── */
.admin-theme .admin-kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}

.admin-theme .kpi-card {
  background: var(--admin-surface);
  border: 1px solid var(--admin-border);
  border-left: none;
  border-radius: var(--admin-radius);
  padding: 20px 22px;
  transition: all 0.2s ease;
  position: relative;
  overflow: hidden;
  box-shadow: none;
}

.admin-theme .kpi-card:hover {
  box-shadow: var(--admin-shadow-lg);
  transform: translateY(-1px);
}

.admin-theme .kpi-card .kpi-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 12px;
  font-size: 18px;
}

.admin-theme .kpi-card .kpi-icon.blue { background: var(--admin-blue-light); color: var(--admin-blue); }
.admin-theme .kpi-card .kpi-icon.green { background: var(--admin-green-light); color: var(--admin-green); }
.admin-theme .kpi-card .kpi-icon.amber { background: var(--admin-amber-light); color: var(--admin-amber); }
.admin-theme .kpi-card .kpi-icon.red { background: var(--admin-red-light); color: var(--admin-red); }
.admin-theme .kpi-card .kpi-icon.purple { background: var(--admin-purple-light); color: var(--admin-purple); }
.admin-theme .kpi-card .kpi-icon.teal { background: var(--admin-teal-light); color: var(--admin-teal); }

/* Remove old left-border accent */
.admin-theme .kpi-card,
.admin-theme .kpi-card.kpi-success,
.admin-theme .kpi-card.kpi-warning,
.admin-theme .kpi-card.kpi-danger,
.admin-theme .kpi-card.kpi-teal,
.admin-theme .kpi-card.kpi-purple {
  border-left: 1px solid var(--admin-border);
}

.admin-theme .kpi-label {
  font-size: 12.5px;
  color: var(--admin-text-3);
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  margin: 0 0 2px;
}

.admin-theme .kpi-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--admin-text);
  letter-spacing: -0.5px;
  line-height: 1.2;
  margin: 0 0 6px;
}

.admin-theme .kpi-change {
  font-size: 11.5px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 20px;
  margin: 0;
}

.admin-theme .kpi-change.up { background: var(--admin-green-light); color: var(--admin-green); }
.admin-theme .kpi-change.down { background: var(--admin-red-light); color: var(--admin-red); }
.admin-theme .kpi-change.flat { color: var(--admin-text-3); background: none; padding: 0; }

/* ── Cards ──────────────────────────────────────────────── */
.admin-theme .card {
  background: var(--admin-surface);
  border: 1px solid var(--admin-border);
  border-radius: var(--admin-radius);
  overflow: hidden;
  box-shadow: none;
}

.admin-theme .card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--admin-border);
}

.admin-theme .card-header .card-title,
.admin-theme .card-header h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--admin-text);
  margin: 0;
}

/* ── Tables ─────────────────────────────────────────────── */
.admin-theme table {
  width: 100%;
  border-collapse: collapse;
}

.admin-theme table thead th {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--admin-text-3);
  padding: 10px 16px;
  text-align: left;
  background: var(--admin-surface-2);
  border-bottom: 1px solid var(--admin-border);
  white-space: nowrap;
}

.admin-theme table tbody td {
  padding: 12px 16px;
  font-size: 13px;
  border-bottom: 1px solid var(--admin-border);
  color: var(--admin-text-2);
  vertical-align: middle;
}

.admin-theme table tbody tr:last-child td {
  border-bottom: none;
}

.admin-theme table tbody tr:hover td {
  background: #f8fafc;
}

.admin-theme .cell-bold,
.admin-theme .cell-id a {
  font-weight: 600;
  color: var(--admin-text);
}

.admin-theme .cell-id a,
.admin-theme td a small {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11.5px;
  color: var(--admin-blue);
  font-weight: 500;
  text-decoration: none;
}

.admin-theme .cell-muted {
  color: var(--admin-text-3);
  font-size: 12px;
}

/* ── Status Pills ───────────────────────────────────────── */
.admin-theme .status-pill,
.admin-theme .pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}

.admin-theme .status-pill::before,
.admin-theme .pill::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* New / Pending */
.admin-theme .status-pill--new,
.admin-theme .pill-new {
  background: var(--admin-blue-light);
  color: var(--admin-blue);
}
.admin-theme .status-pill--new::before,
.admin-theme .pill-new::before { background: var(--admin-blue); }

/* Accepted */
.admin-theme .status-pill--accepted {
  background: var(--admin-green-light);
  color: var(--admin-green);
}
.admin-theme .status-pill--accepted::before { background: var(--admin-green); }

/* In Review */
.admin-theme .status-pill--in_review,
.admin-theme .status-pill--review,
.admin-theme .status-pill--assigned {
  background: var(--admin-amber-light);
  color: var(--admin-amber);
}
.admin-theme .status-pill--in_review::before,
.admin-theme .status-pill--review::before,
.admin-theme .status-pill--assigned::before { background: var(--admin-amber); }

/* Completed */
.admin-theme .status-pill--completed {
  background: var(--admin-green-light);
  color: var(--admin-green);
}
.admin-theme .status-pill--completed::before { background: var(--admin-green); }

/* Breached */
.admin-theme .status-pill--breached {
  background: var(--admin-red-light);
  color: var(--admin-red);
}
.admin-theme .status-pill--breached::before { background: var(--admin-red); }

/* Cancelled */
.admin-theme .status-pill--cancelled,
.admin-theme .status-pill--rejected {
  background: #f1f5f9;
  color: var(--admin-text-3);
}
.admin-theme .status-pill--cancelled::before,
.admin-theme .status-pill--rejected::before { background: var(--admin-text-3); }

/* ── Tag pill (SLA, Reassignment) ───────────────────────── */
.admin-theme .tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  background: var(--admin-surface-2);
  color: var(--admin-text-3);
}

/* ── Activity / Events Feed ─────────────────────────────── */
.admin-theme .events-list {
  list-style: none;
  padding: 4px 0;
  margin: 0;
}

.admin-theme .event-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--admin-border);
  transition: background 0.1s;
}

.admin-theme .event-item:last-child {
  border-bottom: none;
}

.admin-theme .event-item:hover {
  background: var(--admin-surface-2);
}

.admin-theme .event-label {
  font-size: 13px;
  color: var(--admin-text);
  font-weight: 500;
}

.admin-theme .event-meta {
  font-size: 11px;
  color: var(--admin-text-3);
}

.admin-theme .event-meta a {
  color: var(--admin-blue);
  text-decoration: none;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
}

/* ── Filters Bar ────────────────────────────────────────── */
.admin-theme .filters {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  background: var(--admin-surface);
  padding: 16px 20px;
  border-radius: var(--admin-radius);
  border: 1px solid var(--admin-border);
  margin-bottom: 24px;
}

.admin-theme .filter-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.admin-theme .filter-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--admin-text-3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.admin-theme .filter-input,
.admin-theme .filter-select {
  border: 1px solid var(--admin-border);
  background: var(--admin-surface);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  font-family: 'DM Sans', system-ui, sans-serif;
  color: var(--admin-text);
  transition: border-color 0.15s;
}

.admin-theme .filter-input:focus,
.admin-theme .filter-select:focus {
  outline: none;
  border-color: var(--admin-blue);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

/* ── Buttons ────────────────────────────────────────────── */
.admin-theme .btn {
  font-family: 'DM Sans', system-ui, sans-serif;
  border-radius: var(--admin-radius-sm);
  font-weight: 600;
  transition: all 0.15s;
}

.admin-theme .btn-primary {
  background: var(--admin-blue);
  color: #fff;
  border: 1px solid var(--admin-blue);
}

.admin-theme .btn-primary:hover {
  background: var(--admin-blue-dark);
  border-color: var(--admin-blue-dark);
}

.admin-theme .btn-outline {
  background: var(--admin-surface);
  color: var(--admin-text-2);
  border: 1px solid var(--admin-border);
}

.admin-theme .btn-outline:hover {
  border-color: var(--admin-blue);
  color: var(--admin-blue);
}

.admin-theme .btn-small,
.admin-theme .btn-sm {
  padding: 5px 12px;
  font-size: 12px;
}

/* ── Grid Layouts ───────────────────────────────────────── */
.admin-theme .grid.two-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.admin-theme .admin-table-wrap {
  background: var(--admin-surface);
  border: 1px solid var(--admin-border);
  border-radius: var(--admin-radius);
  overflow: hidden;
  margin-bottom: 20px;
}

.admin-theme .admin-table-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--admin-border);
}

.admin-theme .admin-table-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--admin-text);
  margin: 0;
}

/* ── Empty state ────────────────────────────────────────── */
.admin-theme .empty,
.admin-theme .muted {
  color: var(--admin-text-3);
  font-size: 13px;
  padding: 16px 20px;
}

/* ── Responsive ─────────────────────────────────────────── */
@media (max-width: 1200px) {
  .admin-theme .admin-kpi-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .admin-theme .grid.two-cols {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .admin-theme .admin-kpi-grid {
    grid-template-columns: 1fr;
  }
  .admin-theme .filters {
    flex-direction: column;
    align-items: stretch;
  }
}

/* ── Animations ─────────────────────────────────────────── */
@keyframes adminFadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

.admin-theme .kpi-card,
.admin-theme .card,
.admin-theme .admin-table-wrap {
  animation: adminFadeUp 0.35s ease both;
}

.admin-theme .kpi-card:nth-child(2) { animation-delay: 0.05s; }
.admin-theme .kpi-card:nth-child(3) { animation-delay: 0.1s; }
.admin-theme .kpi-card:nth-child(4) { animation-delay: 0.15s; }
```

---

## STEP 3: Add `admin-theme` class to all admin page bodies

The new CSS is scoped under `.admin-theme` so it won't affect doctor or patient portal pages. We need to add this class to the `<body>` tag for admin pages only.

In `src/views/layouts/portal.ejs`, find:
```html
<body class="layout layout-portal">
```

Replace with:
```html
<body class="layout layout-portal<% if (isSuperadminFrame) { %> admin-theme<% } %>">
```

This ensures ONLY superadmin/admin pages get the new theme. Doctor portal pages remain unchanged.

---

## STEP 4: Verify all admin views are consistent

After applying the CSS, go through each admin view and verify it renders correctly. The views that need to work with the new theme are:

**Main dashboard:**
- `admin.ejs` — KPI grid, filters, events, tables, SLA risk, notifications
- `superadmin.ejs` — Similar to admin.ejs (if different)

**Orders:**
- `admin_orders.ejs` — Orders list table
- `admin_order_detail.ejs` — Single order detail
- `superadmin_order_detail.ejs` — Superadmin order detail
- `superadmin_order_new.ejs` — Create new order
- `superadmin_order_payment.ejs` — Order payment

**Doctors:**
- `admin_doctors.ejs` — Doctors list
- `admin_doctor_form.ejs` — Edit doctor
- `superadmin_doctors.ejs` — Superadmin doctors list
- `superadmin_doctor_detail.ejs` — Doctor detail
- `superadmin_doctor_form.ejs` — Doctor form

**Services & Pricing:**
- `admin_services.ejs` — Services list
- `admin_service_form.ejs` — Edit service
- `admin_pricing.ejs` — Pricing management
- `superadmin_services.ejs` — Superadmin services
- `superadmin_service_form.ejs` — Service form

**Other admin pages:**
- `admin_analytics.ejs` — Analytics dashboard
- `admin_campaigns.ejs` — Campaign list
- `admin_campaign_new.ejs` — New campaign
- `admin_campaign_detail.ejs` — Campaign detail
- `admin_reviews.ejs` — Reviews
- `admin_referrals.ejs` — Referrals
- `admin_errors.ejs` — Error log
- `admin_alerts.ejs` — Alerts
- `superadmin_alerts.ejs` — Superadmin alerts
- `superadmin_events.ejs` — Audit log
- `superadmin_profile.ejs` — Admin profile

For each of these, check if any have inline styles that conflict with the new theme and fix them. Specifically:
- Any `style="background:#fff"` on cards should be removed (the theme handles it)
- Any hardcoded `border-left: 4px solid` on KPI cards should be removed
- Any `font-family: Inter` declarations should be removed (DM Sans will cascade)
- Make sure all tables use `<thead>` with `<th>` for headers (not `<td>` in `<thead>`)

---

## STEP 5: Clean up the admin.ejs dashboard specifically

In `admin.ejs`, the secondary KPI row has an inline style:
```html
<div class="admin-kpi-grid" style="grid-template-columns: repeat(4, 1fr);">
```

Remove the inline `style` attribute since the CSS already defines `repeat(4, 1fr)`.

Also remove any inline `style="color:#10b981;"` on `.kpi-value` elements — the new theme handles coloring through the card variants.

---

## STEP 6: Update the notification stats row in admin.ejs

The current notification KPI row uses the same `admin-kpi-grid` class. Add a dedicated class for the notification mini-stats to get the compact inline layout from Option A:

In `admin.ejs`, find the notification stats section and wrap it with:
```html
<div class="card" style="margin-bottom:20px;">
  <div class="card-header">
    <div class="card-title">Notifications</div>
  </div>
  <div class="notif-mini-grid">
    <!-- existing 4 notification KPI cards content but as inline divs -->
  </div>
</div>
```

Add to `admin-styles.css`:
```css
.admin-theme .notif-mini-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-bottom: 1px solid var(--admin-border);
}

.admin-theme .notif-mini {
  padding: 14px 16px;
  text-align: center;
  border-right: 1px solid var(--admin-border);
}

.admin-theme .notif-mini:last-child {
  border-right: none;
}

.admin-theme .notif-mini .nm-val {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 2px;
}

.admin-theme .notif-mini .nm-label {
  font-size: 10.5px;
  color: var(--admin-text-3);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
```

---

## VERIFICATION

After all changes:
1. Restart server
2. Login as superadmin → Dashboard should render with new theme
3. Navigate through ALL admin sidebar links — each page should use white cards, clean tables, no old blue-border KPI style
4. Check doctor portal → Should be UNCHANGED (no admin-theme class on body)
5. Check patient portal → Should be UNCHANGED
6. Check mobile responsive (resize to 768px) — KPI grid should stack

---

## COMMIT

```
feat: redesign admin dashboard with Command Center theme (Option A)

- Replace admin-styles.css with comprehensive design system
- Add DM Sans + JetBrains Mono fonts
- Scope new theme under .admin-theme class (admin only)
- New KPI cards, tables, pills, feed, filters, and card components
- All admin/superadmin views inherit new theme automatically
- Doctor and patient portal pages remain unchanged
```
