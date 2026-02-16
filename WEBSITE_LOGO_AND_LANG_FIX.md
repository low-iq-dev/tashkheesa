# FIX: Website Logo + Add EN/AR Language Toggle to All Public Pages

**Project root:** tashkheesa-portal

---

## PROBLEM 1: Logo is broken/clipped in the nav

The logo SVG (`public/assets/brand/tashkheesa-logo-primary.svg`) has viewBox `0 0 980 230` and uses `<text>` elements with fonts Inter and Noto Sans Arabic. Two issues:
1. Those fonts aren't loaded on the public HTML pages → Arabic text "تشخيصه" renders with fallback font and looks garbled
2. At `height: 40px`, the 980-wide SVG gets squeezed and the Arabic portion clips

### Fix 1A: Add Google Fonts to all public HTML pages

In each of these files: `public/index.html`, `public/services.html`, `public/about.html`, `public/doctors.html`, `public/contact.html`

Add these lines in the `<head>` section (before the CSS links):

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+Arabic:wght@400;600;700&display=swap" rel="stylesheet" />
```

### Fix 1B: Increase logo width in nav

In `public/css/styles.css`, find the `.nav-logo` rule (around line 82) and change it:

```css
.nav-logo img {
  height: 40px;
  width: auto;
  max-width: 200px; /* ensure enough room for full wordmark */
}
```

If the logo still clips, increase to `max-width: 240px`.

### Fix 1C: Alternative — use PNG logo instead of SVG

If the SVG still renders poorly after adding fonts (because SVG `<text>` is unreliable across browsers), replace the SVG with the PNG version that already exists.

In all 5 public HTML files, find:
```html
<img src="/site/assets/brand/tashkheesa-logo-primary.svg" alt="Tashkheesa" height="40" />
```

And replace with:
```html
<img src="/site/assets/brand/tashkheesa-logo-full.png" alt="Tashkheesa" height="40" style="width:auto;" />
```

**Try the SVG fix first (1A + 1B). If the logo still looks bad, use the PNG fallback (1C).**

---

## PROBLEM 2: No EN/AR language toggle on public website

The public marketing pages (index.html, services.html, about.html, doctors.html, contact.html) have no way to switch to Arabic. The portal has it, but the public site doesn't.

### Fix 2A: Add EN/AR toggle to the nav in ALL 5 public HTML files

Find the nav-links section in each file. It looks like this:

```html
<div class="nav-links">
  <a href="/site/">Home</a>
  <a href="/site/services.html">Services</a>
  <a href="/site/about.html">About</a>
  <a href="/site/doctors.html">Doctors</a>
  <a href="/site/contact.html">Contact</a>
  <a href="/login" class="nav-signin">Sign In</a>
  <div class="nav-cta">
    <span class="btn btn-coming-soon btn-sm disabled" ...>Coming Soon</span>
  </div>
</div>
```

Add the language toggle BEFORE the Sign In link:

```html
<div class="nav-links">
  <a href="/site/">Home</a>
  <a href="/site/services.html">Services</a>
  <a href="/site/about.html">About</a>
  <a href="/site/doctors.html">Doctors</a>
  <a href="/site/contact.html">Contact</a>
  <div class="nav-lang-toggle">
    <a href="#" onclick="switchLang('en'); return false;" class="lang-btn active" id="lang-en">EN</a>
    <a href="#" onclick="switchLang('ar'); return false;" class="lang-btn" id="lang-ar">AR</a>
  </div>
  <a href="/login" class="nav-signin">Sign In</a>
  <div class="nav-cta">
    <span class="btn btn-coming-soon btn-sm disabled" ...>Coming Soon</span>
  </div>
</div>
```

### Fix 2B: Add the language toggle CSS

In `public/css/styles.css`, add:

```css
/* Language Toggle */
.nav-lang-toggle {
  display: flex;
  align-items: center;
  gap: 2px;
  background: #f0f4ff;
  border-radius: 6px;
  padding: 2px;
  margin: 0 4px;
}

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

.lang-btn:hover:not(.active) {
  color: #1e3a8a;
}
```

### Fix 2C: Create the language switching JavaScript

Create a new file `public/js/i18n-site.js`:

```javascript
// i18n for public marketing site
// Uses data attributes: data-en="English text" data-ar="Arabic text"
// Also handles RTL/LTR direction switching

(function() {
  // Detect saved language
  var savedLang = localStorage.getItem('tashkheesa_lang') || 'en';
  
  window.switchLang = function(lang) {
    lang = (lang === 'ar') ? 'ar' : 'en';
    localStorage.setItem('tashkheesa_lang', lang);
    
    // Also set cookie so server-side pages (login, portal) pick it up
    document.cookie = 'lang=' + lang + '; path=/; max-age=' + (365*24*60*60) + '; SameSite=lax';
    
    // Update HTML dir and lang
    document.documentElement.lang = lang;
    document.documentElement.dir = (lang === 'ar') ? 'rtl' : 'ltr';
    
    // Update all translatable elements
    var elements = document.querySelectorAll('[data-en][data-ar]');
    elements.forEach(function(el) {
      var text = el.getAttribute('data-' + lang);
      if (text) {
        if (el.tagName === 'INPUT' && el.type !== 'hidden') {
          el.placeholder = text;
        } else {
          el.textContent = text;
        }
      }
    });
    
    // Update active state on toggle buttons
    var enBtn = document.getElementById('lang-en');
    var arBtn = document.getElementById('lang-ar');
    if (enBtn) enBtn.classList.toggle('active', lang === 'en');
    if (arBtn) arBtn.classList.toggle('active', lang === 'ar');
    
    // Update nav links text
    var navTranslations = {
      'Home': 'الرئيسية',
      'Services': 'الخدمات',
      'About': 'عن تشخيصه',
      'Doctors': 'الأطباء',
      'Contact': 'تواصل معنا',
      'Sign In': 'تسجيل الدخول',
      'Coming Soon': 'قريباً',
      'Our Services': 'خدماتنا',
      'Get Started': 'ابدأ الآن'
    };
    
    document.querySelectorAll('.nav-links a, .nav-cta .btn, .hero-buttons a, .hero-buttons span').forEach(function(el) {
      var enText = el.getAttribute('data-en') || el.textContent.trim();
      if (!el.getAttribute('data-en') && enText) {
        el.setAttribute('data-en', enText);
        var arText = navTranslations[enText];
        if (arText) el.setAttribute('data-ar', arText);
      }
      var targetText = el.getAttribute('data-' + lang);
      if (targetText) el.textContent = targetText;
    });
  };
  
  // Apply saved language on page load
  if (savedLang === 'ar') {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() { switchLang('ar'); });
    } else {
      switchLang('ar');
    }
  }
})();
```

### Fix 2D: Include the script in all 5 public HTML files

Add before `</body>` in each file:

```html
<script src="/site/js/i18n-site.js"></script>
```

### Fix 2E: Add data-en/data-ar attributes to key content sections

For the homepage (`index.html`), add translation attributes to the main content elements. Example for the hero:

```html
<span class="hero-kicker hero-fade-in" data-en="Trusted Medical Second Opinions" data-ar="آراء طبية ثانية موثوقة">Trusted Medical Second Opinions</span>
<h1 class="hero-fade-in" data-en="Expert Medical Consultations, Anytime, Anywhere" data-ar="استشارات طبية متخصصة، في أي وقت ومن أي مكان">Expert Medical Consultations, Anytime, Anywhere</h1>
<p class="hero-fade-in" data-en="Connect with verified specialists for second opinions, diagnostic reviews, and treatment guidance. Secure, fast, and built for clarity." data-ar="تواصل مع أطباء متخصصين معتمدين للحصول على رأي طبي ثانٍ، مراجعة تشخيصية، وإرشاد علاجي. آمن وسريع وواضح.">Connect with verified specialists for second opinions, diagnostic reviews, and treatment guidance. Secure, fast, and built for clarity.</p>
```

For the "Why Choose Us" section:

```html
<span data-en="WHY CHOOSE US" data-ar="لماذا تختارنا">WHY CHOOSE US</span>
<h2 data-en="Healthcare Built Around You" data-ar="رعاية صحية مبنية حولك">Healthcare Built Around You</h2>
<p data-en="Everything you need for confident medical decisions, in one secure platform." data-ar="كل ما تحتاجه لاتخاذ قرارات طبية واثقة، في منصة واحدة آمنة.">Everything you need for confident medical decisions, in one secure platform.</p>
```

For the 4 feature cards:

```html
<h3 data-en="Quick Appointments" data-ar="مواعيد سريعة">Quick Appointments</h3>
<p data-en="Schedule consultations within minutes and get connected with specialists fast." data-ar="حجز استشارات في دقائق والتواصل مع المتخصصين بسرعة.">Schedule consultations within minutes and get connected with specialists fast.</p>

<h3 data-en="Verified Doctors" data-ar="أطباء معتمدون">Verified Doctors</h3>
<p data-en="Every specialist is hospital-based, credentialed, and peer-reviewed." data-ar="كل متخصص يعمل في مستشفى، معتمد، ومُراجع من أقرانه.">Every specialist is hospital-based, credentialed, and peer-reviewed.</p>

<h3 data-en="Secure & Private" data-ar="آمن وخاص">Secure & Private</h3>
<p data-en="End-to-end encryption for all uploads, records, and communication." data-ar="تشفير شامل لجميع الملفات والسجلات والمحادثات.">End-to-end encryption for all uploads, records, and communication.</p>

<h3 data-en="24/7 Available" data-ar="متاح ٢٤/٧">24/7 Available</h3>
<p data-en="Access your consultations and reports anytime, from any device." data-ar="اطلع على استشاراتك وتقاريرك في أي وقت ومن أي جهاز.">Access your consultations and reports anytime, from any device.</p>
```

Do the same for ALL text content sections on ALL 5 public pages. Add `data-en` and `data-ar` attributes to every heading, paragraph, button, and card that has user-facing text.

### Fix 2F: Add RTL CSS support

In `public/css/styles.css`, add at the bottom:

```css
/* RTL Support */
[dir="rtl"] .nav-inner {
  flex-direction: row-reverse;
}

[dir="rtl"] .nav-links {
  flex-direction: row-reverse;
}

[dir="rtl"] .hero-grid {
  direction: rtl;
}

[dir="rtl"] .hero-content {
  text-align: right;
}

[dir="rtl"] .hero-buttons {
  justify-content: flex-end;
}

[dir="rtl"] .site-footer {
  text-align: right;
}

[dir="rtl"] .section-header {
  text-align: center; /* keep centered sections centered */
}
```

---

## COMMIT

```
fix: fix logo rendering on public site, add EN/AR language toggle to all pages
```
