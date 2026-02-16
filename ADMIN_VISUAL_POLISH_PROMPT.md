# ADMIN DASHBOARD VISUAL POLISH — Match Command Center Render

**Execute AFTER** ADMIN_DASHBOARD_REWRITE_PROMPT.md

The admin dashboard layout and data are correct, but it doesn't match the polished Command Center design from the original render (admin_option_a.html). This prompt fixes the visual styling to match.

---

## WHAT'S WRONG

The current admin.ejs uses basic `admin-kpi` / `admin-card` classes but the original Command Center render had:
1. A sticky top header bar (not just inline text)
2. KPI cards with colored icon boxes (38x38px rounded squares with icons)
3. KPI values at 28px weight 700 with colored change pills
4. Proper 4-column grid with hover lift effects
5. Section titles styled differently
6. Issues cards with proper card styling (not just icon + number)

## WHAT TO DO

### 1. Update admin.ejs KPI cards to include icon boxes

Each KPI card should have this structure (matching the render):
```html
<div class="kpi-card">
  <div class="kpi-header">
    <div class="kpi-icon blue">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
        <rect x="9" y="3" width="6" height="4" rx="1"/>
      </svg>
    </div>
  </div>
  <p class="kpi-label">Total Cases</p>
  <p class="kpi-value"><%= totalOrders %></p>
  <p class="kpi-change down">▼ 56% vs last month</p>
</div>
```

Assign these icon+color combos to each KPI:
- Total Cases → blue, clipboard icon
- Pending → amber, clock icon
- Completed → green, check-circle icon
- Breached SLA → red, alert-triangle icon
- SLA On-Time → purple, zap icon (or percent)
- Avg Turnaround → teal, timer/clock icon

### 2. Add a top bar

Add a sticky top bar between the header include and the `admin-page` div:

```html
<div class="admin-topbar">
  <div class="admin-topbar-left">
    <h1>Operations Dashboard</h1>
  </div>
  <div class="admin-topbar-right">
    <form class="admin-topbar-filters" method="get" action="/admin">
      <div class="filter-bar">
        <input type="date" name="from" value="<%= filters.from %>"/>
        <input type="date" name="to" value="<%= filters.to %>"/>
        <select name="specialty">
          <option value="all">All specialties</option>
          <% specialties.forEach(function(sp){ %>
            <option value="<%= sp.id %>" <%= filters.specialty == sp.id ? 'selected' : '' %>><%= sp.name %></option>
          <% }); %>
        </select>
        <button type="submit">Apply</button>
      </div>
    </form>
  </div>
</div>
```

Then inside `admin-page`, remove the page header and inline filters — the topbar replaces them.

### 3. Style the topbar in admin-styles.css

Add under `.admin-theme`:
```css
.admin-theme .admin-topbar {
  height: 64px;
  background: rgba(255,255,255,.9);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--admin-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 32px;
  position: sticky;
  top: 0;
  z-index: 5;
}
.admin-theme .admin-topbar h1 {
  font-size: 18px;
  font-weight: 700;
  margin: 0;
}
.admin-theme .admin-topbar .filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--admin-surface-2, #f1f4f9);
  padding: 6px;
  border-radius: 8px;
}
.admin-theme .admin-topbar .filter-bar input,
.admin-theme .admin-topbar .filter-bar select {
  border: 1px solid var(--admin-border);
  background: var(--admin-surface);
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  color: var(--admin-text);
}
.admin-theme .admin-topbar .filter-bar button {
  background: var(--admin-blue, #2563eb);
  color: #fff;
  border: none;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
```

### 4. Fix the KPI grid to be 4 columns with overflow to second row

The current grid uses `admin-kpi-row` with auto-fit. Replace with `admin-kpi-grid` which is a fixed 4-column grid. If there are more than 4 KPIs (we have 6), they flow to the next row naturally.

Update admin.ejs to use `admin-kpi-grid` class (which already exists in admin-styles.css as a 4-column grid):
```html
<div class="admin-kpi-grid">
  <!-- 6 KPI cards here — they'll be 4 on first row, 2 on second -->
</div>
```

### 5. Fix the Patient Issues section

The Patient Issues cards should be proper cards with icon boxes, matching the KPI visual style:
```html
<div class="admin-section-title">Patient Issues</div>
<div class="admin-issues-grid">
  <div class="kpi-card">
    <div class="kpi-header">
      <div class="kpi-icon red">💬</div>
      <% if (openChatReports > 0) { %><a href="/admin/chat-moderation" class="admin-btn admin-btn-sm admin-btn-outline">Review</a><% } %>
    </div>
    <p class="kpi-value"><%= openChatReports %></p>
    <p class="kpi-label">Open Chat Reports</p>
  </div>
  <!-- ... same pattern for other 3 ... -->
</div>
```

### 6. Fix the Doctor Management and Order Financials sections

Same pattern — use `kpi-card` with `kpi-icon` boxes:
```html
<div class="admin-section-title">Doctor Management</div>
<div class="admin-kpi-grid" style="grid-template-columns: repeat(3, 1fr);">
  <div class="kpi-card">
    <div class="kpi-header">
      <div class="kpi-icon amber">
        <svg ...user-check icon.../>
      </div>
      <% if (pendingDoctorsCount > 0) { %><a href="/superadmin/doctors?status=pending" class="admin-btn admin-btn-sm admin-btn-primary">Review</a><% } %>
    </div>
    <p class="kpi-value"><%= pendingDoctorsCount %></p>
    <p class="kpi-label">Pending Approvals</p>
  </div>
  <!-- ... -->
</div>
```

### 7. Fix the Recent Cases table styling

The table should use proper admin-table classes. Check that the admin-styles.css has `admin-table` styles and they're actually matching what admin.ejs uses:

Make sure admin.ejs wraps the table in:
```html
<div class="admin-card">
  <div class="admin-card-header">
    <h3>Recent Cases</h3>
    <a href="/admin/orders" class="admin-btn admin-btn-sm admin-btn-outline">View All</a>
  </div>
  <table class="admin-table">
    <thead>
      <tr>
        <th>Order</th>
        <th>Patient</th>
        <!-- ... -->
      </tr>
    </thead>
    <tbody>
      <!-- rows -->
    </tbody>
  </table>
</div>
```

### 8. System strip at bottom

This should be a subtle bar at the very bottom, not prominent:
```html
<div class="admin-system-strip">
  <span class="system-item">
    <span class="system-dot <%= errorsLast24h > 0 ? 'system-dot--alert' : 'system-dot--ok' %>"></span>
    Errors (24h): <strong><%= errorsLast24h %></strong>
  </span>
  <span class="system-sep">·</span>
  <span class="system-item">
    Notif. Failed: <strong class="<%= notifStats.failed > 0 ? 'system-val--alert' : '' %>"><%= notifStats.failed %></strong>
  </span>
  <span class="system-sep">·</span>
  <span class="system-item">
    Queued: <strong><%= notifStats.queued %></strong>
  </span>
</div>
```

Add CSS for the dots:
```css
.admin-theme .system-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 4px;
}
.admin-theme .system-dot--ok { background: var(--admin-green); }
.admin-theme .system-dot--alert { background: var(--admin-red); animation: pulse 1.5s infinite; }
.admin-theme .system-sep { color: var(--admin-text-3); margin: 0 6px; }
```

---

## VERIFICATION

After applying:
- [ ] Sticky top bar with title + filter bar visible
- [ ] 6 KPI cards in 4+2 grid layout, each with colored icon box (38x38)
- [ ] Hover lift effect on KPI cards
- [ ] Change indicators (▲ up green, ▼ down red)
- [ ] Patient Issues 2x2 grid with icon boxes + Review buttons
- [ ] Doctor Management 3-column grid with icon boxes
- [ ] Order Financials 3-column grid
- [ ] Recent Cases table with proper table styling
- [ ] SLA Risk + Live Activity cards in right column
- [ ] System strip with colored dots at bottom
- [ ] Alert strip (yellow) for SLA breaches
- [ ] Admin sidebar still correct (not doctor sidebar)

## COMMIT
```
style: polish admin dashboard to match Command Center render

- Added sticky topbar with filter bar
- KPI cards now have colored icon boxes (38x38 rounded squares)
- Hover lift effect on all cards
- Patient Issues / Doctor Management / Order Financials all use icon box pattern
- System strip with health dots at bottom
- Matches original admin_option_a.html render design
```
