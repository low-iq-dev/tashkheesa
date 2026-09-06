// src/middleware/patient_unread.js
//
// AUDIT-UNREAD-2026-09-06 — makes the unread-messages count available to the
// patient chrome on every page, as `res.locals.patientUnreadMessages`.
//
// WHY MIDDLEWARE AND NOT SIX ROUTE HANDLERS. The badge is rendered by
// partials/patient/{head,sidebar,mobile-tabbar}, which every patient page
// includes, and EJS partials cannot query. Before this, six views passed the
// literal `unreadCount: 0` into that chrome and one (the dashboard) passed a
// number computed by a query against columns that do not exist. Threading the
// value through each route would have left the same shape — six places to
// forget — so the value is computed once, next to the gate that already runs on
// every patient request, and the views read it.
//
// Self-gating, in this order, because each condition removes work:
//   * a signed-in patient only        — no role, no badge, no query
//   * GET only                        — a POST renders no chrome worth badging
//   * not an API / asset / file path  — those return JSON or bytes
//
// Failure is LOUD-but-harmless: the count falls back to 0 (identical to the
// behaviour this replaces) and the error is written to error_logs. It must not
// be silent — a bare catch on this exact query is what hid the missing-column
// bug for the entire life of the feature.

'use strict';

const { logErrorToDb } = require('../logger');

// Paths that render no patient chrome. Prefix-matched.
const SKIP_PREFIXES = [
  '/api/', '/files/', '/uploads/', '/assets/', '/js/', '/css/', '/fonts/',
  '/icons/', '/vendor/', '/site/', '/webhooks/', '/payments/', '/ops/'
];

function patientUnreadMessages() {
  return async function (req, res, next) {
    try {
      const user = req.user;
      if (!user || String(user.role || '').toLowerCase() !== 'patient') return next();
      if (req.method !== 'GET') return next();
      const p = String(req.path || '');
      for (const prefix of SKIP_PREFIXES) {
        if (p.startsWith(prefix)) return next();
      }

      const { countPatientUnreadMessages } = require('../services/patient_unread');
      res.locals.patientUnreadMessages = await countPatientUnreadMessages(user.id);
    } catch (err) {
      // 0 is the safe render (and what every one of these pages showed before),
      // but the error is recorded rather than swallowed: the previous version of
      // this count failed on EVERY request for months and nothing knew.
      res.locals.patientUnreadMessages = 0;
      try {
        logErrorToDb(err, {
          context: 'middleware.patient_unread',
          requestId: req.requestId,
          userId: req.user && req.user.id,
          url: req.originalUrl,
          method: req.method,
          category: 'patient_case'
        });
      } catch (_) { /* logging must never break the page */ }
      console.error('[patient-unread] count failed', err && err.message ? err.message : err);
    }
    return next();
  };
}

module.exports = { patientUnreadMessages };
