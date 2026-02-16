// Admin Portal Tours
(function() {
  'use strict';

  // Tour 1: Admin Dashboard (page: /admin)
  window.adminDashboardTour = [
    {
      target: '.portal-nav',
      title: 'Admin Navigation',
      text: 'Manage cases, doctors, video calls, chat moderation, services, pricing, campaigns, and system monitoring from here.',
      position: 'right'
    },
    {
      target: '.admin-kpi-grid',
      title: 'Case Overview',
      text: 'Monitor total cases, pending items, completions, and SLA compliance at a glance. Red indicators need attention.',
      position: 'bottom'
    },
    {
      target: '.admin-alert-strip',
      title: 'Attention Required',
      text: 'This alert bar highlights urgent items — SLA breaches, open reports, and pending refunds that need immediate action.',
      position: 'bottom'
    },
    {
      target: '.admin-issues-grid',
      title: 'Patient Issues',
      text: 'Track open chat reports, refund requests, file re-uploads, and no-shows. Click "Review" to take action.',
      position: 'bottom'
    },
    {
      target: '.admin-system-strip',
      title: 'System Health',
      text: 'Monitor error counts and notification failures. Red indicators mean something needs investigation.',
      position: 'top'
    }
  ];
})();
