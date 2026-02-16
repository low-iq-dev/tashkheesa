# AUDIT FIX PROMPT — From External Pre-Launch Audit Report

**Project root:** tashkheesa-portal

Execute each section in order. Commit after each section.

---

## SECTION 1: CRITICAL — Registration 500 Error (missing country_code column)

**Root cause:** The `POST /register` handler in `src/routes/auth.js` inserts `country_code` into the `users` table, but the `CREATE TABLE users` in `src/db.js` does NOT include a `country_code` column. There is also no `ALTER TABLE` migration to add it. This causes a SQLite "table users has no column named country_code" error → 500.

**Fix:** In `src/db.js`, inside the `migrate()` function, add safe ALTER TABLE statements for ALL columns that routes depend on but aren't in the original CREATE TABLE. Add these AFTER the existing CREATE TABLE statements but before any other migration logic:

```javascript
// Safe column additions (idempotent — duplicate column errors are caught and ignored)
const safeAddColumn = (table, column, type) => {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (e) {
    // Column already exists — ignore
  }
};

// Users table columns needed by routes
safeAddColumn('users', 'country_code', 'TEXT');
safeAddColumn('users', 'pending_approval', 'INTEGER DEFAULT 0');
safeAddColumn('users', 'bio', 'TEXT');
safeAddColumn('users', 'display_name', 'TEXT');
safeAddColumn('users', 'onboarding_complete', 'INTEGER DEFAULT 0');
safeAddColumn('users', 'date_of_birth', 'TEXT');
safeAddColumn('users', 'gender', 'TEXT');
safeAddColumn('users', 'email_marketing_opt_out', 'INTEGER DEFAULT 0');
safeAddColumn('users', 'approved_at', 'TEXT');
safeAddColumn('users', 'approved_by', 'TEXT');

// Orders table columns
safeAddColumn('orders', 'sla_hours', 'INTEGER');
safeAddColumn('orders', 'deadline_at', 'TEXT');
safeAddColumn('orders', 'accepted_at', 'TEXT');
safeAddColumn('orders', 'completed_at', 'TEXT');
safeAddColumn('orders', 'breached_at', 'TEXT');
safeAddColumn('orders', 'sla_reminder_sent', 'INTEGER DEFAULT 0');
safeAddColumn('orders', 'reassigned_count', 'INTEGER DEFAULT 0');
safeAddColumn('orders', 'payment_status', 'TEXT');
safeAddColumn('orders', 'payment_method', 'TEXT');
safeAddColumn('orders', 'payment_reference', 'TEXT');
safeAddColumn('orders', 'updated_at', 'TEXT');

// Services table columns
safeAddColumn('services', 'base_price', 'REAL');
safeAddColumn('services', 'doctor_fee', 'REAL');
safeAddColumn('services', 'currency', 'TEXT DEFAULT \'EGP\'');
safeAddColumn('services', 'payment_link', 'TEXT');
safeAddColumn('services', 'sla_hours', 'INTEGER DEFAULT 72');
safeAddColumn('services', 'is_visible', 'INTEGER DEFAULT 1');
```

Search `src/db.js` for all existing `ALTER TABLE` statements and `safeAddColumn`-type patterns. If there are already some, consolidate them into this single block. The key point is that `country_code` on `users` MUST exist before registration can work.

**Verify:** After this fix, restart the server and test `POST /register` — it should create the user successfully.

---

## SECTION 2: CRITICAL — Login Fails for All Roles

**Root cause:** This is NOT a code bug. The auditor tested on production where no demo accounts exist. The `seedDemoData()` function only runs when `MODE=staging AND SEED_DEMO_DATA=1`. On production, the DB has no users until someone registers.

**Fix:** No code change needed. BUT add a safety check — wrap the POST /register handler's INSERT in a try/catch that returns a meaningful error instead of 500:

In `src/routes/auth.js`, find the `POST /register` route's INSERT statement:

```javascript
db.prepare(`
  INSERT INTO users (id, email, password_hash, name, role, lang, country_code)
  VALUES (?, ?, ?, ?, 'patient', ?, ?)
`).run(id, normalizedEmail, passwordHash, name, lang, normalizedCountry);
```

Wrap it in try/catch:

```javascript
try {
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, lang, country_code, is_active, created_at)
    VALUES (?, ?, ?, ?, 'patient', ?, ?, 1, ?)
  `).run(id, normalizedEmail, passwordHash, name, lang, normalizedCountry, new Date().toISOString());
} catch (dbErr) {
  console.error('[REGISTER] DB insert failed:', dbErr.message);
  return res.status(500).render('register', {
    error: c.isAr ? 'حدث خطأ أثناء إنشاء الحساب. حاول مرة أخرى.' : 'Error creating account. Please try again.',
    form,
    lang: c.isAr ? 'ar' : 'en',
    _lang: c.isAr ? 'ar' : 'en',
    isAr: c.isAr,
    copy: c
  });
}
```

---

## SECTION 3: HIGH — About Page Broken Image

The "How We're Different" section uses a Unicode character (&#9879;) inside `<span class="about-image-icon">` as a placeholder. On some browsers this renders as a broken/empty box.

In `public/about.html`, find both instances of `about-image-icon` and replace the Unicode characters with proper SVG icons or emoji that render universally:

```html
<!-- First block: Our Story -->
<span class="about-image-icon">🏥</span>

<!-- Second block: How We're Different -->
<span class="about-image-icon">⚕️</span>
```

Or better, use inline SVGs that don't depend on emoji support. Check the CSS for `.about-image-icon` and ensure it has proper dimensions and font-size so the icons display correctly.

---

## SECTION 4: HIGH — Unrealistic Stats on About Page

The "Our Impact" section shows 5,000+ cases, 200+ specialists, 50+ specialties, 98% satisfaction. This is misleading for a pre-launch platform.

In `public/about.html`, find the stats grid and replace with honest pre-launch numbers:

```html
<div class="stat-item reveal stagger-1">
  <div class="stat-number" data-count-to="16" data-count-suffix="">0</div>
  <div class="stat-label" data-en="Medical Specialties" data-ar="تخصص طبي">Medical Specialties</div>
</div>
<div class="stat-item reveal stagger-2">
  <div class="stat-number" data-count-to="47" data-count-suffix="">0</div>
  <div class="stat-label" data-en="Services Available" data-ar="خدمة متاحة">Services Available</div>
</div>
<div class="stat-item reveal stagger-3">
  <div class="stat-number" data-count-to="72" data-count-suffix="h">0</div>
  <div class="stat-label" data-en="Max Turnaround" data-ar="أقصى وقت للرد">Max Turnaround</div>
</div>
<div class="stat-item reveal stagger-4">
  <div class="stat-number" data-count-to="24" data-count-suffix="/7">0</div>
  <div class="stat-label" data-en="Available" data-ar="متاح">Available</div>
</div>
```

---

## SECTION 5: HIGH — Privacy/Terms Pages Missing Header/Footer/Contact

The privacy and terms pages (`public/privacy.html`, `public/terms.html`) have minimal layout without the site nav, footer, or contact info.

For each of these files:
1. Add the same `<nav class="site-nav">` block used in `index.html` (with logo, nav links, language toggle, Sign In, Coming Soon)
2. Add the same `<footer>` block used in `index.html`
3. Add the Google Fonts imports in `<head>`
4. Add the `i18n-site.js` script before `</body>`
5. Link the same CSS files (variables.css, styles.css, animations.css, responsive.css)

---

## SECTION 6: HIGH — Contact Form No Success Feedback

In `public/contact.html`, find the contact form's submit handler. If there's JavaScript handling the form (check for `addEventListener('submit')` in the page or in `public/js/site-main.js`), add a success message display after submission.

If the form uses a simple `<form action="..." method="post">`, add client-side JavaScript:

```javascript
document.querySelector('.contact-form')?.addEventListener('submit', function(e) {
  e.preventDefault();
  var form = this;
  var data = new FormData(form);
  
  fetch(form.action || '/contact', {
    method: 'POST',
    body: data
  }).then(function(res) {
    if (res.ok) {
      form.reset();
      var msg = document.createElement('div');
      msg.className = 'contact-success';
      msg.textContent = 'Thank you! We\'ll get back to you soon.';
      msg.style.cssText = 'background:#e9f7ef; color:#065f46; padding:16px; border-radius:8px; margin-top:16px; font-weight:600;';
      form.parentNode.insertBefore(msg, form.nextSibling);
      setTimeout(function() { msg.remove(); }, 5000);
    }
  }).catch(function() {
    alert('Failed to send. Please try again.');
  });
});
```

If there's no backend endpoint for the contact form, check if there's one and add it. If not, the form can email via a simple POST handler in server.js or use a service like Formspree.

---

## SECTION 7: MEDIUM — Custom 404 Page

The server already has a 404 handler in `src/server.js` that returns plain text. Create a proper branded 404 page.

Create `src/views/404.ejs`:

```html
<%- include('partials/header', { title: '404 - Not Found', layout: 'auth', showNav: false, showFooter: false }) %>
<div class="auth-page">
  <div class="auth-card" style="text-align:center; padding:40px;">
    <div style="font-size:64px; margin-bottom:16px;">🔍</div>
    <h1 style="font-size:24px; margin-bottom:8px;">Page Not Found</h1>
    <p style="color:#64748b; margin-bottom:24px;">The page you're looking for doesn't exist or has been moved.</p>
    <a href="/" class="btn btn-primary" style="display:inline-block; padding:10px 24px;">Go Home</a>
  </div>
</div>
<%- include('partials/footer', { showFooter: false }) %>
```

Then in `src/server.js`, update the 404 handler to use this view:

```javascript
app.use((req, res) => {
  const requestId = req.requestId;
  const pathStr = req.originalUrl || req.url;
  const wantsJson =
    (req.get('accept') || '').includes('application/json') ||
    pathStr.startsWith('/api/') ||
    pathStr.startsWith('/internal/');

  if (wantsJson) {
    return res.status(404).json({ ok: false, error: 'NOT_FOUND', path: pathStr, requestId });
  }

  try {
    return res.status(404).render('404', { title: '404', brand: 'Tashkheesa' });
  } catch (e) {
    return res.status(404).type('text/plain').send('Not found');
  }
});
```

---

## SECTION 8: MEDIUM — "Coming Soon" Button Styling Inconsistency

Search all HTML files for "Coming Soon" buttons and standardize their appearance:

```bash
grep -rn "Coming Soon\|coming-soon" public/*.html src/views/*.ejs
```

All should use this consistent style:
```html
<span class="btn btn-coming-soon btn-sm disabled" style="opacity:0.6; cursor:default; pointer-events:none; background:#94a3b8; color:#fff; border:none;">Coming Soon</span>
```

Make sure none of them use blue backgrounds or have pointer cursor.

---

## VERIFICATION CHECKLIST

After all fixes:
1. Restart server
2. Visit `/register` → fill form → should create account and redirect (no 500)
3. Login with the newly created account → should work
4. Visit `/site/about.html` → no broken images, realistic stats
5. Visit `/site/privacy.html` and `/site/terms.html` → should have full nav and footer
6. Visit `/invalid-route` → should show branded 404 page
7. Submit contact form → should show success message

---

## COMMIT STRATEGY

- Commit 1: "fix: add missing DB columns (country_code etc) to prevent registration 500"
- Commit 2: "fix: wrap registration INSERT in try/catch for graceful errors"
- Commit 3: "fix: about page broken image and unrealistic stats"
- Commit 4: "fix: add header/footer to privacy and terms pages"
- Commit 5: "fix: contact form success feedback"
- Commit 6: "fix: branded 404 page"
- Commit 7: "fix: standardize Coming Soon button styling"
