// src/middleware/requirePhone.js
//
// P0-FORM-1: Backfill gate for patients without a phone number.
//
// Behavior:
//   - Inert when req.user is unset (lets auth middleware decide)
//   - Inert when role !== 'patient' (doctors / admins / superadmins
//     pass through unconditionally — important for shared routes
//     like /portal/messages that serve both roles)
//   - Inert when req.user.phone is non-empty (the happy path)
//   - Inert on the explicit EXEMPT_PREFIXES list — so the user can
//     reach the onboarding wizard, edit their profile, log out, etc.
//   - Inert on /api/* — mobile API gating is filed as P3-AUTH-2
//     (needs JSON-shaped backfill UX, not a 302 redirect)
//   - Otherwise: redirect to /portal/patient/onboarding with
//     ?force_phone=1 and the original URL captured in ?next= so
//     the onboarding POST can bounce them back when done.

'use strict';

// Path PREFIXES (startsWith match). Order doesn't matter; first hit wins.
var EXEMPT_PREFIXES = [
  '/portal/patient/onboarding',  // gate destination — gating it would loop
  '/patient/profile',            // phone-edit surface (must be reachable)
  '/lang/',                      // language switching
  '/logout'
];

function _isExempt(path) {
  for (var i = 0; i < EXEMPT_PREFIXES.length; i++) {
    if (path.indexOf(EXEMPT_PREFIXES[i]) === 0) return true;
  }
  return false;
}

function requirePhone() {
  return function (req, res, next) {
    if (!req.user) return next();
    if (req.user.role !== 'patient') return next();
    if (req.user.phone && String(req.user.phone).trim().length > 0) return next();

    var path = (req.path || (req.url || '').split('?')[0]) || '/';
    if (_isExempt(path)) return next();
    if (path.indexOf('/api/') === 0) return next(); // P3-AUTH-2

    var origUrl = req.originalUrl || req.url || '/';
    var nextParam = encodeURIComponent(origUrl);
    return res.redirect('/portal/patient/onboarding?force_phone=1&next=' + nextParam);
  };
}

module.exports = {
  requirePhone: requirePhone,
  EXEMPT_PREFIXES: EXEMPT_PREFIXES
};
