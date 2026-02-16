# DEFINITIVE FIX: Logo + Verify Toggle Rendering

**Project root:** tashkheesa-portal

---

## FIX 1: Logo — Replace Text-Based SVG with Path-Based Version

**Root cause:** The SVG at `public/assets/brand/tashkheesa-logo-primary.svg` uses `<text>` elements. Even with Google Fonts loaded in the HTML `<head>`, SVG `<text>` elements render using their own font context — the HTML page's font imports do NOT apply inside SVG images loaded via `<img>`. The Arabic text "تشخيصه" will always render with a system fallback font and look broken.

**The only reliable fix:** Remove the Arabic text from the logo SVG entirely. Show just the icon + English wordmark. This is actually better for the nav anyway — cleaner and simpler. The Arabic branding can appear on the Arabic version of the page as regular HTML.

Replace the ENTIRE contents of `public/assets/brand/tashkheesa-logo-primary.svg` with:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 60" role="img" aria-labelledby="title">
  <title id="title">Tashkheesa</title>
  <defs>
    <linearGradient id="g" x1="0" y1="2" x2="52" y2="56" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2f8dff"/>
      <stop offset="1" stop-color="#1f62e3"/>
    </linearGradient>
  </defs>
  <!-- Icon: rounded blue square with checkmark + smile arc -->
  <rect x="2" y="4" width="52" height="52" rx="13" fill="url(#g)"/>
  <path d="M15 30 l9 9 l20-20" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M17 39 C17 47 22 51 30 51 C38 51 43 47 43 39" fill="none" stroke="#53c7ff" stroke-width="3.5" stroke-linecap="round"/>
  <!-- English wordmark only (no font dependency for Arabic) -->
  <text x="66" y="40" fill="#1e3a8a" font-family="Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="28" font-weight="700" letter-spacing="-0.5">Tashkheesa</text>
</svg>
```

Key changes:
- Removed Arabic text and divider entirely (viewBox is now `0 0 320 60`)
- English "Tashkheesa" with broad system font stack so it degrades gracefully
- Much tighter viewBox = renders perfectly at `height: 40px`
- Arabic branding will come from the page itself when language is switched

**Then** update `.site-nav .nav-logo img` in `public/css/styles.css`:

```css
.site-nav .nav-logo img {
  height: 40px;
  width: auto;
  max-width: 220px;
}
```

---

## FIX 2: Verify toggle actually renders correctly after previous CSS fix

The previous prompt already added `:not(.lang-btn):not(.nav-signin)` exclusions to `.site-nav .nav-links a` selectors and added `.nav-lang-toggle .lang-btn::after { display: none !important; }`. 

**Verify this is working** by opening tashkheesa.com in a browser, inspecting the EN button element, and confirming:
- No `::after` pseudo-element creating an underline
- `background: #1e3a8a` on the `.active` button (EN)
- `color: #ffffff` on the active button
- Both buttons sit inside a light blue pill (`background: #f0f4ff` on `.nav-lang-toggle`)

If the toggle STILL looks wrong in production, it may be a **caching issue**. Add a cache-busting query param to the CSS link in all 5 HTML files:

```html
<link rel="stylesheet" href="/site/css/styles.css?v=20260215" />
```

Do this in: `index.html`, `services.html`, `about.html`, `doctors.html`, `contact.html`.

---

## FIX 3: Portal-side EN/AR toggles — audit and standardize

The portal uses EN/AR toggles in multiple places with different HTML patterns. Make sure they all work correctly:

### 3A: Portal sidebar toggle (layouts/portal.ejs, line ~108)

Currently:
```html
<div class="section-cta">
  <a class="btn btn-secondary btn-full" href="/lang/en?next=...">EN</a>
  <a class="btn btn-secondary btn-full" href="/lang/ar?next=...">AR</a>
</div>
```

This uses `btn btn-secondary btn-full` classes and sits inside `.portal-sidebar .section-cta`. These are properly styled in `portal-global.css` so should be fine. **No changes needed** unless they look wrong.

### 3B: Doctor header toggle (partials/doctor_header.ejs, line ~47)

Currently:
```html
<span class="pill lang-switch">
  <a class="lang-link" href="/lang/en?next=...">EN</a>
  |
  <a class="lang-link" href="/lang/ar?next=...">AR</a>
</span>
```

Check that `.pill` and `.lang-link` and `.lang-switch` classes are styled in portal CSS files. Search for `.lang-switch` and `.lang-link` in all CSS files. If they have NO CSS rules, add styling in `portal-global.css`:

```css
/* Doctor header language toggle */
.lang-switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8rem;
  color: #64748b;
}

.lang-switch .lang-link {
  padding: 3px 8px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 0.75rem;
  color: #64748b;
  text-decoration: none;
  transition: all 0.2s;
}

.lang-switch .lang-link:hover {
  background: #e8eeff;
  color: #1e3a8a;
}
```

### 3C: Login page toggle (login.ejs, line ~23)

```html
<div class="auth-actions">
  <a href="/lang/en?next=...">EN</a>
  <a href="/lang/ar?next=...">AR</a>
</div>
```

Uses `.auth-actions` which is a flex container for the login page. These are plain `<a>` tags. Check the auth styles — if `.auth-actions a` has styles that make them look weird, they need exclusion or specific styling. Search for `.auth-actions` in the CSS.

### 3D: Other pages with toggles

- `forgot_password.ejs` — same `.auth-actions` pattern as login
- `intake_form.ejs` — uses `btn btn-secondary` inside `.portal-hero-actions`
- `public_case_new.ejs` — uses `btn btn-secondary` inside `.section-cta`
- `order_payment.ejs` — uses `.lang-switch` wrapper
- `doctor_queue.ejs` — uses `.lang-switch` wrapper

**For each one, verify the toggle is styled and functional.** If any use bare `<a>` tags without classes inside a parent that styles all `<a>` descendants, add specific classes or `:not()` exclusions just like we did for the marketing site nav.

---

## COMMIT

```
fix: replace logo SVG text with English-only wordmark, verify all EN/AR toggles site-wide
```
