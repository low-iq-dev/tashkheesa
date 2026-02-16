const express = require('express');
const router = express.Router();

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
router.get('/help/admin-guide', (req, res) => {
  const lang = (req.query.lang === 'ar' || (req.cookies && req.cookies.lang === 'ar')) ? 'ar' : 'en';
  res.render('help_admin_guide', { title: lang === 'ar' ? 'دليل المدير' : 'Admin Guide', lang, layout: false });
});

// Arabic versions
router.get('/help/ar/patient-guide', (req, res) => {
  res.render('help_patient_guide', { title: 'دليل المريض', lang: 'ar', layout: false });
});
router.get('/help/ar/doctor-guide', (req, res) => {
  res.render('help_doctor_guide', { title: 'دليل الطبيب', lang: 'ar', layout: false });
});
router.get('/help/ar/admin-guide', (req, res) => {
  res.render('help_admin_guide', { title: 'دليل المدير', lang: 'ar', layout: false });
});

module.exports = router;
