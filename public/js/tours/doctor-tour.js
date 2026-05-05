// Doctor Portal Tours
(function() {
  'use strict';

  // Tour 1: Doctor Dashboard (page: /portal/doctor)
  window.doctorDashboardTour = [
    {
      target: '.portal-sidebar, .portal-nav',
      title: 'Doctor Portal Navigation',
      text: 'Access your case queue, appointments, messages, prescriptions, analytics, and profile from here.',
      position: 'right'
    },
    {
      target: '.portal-nav li:nth-child(2) a',
      title: 'Your Case Queue',
      text: 'New cases assigned to you will appear in your queue. Click to review patient files and submit your medical report.',
      position: 'right'
    },
    {
      target: '.portal-nav li:nth-child(3) a',
      title: 'Video Appointments',
      text: 'View your upcoming video consultations and join calls when it\'s time. You\'ll receive reminders before each appointment.',
      position: 'right'
    },
    {
      // P1-DOC-1 (2026-05-05): repointed at the real Messages page now that
      // /portal/doctor/messages → /portal/messages (shared inbox). Yesterday's
      // P1-DOC-7 step pointed at the in-page case-queue card as a fallback
      // because messages was a "Coming in Phase 2" stub. Direct repoint is
      // correct now that the real page exists.
      target: 'a[href="/portal/messages"], .portal-nav a[href*="messages"]',
      title: 'Patient messages',
      text: 'All your patient conversations live in one inbox — open Messages to see unread questions across every case.',
      position: 'right'
    }
  ];

  // Tour 2: Reviewing a Case (case detail page)
  // Selectors updated to match the redesigned .dcd-* markup in
  // src/views/portal_doctor_case.ejs (commit eb5177d). The original
  // annotation-tool step has been dropped — image annotation lives on a
  // separate /annotator.html page, not on the case detail view.
  window.doctorCaseReviewTour = [
    {
      target: '.dcd-ctx',
      title: 'Clinical context',
      text: "Read the patient's clinical question, medical history, and medication list before opening the files. This frames the rest of the review.",
      position: 'bottom'
    },
    {
      target: '.dcd-files',
      title: 'Uploaded files',
      text: "The patient's uploaded images and documents live here. Click any file to open it in a new tab. AI-quality chips flag images that may not read well.",
      position: 'bottom'
    },
    {
      target: 'textarea[name="diagnosis"]',
      title: 'Medical notes',
      text: 'Write findings, impression, and recommendations in these three fields. Save a draft any time; generating the report creates a PDF and attaches it to the case.',
      position: 'top'
    },
    {
      target: '#requestFilesForm',
      title: 'Request additional files',
      text: "If the files are unclear or incomplete, describe what's missing here. The patient will be prompted to re-upload.",
      position: 'top'
    },
    {
      target: '.dcd-aside',
      title: 'Quick actions',
      text: 'The right rail summarises the case at a glance. Use Back to return to your queue, or Create prescription once the review is done.',
      position: 'left'
    }
  ];
})();
