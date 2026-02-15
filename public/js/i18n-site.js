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
