# PORTAL GUIDED TOURS + PDF USER GUIDES

Build an interactive guided tour system and downloadable PDF user guides for all 3 portal roles. Patient portal is highest priority.

---

## PART 1: GUIDED TOUR SYSTEM (Shepherd.js-style)

### Architecture

Create a reusable tour engine at `/public/js/portal-tours.js` that:
- Shows step-by-step tooltip overlays highlighting UI elements
- Dims the background except the highlighted element
- Has Next / Back / Skip buttons
- Tracks progress (step 3 of 8)
- Saves completion state in localStorage so tours don't re-trigger
- Can be manually triggered via a "?" help button in the sidebar footer
- Supports bilingual (EN/AR) — tour text follows current lang

### Tour CSS

Create `/public/css/portal-tours.css`:
```css
/* Tour overlay */
.tour-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.45);
  z-index: 9998;
  transition: opacity .3s;
}

/* Highlighted element gets this */
.tour-highlight {
  position: relative;
  z-index: 9999;
  box-shadow: 0 0 0 4px rgba(37,99,235,.5), 0 0 0 9999px rgba(0,0,0,.45);
  border-radius: 8px;
  transition: box-shadow .3s;
}

/* Tooltip */
.tour-tooltip {
  position: fixed;
  z-index: 10000;
  background: #fff;
  border-radius: 14px;
  padding: 20px 24px;
  max-width: 380px;
  box-shadow: 0 20px 60px rgba(0,0,0,.15), 0 4px 16px rgba(0,0,0,.1);
  font-family: 'DM Sans', system-ui, sans-serif;
  animation: tourFadeIn .25s ease;
}
@keyframes tourFadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Tooltip arrow */
.tour-tooltip::before {
  content: '';
  position: absolute;
  width: 14px;
  height: 14px;
  background: #fff;
  transform: rotate(45deg);
}
.tour-tooltip[data-position="bottom"]::before {
  top: -7px;
  left: 50%;
  margin-left: -7px;
}
.tour-tooltip[data-position="top"]::before {
  bottom: -7px;
  left: 50%;
  margin-left: -7px;
}
.tour-tooltip[data-position="left"]::before {
  right: -7px;
  top: 50%;
  margin-top: -7px;
}
.tour-tooltip[data-position="right"]::before {
  left: -7px;
  top: 50%;
  margin-top: -7px;
}

/* Tooltip content */
.tour-step-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .5px;
  color: #2563eb;
  margin-bottom: 6px;
}
.tour-title {
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 6px;
}
.tour-text {
  font-size: 13.5px;
  color: #475569;
  line-height: 1.5;
  margin-bottom: 16px;
}

/* Progress bar */
.tour-progress {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
}
.tour-progress-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e2e8f0;
  transition: background .2s;
}
.tour-progress-dot.active {
  background: #2563eb;
}
.tour-progress-dot.done {
  background: #059669;
}

/* Buttons */
.tour-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.tour-btn {
  padding: 8px 18px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  font-family: inherit;
  transition: all .15s;
}
.tour-btn-primary {
  background: #2563eb;
  color: #fff;
}
.tour-btn-primary:hover { background: #1d4ed8; }
.tour-btn-secondary {
  background: transparent;
  color: #64748b;
}
.tour-btn-secondary:hover { color: #334155; }
.tour-btn-skip {
  background: none;
  border: none;
  color: #94a3b8;
  font-size: 12px;
  cursor: pointer;
}

/* Help button (sidebar) */
.tour-help-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 8px;
  background: #eff6ff;
  color: #2563eb;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  width: 100%;
  transition: background .15s;
}
.tour-help-btn:hover { background: #dbeafe; }
.tour-help-btn svg { flex-shrink: 0; }

/* Welcome modal (first visit) */
.tour-welcome {
  position: fixed;
  inset: 0;
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,.5);
}
.tour-welcome-card {
  background: #fff;
  border-radius: 16px;
  padding: 40px;
  max-width: 440px;
  text-align: center;
  box-shadow: 0 25px 60px rgba(0,0,0,.2);
}
.tour-welcome-icon {
  width: 64px;
  height: 64px;
  background: #eff6ff;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 20px;
  font-size: 28px;
}
.tour-welcome-title {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 8px;
}
.tour-welcome-text {
  font-size: 14px;
  color: #64748b;
  line-height: 1.5;
  margin-bottom: 24px;
}
```

### Tour Engine (portal-tours.js)

```javascript
// Portal Tour Engine
(function() {
  'use strict';

  window.PortalTour = {
    currentStep: 0,
    steps: [],
    overlay: null,
    tooltip: null,
    isActive: false,

    // Start a tour
    start: function(tourId, steps) {
      if (this.isActive) return;
      this.tourId = tourId;
      this.steps = steps;
      this.currentStep = 0;
      this.isActive = true;
      this._createOverlay();
      this._showStep(0);
    },

    // Show specific step
    _showStep: function(index) {
      if (index < 0 || index >= this.steps.length) {
        this.end();
        return;
      }
      this.currentStep = index;
      var step = this.steps[index];

      // Remove previous highlight
      var prev = document.querySelector('.tour-highlight');
      if (prev) prev.classList.remove('tour-highlight');

      // Find target element
      var target = document.querySelector(step.target);
      if (!target) {
        // Skip to next step if target not found
        this._showStep(index + 1);
        return;
      }

      // Scroll target into view
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Highlight target
      setTimeout(function() {
        target.classList.add('tour-highlight');
        this._positionTooltip(target, step, index);
      }.bind(this), 300);
    },

    _positionTooltip: function(target, step, index) {
      if (this.tooltip) this.tooltip.remove();

      var rect = target.getBoundingClientRect();
      var pos = step.position || 'bottom';
      var total = this.steps.length;

      // Build tooltip HTML
      var html = '<div class="tour-progress">';
      for (var i = 0; i < total; i++) {
        var cls = i < index ? 'done' : (i === index ? 'active' : '');
        html += '<div class="tour-progress-dot ' + cls + '"></div>';
      }
      html += '</div>';
      html += '<div class="tour-step-label">Step ' + (index + 1) + ' of ' + total + '</div>';
      html += '<div class="tour-title">' + step.title + '</div>';
      html += '<div class="tour-text">' + step.text + '</div>';
      html += '<div class="tour-actions">';
      if (index > 0) {
        html += '<button class="tour-btn tour-btn-secondary" onclick="PortalTour.prev()">Back</button>';
      } else {
        html += '<button class="tour-btn-skip" onclick="PortalTour.end()">Skip tour</button>';
      }
      if (index < total - 1) {
        html += '<button class="tour-btn tour-btn-primary" onclick="PortalTour.next()">Next</button>';
      } else {
        html += '<button class="tour-btn tour-btn-primary" onclick="PortalTour.end()">Finish ✓</button>';
      }
      html += '</div>';

      var tooltip = document.createElement('div');
      tooltip.className = 'tour-tooltip';
      tooltip.setAttribute('data-position', pos);
      tooltip.innerHTML = html;
      document.body.appendChild(tooltip);
      this.tooltip = tooltip;

      // Position tooltip relative to target
      var tooltipRect = tooltip.getBoundingClientRect();
      var gap = 16;
      var top, left;

      if (pos === 'bottom') {
        top = rect.bottom + gap;
        left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
      } else if (pos === 'top') {
        top = rect.top - tooltipRect.height - gap;
        left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
      } else if (pos === 'right') {
        top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
        left = rect.right + gap;
      } else if (pos === 'left') {
        top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
        left = rect.left - tooltipRect.width - gap;
      }

      // Clamp to viewport
      left = Math.max(12, Math.min(left, window.innerWidth - tooltipRect.width - 12));
      top = Math.max(12, Math.min(top, window.innerHeight - tooltipRect.height - 12));

      tooltip.style.top = top + 'px';
      tooltip.style.left = left + 'px';
    },

    next: function() { this._showStep(this.currentStep + 1); },
    prev: function() { this._showStep(this.currentStep - 1); },

    end: function() {
      this.isActive = false;
      if (this.overlay) { this.overlay.remove(); this.overlay = null; }
      if (this.tooltip) { this.tooltip.remove(); this.tooltip = null; }
      var prev = document.querySelector('.tour-highlight');
      if (prev) prev.classList.remove('tour-highlight');
      // Mark tour as completed
      if (this.tourId) {
        localStorage.setItem('tour_' + this.tourId + '_done', '1');
      }
    },

    _createOverlay: function() {
      if (this.overlay) return;
      this.overlay = document.createElement('div');
      this.overlay.className = 'tour-overlay';
      this.overlay.onclick = function() {}; // Prevent click-through
      document.body.appendChild(this.overlay);
    },

    // Check if tour was completed
    isDone: function(tourId) {
      return localStorage.getItem('tour_' + tourId + '_done') === '1';
    },

    // Reset tour state
    reset: function(tourId) {
      localStorage.removeItem('tour_' + tourId + '_done');
    },

    // Show welcome modal
    showWelcome: function(options) {
      var tourId = options.tourId;
      if (this.isDone(tourId) && !options.force) return;

      var modal = document.createElement('div');
      modal.className = 'tour-welcome';
      modal.innerHTML =
        '<div class="tour-welcome-card">' +
          '<div class="tour-welcome-icon">' + (options.icon || '👋') + '</div>' +
          '<div class="tour-welcome-title">' + (options.title || 'Welcome!') + '</div>' +
          '<div class="tour-welcome-text">' + (options.text || 'Take a quick tour?') + '</div>' +
          '<div style="display:flex;gap:12px;justify-content:center;">' +
            '<button class="tour-btn tour-btn-secondary" id="tour-skip-welcome">Maybe later</button>' +
            '<button class="tour-btn tour-btn-primary" id="tour-start-welcome">Start Tour</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);

      document.getElementById('tour-skip-welcome').onclick = function() {
        modal.remove();
        localStorage.setItem('tour_' + tourId + '_done', '1');
      };
      document.getElementById('tour-start-welcome').onclick = function() {
        modal.remove();
        if (options.onStart) options.onStart();
      };
    }
  };
})();
```

### Include in Portal

Add to the header partial (header.ejs) — only include when portalFrame is true:
```html
<% if (portalFrame) { %>
  <link rel="stylesheet" href="/css/portal-tours.css">
  <script src="/js/portal-tours.js" defer></script>
<% } %>
```

### Add Help Button to Sidebar

In each sidebar section (patient_sidebar.ejs, portal.ejs for admin/superadmin/doctor), add at the bottom before closing `</aside>`:
```html
<div style="padding:12px;">
  <button class="tour-help-btn" onclick="startPortalTour()">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    Take a Tour
  </button>
</div>
```

---

## PART 2: PATIENT PORTAL TOUR STEPS

Create `/public/js/tours/patient-tour.js`:

### Tour 1: Dashboard Overview
Page: /dashboard
```javascript
var patientDashboardTour = [
  {
    target: '.portal-sidebar',
    title: 'Your Portal Navigation',
    text: 'Use this sidebar to navigate between all sections of your patient portal — your cases, appointments, messages, and more.',
    position: 'right'
  },
  {
    target: '.portal-nav li:nth-child(2) a', // New Case link
    title: 'Submit a New Case',
    text: 'Click here to submit a new case. You\'ll select a medical service, upload your files (X-rays, MRIs, blood work), and our specialists will review them.',
    position: 'right'
  },
  {
    target: '.portal-nav li:nth-child(4) a', // Appointments
    title: 'Video Consultations',
    text: 'Book and join video calls with your assigned doctor. You\'ll get a notification when your appointment is confirmed.',
    position: 'right'
  },
  {
    target: '.portal-nav li:nth-child(5) a', // Messages
    title: 'Chat with Your Doctor',
    text: 'Send messages and files directly to your assigned doctor. You\'ll receive notifications when they reply.',
    position: 'right'
  }
];
// Additional steps target the main content area elements when they exist:
// - Active cases cards
// - Quick actions
// - Profile/payment history
```

### Tour 2: Submitting a New Case
Page: /portal/patient/orders/new
```javascript
var patientNewCaseTour = [
  {
    target: '.service-select, select[name="service_id"], .service-card:first-child',
    title: 'Choose a Service',
    text: 'Select the type of medical review you need — X-ray review, MRI analysis, blood work interpretation, etc. Each service has a fixed price and turnaround time.',
    position: 'bottom'
  },
  {
    target: '.specialty-select, select[name="specialty_id"]',
    title: 'Pick a Specialty',
    text: 'Choose the medical specialty that matches your condition. This ensures your case is reviewed by the right specialist.',
    position: 'bottom'
  },
  {
    target: '.file-upload, input[type="file"], .upload-zone, .dropzone',
    title: 'Upload Your Medical Files',
    text: 'Upload your medical images or documents here. We accept DICOM, JPEG, PNG, and PDF files. You can drag and drop or click to browse.',
    position: 'bottom'
  },
  {
    target: '.notes-field, textarea[name="notes"], textarea[name="patient_notes"]',
    title: 'Add Your Notes',
    text: 'Describe your symptoms, concerns, or specific questions for the doctor. The more detail you provide, the better the review.',
    position: 'top'
  },
  {
    target: '.submit-btn, button[type="submit"], .btn-primary',
    title: 'Submit Your Case',
    text: 'Once you\'ve uploaded your files and added notes, submit your case. You\'ll be taken to the payment page next.',
    position: 'top'
  }
];
```

### Tour 3: Viewing Case Status
Page: /portal/patient/orders/:id (patient_order.ejs)
```javascript
var patientCaseViewTour = [
  {
    target: '.status-pill, .case-status, .order-status',
    title: 'Case Status',
    text: 'Track your case progress here. Statuses include: New (submitted), Accepted (doctor assigned), In Review (doctor working), and Completed (report ready).',
    position: 'bottom'
  },
  {
    target: '.sla-info, .deadline-info, .turnaround',
    title: 'Expected Delivery',
    text: 'Your report will be delivered within this timeframe. You\'ll receive a notification when it\'s ready.',
    position: 'bottom'
  },
  {
    target: '.report-section, .download-report, .case-report',
    title: 'Download Your Report',
    text: 'Once your case is completed, your specialist\'s report will appear here. You can download it as a PDF.',
    position: 'top'
  }
];
```

### Tour 4: Video Call Booking
Page: /portal/patient/appointments
```javascript
var patientAppointmentsTour = [
  {
    target: '.book-appointment-btn, .btn-book, a[href*="booking"]',
    title: 'Book a Video Call',
    text: 'Schedule a live video consultation with your doctor. Choose an available time slot that works for you.',
    position: 'bottom'
  },
  {
    target: '.appointment-card:first-child, .appointments-list tr:first-child',
    title: 'Your Appointments',
    text: 'View all your upcoming and past appointments here. When it\'s time, a "Join Call" button will appear.',
    position: 'bottom'
  }
];
```

### Auto-trigger Logic

Add to patient_dashboard.ejs (at bottom, before footer include):
```html
<script src="/js/tours/patient-tour.js" defer></script>
<script>
document.addEventListener('DOMContentLoaded', function() {
  if (typeof PortalTour !== 'undefined' && !PortalTour.isDone('patient_dashboard')) {
    setTimeout(function() {
      PortalTour.showWelcome({
        tourId: 'patient_dashboard',
        icon: '🏥',
        title: 'Welcome to Tashkheesa!',
        text: 'Let us show you around your patient portal. It only takes 30 seconds and will help you get the most out of our service.',
        onStart: function() {
          PortalTour.start('patient_dashboard', patientDashboardTour);
        }
      });
    }, 1000);
  }

  // Also wire up the help button
  window.startPortalTour = function() {
    PortalTour.reset('patient_dashboard');
    PortalTour.start('patient_dashboard', patientDashboardTour);
  };
});
</script>
```

Add similar auto-trigger to patient_new_case.ejs, patient_order.ejs, patient_appointments_list.ejs.

---

## PART 3: DOCTOR PORTAL TOUR STEPS

Create `/public/js/tours/doctor-tour.js`:

### Tour 1: Doctor Dashboard
```javascript
var doctorDashboardTour = [
  {
    target: '.portal-sidebar, .portal-nav',
    title: 'Doctor Portal Navigation',
    text: 'Access your case queue, appointments, messages, prescriptions, analytics, and profile from here.',
    position: 'right'
  },
  {
    target: '.portal-nav li a[href*="queue"], .portal-nav li:nth-child(2) a',
    title: 'Your Case Queue',
    text: 'New cases assigned to you will appear in your queue. Click to review patient files and submit your medical report.',
    position: 'right'
  },
  {
    target: '.portal-nav li a[href*="appointments"]',
    title: 'Video Appointments',
    text: 'View your upcoming video consultations and join calls when it\'s time. You\'ll receive reminders before each appointment.',
    position: 'right'
  },
  {
    target: '.portal-nav li a[href*="messages"]',
    title: 'Patient Messages',
    text: 'Communicate with your patients securely. You can share files and respond to their questions about cases.',
    position: 'right'
  }
];
```

### Tour 2: Reviewing a Case
Page: Case detail page
```javascript
var doctorCaseReviewTour = [
  {
    target: '.patient-files, .uploaded-files, .file-gallery',
    title: 'Patient Medical Files',
    text: 'Review the patient\'s uploaded medical images and documents here. Click on any file to view it full-screen.',
    position: 'bottom'
  },
  {
    target: '.patient-notes, .case-notes',
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
```

---

## PART 4: ADMIN PORTAL TOUR STEPS

Create `/public/js/tours/admin-tour.js`:

```javascript
var adminDashboardTour = [
  {
    target: '.portal-nav, .admin-sidebar',
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
    target: '.admin-issues-grid, [class*="patient-issues"]',
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
```

---

## PART 5: PDF USER GUIDES

### Architecture

Create a route at `/portal/help/guide/:role` that generates a downloadable PDF guide.

Use the server-side PDF generation (same approach as medical reports). Each guide has:
- Cover page with Tashkheesa branding
- Table of contents
- Step-by-step sections with placeholder screenshot boxes
- Each step has: numbered step indicator, title, description, and a bordered rectangle labeled "[Screenshot: page name]"

Since we can't take real screenshots server-side, create the PDFs with descriptive placeholder boxes. You (Ziad) can later replace them with actual screenshots using any PDF editor.

Alternatively, create the guides as **styled HTML pages** at `/help/patient-guide`, `/help/doctor-guide`, `/help/admin-guide` that are printable (use `@media print` CSS) and can be saved as PDF from the browser.

### Preferred approach: HTML pages (easier to maintain)

Create 3 HTML guide pages:

#### `/help/patient-guide` — Patient User Guide

Structure (step-by-step cards with large screenshot placeholders):

```
┌──────────────────────────────────────────────────────────┐
│ 🏥 TASHKHEESA Patient Portal Guide                      │
│ How to use our medical second opinion platform           │
│                                                          │
│ [Tashkheesa logo]                                       │
└──────────────────────────────────────────────────────────┘

Section 1: Getting Started
┌──────────────────────────────────────────────────────────┐
│ STEP 1 of 12                                             │
│ ┌──────────────────────────────────────────────────────┐ │
│ │                                                      │ │
│ │          [Screenshot: Login Page]                     │ │
│ │          800 x 450 placeholder                       │ │
│ │                                                      │ │
│ └──────────────────────────────────────────────────────┘ │
│                                                          │
│ 🔑 Log In to Your Account                               │
│                                                          │
│ Visit tashkheesa.com and click "Patient Login".          │
│ Enter your email and password to access your portal.     │
│ If you're new, click "Register" to create an account.    │
│                                                          │
│ 💡 Tip: Bookmark this page for easy access.              │
└──────────────────────────────────────────────────────────┘

STEP 2: Your Dashboard
STEP 3: Submitting a New Case — Choose a Service
STEP 4: Submitting a New Case — Upload Medical Files
STEP 5: Submitting a New Case — Add Notes & Submit
STEP 6: Payment
STEP 7: Tracking Your Case Status
STEP 8: Downloading Your Report
STEP 9: Booking a Video Consultation
STEP 10: Joining a Video Call
STEP 11: Your Profile & Payment History
STEP 12: Getting Help
```

Create this as a standalone EJS page rendered by a public route. The page should:
- Have `@media print` CSS for clean PDF output
- Use Tashkheesa blue color scheme
- Have large bordered placeholder boxes (800x450) for screenshots with labels
- Be fully responsive
- Include a "Download as PDF" button that triggers window.print()
- Be bilingual (EN version at /help/patient-guide, AR at /help/ar/patient-guide)

#### Route setup

In a new routes file `routes/help.js`:
```javascript
router.get('/help/patient-guide', (req, res) => {
  res.render('help_patient_guide', { lang: 'en' });
});
router.get('/help/doctor-guide', (req, res) => {
  res.render('help_doctor_guide', { lang: 'en' });
});
router.get('/help/admin-guide', (req, res) => {
  res.render('help_admin_guide', { lang: 'en' });
});
// Arabic versions
router.get('/help/ar/patient-guide', (req, res) => {
  res.render('help_patient_guide', { lang: 'ar' });
});
// ... etc
```

Mount in server.js: `app.use('/', require('./routes/help'));`

---

## PART 6: GUIDE CONTENT (Patient)

### Patient Guide Steps (detailed content for the EJS template):

**Step 1: Log In**
- Screenshot label: "Login Page"
- Title: "Log In to Your Account"
- Text: "Visit the Tashkheesa website and click 'Patient Login' in the top navigation. Enter your registered email and password. If you're a new patient, click 'Register' to create your account first."
- Tip: "Save your login page as a bookmark for quick access."

**Step 2: Your Dashboard**
- Screenshot label: "Patient Dashboard"
- Title: "Your Dashboard"
- Text: "After logging in, you'll see your dashboard with an overview of your active cases, upcoming appointments, and recent messages. The sidebar on the left lets you navigate to all sections."

**Step 3: Start a New Case — Choose Service**
- Screenshot label: "New Case — Service Selection"
- Title: "Choose Your Medical Service"
- Text: "Click 'New Case' in the sidebar. You'll see available services like X-ray Review, MRI Analysis, CT Scan Review, Blood Work Interpretation, and Video Consultation. Each shows the price and expected turnaround time. Click to select."

**Step 4: Upload Medical Files**
- Screenshot label: "New Case — File Upload"
- Title: "Upload Your Medical Files"
- Text: "Upload your medical images or documents. We accept DICOM, JPEG, PNG, and PDF files up to 25MB each. You can drag files into the upload area or click to browse. Upload all relevant files for the most thorough review."
- Tip: "Higher quality images lead to better reviews. If your images are on a CD, take photos of the light box or scan them."

**Step 5: Add Notes & Submit**
- Screenshot label: "New Case — Notes & Submit"
- Title: "Add Your Medical History & Submit"
- Text: "Describe your symptoms, medical history, and any specific questions you have for the specialist. The more context you provide, the more useful the report will be. Click 'Submit' when ready."

**Step 6: Payment**
- Screenshot label: "Payment Page"
- Title: "Complete Payment"
- Text: "You'll be taken to our secure payment page. We accept Visa, Mastercard, and local payment methods. Your case will be assigned to a specialist immediately after payment."
- Tip: "Payment is processed securely through Paymob. Your card details are never stored on our servers."

**Step 7: Track Case Status**
- Screenshot label: "Case Detail — Status Tracking"
- Title: "Track Your Case Progress"
- Text: "Return to your dashboard to see your case status. Statuses include: 'Case Received' (we got your files), 'Doctor Assigned' (specialist reviewing), 'In Review' (doctor working on report), and 'Completed' (report ready to download)."

**Step 8: Download Report**
- Screenshot label: "Case Detail — Report Download"
- Title: "Download Your Specialist Report"
- Text: "Once your case is marked 'Completed', you'll receive a notification. Open the case to view and download your detailed medical report as a PDF. The report includes the specialist's findings, diagnosis, and recommendations."

**Step 9: Book Video Consultation**
- Screenshot label: "Appointment Booking"
- Title: "Book a Video Consultation"
- Text: "Click 'Appointments' in the sidebar, then 'Book New Appointment'. Choose your preferred specialist, pick an available date and time, and confirm your booking. You'll receive a confirmation email."

**Step 10: Join Video Call**
- Screenshot label: "Video Call Room"
- Title: "Join Your Video Call"
- Text: "When it's time for your appointment, a 'Join Call' button will appear on your dashboard and in the Appointments section. Click it to enter the video call room. Make sure your camera and microphone are enabled."
- Tip: "Test your camera and microphone before the call. Use a quiet, well-lit room."

**Step 11: Profile & Payment History**
- Screenshot label: "Profile Page"
- Title: "Your Profile & Payment History"
- Text: "Click 'Profile' in the sidebar to update your personal information, change your password, and view your complete payment history and receipts."

**Step 12: Getting Help**
- Screenshot label: "Help Section"
- Title: "Need Help?"
- Text: "If you have questions or issues, use the 'Messages' section to contact your doctor or our support team. You can also click the '?' button in the sidebar to retake the guided tour at any time."

---

## IMPLEMENTATION PRIORITY

1. Create `/public/css/portal-tours.css`
2. Create `/public/js/portal-tours.js` (the engine)
3. Include both in header.ejs when portalFrame is true
4. Create `/public/js/tours/patient-tour.js` with all patient tour steps
5. Add auto-trigger to patient_dashboard.ejs
6. Add "Take a Tour" help button to patient_sidebar.ejs
7. Create the HTML guide page: `help_patient_guide.ejs`
8. Create the help route in routes/help.js
9. Mount in server.js
10. Create `/public/js/tours/doctor-tour.js` (doctor tours)
11. Create `/public/js/tours/admin-tour.js` (admin tours)  
12. Create `help_doctor_guide.ejs` and `help_admin_guide.ejs`

---

## COMMIT

```
feat: add guided portal tours + downloadable PDF user guides

- Built reusable tour engine (portal-tours.js) with step-by-step tooltips
- Patient portal tour: dashboard, new case, case view, appointments (4 tours)
- Doctor portal tour: dashboard, case review (2 tours)
- Admin portal tour: dashboard overview (1 tour)
- Welcome modal auto-triggers on first visit
- "Take a Tour" help button in all sidebar footers
- HTML user guides at /help/patient-guide, /help/doctor-guide, /help/admin-guide
- Print-optimized CSS for PDF download
- Step-by-step cards with screenshot placeholders
- Bilingual support (EN/AR)
```
