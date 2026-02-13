/* Tashkheesa Marketing Site - Form Validation & Submit */
(function () {
  'use strict';

  var form = document.getElementById('contact-form');
  if (!form) return;

  function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function showError(field, msg) {
    var group = field.closest('.form-group');
    if (!group) return;
    group.classList.add('has-error');
    var errorEl = group.querySelector('.error-msg');
    if (errorEl) errorEl.textContent = msg;
  }

  function clearError(field) {
    var group = field.closest('.form-group');
    if (!group) return;
    group.classList.remove('has-error');
  }

  function clearAllErrors() {
    form.querySelectorAll('.form-group').forEach(function (g) {
      g.classList.remove('has-error');
    });
  }

  // Real-time validation
  form.querySelectorAll('input, textarea, select').forEach(function (field) {
    field.addEventListener('input', function () {
      clearError(field);
    });
  });

  function showToast(message) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(function () {
      toast.classList.add('show');
    });

    setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () { toast.remove(); }, 300);
    }, 4000);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearAllErrors();

    var valid = true;

    var name = form.querySelector('[name="name"]');
    var email = form.querySelector('[name="email"]');
    var subject = form.querySelector('[name="subject"]');
    var message = form.querySelector('[name="message"]');

    if (name && !name.value.trim()) {
      showError(name, 'Please enter your name');
      valid = false;
    }

    if (email && !email.value.trim()) {
      showError(email, 'Please enter your email');
      valid = false;
    } else if (email && !validateEmail(email.value.trim())) {
      showError(email, 'Please enter a valid email address');
      valid = false;
    }

    if (subject && !subject.value.trim()) {
      showError(subject, 'Please select a subject');
      valid = false;
    }

    if (message && !message.value.trim()) {
      showError(message, 'Please enter a message');
      valid = false;
    }

    if (!valid) {
      var firstError = form.querySelector('.has-error input, .has-error textarea, .has-error select');
      if (firstError) firstError.focus();
      return;
    }

    // Simulate submit success
    var btn = form.querySelector('button[type="submit"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Sending...';
    }

    setTimeout(function () {
      form.reset();
      showToast('Message sent successfully! We\'ll get back to you soon.');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Send Message';
      }
    }, 1000);
  });
})();
