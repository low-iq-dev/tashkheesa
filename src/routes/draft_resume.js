'use strict';

// src/routes/draft_resume.js — the links in the draft-resume nudges
// (patient recovery, Part A, 2 Nov 2026).
//
//   GET /portal/patient/resume/:token   WhatsApp, email and in-app copy
//   GET /r/:token                       the same link, short, for SMS
//
// A token opens ONE draft and NEVER signs anyone in (services/draft_resume):
//   * this browser holds the patient's own session → the draft at its saved
//     step (/patient/new-case?resume=<id>, which checks ownership and that it is
//     still a draft); the open is recorded and any nudge still queued for that
//     draft is cancelled;
//   * no session → /login with `next` set to that same URL, so the draft opens
//     after the patient signs in (phone OTP or email);
//   * someone else's session, an expired token, a forged or unknown one → the
//     signed-in person's own home, or /login. Nothing about the draft is said.

const express = require('express');
const draftResume = require('../services/draft_resume');

const router = express.Router();

function homeFor(user) {
  if (!user) return '/login';
  return String(user.role || '') === 'patient' ? '/dashboard' : '/';
}

async function handleResume(req, res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  let r;
  try { r = await draftResume.resolveToken(req.params.token); }
  catch (err) {
    console.error('[draft-resume] lookup failed', err && err.message);
    return res.redirect(homeFor(req.user));
  }
  if (!r.ok) return res.redirect(homeFor(req.user));

  const row = r.row;
  const target = draftResume.wizardPathFor(row.order_id);
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(target));
  if (String(req.user.id) !== String(row.patient_id)) return res.redirect(homeFor(req.user));

  await draftResume.recordOpen(row);
  return res.redirect(target);
}

router.get('/portal/patient/resume/:token', handleResume);
router.get('/r/:token', handleResume);

module.exports = router;
module.exports.handleResume = handleResume;
