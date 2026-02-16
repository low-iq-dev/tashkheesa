# ADMIN & SUPERADMIN SUB-PAGE THEME CONSISTENCY

**Execute AFTER** all 3 redesign prompts (ADMIN_REDESIGN_PROMPT.md, ADMIN_REDESIGN_ADDENDUM.md, SUPERADMIN_REDESIGN_PROMPT.md).

This prompt ensures EVERY admin and superadmin sub-page matches its respective theme. The dashboards look great but if you click into "Orders" or "Doctor Detail" and it looks completely different, the whole thing falls apart.

---

## THE PROBLEM

Right now, sub-pages have inconsistent structures:
- Some use `<div class="page-shell"><div class="page-inner">` 
- Some use `<div class="portal-page portal-superadmin-*">`
- Some still have the old `<nav class="portal-top-tabs">` horizontal nav (Dashboard | Doctors | Services | Audit Log | Alerts)
- Forms use random inline styles
- Tables use different class names across pages
- Status pills are inconsistent
- No shared page header pattern

## THE FIX

All admin/superadmin pages must use a UNIFIED page structure that the theme CSS targets. The sidebar handles navigation — the old top-tabs nav must be removed from every page.

---

## PART 1: SHARED PAGE STRUCTURE

Every admin/superadmin sub-page must follow this HTML skeleton:

```html
<%- include('partials/header', { 
  title: "Page Title", 
  layout: "portal", 
  showNav: false, 
  showFooter: false, 
  portalFrame: true, 
  portalRole: 'superadmin',  /* or the dynamic version */
  portalActive: 'active-nav-item' 
}) %>

<div class="admin-page">
  <!-- PAGE HEADER -->
  <div class="admin-page-header">
    <div class="admin-page-header-left">
      <nav class="admin-breadcrumb">
        <a href="/superadmin">Dashboard</a>
        <span class="admin-breadcrumb-sep">›</span>
        <a href="/admin/orders">Cases</a>
        <span class="admin-breadcrumb-sep">›</span>
        <span>Order #a3f8c2</span>
      </nav>
      <h1 class="admin-page-title">Page Title</h1>
      <p class="admin-page-subtitle">Optional description</p>
    </div>
    <div class="admin-page-header-right">
      <!-- Action buttons -->
      <a class="admin-btn admin-btn-outline" href="#">Export</a>
      <a class="admin-btn admin-btn-primary" href="#">+ Create New</a>
    </div>
  </div>

  <!-- OPTIONAL: FILTER BAR -->
  <form class="admin-filters" method="get">
    <!-- filter inputs -->
  </form>

  <!-- OPTIONAL: KPI CARDS (for list pages) -->
  <div class="admin-kpi-row">
    <div class="admin-kpi">...</div>
  </div>

  <!-- PAGE CONTENT -->
  <div class="admin-content">
    <!-- Cards, tables, forms, etc. -->
  </div>
</div>

<%- include('partials/footer', { showFooter: false, portalFrame: true }) %>
```

---

## PART 2: CSS CLASSES TO ADD TO admin-styles.css AND owner-styles.css

### Add to admin-styles.css (scoped under .admin-theme):

```css
/* === PAGE STRUCTURE === */
.admin-theme .admin-page {
  padding: 24px 32px 48px;
}

/* Breadcrumb */
.admin-theme .admin-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin-bottom: 6px;
}
.admin-theme .admin-breadcrumb a {
  color: var(--admin-text-3, #8892a4);
  text-decoration: none;
  font-weight: 500;
}
.admin-theme .admin-breadcrumb a:hover {
  color: var(--admin-blue, #2563eb);
}
.admin-theme .admin-breadcrumb-sep {
  color: var(--admin-text-3, #8892a4);
  font-size: 11px;
}
.admin-theme .admin-breadcrumb span:last-child {
  color: var(--admin-text, #0c1222);
  font-weight: 600;
}

/* Page header */
.admin-theme .admin-page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 24px;
}
.admin-theme .admin-page-title {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -.3px;
  margin: 0;
  line-height: 1.2;
}
.admin-theme .admin-page-subtitle {
  font-size: 13px;
  color: var(--admin-text-3, #8892a4);
  margin: 4px 0 0;
}
.admin-theme .admin-page-header-right {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* Buttons */
.admin-theme .admin-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all .15s;
  text-decoration: none;
  border: 1px solid transparent;
}
.admin-theme .admin-btn-primary {
  background: var(--admin-blue, #2563eb);
  color: #fff;
  border-color: var(--admin-blue, #2563eb);
}
.admin-theme .admin-btn-primary:hover {
  background: var(--admin-blue-dark, #1d4ed8);
}
.admin-theme .admin-btn-outline {
  background: var(--admin-surface, #fff);
  color: var(--admin-text-2, #3d4a5c);
  border-color: var(--admin-border, #e2e6ef);
}
.admin-theme .admin-btn-outline:hover {
  border-color: var(--admin-blue, #2563eb);
  color: var(--admin-blue, #2563eb);
}
.admin-theme .admin-btn-sm {
  padding: 5px 10px;
  font-size: 11.5px;
}
.admin-theme .admin-btn-danger {
  background: var(--admin-red-light, #fef2f2);
  color: var(--admin-red, #dc2626);
  border-color: var(--admin-red-light, #fef2f2);
}
.admin-theme .admin-btn-danger:hover {
  background: var(--admin-red, #dc2626);
  color: #fff;
}

/* Filter bar */
.admin-theme .admin-filters {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 14px 18px;
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #e2e6ef);
  border-radius: 14px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.admin-theme .admin-filter-group label {
  display: block;
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .5px;
  color: var(--admin-text-3, #8892a4);
  margin-bottom: 4px;
}
.admin-theme .admin-filter-group input,
.admin-theme .admin-filter-group select {
  padding: 7px 12px;
  border: 1px solid var(--admin-border, #e2e6ef);
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  background: var(--admin-surface, #fff);
  color: var(--admin-text, #0c1222);
}
.admin-theme .admin-filter-group input:focus,
.admin-theme .admin-filter-group select:focus {
  outline: none;
  border-color: var(--admin-blue, #2563eb);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, .1);
}

/* KPI row (for list pages) */
.admin-theme .admin-kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}
.admin-theme .admin-kpi {
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #e2e6ef);
  border-radius: 14px;
  padding: 16px 18px;
}
.admin-theme .admin-kpi-label {
  font-size: 11px;
  color: var(--admin-text-3, #8892a4);
  font-weight: 500;
}
.admin-theme .admin-kpi-value {
  font-size: 24px;
  font-weight: 800;
  margin-top: 2px;
}

/* Card for content sections */
.admin-theme .admin-card {
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #e2e6ef);
  border-radius: 14px;
  overflow: hidden;
  margin-bottom: 18px;
}
.admin-theme .admin-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--admin-border, #e2e6ef);
}
.admin-theme .admin-card-header h3 {
  font-size: 14px;
  font-weight: 700;
  margin: 0;
}
.admin-theme .admin-card-body {
  padding: 20px;
}

/* Form fields */
.admin-theme .admin-form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.admin-theme .admin-form-grid.full {
  grid-template-columns: 1fr;
}
.admin-theme .admin-form-group {
  display: flex;
  flex-direction: column;
}
.admin-theme .admin-form-group label {
  font-size: 12px;
  font-weight: 600;
  color: var(--admin-text-2, #3d4a5c);
  margin-bottom: 4px;
}
.admin-theme .admin-form-group input,
.admin-theme .admin-form-group select,
.admin-theme .admin-form-group textarea {
  padding: 9px 12px;
  border: 1px solid var(--admin-border, #e2e6ef);
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  background: var(--admin-surface, #fff);
  transition: border-color .15s;
}
.admin-theme .admin-form-group input:focus,
.admin-theme .admin-form-group select:focus,
.admin-theme .admin-form-group textarea:focus {
  outline: none;
  border-color: var(--admin-blue, #2563eb);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, .1);
}
.admin-theme .admin-form-group textarea {
  min-height: 100px;
  resize: vertical;
}

/* Detail page: key-value pairs */
.admin-theme .admin-detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
}
.admin-theme .admin-detail-item {
  padding: 12px 20px;
  border-bottom: 1px solid var(--admin-border-light, #eef0f5);
}
.admin-theme .admin-detail-item:nth-child(odd) {
  border-right: 1px solid var(--admin-border-light, #eef0f5);
}
.admin-theme .admin-detail-label {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .5px;
  color: var(--admin-text-3, #8892a4);
}
.admin-theme .admin-detail-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--admin-text, #0c1222);
  margin-top: 2px;
}

/* Grid layouts */
.admin-theme .admin-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  margin-bottom: 18px;
}
.admin-theme .admin-grid-main {
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 18px;
  margin-bottom: 18px;
}

/* Empty state */
.admin-theme .admin-empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--admin-text-3, #8892a4);
}
.admin-theme .admin-empty-icon {
  font-size: 32px;
  margin-bottom: 8px;
}
.admin-theme .admin-empty-text {
  font-size: 14px;
  font-weight: 500;
}
```

### Add to owner-styles.css (overrides for .owner-theme):

```css
/* === OWNER PAGE OVERRIDES === */
.owner-theme .admin-page {
  padding: 24px 36px 48px;
}
.owner-theme .admin-page-title {
  font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
}
.owner-theme .admin-breadcrumb a:hover {
  color: var(--owner-primary);
}
.owner-theme .admin-btn-primary {
  background: var(--owner-primary);
  border-color: var(--owner-primary);
}
.owner-theme .admin-btn-primary:hover {
  background: var(--owner-primary-dark);
}
.owner-theme .admin-btn-outline:hover {
  border-color: var(--owner-primary);
  color: var(--owner-primary);
}
.owner-theme .admin-card {
  border-radius: 16px;
  border-color: var(--owner-border-light);
}
.owner-theme .admin-kpi {
  border-radius: 16px;
  border-color: var(--owner-border-light);
}
.owner-theme .admin-filters {
  border-radius: 16px;
  border-color: var(--owner-border-light);
}
.owner-theme .admin-form-group input:focus,
.owner-theme .admin-form-group select:focus,
.owner-theme .admin-form-group textarea:focus {
  border-color: var(--owner-primary);
  box-shadow: 0 0 0 3px rgba(23, 70, 162, .1);
}
.owner-theme .admin-filter-group input:focus,
.owner-theme .admin-filter-group select:focus {
  border-color: var(--owner-primary);
  box-shadow: 0 0 0 3px rgba(23, 70, 162, .1);
}
.owner-theme .t-id,
.owner-theme .order-id,
.owner-theme .admin-detail-value.mono {
  font-family: 'Space Mono', monospace;
  color: var(--owner-primary);
}

/* Owner status pills */
.owner-theme .status-pill--new { background: var(--owner-primary-light); color: var(--owner-primary); }
.owner-theme .status-pill--accepted { background: var(--owner-teal-light); color: var(--owner-teal); }
.owner-theme .status-pill--in_review { background: var(--owner-amber-light); color: var(--owner-amber); }
.owner-theme .status-pill--completed { background: var(--owner-green-light); color: var(--owner-green); }
.owner-theme .status-pill--breached { background: var(--owner-red-light); color: var(--owner-red); }
```

---

## PART 3: PAGE-BY-PAGE CONVERSION

For EACH page below, do the following:
1. Remove `<nav class="portal-top-tabs">` if present (sidebar replaces it)
2. Remove `<div class="portal-page-kicker">` if present (breadcrumb replaces it)
3. Replace the outer wrapper with the `admin-page` structure from Part 1
4. Add breadcrumb navigation showing the path
5. Convert all tables to use unified table styling (thead with uppercase headers)
6. Convert all status pills to use `.status-pill--{status}` class names
7. Convert all form inputs to use `.admin-form-group` wrapper
8. Convert action buttons to `.admin-btn .admin-btn-primary` / `.admin-btn-outline`
9. Remove ALL inline styles (style="...") and replace with CSS classes
10. Ensure `portalRole` is set correctly — if the request user is superadmin, pass `portalRole: 'superadmin'` even on admin_* pages

### ADMIN PAGES (Command Center theme):

**admin_orders.ejs** — Cases List
- Breadcrumb: Dashboard > Cases
- Page title: "Cases" with subtitle "All case submissions and their status"
- Filters: Date range + specialty + status dropdown
- KPI row: Total, Completed, Pending, Breached (small cards)
- Table: Order ID (monospace), Patient, Doctor, Service, Status (pill), Amount, Actions
- Action buttons: View (outline), Export CSV

**admin_order_detail.ejs** — Case Detail
- Breadcrumb: Dashboard > Cases > Order #abc123
- Page title: "Order #abc123" with subtitle showing service + specialty
- Layout: 2-column grid
  - Left column: admin-card with detail grid (patient, doctor, service, specialty, status, payment, SLA deadline, created, updated)
  - Right column: stacked cards (Timeline/Events, File Attachments, Doctor Notes)
- Action buttons at top: Reassign, Mark Paid, Cancel (danger)
- Bottom: File re-upload request section if applicable

**admin_doctors.ejs** — Doctors List
- Breadcrumb: Dashboard > Doctors
- Page title: "Doctors" with action button "+ Add Doctor"
- Filters: Status (all/active/pending/inactive), search by name
- Table: Name, Email, Specialties, Status (pill), Cases (count), Rating, Actions

**admin_doctor_form.ejs** — Add/Edit Doctor
- Breadcrumb: Dashboard > Doctors > Add Doctor (or Edit: Dr. Name)
- Page title: "Add Doctor" or "Edit Doctor"
- Form in admin-card with admin-form-grid (2 columns)
- Fields: Name, Email, Phone, License, Specialty (multi-select), Bio (textarea), Commission %, Status
- Buttons: Save (primary), Cancel (outline)

**admin_services.ejs** — Services List
- Breadcrumb: Dashboard > Services
- Table: Service Name, Specialty, Base Price, Video Price, Status, Actions

**admin_service_form.ejs** — Add/Edit Service
- Breadcrumb: Dashboard > Services > Add/Edit
- Form in admin-card, admin-form-grid

**admin_pricing.ejs** — Pricing Management
- Breadcrumb: Dashboard > Pricing
- Filter by country/region
- Table with inline-editable prices
- Export CSV button

**admin_analytics.ejs** — Analytics
- Breadcrumb: Dashboard > Analytics
- Keep existing chart layout but wrap in admin-cards
- Filters: period selector (7d, 30d, 90d, 12m)

**admin_reviews.ejs** — Reviews
- Breadcrumb: Dashboard > Reviews
- Table: Patient, Doctor, Rating (stars), Comment, Date, Status, Actions

**admin_referrals.ejs** — Referrals
- Breadcrumb: Dashboard > Referrals
- KPIs: Total codes, Used, Revenue from referrals
- Table: Referrer, Code, Uses, Revenue, Date

**admin_campaigns.ejs** — Campaigns List
- Breadcrumb: Dashboard > Campaigns
- Table: Campaign Name, Status, Audience, Sent, Open Rate, Date

**admin_campaign_new.ejs / admin_campaign_detail.ejs** — Campaign Create/Detail
- Breadcrumb: Dashboard > Campaigns > New/Detail
- Form or detail view in admin-cards

**admin_chat_moderation.ejs** — Chat Moderation
- Breadcrumb: Dashboard > Chat Moderation
- KPI: Open reports count
- Table: Reporter, Reason, Status (pill), Date, Actions

**admin_chat_moderation_detail.ejs** — Report Review
- Breadcrumb: Dashboard > Chat Moderation > Report #abc
- Context messages in a chat-bubble style card
- Flagged message highlighted
- Action buttons: Dismiss, Warn, Mute, Resolve

**admin_video_calls.ejs** — Video Calls
- Breadcrumb: Dashboard > Video Calls
- KPIs: Total, Completed, No-shows, Avg Duration
- Today's schedule section
- Table: Date, Patient, Doctor, Status, Duration, Payment

**admin_errors.ejs** — Error Log
- Breadcrumb: Dashboard > Error Log
- Table: Timestamp, Error, File, Line, Count

**admin_alerts.ejs** — Alerts
- Breadcrumb: Dashboard > Alerts
- Table/feed of alert items

### SUPERADMIN PAGES (Glass Tower theme):

All superadmin pages follow the same pattern as admin pages but they'll automatically get the Glass Tower styling through `.owner-theme` CSS overrides.

**superadmin_order_detail.ejs** — Owner Case Detail
- Same structure as admin_order_detail.ejs but with portalRole: 'superadmin'
- Additional owner actions: Override SLA, Force Complete, Delete Order

**superadmin_order_new.ejs** — Create Order (Manual)
- Breadcrumb: Dashboard > Cases > Create Order
- Form: Patient (select/create), Service, Specialty, Price override, Notes

**superadmin_order_payment.ejs** — Mark Payment
- Breadcrumb: Dashboard > Cases > Order #abc > Payment
- Payment details form

**superadmin_doctors.ejs** — Owner Doctors List
- Same as admin_doctors but with portalRole: 'superadmin'
- Remove the `<nav class="portal-top-tabs">` horizontal nav

**superadmin_doctor_detail.ejs** — Doctor Profile (Owner View)
- Breadcrumb: Dashboard > Doctors > Dr. Name
- Full profile card + stats + cases + earnings

**superadmin_doctor_form.ejs** — Add/Edit Doctor (Owner)
- Same form structure with admin-form-grid

**superadmin_services.ejs / superadmin_service_form.ejs**
- Same as admin versions, portalRole: 'superadmin'
- Remove top-tabs nav

**superadmin_events.ejs** — Audit Log
- Breadcrumb: Dashboard > Audit Log
- Filters: date range, event type, user
- Table: Timestamp, User, Action, Entity, Details

**superadmin_alerts.ejs** — Alerts (Owner)
- Breadcrumb: Dashboard > Alerts

**superadmin_profile.ejs** — Owner Profile
- Breadcrumb: Dashboard > Profile
- Profile card with name, email, role
- Change password form

---

## PART 4: ROUTE HANDLER FIX — portalRole MUST FOLLOW THE USER

This is critical. Right now some admin pages hardcode `portalRole: 'admin'` or `portalRole: 'superadmin'`. The rule should be:

**If the logged-in user is a superadmin, ALWAYS pass `portalRole: 'superadmin'`**, even for admin_* pages. This ensures the Glass Tower sidebar shows everywhere for the owner.

In every admin route handler, change:
```javascript
// BEFORE (hardcoded)
portalRole: 'superadmin'
// or
portalRole: 'admin'

// AFTER (dynamic)
portalRole: req.user.role === 'superadmin' ? 'superadmin' : 'admin'
```

Apply this to ALL route handlers that render admin_* or superadmin_* views. Search for `portalRole:` across all route files and update.

---

## PART 5: REMOVE ALL TOP-TABS NAV

Search for `portal-top-tabs` across ALL .ejs files and REMOVE the entire `<nav class="portal-top-tabs">...</nav>` block. The sidebar now handles all navigation.

Files known to have it:
- superadmin.ejs ✓ (already handled by SUPERADMIN_REDESIGN_PROMPT)
- superadmin_doctors.ejs
- superadmin_services.ejs
- superadmin_events.ejs
- superadmin_alerts.ejs
- Any other file — search and remove

---

## PART 6: REMOVE INLINE STYLES

Search for `style="` across ALL admin_* and superadmin_* .ejs files. Replace inline styles with appropriate CSS classes from the unified system. Common patterns to fix:

- `style="display:flex;gap:8px;"` → use `admin-page-header-right` or a flex utility
- `style="font-size:12px; color: var(--text-muted);"` → use existing text utility or add class
- `style="margin-top: 24px;"` → use `admin-content` spacing or margin utility
- `style="padding: 12px; background: #F0F7FF;"` → use `admin-card-body` or kpi class

Not every single inline style needs removing, but anything that sets colors, fonts, or layout structure MUST use the theme CSS variables so it adapts correctly between Command Center and Glass Tower.

---

## VERIFICATION CHECKLIST

After implementation, navigate to EVERY page as superadmin and verify:

- [ ] Sidebar: Glass Tower navy sidebar with grouped sections visible on ALL pages
- [ ] No horizontal top-tabs nav anywhere
- [ ] Breadcrumb visible on every sub-page
- [ ] Page titles consistent (font, size, weight)
- [ ] Tables: uppercase headers, hover states, monospace IDs
- [ ] Status pills: consistent colors matching theme
- [ ] Buttons: consistent primary/outline styling
- [ ] Forms: consistent input/label styling with focus rings
- [ ] Cards: consistent border-radius and borders
- [ ] Filters: consistent filter bar styling
- [ ] No broken inline styles / no visual inconsistencies
- [ ] Doctor portal: UNCHANGED
- [ ] Patient portal: UNCHANGED

**Pages to check:**
1. /superadmin → Dashboard (Glass Tower)
2. /admin/orders → Cases list
3. /superadmin/orders/{id} → Case detail
4. /superadmin/orders/new → Create order
5. /superadmin/doctors → Doctors list
6. /superadmin/doctors/new → Add doctor
7. /superadmin/doctors/{id} → Doctor detail
8. /superadmin/services → Services list
9. /superadmin/services/new → Add service
10. /admin/pricing → Pricing
11. /portal/admin/analytics → Analytics
12. /admin/reviews → Reviews
13. /admin/chat-moderation → Chat Moderation
14. /admin/video-calls → Video Calls
15. /portal/admin/referrals → Referrals
16. /portal/admin/campaigns → Campaigns
17. /portal/admin/campaigns/new → New Campaign
18. /admin/errors → Error Log
19. /superadmin/events → Audit Log
20. /superadmin/alerts → Alerts
21. /superadmin/profile → Profile

---

## COMMIT

```
feat: unify all admin/superadmin sub-pages with theme-consistent structure

- Shared page skeleton: breadcrumbs, page header, filter bars, cards, forms
- All admin pages use Command Center component classes
- All superadmin pages inherit Glass Tower overrides via .owner-theme
- Removed portal-top-tabs horizontal nav from all pages (sidebar handles it)
- Dynamic portalRole based on logged-in user (superadmin always gets Glass Tower)
- Removed inline styles, replaced with theme-aware CSS classes
- Consistent tables, pills, buttons, forms across all 21+ pages
```
