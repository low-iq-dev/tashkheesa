// src/views/registry.js

module.exports = {
  // Doctor portal
  portal_doctor_dashboard: true,
  portal_doctor_case: true,
  portal_doctor_services: true,
  doctor_alerts: true,

  // Auth
  login: true,

  // Admin
  admin_dashboard: true,
  superadmin_dashboard: true,
  superadmin_bulk_welcome: true,
  // 2026-08-29 — the doctor outreach console. Registered at the same time
  // the view was created, which is the whole lesson from superadmin_bulk_welcome:
  // that one was rendered but never registered, assertRenderableView threw
  // inside an async handler, and every click on "Email all" exited the process.
  superadmin_doctor_outreach: true
};