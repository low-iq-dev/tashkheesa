const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware');

// The admin guide is an operations manual: it walks through the admin and
// superadmin URL surface, the manual-queue triage flow and the escalation
// paths. Served unauthenticated it was a free reconnaissance document for
// anyone who guessed /help/admin-guide — and it is linked from the sitemap's
// sibling /help pages, so it was reachable without guessing.
//
// requireRole redirects an anonymous visitor to /login?next=… and answers 403
// to a logged-in patient or doctor, which is the behaviour we want: no
// existence oracle for signed-out users, hard refusal for wrong-role users.
const requireAdmin = requireRole('admin', 'superadmin');

// Bare /help index → send to the patient guide (avoids a 404 on /help)
router.get('/help', (req, res) => res.redirect('/help/patient-guide'));

// Patient Guide
router.get('/help/patient-guide', (req, res) => {
  const lang = (req.query.lang === 'ar' || (req.cookies && req.cookies.lang === 'ar')) ? 'ar' : 'en';
  res.render('help_patient_guide', { title: lang === 'ar' ? 'دليل المريض' : 'Patient Guide', lang, layout: false });
});

// Doctor Guide
router.get('/help/doctor-guide', (req, res) => {
  const lang = (req.query.lang === 'ar' || (req.cookies && req.cookies.lang === 'ar')) ? 'ar' : 'en';
  res.render('help_doctor_guide', { title: lang === 'ar' ? 'دليل الطبيب' : 'Doctor Guide', lang, layout: false });
});

// Admin Guide
router.get('/help/admin-guide', requireAdmin, (req, res) => {
  const lang = (req.query.lang === 'ar' || (req.cookies && req.cookies.lang === 'ar')) ? 'ar' : 'en';
  res.render('help_admin_guide', { title: lang === 'ar' ? 'دليل المدير' : 'Admin Guide', lang, layout: false });
});

// Patient Walkthrough (interactive)
router.get('/help/patient-walkthrough', (req, res) => {
  const lang = (req.query.lang === 'ar' || (req.cookies && req.cookies.lang === 'ar')) ? 'ar' : 'en';
  res.render('patient_walkthrough', { cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '', title: lang === 'ar' ? 'الدليل التفاعلي للمريض' : 'Interactive Patient Walkthrough', lang, layout: false });
});

// Arabic versions
router.get('/help/ar/patient-walkthrough', (req, res) => {
  res.render('patient_walkthrough', { cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '', title: 'الدليل التفاعلي للمريض', lang: 'ar', layout: false });
});
router.get('/help/ar/patient-guide', (req, res) => {
  res.render('help_patient_guide', { title: 'دليل المريض', lang: 'ar', layout: false });
});
router.get('/help/ar/doctor-guide', (req, res) => {
  res.render('help_doctor_guide', { title: 'دليل الطبيب', lang: 'ar', layout: false });
});
router.get('/help/ar/admin-guide', requireAdmin, (req, res) => {
  res.render('help_admin_guide', { title: 'دليل المدير', lang: 'ar', layout: false });
});

module.exports = router;
