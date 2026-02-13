/* Tashkheesa Marketing Site - Main JS */
(function () {
  'use strict';

  // Sticky nav shadow on scroll
  var nav = document.querySelector('.site-nav');
  if (nav) {
    window.addEventListener('scroll', function () {
      if (window.scrollY > 10) {
        nav.classList.add('nav-scrolled');
      } else {
        nav.classList.remove('nav-scrolled');
      }
    }, { passive: true });
  }

  // Hamburger toggle
  var hamburger = document.querySelector('.hamburger');
  var navLinks = document.querySelector('.nav-links');
  var navOverlay = document.querySelector('.nav-overlay');
  var siteNav = document.querySelector('.site-nav');

  if (hamburger && navLinks) {
    hamburger.addEventListener('click', function () {
      siteNav.classList.toggle('nav-open');
      document.body.style.overflow = siteNav.classList.contains('nav-open') ? 'hidden' : '';
    });

    if (navOverlay) {
      navOverlay.addEventListener('click', function () {
        siteNav.classList.remove('nav-open');
        document.body.style.overflow = '';
      });
    }

    // Close on link click (mobile)
    navLinks.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        siteNav.classList.remove('nav-open');
        document.body.style.overflow = '';
      });
    });
  }

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      var targetId = this.getAttribute('href');
      if (targetId === '#') return;
      var target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        var navHeight = nav ? nav.offsetHeight : 0;
        var top = target.getBoundingClientRect().top + window.pageYOffset - navHeight - 20;
        window.scrollTo({ top: top, behavior: 'smooth' });
      }
    });
  });

  // Set active nav link
  var currentPath = window.location.pathname.replace('/site/', '/').replace('.html', '');
  if (currentPath === '/site' || currentPath === '/site/') currentPath = '/';
  document.querySelectorAll('.nav-links a').forEach(function (link) {
    var href = link.getAttribute('href');
    if (!href) return;
    var linkPath = href.replace('/site/', '/').replace('.html', '');
    if (linkPath === currentPath || (currentPath === '/' && (linkPath === '/' || href === '/site/' || href === '/site/index.html'))) {
      link.classList.add('active');
    }
  });
})();
