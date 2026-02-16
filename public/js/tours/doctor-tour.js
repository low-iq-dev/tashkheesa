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
      target: '.portal-nav li:nth-child(4) a',
      title: 'Patient Messages',
      text: 'Communicate with your patients securely. You can share files and respond to their questions about cases.',
      position: 'right'
    }
  ];

  // Tour 2: Reviewing a Case (case detail page)
  window.doctorCaseReviewTour = [
    {
      target: '.patient-files, .uploaded-files, .file-gallery, .order-files',
      title: 'Patient Medical Files',
      text: 'Review the patient\'s uploaded medical images and documents here. Click on any file to view it full-screen.',
      position: 'bottom'
    },
    {
      target: '.patient-notes, .case-notes, .order-notes',
      title: 'Patient Notes',
      text: 'Read the patient\'s description of their symptoms and concerns.',
      position: 'bottom'
    },
    {
      target: '.annotation-tool, .fabric-canvas, .image-viewer',
      title: 'Image Annotation',
      text: 'Use our annotation tools to mark up medical images — add arrows, circles, text, and measurements directly on the images.',
      position: 'bottom'
    },
    {
      target: '.report-form, .submit-report, textarea[name="report"]',
      title: 'Submit Your Report',
      text: 'Write your medical opinion and recommendations here. Once submitted, the patient will be notified and can download the report.',
      position: 'top'
    },
    {
      target: '.request-files-btn, .request-reupload',
      title: 'Request Additional Files',
      text: 'If you need better quality images or additional documents, use this to request the patient re-upload.',
      position: 'top'
    }
  ];
})();
