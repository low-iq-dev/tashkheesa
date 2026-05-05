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
      // P1-DOC-7: target the in-page case-queue card on the dashboard
      // (data-tour="case-queue") with the sidebar queue nav as a fallback
      // when this view doesn't render the card. Previously pointed at the
      // sidebar Messages nav item — `/portal/doctor/messages` is a
      // P1-DOC-1 stub, so the tour was leading doctors to a dead page.
      target: '[data-tour="case-queue"], .portal-nav li:nth-child(2) a',
      title: 'Patient messages',
      text: 'Patients can ask follow-up questions inside each case. Open any case from your queue to see the conversation thread and reply.',
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
