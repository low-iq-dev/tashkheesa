# GUIDED TOURS ENHANCEMENT + SCREENSHOT CAPTURE FOR GUIDES

Execute all steps below in order.

---

## STEP 1: Mandatory Tour on First Visit

Currently the tour shows a welcome modal that users can dismiss. Change this so that on first visit, users MUST complete the tour (no "Maybe later" option).

### Changes needed:

**portal-tours.js** — Modify `showWelcome()`:
- Remove the "Maybe later" / skip button from the welcome modal
- Only show "Start Tour" button
- Add a semi-transparent overlay behind the modal that can't be clicked to dismiss
- The modal should NOT be closable by clicking outside
- Once the tour ends (via `end()` method), set localStorage flag as before
- The "Skip tour" link INSIDE the tour steps should still work (so users can skip after starting)

**patient_dashboard.ejs** — Update the auto-trigger:
- On first visit (no localStorage flag), show the welcome modal with only "Start Tour"
- On subsequent visits, don't show it
- The "Take a Tour" sidebar button should still work to restart the tour anytime

**portal_doctor_dashboard.ejs** or **doctor_queue.ejs** — Same pattern:
- Mandatory tour on first doctor visit
- Same welcome modal with only "Start Tour"

**admin.ejs** — Same pattern for admin first visit

### Implementation:

In `portal-tours.js`, add a `mandatory` option to `showWelcome`:

```javascript
showWelcome: function(options) {
  var tourId = options.tourId;
  if (this.isDone(tourId) && !options.force) return;

  var mandatory = options.mandatory || false;

  var modal = document.createElement('div');
  modal.className = 'tour-welcome';
  // Prevent closing by click outside if mandatory
  if (!mandatory) {
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
  }
  
  var buttonsHtml = '';
  if (!mandatory) {
    buttonsHtml += '<button class="tour-btn tour-btn-secondary" id="tour-skip-welcome">Maybe later</button>';
  }
  buttonsHtml += '<button class="tour-btn tour-btn-primary" id="tour-start-welcome">' + 
    (mandatory ? '👋 Let\'s Go!' : 'Start Tour') + '</button>';

  modal.innerHTML =
    '<div class="tour-welcome-card">' +
      '<div class="tour-welcome-icon">' + (options.icon || '👋') + '</div>' +
      '<div class="tour-welcome-title">' + (options.title || 'Welcome!') + '</div>' +
      '<div class="tour-welcome-text">' + (options.text || 'Take a quick tour to learn how to use your portal.') + '</div>' +
      '<div style="display:flex;gap:12px;justify-content:center;">' +
        buttonsHtml +
      '</div>' +
    '</div>';
  document.body.appendChild(modal);

  if (!mandatory && document.getElementById('tour-skip-welcome')) {
    document.getElementById('tour-skip-welcome').onclick = function() {
      modal.remove();
      localStorage.setItem('tour_' + tourId + '_done', '1');
    };
  }
  document.getElementById('tour-start-welcome').onclick = function() {
    modal.remove();
    if (options.onStart) options.onStart();
  };
}
```

Then in each dashboard auto-trigger, set `mandatory: true`:
```javascript
PortalTour.showWelcome({
  tourId: 'patient_dashboard',
  mandatory: true,  // <-- ADD THIS
  icon: '🏥',
  title: 'Welcome to Tashkheesa!',
  text: 'Let us show you around your patient portal. It only takes 30 seconds.',
  onStart: function() {
    PortalTour.start('patient_dashboard', patientDashboardTour);
  }
});
```

---

## STEP 2: Ensure "Take a Tour" Button on Patient and Doctor Dashboards

Check that the "Take a Tour" help button is present in:
1. `patient_sidebar.ejs` — at the bottom before `</aside>`
2. `portal.ejs` — in the doctor sidebar section (portalRole === 'doctor')
3. `portal.ejs` — in the admin sidebar section (portalRole === 'admin')
4. `portal.ejs` — in the superadmin sidebar section (portalRole === 'superadmin')

If missing from any, add:
```html
<div style="padding:12px;">
  <button class="tour-help-btn" onclick="startPortalTour()">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    Take a Tour
  </button>
</div>
```

---

## STEP 3: Take Screenshots and Save to Guide Directory

Take screenshots of every page referenced in the help guides. Save them as PNG files to `/public/images/guide/`.

### Method:
Use Puppeteer (install: `npm install puppeteer --save-dev`) to take automated screenshots.

Create a script at `/scripts/capture-guide-screenshots.js`:

```javascript
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const OUTPUT = path.join(__dirname, '..', 'public', 'images', 'guide');

// Ensure output dir exists
if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

// Account credentials
const ACCOUNTS = {
  patient: { email: 'client@demo.com', password: 'demo123' },
  // If no doctor account exists with known password, skip doctor screenshots
  // doctor: { email: 'doctor@demo.com', password: 'demo123' },
  admin: { email: 'YOUR_ADMIN_EMAIL', password: 'YOUR_ADMIN_PASSWORD' }
};

async function login(page, email, password) {
  await page.goto(BASE + '/logout', { waitUntil: 'networkidle2' });
  await page.goto(BASE + '/login', { waitUntil: 'networkidle2' });
  await page.type('input[name="email"]', email);
  await page.type('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });
}

async function screenshot(page, url, filename) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(OUTPUT, filename),
    type: 'png',
    clip: { x: 0, y: 0, width: 1280, height: 720 }
  });
  console.log('✓ ' + filename);
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  // 1. Login page (no auth needed)
  await page.goto(BASE + '/login', { waitUntil: 'networkidle2' });
  await page.screenshot({ path: path.join(OUTPUT, 'patient-01-login.png'), type: 'png' });
  console.log('✓ patient-01-login.png');

  // 2. Patient pages
  try {
    await login(page, ACCOUNTS.patient.email, ACCOUNTS.patient.password);
    
    await screenshot(page, BASE + '/dashboard', 'patient-02-dashboard.png');
    await screenshot(page, BASE + '/portal/patient/orders/new', 'patient-03-new-case.png');
    // For step 4 (upload) and step 5 (notes) — same page, different scroll positions
    // Just reuse step 3 screenshot or take at different scroll
    await screenshot(page, BASE + '/portal/patient/orders/new', 'patient-04-upload.png');
    await screenshot(page, BASE + '/portal/patient/orders/new', 'patient-05-submit.png');
    // Payment page — try navigating, if needs a real order just use placeholder
    await screenshot(page, BASE + '/dashboard', 'patient-06-payment.png');
    // Case detail — find first order
    await screenshot(page, BASE + '/dashboard', 'patient-07-case-status.png');
    await screenshot(page, BASE + '/dashboard', 'patient-08-report.png');
    await screenshot(page, BASE + '/portal/patient/appointments', 'patient-09-appointments.png');
    await screenshot(page, BASE + '/portal/patient/appointments', 'patient-10-video-call.png');
    await screenshot(page, BASE + '/patient/profile', 'patient-11-profile.png');
    await screenshot(page, BASE + '/dashboard', 'patient-12-help.png');
  } catch(e) {
    console.log('Patient screenshots error:', e.message);
  }

  // 3. Admin pages
  try {
    // Login as admin/superadmin
    await page.goto(BASE + '/logout', { waitUntil: 'networkidle2' });
    // Need to know admin credentials — use the same session or direct login
    await screenshot(page, BASE + '/admin', 'admin-01-dashboard.png');
  } catch(e) {
    console.log('Admin screenshots error:', e.message);
  }

  await browser.close();
  console.log('\\nDone! Screenshots saved to /public/images/guide/');
})();
```

**IMPORTANT**: If Puppeteer is too complex or credentials are unknown, use this SIMPLER alternative approach:

### Alternative: Manual Screenshot Method

Instead of Puppeteer, take screenshots manually using the browser's built-in capabilities. Here's the simpler approach:

1. Navigate to each page in the browser
2. Use `page.screenshot()` equivalent from the Chrome DevTools Protocol
3. Save to `/public/images/guide/`

**Even simpler**: Create a server-side route that generates placeholder screenshots with the page title and a colored background. This is actually better because it won't have stale data.

Create `/src/routes/guide-images.js`:
```javascript
const { createCanvas } = require('canvas'); // npm install canvas
const path = require('path');
const fs = require('fs');

function generatePlaceholder(title, subtitle, filename) {
  const width = 800;
  const height = 450;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background gradient (Tashkheesa blue)
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, '#2563eb');
  grad.addColorStop(1, '#1e40af');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Semi-transparent overlay for depth
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(0, 0, width, height / 2);

  // White content card
  ctx.fillStyle = '#fff';
  ctx.roundRect(60, 60, width - 120, height - 120, 16);
  ctx.fill();

  // Title
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 24px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, height / 2 - 20);

  // Subtitle
  ctx.fillStyle = '#64748b';
  ctx.font = '16px sans-serif';
  ctx.fillText(subtitle, width / 2, height / 2 + 20);

  // Tashkheesa logo text
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Tashkheesa Guide', 24, height - 20);

  // Save
  const outDir = path.join(__dirname, '..', '..', 'public', 'images', 'guide');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(outDir, filename), buffer);
}

// Generate all placeholders
const images = [
  // Patient guide
  ['Login Page', 'Enter your email and password', 'patient-01-login.png'],
  ['Patient Dashboard', 'Your cases, appointments, and messages', 'patient-02-dashboard.png'],
  ['Choose a Service', 'Select the type of medical review', 'patient-03-service.png'],
  ['Upload Medical Files', 'Drag and drop your images or documents', 'patient-04-upload.png'],
  ['Add Notes & Submit', 'Describe your symptoms and concerns', 'patient-05-submit.png'],
  ['Secure Payment', 'Pay with Visa, Mastercard, or local methods', 'patient-06-payment.png'],
  ['Case Status Tracking', 'Monitor your case progress in real-time', 'patient-07-status.png'],
  ['Download Report', 'View and download your specialist report', 'patient-08-report.png'],
  ['Book Video Consultation', 'Schedule a live call with your doctor', 'patient-09-booking.png'],
  ['Video Call Room', 'Join your appointment with camera and mic', 'patient-10-video.png'],
  ['Profile & Payment History', 'Manage your account and view receipts', 'patient-11-profile.png'],
  ['Getting Help', 'Use the tour or contact support', 'patient-12-help.png'],
  
  // Doctor guide
  ['Doctor Dashboard', 'Your case queue and appointments', 'doctor-01-dashboard.png'],
  ['Case Queue', 'New cases assigned to you', 'doctor-02-queue.png'],
  ['Review Patient Files', 'View uploaded medical images', 'doctor-03-files.png'],
  ['Image Annotation', 'Mark up images with arrows and text', 'doctor-04-annotate.png'],
  ['Write Report', 'Submit your medical opinion', 'doctor-05-report.png'],
  ['Request Additional Files', 'Ask patient to re-upload', 'doctor-06-reupload.png'],
  ['Video Appointments', 'Join scheduled video calls', 'doctor-07-appointments.png'],
  ['Patient Messages', 'Communicate with your patients', 'doctor-08-messages.png'],
  ['Prescriptions', 'Write and manage prescriptions', 'doctor-09-prescriptions.png'],
  ['Doctor Profile', 'Update your qualifications', 'doctor-10-profile.png'],
  
  // Admin guide
  ['Operations Dashboard', 'Case management and monitoring', 'admin-01-dashboard.png'],
  ['Case Management', 'View and manage all cases', 'admin-02-cases.png'],
  ['Doctor Management', 'Approve and manage doctors', 'admin-03-doctors.png'],
  ['Video Calls', 'Monitor appointments and no-shows', 'admin-04-video.png'],
  ['Chat Moderation', 'Review reported conversations', 'admin-05-moderation.png'],
  ['Services & Pricing', 'Manage medical services', 'admin-06-services.png'],
  ['Analytics', 'View performance metrics', 'admin-07-analytics.png'],
  ['Campaigns', 'Send marketing campaigns', 'admin-08-campaigns.png'],
  ['Error Log', 'Monitor system errors', 'admin-09-errors.png'],
  ['Admin Profile', 'Account settings', 'admin-10-profile.png'],
];

images.forEach(([title, subtitle, filename]) => {
  generatePlaceholder(title, subtitle, filename);
});

console.log(`Generated ${images.length} guide images`);
```

**HOWEVER** — the BEST approach that doesn't require any npm packages is to use **CSS-based screenshot placeholders with actual page descriptions**. Instead of image files, render the screenshot areas as styled divs in the guide HTML.

### RECOMMENDED: Use CSS illustration cards instead of real screenshots

Update the guide EJS templates to replace the dashed placeholder boxes with **styled illustration cards** that show:
- A visual representation of the page (using CSS shapes, icons, and layout mockups)
- The page title
- A brief description

This is actually MORE maintainable than real screenshots because screenshots get stale as the UI changes.

Here's how to update `help_patient_guide.ejs`:

Replace each screenshot placeholder:
```html
<!-- OLD -->
<div class="guide-screenshot-placeholder">
  [Screenshot: Login Page]<br>800 x 450
</div>

<!-- NEW -->
<div class="guide-screenshot">
  <div class="guide-mockup guide-mockup--login">
    <div class="mockup-browser-bar">
      <span class="mockup-dot"></span>
      <span class="mockup-dot"></span>
      <span class="mockup-dot"></span>
      <span class="mockup-url">tashkheesa.com/login</span>
    </div>
    <div class="mockup-content">
      <div class="mockup-card">
        <div style="font-weight:700;color:#2563eb;font-size:18px;margin-bottom:4px;">Tashkheesa</div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:16px;">Second opinions, done right</div>
        <div class="mockup-input">Email</div>
        <div class="mockup-input">Password</div>
        <div class="mockup-btn">Sign in</div>
      </div>
    </div>
  </div>
</div>
```

Create CSS for mockups (add to the guide page's `<style>`):
```css
.guide-mockup {
  background: #f1f5f9;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #e2e8f0;
  font-family: 'DM Sans', sans-serif;
}
.mockup-browser-bar {
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.mockup-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d1d5db;
}
.mockup-dot:first-child { background: #fca5a5; }
.mockup-dot:nth-child(2) { background: #fcd34d; }
.mockup-dot:nth-child(3) { background: #86efac; }
.mockup-url {
  margin-left: 12px;
  font-size: 11px;
  color: #94a3b8;
  background: #fff;
  padding: 3px 12px;
  border-radius: 4px;
  border: 1px solid #e2e8f0;
}
.mockup-content {
  padding: 30px;
  min-height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mockup-card {
  background: #fff;
  padding: 24px;
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0,0,0,.06);
  width: 240px;
  text-align: center;
}
.mockup-input {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 8px;
  text-align: left;
}
.mockup-btn {
  background: #2563eb;
  color: #fff;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  margin-top: 4px;
}

/* Dashboard mockup */
.mockup-sidebar {
  width: 160px;
  background: #fff;
  border-right: 1px solid #e2e8f0;
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mockup-nav-item {
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 10px;
  color: #64748b;
}
.mockup-nav-item.active {
  background: #eff6ff;
  color: #2563eb;
  font-weight: 600;
}
.mockup-main {
  flex: 1;
  padding: 16px;
}
.mockup-kpi-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}
.mockup-kpi {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px;
  border-left: 3px solid #2563eb;
}
.mockup-kpi-value {
  font-size: 16px;
  font-weight: 700;
}
.mockup-kpi-label {
  font-size: 8px;
  color: #94a3b8;
}
.mockup-layout {
  display: flex;
  min-height: 280px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid #e2e8f0;
  background: #f1f5f9;
}
```

### Create specific mockups for each step:

**Step 1 (Login)**: Login form card centered
**Step 2 (Dashboard)**: Sidebar + KPI grid + case cards
**Step 3 (Service Selection)**: Grid of service cards with icons
**Step 4 (File Upload)**: Dropzone with upload icon
**Step 5 (Notes)**: Form with textarea and submit button
**Step 6 (Payment)**: Payment form with card inputs
**Step 7 (Case Status)**: Status timeline/progress bar
**Step 8 (Report Download)**: PDF icon with download button
**Step 9 (Appointments)**: Calendar grid with time slots
**Step 10 (Video Call)**: Video room with participant frames
**Step 11 (Profile)**: Form with user info fields
**Step 12 (Help)**: Tour button + help info

Each mockup should be a simplified CSS illustration of the actual page — enough to give users an idea of what to expect without requiring real screenshots.

---

## STEP 4: Update All Three Guide Templates

Update `help_patient_guide.ejs`, `help_doctor_guide.ejs`, and `help_admin_guide.ejs` to:

1. Replace all `[Screenshot: ...]` placeholder divs with CSS mockup illustrations
2. Add the mockup CSS styles to each template
3. Each mockup should have:
   - A browser bar (macOS-style dots + URL)
   - A simplified visual representation of the actual page
   - Enough detail that users recognize the page when they see it

---

## STEP 5: Verify Tour Triggers

Test that:
1. Clear localStorage (use DevTools > Application > Local Storage > Clear)
2. Visit /dashboard as patient → Welcome modal appears with ONLY "Let's Go!" button (no skip)
3. Click "Let's Go!" → Tour starts with step 1
4. Complete tour or skip via "Skip tour" link inside tour → localStorage flag set
5. Revisit /dashboard → No welcome modal
6. Click "Take a Tour" in sidebar → Tour restarts
7. Same for doctor dashboard and admin dashboard

---

## COMMIT

```
feat: mandatory first-visit tours + CSS mockup illustrations for guides

- Tour welcome modal is now mandatory on first visit (no skip button)
- "Take a Tour" button confirmed on all portal sidebars
- Guide templates updated with CSS mockup illustrations (no real screenshots needed)
- Browser-bar styled mockups for login, dashboard, case flow, appointments, etc.
- Mockups are maintainable — no screenshots to update when UI changes
```
