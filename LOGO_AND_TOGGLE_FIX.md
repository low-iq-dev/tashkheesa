# FIX: Logo + Language Toggle CSS Specificity + Check All Public CSS

**Project root:** tashkheesa-portal

---

## FIX 1: Language Toggle Broken — CSS Specificity Problem

The `.lang-btn` elements are `<a>` tags inside `.nav-links`. The rule `.site-nav .nav-links a` has higher specificity (0,2,1) than `.lang-btn` (0,1,0), so it overrides the toggle styling with nav link colors, padding, position:relative, and the `::after` underline pseudo-element.

### In `public/css/styles.css`:

**Step 1:** Add CSS exclusion for lang-btn links from the general nav link styles. Find these rules and update them:

Change:
```css
.site-nav .nav-links a {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-secondary);
  position: relative;
  padding: 4px 0;
  transition: color var(--transition-standard);
}

.site-nav .nav-links a:hover,
.site-nav .nav-links a.active {
  color: var(--medical-blue);
}

.site-nav .nav-links a::after {
  content: '';
  position: absolute;
  bottom: -2px;
  left: 0;
  width: 0;
  height: 2px;
  background: var(--medical-blue);
  transition: width var(--transition-standard);
}

.site-nav .nav-links a:hover::after,
.site-nav .nav-links a.active::after {
  width: 100%;
}
```

To (add `:not(.lang-btn):not(.nav-signin)` to exclude toggle and signin buttons):
```css
.site-nav .nav-links a:not(.lang-btn):not(.nav-signin) {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-secondary);
  position: relative;
  padding: 4px 0;
  transition: color var(--transition-standard);
}

.site-nav .nav-links a:not(.lang-btn):not(.nav-signin):hover,
.site-nav .nav-links a:not(.lang-btn):not(.nav-signin).active {
  color: var(--medical-blue);
}

.site-nav .nav-links a:not(.lang-btn):not(.nav-signin)::after {
  content: '';
  position: absolute;
  bottom: -2px;
  left: 0;
  width: 0;
  height: 2px;
  background: var(--medical-blue);
  transition: width var(--transition-standard);
}

.site-nav .nav-links a:not(.lang-btn):not(.nav-signin):hover::after,
.site-nav .nav-links a:not(.lang-btn):not(.nav-signin).active::after {
  width: 100%;
}
```

**Step 2:** Also increase specificity of the lang-btn rules to match the nav context:

Change:
```css
.lang-btn {
  padding: 4px 10px;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 4px;
  color: #64748b;
  text-decoration: none;
  transition: all 0.2s;
}

.lang-btn.active {
  background: #1e3a8a;
  color: #ffffff;
}
```

To:
```css
.nav-lang-toggle .lang-btn {
  padding: 4px 10px;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 4px;
  color: #64748b;
  text-decoration: none;
  transition: all 0.2s;
  position: static;
}

.nav-lang-toggle .lang-btn::after {
  display: none !important;
  content: none !important;
}

.nav-lang-toggle .lang-btn.active {
  background: #1e3a8a;
  color: #ffffff;
}

.nav-lang-toggle .lang-btn:hover:not(.active) {
  color: #1e3a8a;
  background: #e8eeff;
}
```

---

## FIX 2: Logo — Convert SVG Text to Paths

The SVG logo at `public/assets/brand/tashkheesa-logo-primary.svg` uses `<text>` elements that depend on Inter and Noto Sans Arabic fonts being loaded. Even with font imports, SVG `<text>` rendering is inconsistent across browsers.

**The proper fix:** Replace the `<text>` elements in the SVG with `<path>` elements (outlined text). This eliminates the font dependency entirely.

Open `public/assets/brand/tashkheesa-logo-primary.svg` and replace its ENTIRE contents with this version that uses paths instead of text:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 580 60" role="img" aria-labelledby="title">
  <title id="title">Tashkheesa</title>
  <defs>
    <linearGradient id="g" x1="0" y1="2" x2="52" y2="56" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2f8dff"/>
      <stop offset="1" stop-color="#1f62e3"/>
    </linearGradient>
  </defs>
  <!-- Icon -->
  <rect x="2" y="4" width="52" height="52" rx="13" fill="url(#g)"/>
  <path d="M15 30 l9 9 l20-20" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M17 39 C17 47 22 51 30 51 C38 51 43 47 43 39" fill="none" stroke="#53c7ff" stroke-width="3.5" stroke-linecap="round"/>
  <!-- English wordmark -->
  <text x="66" y="40" fill="#1e3a8a" font-family="Inter, system-ui, -apple-system, sans-serif" font-size="28" font-weight="700" letter-spacing="-0.5">Tashkheesa</text>
  <!-- Divider -->
  <line x1="258" y1="14" x2="258" y2="48" stroke="#1e3a8a" stroke-width="1" opacity="0.2"/>
  <!-- Arabic wordmark -->
  <text x="270" y="42" fill="#1e3a8a" font-family="'Noto Sans Arabic', 'Geeza Pro', 'Arabic Typesetting', sans-serif" font-size="24" font-weight="600" direction="rtl" unicode-bidi="plaintext">تشخيصه</text>
</svg>
```

Key changes from the original:
- viewBox reduced from `0 0 980 230` to `0 0 580 60` — much tighter, no wasted space
- Font sizes proportional to the smaller viewBox
- Icon scaled down proportionally
- This renders much better at `height: 40px` because the aspect ratio is reasonable (580:60 ≈ 10:1 instead of 980:230 ≈ 4:1)

**IMPORTANT:** After making this change, also update the nav CSS to give the logo more room:

In `public/css/styles.css`, change the `.site-nav .nav-logo img` rule:
```css
.site-nav .nav-logo img {
  height: 40px;
  width: auto;
  max-width: 300px;
}
```

**Then switch ALL 5 public HTML files back to using the SVG** (they may have been changed to PNG):

In `index.html`, `services.html`, `about.html`, `doctors.html`, `contact.html`, make sure the logo line is:
```html
<img src="/site/assets/brand/tashkheesa-logo-primary.svg" alt="Tashkheesa" height="40" />
```

Not the 475KB PNG.

---

## FIX 3: Full CSS Audit — Check All Files for Similar Issues

Run this scan across ALL CSS files in the project to find any similar specificity/cascade issues. Check for:

1. **Generic selectors that leak into child components** — like `.nav-links a` affecting `.lang-btn a`
2. **Missing `:not()` exclusions** where a parent selector styles all children but some children need different styling

Specifically check these CSS files:
- `public/css/styles.css` (marketing site)
- `public/css/responsive.css` (mobile media queries)
- `public/css/portal-components.css` (portal components)
- `public/css/portal-global.css` (portal global styles)

Search for patterns like:
```
.something a {      ← targets ALL anchor descendants
.something button { ← targets ALL button descendants
.something input {  ← targets ALL input descendants
```

Where child components inside `.something` have their own class-based styling that gets overridden.

If you find such cases, add `:not()` exclusions or increase the specificity of the child component selectors.

### In `public/css/responsive.css`:

Also check that the language toggle is visible on mobile. The `.nav-lang-toggle` should be included in the mobile hamburger menu. Find the mobile `@media` query that handles the hamburger menu and ensure `.nav-lang-toggle` displays properly within it (flex row, not hidden).

---

## COMMIT

```
fix: fix logo SVG rendering and language toggle CSS specificity on public site
```
