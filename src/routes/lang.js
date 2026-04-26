// src/routes/lang.js
// Language switch endpoint with safe redirect logic.

var express = require('express');
var router = express.Router();

// pg helper — used to persist patient lang preference so notifications match the UI.
// Loaded lazily-tolerant: if pg is unavailable in some test harness, the toggle still works.
var pgHelper = null;
try { pgHelper = require('../pg'); } catch (_e) { pgHelper = null; }

function setupLangRoutes(opts) {
  var COOKIE_SECURE = opts.COOKIE_SECURE;
  var COOKIE_SAMESITE = opts.COOKIE_SAMESITE;

  function sanitizeNext(nextVal) {
    if (!nextVal) return null;
    var s = String(nextVal).trim();
    if (!s) return null;

    var MAX_NEXT_LEN = 2048;
    if (s.length > MAX_NEXT_LEN) s = s.slice(0, MAX_NEXT_LEN);

    if (/[\u0000-\u001F\u007F]/.test(s)) return null;
    if (s.indexOf('\\') !== -1) return null;
    if (s.indexOf('://') !== -1 || s.startsWith('//')) return null;
    if (!s.startsWith('/')) return null;
    if (s.startsWith('/lang/')) return null;

    return s;
  }

  router.get('/lang/:code', function(req, res) {
    var code = req.params.code === 'ar' ? 'ar' : 'en';

    if (req.session) {
      req.session.lang = code;
    }

    res.cookie('lang', code, {
      httpOnly: false,
      sameSite: COOKIE_SAMESITE,
      secure: COOKIE_SECURE,
      maxAge: 365 * 24 * 60 * 60 * 1000
    });

    // Persist preference on the user row so outbound WhatsApp/email match the UI choice.
    // Patients only — doctor/admin notification flows are out of scope for the patient migration.
    // Fire-and-forget: never block the redirect on a DB hiccup.
    if (pgHelper && pgHelper.execute && req.user && req.user.role === 'patient' && req.user.id) {
      pgHelper.execute('UPDATE users SET lang = $1 WHERE id = $2', [code, req.user.id])
        .catch(function(e) { console.warn('[lang] users.lang persist failed:', e && e.message ? e.message : e); });
    }

    function roleDefault() {
      if (!req.user) return '/login';
      switch (req.user.role) {
        case 'patient': return '/dashboard';
        case 'doctor': return '/portal/doctor';
        case 'admin': return '/admin';
        case 'superadmin': return '/superadmin';
        default: return '/dashboard';
      }
    }

    var host = String(req.get('host') || '').toLowerCase();
    var ref = String(req.get('referer') || '');

    var target = (req.cookies && req.cookies.last_path) ? req.cookies.last_path : roleDefault();

    var nextParam = sanitizeNext(req.query && req.query.next);
    if (nextParam) {
      target = nextParam;
    } else if (ref) {
      try {
        var u = new URL(ref, 'http://' + (host || 'localhost'));
        if (!host || String(u.host || '').toLowerCase() === host) {
          var p = (u.pathname || '') + (u.search || '') + (u.hash || '');
          if (p && !p.startsWith('/lang/')) {
            target = p;
          }
        }
      } catch (e) {
        // ignore parse errors
      }
    }

    target = sanitizeNext(target) || roleDefault();

    if (req.session && typeof req.session.save === 'function') {
      return req.session.save(function() { res.redirect(302, target); });
    }
    return res.redirect(302, target);
  });

  return router;
}

module.exports = { setupLangRoutes: setupLangRoutes };
