# TASHKHEESA DEMO VIDEO — Automated Screen Recording

## OBJECTIVE
Create a polished marketing/tutorial video showing the complete Tashkheesa user journey.
Record the localhost:3000 app using Puppeteer screen recording, then combine clips with FFmpeg.

## SETUP
```bash
npm install puppeteer @puppeteer/recorder 2>/dev/null || true
brew install ffmpeg 2>/dev/null || true
```

If puppeteer screen recording isn't available, use puppeteer screenshots at each step and combine them into a video with FFmpeg (screenshot slideshow approach with transitions).

Alternative approach if needed: Use the `screencapture` macOS command for native screen recording:
```bash
# Record screen to video file
screencapture -v /tmp/demo_clip.mov
```

## RECORDING APPROACH

Use Puppeteer to:
1. Launch Chrome in a 1920x1080 viewport (or 1440x900 for a cleaner look)
2. Navigate through each step
3. Take screenshots at each key moment (PNG, high quality)
4. Use page.screencast() if available, OR take rapid screenshots (every 500ms) during interactions
5. Combine everything with FFmpeg into a single MP4

## VIDEO STRUCTURE & SCRIPT

### INTRO (3 seconds)
- Black screen with Tashkheesa logo centered
- Text: "How It Works" / "كيف يعمل"
- Fade in

### SCENE 1: Landing Page (5 seconds)
- Browser opens to http://localhost:3000
- Slow scroll down showing the homepage
- Pause on "Expert Medical Consultations" hero
- Highlight "View Services & Pricing" button

### SCENE 2: Services Page (8 seconds)  
- Click "View Services & Pricing" (or navigate to /services)
- Show specialties grid
- Click into a specialty (e.g., Radiology)
- Show available services with prices in EGP
- Hover/highlight a specific service

### SCENE 3: Patient Registration (8 seconds)
- Click "Sign In" → "Create account"
- Fill in registration form:
  - Name: "Ahmed Mohamed"
  - Email: "ahmed.demo@example.com"
  - Country: Egypt
  - Phone: +20 123 456 7890
  - Password: ••••••••
- Click Register
- Show success / redirect to dashboard

### SCENE 4: Patient Dashboard (4 seconds)
- Show the Clarity theme patient portal
- Clean dashboard with navigation
- Highlight "New Case" button or case creation flow

### SCENE 5: Create New Case (12 seconds)
- Navigate to case creation
- Step 1: Select Specialty → Radiology
- Step 2: Select Service → e.g., "MRI Brain Review"
- Step 3: Upload medical files (simulate drag & drop or file select)
  - Show file validation / preview
- Step 4: Add clinical notes: "Patient presents with recurring headaches. MRI performed on 15/02/2026. Requesting specialist review of findings."
- Step 5: Choose SLA — show both options:
  - ⚡ Priority (24 hours) — highlighted
  - 📋 Standard (72 hours)
- Step 6: Review & submit
- Show confirmation page: "Your case has been submitted! Reference: TSK-2026-XXXX"

### SCENE 6: TRANSITION — "Meanwhile, your specialist receives the case..." (3 seconds)
- Animated text overlay or simple title card

### SCENE 7: Doctor Portal (10 seconds)
- Log out patient, log in as doctor: dr.radiology@tashkheesa.com / test1234
- Show Clinical Workspace theme
- Dashboard with streak banner, KPI cards
- New case appears in "New Assignments" with SLA badge
- Click into Case Queue
- Show the case card with "Overdue" or SLA timer badge
- Click "Accept" on the case
- Case moves to "In Review"

### SCENE 8: Doctor Reviews Case (8 seconds)
- Open the case detail
- Show uploaded medical files
- Show annotation tools (if available)
- Doctor writes review notes
- Show report submission flow

### SCENE 9: TRANSITION — "Your report is ready!" (3 seconds)
- Title card with notification bell icon

### SCENE 10: Patient Receives Report (6 seconds)
- Switch back to patient login
- Dashboard shows notification: "Report Ready"
- Open the case → View report
- Show the completed medical report
- Professional formatting with doctor's assessment

### OUTRO (4 seconds)
- Tashkheesa logo
- "Second opinions, done right."
- "tashkheesa.com"
- "Coming February 28, 2026"

## TECHNICAL IMPLEMENTATION

### Option A: Puppeteer Screenshot Slideshow
```javascript
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');

async function recordDemo() {
  const browser = await puppeteer.launch({ 
    headless: false, // Need visible browser for screen recording
    defaultViewport: { width: 1440, height: 900 },
    args: ['--window-size=1440,900']
  });
  const page = await browser.newPage();
  
  // Create output directory
  execSync('mkdir -p /tmp/tashkheesa-demo/frames');
  
  let frameCount = 0;
  
  async function screenshot(delay = 500) {
    frameCount++;
    const padded = String(frameCount).padStart(5, '0');
    await page.screenshot({ 
      path: `/tmp/tashkheesa-demo/frames/frame_${padded}.png`,
      type: 'png'
    });
    if (delay) await new Promise(r => setTimeout(r, delay));
  }
  
  // SCENE 1: Landing page
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
  await screenshot(2000); // Hold for 2 seconds (multiple frames)
  // Take multiple frames for "hold" effect
  for (let i = 0; i < 4; i++) await screenshot(500);
  
  // Scroll down slowly
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 200));
    await screenshot(300);
  }
  
  // ... continue for each scene ...
  
  await browser.close();
  
  // Combine frames into video with FFmpeg
  execSync(`
    ffmpeg -framerate 2 -i /tmp/tashkheesa-demo/frames/frame_%05d.png \
    -c:v libx264 -pix_fmt yuv420p -vf "scale=1440:900" \
    /tmp/tashkheesa-demo/tashkheesa_demo.mp4
  `);
}

recordDemo().catch(console.error);
```

### Option B: macOS Native Screen Recording + Puppeteer Automation
1. Start macOS screen recording: `screencapture -v /tmp/demo.mov`
2. Run Puppeteer script that automates the browser interactions
3. Stop recording
4. Use FFmpeg to add title cards and transitions

### Title Cards
Create title card images using Node.js canvas or HTML screenshots:
```javascript
// Navigate to a local HTML file with styled title text
await page.setContent(`
  <div style="width:1440px;height:900px;background:#1a365d;display:flex;align-items:center;justify-content:center;flex-direction:column;">
    <h1 style="color:white;font-size:48px;font-family:system-ui;">How It Works</h1>
    <p style="color:#94a3b8;font-size:24px;font-family:system-ui;">كيف يعمل</p>
  </div>
`);
await screenshot(2000);
```

## OUTPUT
- Final video: `~/Desktop/tashkheesa_demo.mp4`
- Resolution: 1440x900 or 1920x1080
- Duration: ~60-70 seconds total
- Format: MP4 (H.264)

## TEST ACCOUNTS TO USE
- Patient: Register fresh as "Ahmed Mohamed" / ahmed.demo@example.com
- Doctor: dr.radiology@tashkheesa.com / test1234
- Make sure localhost:3000 is running before starting

## IMPORTANT NOTES
- The "Coming Soon" redirects may block case creation. If so, the script should handle this gracefully — either skip that step and show a mockup, or temporarily bypass the redirect in the route.
- Keep interactions slow and deliberate — this is for viewers to follow along
- Add mouse cursor movements where possible to show what's being clicked
- Each "hold" moment should last 2-3 seconds so viewers can read
- Record at 2 FPS for screenshots, then speed up to 30 FPS with frame duplication in FFmpeg
