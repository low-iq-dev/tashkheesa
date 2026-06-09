/* Phone-OTP login (web) — wires the Phone tab on /login.
 * Talks to POST /login/otp/request and /login/otp/verify (CSRF via x-csrf-token).
 * No inline JS (CSP-friendly, served from /js). Progressive: if this fails to
 * load, the email/password form still works. */
(function () {
  'use strict';

  var card = document.querySelector('.auth-card');
  if (!card) return;
  var emailPanel = card.querySelector('[data-panel="email"]');
  var phonePanel = card.querySelector('[data-panel="phone"]');
  var tabs = Array.prototype.slice.call(card.querySelectorAll('.auth-tab'));
  if (!emailPanel || !phonePanel || !tabs.length) return;

  var i18n = {
    required: phonePanel.getAttribute('data-i18n-required') || 'Enter your phone number.',
    invalid: phonePanel.getAttribute('data-i18n-invalid') || 'The code is incorrect or expired.',
    error: phonePanel.getAttribute('data-i18n-error') || 'Something went wrong. Please try again.',
    ratelimited: phonePanel.getAttribute('data-i18n-ratelimited') || 'Too many attempts. Please wait a bit and try again.',
    resend: phonePanel.getAttribute('data-i18n-resend') || 'Resend code',
    resendIn: phonePanel.getAttribute('data-i18n-resend-in') || 'Resend in',
    seconds: phonePanel.getAttribute('data-i18n-seconds') || 's'
  };
  var COOLDOWN = parseInt(phonePanel.getAttribute('data-cooldown'), 10) || 60;

  function csrfToken() {
    // Prefer the panel's own token (decoupled from the email form's structure);
    // fall back to the email form's hidden _csrf input.
    var fromPanel = phonePanel.getAttribute('data-csrf');
    if (fromPanel) return fromPanel;
    var el = document.querySelector('input[name="_csrf"]');
    return el ? el.value : '';
  }
  function nextParam() {
    var el = document.querySelector('input[name="next"]');
    return el && el.value ? el.value : '';
  }
  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': csrfToken()
      },
      body: JSON.stringify(body)
    });
  }

  var msg = phonePanel.querySelector('.auth-phone-msg');
  function showMsg(text) {
    if (!msg) return;
    msg.textContent = text || '';
    msg.hidden = !text;
  }

  // ---- tab switching ----
  function activate(which) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === which;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    emailPanel.hidden = which !== 'email';
    phonePanel.hidden = which !== 'phone';
    showMsg('');
    if (which === 'phone' && phoneInput) phoneInput.focus();
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { activate(t.getAttribute('data-tab')); });
  });

  // ---- elements ----
  var stepPhone = phonePanel.querySelector('[data-step="phone"]');
  var stepOtp = phonePanel.querySelector('[data-step="otp"]');
  var ccInput = phonePanel.querySelector('.auth-cc');
  var phoneInput = phonePanel.querySelector('.auth-phone-number');
  var sendBtn = phonePanel.querySelector('[data-action="send"]');
  var verifyBtn = phonePanel.querySelector('[data-action="verify"]');
  var backBtn = phonePanel.querySelector('[data-action="back"]');
  var resendBtn = phonePanel.querySelector('[data-action="resend"]');
  var target = phonePanel.querySelector('.auth-otp-target');
  var boxes = Array.prototype.slice.call(phonePanel.querySelectorAll('.auth-otp-box'));

  function getPhone() {
    return {
      countryCode: ((ccInput && ccInput.value) || '').trim(),
      phone: ((phoneInput && phoneInput.value) || '').trim()
    };
  }
  function setStep(which) {
    if (stepPhone) stepPhone.hidden = which !== 'phone';
    if (stepOtp) stepOtp.hidden = which !== 'otp';
  }
  function otpValue() { return boxes.map(function (b) { return b.value; }).join(''); }
  function clearBoxes() { boxes.forEach(function (b) { b.value = ''; }); }

  // ---- resend cooldown ----
  var timer = null;
  function startCooldown() {
    if (!resendBtn) return;
    var left = COOLDOWN;
    resendBtn.disabled = true;
    if (timer) clearInterval(timer);
    function tick() {
      if (left <= 0) {
        clearInterval(timer); timer = null;
        resendBtn.disabled = false;
        resendBtn.textContent = i18n.resend;
        return;
      }
      resendBtn.textContent = i18n.resendIn + ' ' + left + i18n.seconds;
      left--;
    }
    tick();
    timer = setInterval(tick, 1000);
  }

  // ---- send / resend ----
  var busy = false;
  function requestCode(isResend) {
    var p = getPhone();
    if (!p.phone) { showMsg(i18n.required); return; }
    if (busy) return;
    busy = true; showMsg('');
    var btn = isResend ? resendBtn : sendBtn;
    if (btn && !isResend) btn.disabled = true;
    post('/login/otp/request', p).then(function (r) {
      busy = false;
      if (btn && !isResend) btn.disabled = false;
      if (r.status === 429) { showMsg(i18n.ratelimited); return; }
      // Anti-enumeration: advance to code entry regardless of whether the
      // number is registered or valid — the server masks all cases as success.
      if (target) target.textContent = p.countryCode + ' ' + p.phone;
      setStep('otp');
      clearBoxes();
      if (boxes[0]) boxes[0].focus();
      startCooldown();
    }).catch(function () {
      busy = false;
      if (btn && !isResend) btn.disabled = false;
      showMsg(i18n.error);
    });
  }

  // ---- verify ----
  function verifyCode() {
    var code = otpValue();
    if (code.length !== 6 || busy) return;
    busy = true; showMsg('');
    if (verifyBtn) verifyBtn.disabled = true;
    var p = getPhone();
    var body = { countryCode: p.countryCode, phone: p.phone, otp: code };
    var nx = nextParam(); if (nx) body.next = nx;
    post('/login/otp/verify', body).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        return { status: r.status, data: data };
      });
    }).then(function (res) {
      busy = false;
      if (verifyBtn) verifyBtn.disabled = false;
      if (res.status === 429) { showMsg(i18n.ratelimited); return; }
      if (res.data && res.data.ok && res.data.redirect) {
        window.location.assign(res.data.redirect);
        return;
      }
      showMsg((res.data && res.data.error) || i18n.invalid);
      clearBoxes();
      if (boxes[0]) boxes[0].focus();
    }).catch(function () {
      busy = false;
      if (verifyBtn) verifyBtn.disabled = false;
      showMsg(i18n.error);
    });
  }

  // ---- OTP box behavior: auto-advance, backspace, paste ----
  boxes.forEach(function (box, i) {
    box.addEventListener('input', function () {
      box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      if (otpValue().length === 6) verifyCode();
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
    });
    box.addEventListener('paste', function (e) {
      e.preventDefault();
      var txt = ((e.clipboardData || window.clipboardData).getData('text') || '');
      var digits = txt.replace(/[^0-9]/g, '').slice(0, 6).split('');
      if (!digits.length) return;
      boxes.forEach(function (b, j) { b.value = digits[j] || ''; });
      var last = Math.min(digits.length, boxes.length) - 1;
      if (boxes[last]) boxes[last].focus();
      if (otpValue().length === 6) verifyCode();
    });
  });

  if (sendBtn) sendBtn.addEventListener('click', function () { requestCode(false); });
  if (resendBtn) resendBtn.addEventListener('click', function () {
    if (!resendBtn.disabled) requestCode(true);
  });
  if (verifyBtn) verifyBtn.addEventListener('click', verifyCode);
  if (backBtn) backBtn.addEventListener('click', function () {
    showMsg(''); setStep('phone');
    if (phoneInput) phoneInput.focus();
  });
  if (phoneInput) phoneInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); requestCode(false); }
  });
})();
