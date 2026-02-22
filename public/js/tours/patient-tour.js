// Patient Portal Tours
(function() {
  'use strict';

  // Tour 1: Dashboard Overview (page: /dashboard)
  // Patient sidebar order: 1=Dashboard, 2=My Cases, 3=New Case(Soon),
  // 4=Notifications, 5=Appointments, 6=Messages, 7=Prescriptions,
  // 8=Medical Records, 9=Referrals, 10=Reviews, 11=Profile, 12=Logout
  window.patientDashboardTour = [
    {
      target: '.portal-sidebar',
      title: 'Your Portal Navigation',
      text: 'Use this sidebar to navigate between all sections of your patient portal — your cases, appointments, messages, and more.',
      position: 'right'
    },
    {
      target: '.portal-nav li:nth-child(2) a',
      title: 'My Cases',
      text: 'View all your submitted cases here. Track their status from submission through doctor review to final report.',
      position: 'right'
    },
    {
      target: '.portal-nav li:nth-child(5) a',
      title: 'Appointments',
      text: 'Book and join video consultations with your assigned doctor. You\'ll get a notification when your appointment is confirmed.',
      position: 'right'
    },
    {
      target: '.portal-nav li:nth-child(6) a',
      title: 'Chat with Your Doctor',
      text: 'Send messages and files directly to your assigned doctor. You\'ll receive notifications when they reply.',
      position: 'right'
    },
    {
      target: '.portal-stats',
      title: 'Case Summary',
      text: 'Track your total cases, in-progress cases, completed reviews, and pending payments at a glance.',
      position: 'bottom'
    },
    {
      target: '.filter-pills',
      title: 'Filter by Status',
      text: 'Use these tabs to quickly filter your cases by status — Submitted, In Review, Completed, or Cancelled.',
      position: 'bottom'
    }
  ];

  // Tour 2: Submitting a New Case (page: /portal/patient/orders/new)
  window.patientNewCaseTour = [
    {
      target: 'select[name="service_id"], .service-select, .service-card:first-child',
      title: 'Choose a Service',
      text: 'Select the type of medical review you need — X-ray review, MRI analysis, blood work interpretation, etc. Each service has a fixed price and turnaround time.',
      position: 'bottom'
    },
    {
      target: 'select[name="specialty_id"], .specialty-select',
      title: 'Pick a Specialty',
      text: 'Choose the medical specialty that matches your condition. This ensures your case is reviewed by the right specialist.',
      position: 'bottom'
    },
    {
      target: 'input[type="file"], .file-upload, .upload-zone, .dropzone',
      title: 'Upload Your Medical Files',
      text: 'Upload your medical images or documents here. We accept DICOM, JPEG, PNG, and PDF files. You can drag and drop or click to browse.',
      position: 'bottom'
    },
    {
      target: 'textarea[name="notes"], textarea[name="patient_notes"], .notes-field',
      title: 'Add Your Notes',
      text: 'Describe your symptoms, concerns, or specific questions for the doctor. The more detail you provide, the better the review.',
      position: 'top'
    },
    {
      target: 'button[type="submit"], .submit-btn, .p-btn-primary',
      title: 'Submit Your Case',
      text: 'Once you\'ve uploaded your files and added notes, submit your case. You\'ll be taken to the payment page next.',
      position: 'top'
    }
  ];

  // Tour 3: Viewing Case Status (page: /portal/patient/orders/:id)
  window.patientCaseViewTour = [
    {
      target: '.status-badge, .case-status, .order-status',
      title: 'Case Status',
      text: 'Track your case progress here. Statuses include: Submitted, Assigned (doctor reviewing), In Review (doctor working), and Completed (report ready).',
      position: 'bottom'
    },
    {
      target: '.sla-info, .deadline-info, .turnaround',
      title: 'Expected Delivery',
      text: 'Your report will be delivered within this timeframe. You\'ll receive a notification when it\'s ready.',
      position: 'bottom'
    },
    {
      target: '.report-section, .download-report, .case-report, a[href*="report"]',
      title: 'Download Your Report',
      text: 'Once your case is completed, your specialist\'s report will appear here. You can download it as a PDF.',
      position: 'top'
    }
  ];

  // Tour 4: Appointments (page: /portal/patient/appointments)
  window.patientAppointmentsTour = [
    {
      target: '.book-appointment-btn, .btn-book, a[href*="booking"], .p-btn-primary',
      title: 'Book a Video Call',
      text: 'Schedule a live video consultation with your doctor. Choose an available time slot that works for you.',
      position: 'bottom'
    },
    {
      target: '.appointment-card:first-child, .appointments-list tr:first-child, .portal-card:first-of-type',
      title: 'Your Appointments',
      text: 'View all your upcoming and past appointments here. When it\'s time, a "Join Call" button will appear.',
      position: 'bottom'
    }
  ];
})();
