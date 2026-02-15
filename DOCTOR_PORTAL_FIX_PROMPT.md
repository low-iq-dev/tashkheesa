# DOCTOR PORTAL — COMPLETE FIX PROMPT (Claude Code)
## Execute ALL sections in order. Commit after each section.

**Project root:** The current working directory (tashkheesa-portal)

---

## CONTEXT

The doctor portal has been audited and has **6 critical issues** and **9 medium issues**. The root cause of most critical issues is the same: several doctor portal pages do NOT use the portal layout shell (they're missing `portalFrame: true` in their render calls, or the EJS templates have their own standalone HTML instead of using `layouts/portal.ejs`).

**How the portal layout works:**
- `src/views/layouts/portal.ejs` is the layout file. When a route passes `portalFrame: true`, the layout renders the blue "Tashkheesa / Doctor Portal" header, the left sidebar with all nav links, EN/AR buttons, and Logout.
- The sidebar nav items are determined by the `portalRole` variable. When `portalRole !== 'superadmin'`, it renders doctor nav links.
- The active sidebar item is controlled by `portalActive` — e.g., `portalActive: 'reviews'` highlights the Reviews link.
- The page content goes inside `<main class="portal-content">`.

**Pages that work correctly** (already use portalFrame): `portal_doctor_dashboard.ejs`, `portal_doctor_queue.ejs`, `portal_doctor_case.ejs`, `doctor_analytics.ejs`, `messages.ejs`, `doctor_prescriptions_list.ejs`

**Pages that are BROKEN** (no portalFrame, standalone HTML): `doctor_reviews.ejs`, `doctor_alerts.ejs`, plus doctor profile which falls back to inline HTML in the route.

---

## SECTION 1: FIX DOCTOR REVIEWS PAGE — Add Portal Shell

### 1A. Update the route in `src/routes/reviews.js`

Find the `GET /portal/doctor/:doctorId/reviews` route handler (around line 130-160). It currently renders `doctor_reviews` WITHOUT portalFrame. Update the `res.render` call to include the portal frame variables:

```javascript
res.render('doctor_reviews', {
  doctor,
  specialtyName: specialty ? specialty.name : '',
  reviews,
  avgRating: statsRow ? Math.round((statsRow.avg_rating || 0) * 10) / 10 : 0,
  totalReviews: statsRow ? statsRow.count : 0,
  distribution,
  lang,
  isAr,
  pageTitle: isAr ? ('تقييمات د. ' + doctor.name) : ('Reviews for Dr. ' + doctor.name),
  // ADD THESE:
  portalFrame: true,
  portalRole: 'doctor',
  portalActive: 'reviews',
  brand: 'Tashkheesa',
  user: req.user || null,
  title: isAr ? 'التقييمات' : 'Reviews'
});
```

### 1B. Rewrite `src/views/doctor_reviews.ejs`

The current file starts with `<%- include('partials/header' ...) %>` and has its own standalone `<style>` block. It needs to be rewritten to work INSIDE the portal layout.

**Remove** the first line `<%- include('partials/header' ...)%>` and remove the closing `<%- include('partials/footer') %>` if present. The portal layout already provides `<html>`, `<head>`, `<body>`, sidebar, etc.

The file should start directly with content that goes inside `<main class="portal-content">`. Keep all the existing EJS logic (reviews array, stars function, etc.) but remove any standalone HTML boilerplate (`<!DOCTYPE>`, `<html>`, `<head>`, `<link>` tags that duplicate what portal.ejs provides).

Structure should be:

```ejs
<%
  // Keep all the existing variable declarations and helper functions
  var _lang = (typeof lang !== 'undefined') ? lang : 'en';
  var _isAr = (typeof isAr !== 'undefined') ? isAr : false;
  // ... rest of existing var declarations and helper functions ...
%>

<div class="portal-hero" style="margin-bottom:var(--space-2, 16px);">
  <h1 class="portal-hero-title"><%= _isAr ? 'التقييمات' : 'My Reviews' %></h1>
  <p class="portal-hero-subtitle"><%= _isAr ? 'تقييمات المرضى لخدماتك' : 'Patient ratings for your services' %></p>
</div>

<!-- Then the rest of the existing review content (rating summary, review cards, etc.) -->
<!-- Keep all the existing HTML/EJS for the review list, just remove the standalone wrapper -->
```

**Important:** Fix the doubled "Dr. Dr." prefix. Find any place that outputs `Dr. <%= doctor.name %>` — the doctor's name in the DB already includes "Dr." so just output `<%= doctor.name %>` without prepending "Dr." again.

---

## SECTION 2: FIX DOCTOR ALERTS PAGE — Add Portal Shell

### 2A. Update the route in `src/routes/doctor.js`

Find the GET route for `/portal/doctor/alerts` (search for `doctor_alerts`). Update `res.render` to include portal frame:

```javascript
// Add to the render call:
portalFrame: true,
portalRole: 'doctor',
portalActive: 'alerts',
brand: 'Tashkheesa',
title: isAr ? 'التنبيهات' : 'Alerts'
```

### 2B. Rewrite `src/views/doctor_alerts.ejs`

The current file has its own `<header>`, `<div class="layout">`, custom nav bar, pills, and links. ALL of that needs to be removed because the portal layout provides it.

Remove:
- The `<%- include('partials/header' ...) %>` line at the top
- The entire `<header>...</header>` block with brand, pills, user menu, EN/AR links
- The `<div class="layout">` wrapper
- The `<a class="btn btn-outline" href="/portal/doctor">← Back to dashboard</a>` (the sidebar already has Dashboard link)
- Any closing `</div>` for the layout wrapper
- Any `<%- include('partials/footer') %>`

Keep only the actual alerts content (heading, subtitle, alert cards/list). Wrap in the standard portal hero pattern:

```ejs
<% const _isAr = (typeof isAr !== 'undefined') ? isAr : (typeof lang !== 'undefined' && lang === 'ar'); %>
<% var fmtDate = (typeof formatEventDate !== 'undefined') ? formatEventDate : function(iso){ return iso || ''; }; %>

<div class="portal-hero" style="margin-bottom:var(--space-2, 16px);">
  <h1 class="portal-hero-title"><%= _isAr ? 'التنبيهات' : 'Alerts' %></h1>
  <p class="portal-hero-subtitle"><%= _isAr ? 'إشعارات متعلقة بحالاتك الطبية' : 'Notifications related to your cases' %></p>
</div>

<!-- Then the existing alerts list content -->
```

---

## SECTION 3: FIX DOCTOR PROFILE PAGE — Create Proper View + Edit Form

### 3A. The current profile route in `src/routes/doctor.js` (around line 1153-1200) tries to render `portal_doctor_profile` but falls back to inline HTML because the view doesn't exist. 

Update the route handler to:

```javascript
router.get('/portal/doctor/profile', requireRole('doctor'), function(req, res) {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const doctor = req.user;

  // Load specialty
  var specialty = null;
  if (doctor.specialty_id) {
    specialty = db.prepare('SELECT id, name FROM specialties WHERE id = ?').get(doctor.specialty_id);
  }
  // Load all specialties for dropdown
  var specialties = [];
  try {
    specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name').all();
  } catch(e) { specialties = []; }

  res.render('doctor_profile', {
    portalFrame: true,
    portalRole: 'doctor',
    portalActive: 'profile',
    brand: 'Tashkheesa',
    title: isAr ? 'الملف الشخصي' : 'My Profile',
    user: doctor,
    doctor,
    specialty,
    specialties,
    lang,
    isAr,
    success: req.query.success || null,
    error: req.query.error || null
  });
});
```

### 3B. Add a POST route for profile updates:

```javascript
router.post('/portal/doctor/profile', requireRole('doctor'), function(req, res) {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  try {
    const { name, phone, bio, specialty_id } = req.body;
    
    db.prepare(
      `UPDATE users SET name = ?, phone = ?, bio = ?, specialty_id = ?, updated_at = ? WHERE id = ?`
    ).run(
      name || req.user.name,
      phone || req.user.phone,
      bio || '',
      specialty_id || req.user.specialty_id,
      new Date().toISOString(),
      req.user.id
    );
    
    res.redirect('/portal/doctor/profile?success=' + encodeURIComponent(isAr ? 'تم تحديث الملف الشخصي' : 'Profile updated'));
  } catch(err) {
    console.error('[doctor-profile] update error', err);
    res.redirect('/portal/doctor/profile?error=' + encodeURIComponent(isAr ? 'فشل التحديث' : 'Update failed'));
  }
});
```

### 3C. Create `src/views/doctor_profile.ejs` (NEW FILE):

This page will render inside the portal layout (portalFrame handles the shell). Content only:

```ejs
<%
  var _isAr = (typeof isAr !== 'undefined') ? isAr : false;
  var _doctor = (typeof doctor !== 'undefined') ? doctor : (typeof user !== 'undefined' ? user : {});
  var _specialty = (typeof specialty !== 'undefined' && specialty) ? specialty : null;
  var _specialties = (typeof specialties !== 'undefined' && Array.isArray(specialties)) ? specialties : [];
  var _success = (typeof success !== 'undefined') ? success : null;
  var _error = (typeof error !== 'undefined') ? error : null;
%>

<div class="portal-hero" style="margin-bottom:var(--space-2, 16px);">
  <h1 class="portal-hero-title"><%= _isAr ? 'الملف الشخصي' : 'My Profile' %></h1>
  <p class="portal-hero-subtitle"><%= _isAr ? 'إدارة معلوماتك الشخصية والمهنية' : 'Manage your personal and professional information' %></p>
</div>

<% if (_success) { %>
<div class="alert alert-success" style="background:#d1fae5;color:#065f46;padding:12px 16px;border-radius:8px;margin-bottom:16px;"><%= _success %></div>
<% } %>
<% if (_error) { %>
<div class="alert alert-error" style="background:#fee2e2;color:#991b1b;padding:12px 16px;border-radius:8px;margin-bottom:16px;"><%= _error %></div>
<% } %>

<div style="max-width:640px;">
  <form method="POST" action="/portal/doctor/profile" style="display:flex;flex-direction:column;gap:16px;">
    
    <div class="form-group">
      <label for="name" style="font-weight:600;margin-bottom:4px;display:block;"><%= _isAr ? 'الاسم' : 'Full Name' %></label>
      <input type="text" id="name" name="name" value="<%= _doctor.name || '' %>" class="form-input" style="width:100%;padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;" required />
    </div>

    <div class="form-group">
      <label for="email" style="font-weight:600;margin-bottom:4px;display:block;"><%= _isAr ? 'البريد الإلكتروني' : 'Email' %></label>
      <input type="email" id="email" value="<%= _doctor.email || '' %>" class="form-input" style="width:100%;padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;background:#f3f4f6;color:#6b7280;" disabled />
      <small style="color:#6b7280;"><%= _isAr ? 'لا يمكن تغيير البريد الإلكتروني' : 'Email cannot be changed' %></small>
    </div>

    <div class="form-group">
      <label for="phone" style="font-weight:600;margin-bottom:4px;display:block;"><%= _isAr ? 'رقم الهاتف' : 'Phone' %></label>
      <input type="tel" id="phone" name="phone" value="<%= _doctor.phone || '' %>" class="form-input" style="width:100%;padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;" placeholder="+20 xxx xxx xxxx" />
    </div>

    <div class="form-group">
      <label for="specialty_id" style="font-weight:600;margin-bottom:4px;display:block;"><%= _isAr ? 'التخصص' : 'Specialty' %></label>
      <select id="specialty_id" name="specialty_id" class="form-input" style="width:100%;padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;">
        <option value=""><%= _isAr ? 'اختر التخصص' : 'Select specialty' %></option>
        <% _specialties.forEach(function(s) { %>
          <option value="<%= s.id %>" <%= (_doctor.specialty_id === s.id) ? 'selected' : '' %>><%= s.name %></option>
        <% }); %>
      </select>
    </div>

    <div class="form-group">
      <label for="bio" style="font-weight:600;margin-bottom:4px;display:block;"><%= _isAr ? 'نبذة مختصرة' : 'Bio' %></label>
      <textarea id="bio" name="bio" rows="4" class="form-input" style="width:100%;padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;resize:vertical;" placeholder="<%= _isAr ? 'اكتب نبذة مختصرة عن خبراتك...' : 'Write a brief bio about your experience...' %>"><%= _doctor.bio || '' %></textarea>
    </div>

    <button type="submit" class="btn btn-primary" style="align-self:flex-start;padding:12px 32px;background:var(--deep-blue,#1a365d);color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;">
      <%= _isAr ? 'حفظ التغييرات' : 'Save Changes' %>
    </button>
  </form>
</div>
```

---

## SECTION 4: FIX DOCTOR APPOINTMENTS PAGE — Remove Duplicate Nav

### 4A. Open `src/views/doctor_appointments.ejs`

This page renders a secondary dark-blue navigation bar ("Tashkheesa Consultations Dashboard" with tabs) inside the content area. This is because it was built before the portal layout existed.

Find and remove the entire secondary `<header>` / `<nav>` block that contains the duplicate navigation (the one with "My Cases, Appointments, Availability, Alerts, Home, Dr Radiology, EN|AR"). 

### 4B. Update the render call in the route (in `src/routes/appointments.js` or `src/routes/doctor.js`) to include:

```javascript
portalFrame: true,
portalRole: 'doctor',
portalActive: 'appointments',
brand: 'Tashkheesa',
title: isAr ? 'المواعيد' : 'Appointments'
```

### 4C. Remove the `<%- include('partials/header'...) %>` and `<%- include('partials/footer') %>` from the EJS file — the portal layout handles this.

### 4D. Add the standard portal hero at the top of the remaining content:

```ejs
<div class="portal-hero" style="margin-bottom:var(--space-2, 16px);">
  <h1 class="portal-hero-title"><%= isAr ? 'المواعيد' : 'Appointments' %></h1>
  <p class="portal-hero-subtitle"><%= isAr ? 'إدارة مواعيد الاستشارات' : 'Manage your consultation appointments' %></p>
</div>
```

### 4E. Fix the SERVICE column showing "—" — the query needs to JOIN on the services table. Find the query and add:
```sql
LEFT JOIN services s ON s.id = o.service_id
```
Then display `s.name` in the SERVICE column instead of the dash.

---

## SECTION 5: FIX ANALYTICS CHARTS — Blank Charts

Open `src/views/doctor_analytics.ejs`. Find the chart rendering code (likely uses Chart.js or inline SVG).

The charts "Monthly Revenue" and "Cases by Specialty" are blank. Possible causes:
1. Chart.js CDN not loaded — make sure `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>` is included (check if it was in the old `partials/header` but not in `layouts/portal.ejs`)
2. Data variables are empty — check if `charts.monthlyRevenue` and `charts.bySpecialty` exist and contain data
3. Canvas elements don't have proper dimensions

**Fix approach:**
- Add Chart.js CDN script before the chart initialization code (at the bottom of the EJS file, inside a `<script>` tag)
- Add fallback: if no data, show "No data yet" instead of an empty canvas
- Make sure the `<canvas>` elements have explicit width/height: `<canvas id="revenueChart" width="400" height="200"></canvas>`

If the chart data comes from the route, check the route handler in `src/routes/doctor.js` (or `src/routes/analytics.js`) — the `charts` object might not be populated. Make sure the SQL query returns actual data rows even if empty.

---

## SECTION 6: FIX SIDEBAR ACTIVE STATE FOR ALL PAGES

### 6A. Case Queue (`/portal/doctor/queue`)
Find the render call for `portal_doctor_queue` or `doctor_queue` in `src/routes/doctor.js`. Make sure it passes:
```javascript
portalActive: 'queue'
```

### 6B. Case Detail (`/portal/doctor/case/:id`)
Find the render call for `portal_doctor_case` in `src/routes/doctor.js`. Make sure it passes:
```javascript
portalActive: 'queue'  // highlight Case Queue since case detail is a sub-page of queue
```

### 6C. Messages page
Find the render call for the messages page. Make sure it passes:
```javascript
portalActive: 'messages'
```

### 6D. Prescriptions page
Find the render call for `doctor_prescriptions_list`. Make sure it passes:
```javascript
portalActive: 'prescriptions'
```

---

## SECTION 7: FIX QUEUE FILTER PILL — Invisible Label

Open `src/views/doctor_queue.ejs` or `portal_doctor_queue.ejs`. Find the filter pills/tabs (the row of buttons like "New Assignments (1)", "In Review", etc.).

There's a blank blue button with no visible text. Either:
1. The button text color is white on blue background with no contrast — fix by using the proper CSS class
2. The label is empty — add the missing label text (likely "All" or "In Review")

Search for filter buttons and ensure every button has visible text content and proper contrast.

---

## SECTION 8: FIX CASE DETAIL — Clipped Button + Raw Dates + Empty States

### 8A. Open `src/views/portal_doctor_case.ejs`. Find the "Back to dashboard" button. Either:
- Shorten text to "← Back" 
- Or make the button full-width so text doesn't clip
- Or use `white-space: nowrap; overflow: visible;` CSS

### 8B. Fix raw ISO timestamps. Find any place that outputs dates like `2026-01-17T19:16:06Z` and replace with a formatted date. Add a helper at the top if not already present:

```ejs
<%
  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(isAr ? 'ar-EG' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch(e) { return iso; }
  }
%>
```

Then replace raw ISO outputs with `<%= fmtDate(someDate) %>`.

### 8C. Fix clinical context empty state. Replace bare "—" dashes with descriptive text:

```ejs
<%= order.clinical_question || (isAr ? 'لم يقدم المريض سؤالاً سريرياً' : 'Patient did not provide a clinical question') %>
```

---

## SECTION 9: FIX ARABIC LANGUAGE TOGGLE

The EN/AR buttons in the portal sidebar use `/lang/en?next=...` and `/lang/ar?next=...`. 

### 9A. Check if there's a `/lang/:lang` route defined. Search for it:
```bash
grep -rn "lang/:lang\|/lang/en\|/lang/ar" src/routes/ src/server.js --include="*.js"
```

If it doesn't exist, create it in `src/server.js` (BEFORE the route mounts):

```javascript
app.get('/lang/:lang', function(req, res) {
  var lang = req.params.lang === 'ar' ? 'ar' : 'en';
  res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
  
  // Also update user preference if logged in
  if (req.user && req.user.id) {
    try {
      db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, req.user.id);
    } catch(e) { /* ignore */ }
  }
  
  var next = req.query.next || '/';
  // Security: only allow relative paths
  if (!next.startsWith('/')) next = '/';
  res.redirect(next);
});
```

### 9B. The `next` parameter in the sidebar EN/AR links currently uses a fixed path (`nextPath` which defaults to `/portal/doctor`). This means switching language always redirects to the dashboard instead of staying on the current page.

In `src/views/layouts/portal.ejs`, find the EN/AR links in the sidebar. Change them to use the CURRENT page URL:

```ejs
<a class="btn btn-secondary btn-full" href="/lang/en?next=<%= encodeURIComponent(typeof currentUrl !== 'undefined' ? currentUrl : nextPath) %>">EN</a>
<a class="btn btn-secondary btn-full" href="/lang/ar?next=<%= encodeURIComponent(typeof currentUrl !== 'undefined' ? currentUrl : nextPath) %>">AR</a>
```

Then add middleware in `src/server.js` (near the language middleware) to pass the current URL:

```javascript
app.use(function(req, res, next) {
  res.locals.currentUrl = req.originalUrl || req.url || '/';
  next();
});
```

### 9C. Verify that the language middleware in `src/server.js` reads the cookie:

```javascript
app.use(function(req, res, next) {
  var lang = req.query.lang || req.cookies?.lang || (req.user && req.user.lang) || 'en';
  res.locals.lang = lang;
  res.locals.isAr = lang === 'ar';
  res.locals.dir = lang === 'ar' ? 'rtl' : 'ltr';
  next();
});
```

Make sure this runs AFTER cookie-parser but BEFORE route handlers.

---

## SECTION 10: FIX MOBILE RESPONSIVENESS

Add responsive CSS for the portal layout. Create or add to the appropriate CSS file (`public/css/portal-global.css` or `public/css/portal-components.css`).

Add these mobile styles:

```css
/* Mobile hamburger for portal sidebar */
.portal-sidebar-toggle {
  display: none;
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 1100;
  background: var(--deep-blue, #1a365d);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 1.25rem;
  cursor: pointer;
}

@media (max-width: 768px) {
  .portal-sidebar-toggle {
    display: block;
  }
  
  .portal-grid {
    grid-template-columns: 1fr !important;
  }
  
  .portal-sidebar {
    position: fixed;
    top: 0;
    left: -280px;
    width: 260px;
    height: 100vh;
    z-index: 1050;
    background: var(--deep-blue, #1a365d);
    transition: left 0.3s ease;
    overflow-y: auto;
    padding-top: 60px;
  }
  
  .portal-sidebar.open {
    left: 0;
  }
  
  .portal-sidebar-overlay {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.4);
    z-index: 1040;
  }
  
  .portal-sidebar-overlay.active {
    display: block;
  }
  
  .portal-content {
    width: 100% !important;
    padding: 16px !important;
    min-width: 0 !important;
  }
  
  .portal-header {
    padding-left: 56px !important;
  }
  
  /* Prevent horizontal scroll */
  .portal-shell {
    overflow-x: hidden;
  }
}
```

Then in `src/views/layouts/portal.ejs`, add the hamburger button and overlay INSIDE the `<% if (usePortalFrame) { %>` block, right after `<div class="portal-shell">`:

```html
<button class="portal-sidebar-toggle" onclick="document.querySelector('.portal-sidebar').classList.toggle('open');document.querySelector('.portal-sidebar-overlay').classList.toggle('active');" aria-label="Toggle menu">☰</button>
<div class="portal-sidebar-overlay" onclick="document.querySelector('.portal-sidebar').classList.remove('open');this.classList.remove('active');"></div>
```

---

## SECTION 11: MINOR FIXES

### 11A. Messages page and Prescriptions page — Add blue hero header
Open `src/views/messages.ejs` and `src/views/doctor_prescriptions_list.ejs`. If they don't have the portal hero banner, add at the top of their content:

For messages.ejs:
```ejs
<div class="portal-hero" style="margin-bottom:var(--space-2, 16px);">
  <h1 class="portal-hero-title"><%= (typeof isAr !== 'undefined' && isAr) ? 'الرسائل' : 'Messages' %></h1>
  <p class="portal-hero-subtitle"><%= (typeof isAr !== 'undefined' && isAr) ? 'محادثاتك مع المرضى' : 'Your conversations with patients' %></p>
</div>
```

For doctor_prescriptions_list.ejs:
```ejs
<div class="portal-hero" style="margin-bottom:var(--space-2, 16px);">
  <h1 class="portal-hero-title"><%= (typeof isAr !== 'undefined' && isAr) ? 'الوصفات' : 'Prescriptions' %></h1>
  <p class="portal-hero-subtitle"><%= (typeof isAr !== 'undefined' && isAr) ? 'الوصفات الطبية التي أصدرتها' : 'Prescriptions you have issued' %></p>
</div>
```

### 11B. EN/AR sidebar buttons — Make smaller
In the portal layout CSS, style the language buttons to be smaller:

```css
.section-cta {
  display: flex;
  gap: 8px;
  padding: 8px 16px;
}
.section-cta .btn {
  padding: 6px 12px !important;
  font-size: 0.8rem !important;
  flex: 1;
}
```

---

## SECTION 12: VERIFICATION

After all changes:

1. Start the server: `npm start` or `node src/server.js`
2. Login as doctor (dr.radiology@tashkheesa.com / TempPass123!)
3. Visit each page and verify:

| Page | URL | Check |
|------|-----|-------|
| Dashboard | /portal/doctor | Blue header, Sidebar, Active=Dashboard |
| Case Queue | /portal/doctor/queue | Sidebar, Active=Case Queue, filter pills all visible |
| Case Detail | /portal/doctor/case/:id | Sidebar, Active=Case Queue, dates formatted, Back not clipped |
| Appointments | /portal/doctor/appointments | Sidebar, Active=Appointments, NO duplicate nav bar, SERVICE column populated |
| Messages | /portal/messages | Sidebar, Active=Messages, blue hero header |
| Prescriptions | /portal/doctor/prescriptions | Sidebar, Active=Prescriptions, blue hero header |
| Reviews | /portal/doctor/reviews | Sidebar, Active=Reviews, no "Dr. Dr." prefix |
| Analytics | /portal/doctor/analytics | Sidebar, Active=Analytics, charts render (or show no data message) |
| Alerts | /portal/doctor/alerts | Sidebar, Active=Alerts, no raw text nav |
| Profile | /portal/doctor/profile | Sidebar, Active=Profile, edit form works, save works |
| AR toggle | Click AR in sidebar | Page switches to Arabic, RTL layout, stays on current page |
| Mobile | Resize to 375px | Hamburger menu appears, sidebar slides out, content is full-width |

---

## COMMIT STRATEGY
1. `fix(doctor-portal): add portal shell to Reviews, Alerts, Profile pages`
2. `feat(doctor-portal): create doctor profile edit form`
3. `fix(doctor-portal): remove duplicate nav from Appointments, fix service column`
4. `fix(doctor-portal): fix analytics charts, add Chart.js CDN`
5. `fix(doctor-portal): fix sidebar active states for all pages`
6. `fix(doctor-portal): fix queue filter pill invisible label`
7. `fix(doctor-portal): fix case detail clipped button, raw dates, empty clinical context`
8. `fix(doctor-portal): implement AR language toggle with cookie persistence`
9. `feat(doctor-portal): add mobile responsive hamburger sidebar`
10. `fix(doctor-portal): add hero headers to Messages and Prescriptions, shrink EN/AR buttons`
