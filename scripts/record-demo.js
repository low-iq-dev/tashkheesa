#!/usr/bin/env node
/**
 * Tashkheesa Demo Video Recorder
 *
 * Automates Puppeteer through the full user journey, captures
 * high-quality screenshots, and combines them into an MP4 with FFmpeg.
 *
 * Usage:
 *   1. Start the app:  npm start
 *   2. Run:            node scripts/record-demo.js
 */

const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────
const BASE_URL = process.env.DEMO_URL || 'http://localhost:3000';
const VIEWPORT = { width: 1440, height: 900 };
const FRAMES_DIR = '/tmp/tashkheesa-demo/frames';
const OUTPUT_DIR = path.resolve(process.env.HOME || '/tmp', 'Desktop');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'tashkheesa_demo.mp4');
const FPS_CAPTURE = 2;
const FPS_OUTPUT = 30;
const HOLD_MS = 2500;

// Demo credentials
const PATIENT = { name: 'Ahmed Mohamed', email: 'ahmed.demo@example.com', password: 'Demo2026!@' };
const DOCTOR = { email: 'demo.doctor@tashkheesa.com', password: 'demo1234' };

// ─── Helpers ──────────────────────────────────────────────
let frameCount = 0;

function padNum(n, len = 5) { return String(n).padStart(len, '0'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function screenshot(page, holdMs = 500) {
  frameCount++;
  const file = path.join(FRAMES_DIR, `frame_${padNum(frameCount)}.png`);
  await page.screenshot({ path: file, type: 'png', fullPage: false });
  if (holdMs > 0) await sleep(holdMs);
}

async function hold(page, durationMs) {
  const frames = Math.max(1, Math.round((durationMs / 1000) * FPS_CAPTURE));
  for (let i = 0; i < frames; i++) {
    await screenshot(page, 1000 / FPS_CAPTURE);
  }
}

async function slowScroll(page, totalPx, stepPx = 150, stepMs = 300) {
  const steps = Math.ceil(totalPx / stepPx);
  for (let i = 0; i < steps; i++) {
    await page.evaluate((px) => window.scrollBy(0, px), stepPx);
    await screenshot(page, stepMs);
  }
}

async function scrollToTop(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
}

async function typeSlowly(page, selector, text, delay = 80) {
  await page.click(selector);
  await sleep(200);
  await page.type(selector, text, { delay });
}

async function titleCard(page, { heading, subheading, bg = '#0f172a', color = '#fff', subColor = '#94a3b8', icon = '' }) {
  await page.setContent(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"></head>
    <body style="margin:0;">
      <div style="
        width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;
        background:${bg};display:flex;align-items:center;justify-content:center;flex-direction:column;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
        ${icon ? `<div style="font-size:80px;margin-bottom:24px;">${icon}</div>` : ''}
        <h1 style="color:${color};font-size:52px;margin:0 0 16px;font-weight:700;letter-spacing:-1px;">${heading}</h1>
        ${subheading ? `<p style="color:${subColor};font-size:26px;margin:0;">${subheading}</p>` : ''}
      </div>
    </body></html>
  `, { waitUntil: 'load' });
  await hold(page, 3000);
}

async function highlight(page, selector, durationMs = 1500) {
  try {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.style.outline = '3px solid #2563eb';
      el.style.outlineOffset = '4px';
      el.style.transition = 'outline-color 0.3s';
    }, selector);
    await hold(page, durationMs);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.style.outline = ''; el.style.outlineOffset = ''; }
    }, selector);
  } catch (e) { /* skip */ }
}

async function goto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
  } catch (e) {
    console.warn(`  [warn] Navigation to ${url}: ${e.message}`);
  }
  await sleep(500);
}

// ─── Main ─────────────────────────────────────────────────
async function recordDemo() {
  console.log('🎬 Tashkheesa Demo Video Recorder');
  console.log('─'.repeat(50));

  // Setup
  if (fs.existsSync(FRAMES_DIR)) execSync(`rm -rf "${FRAMES_DIR}"`);
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  try { execSync('which ffmpeg', { stdio: 'ignore' }); }
  catch (e) { console.error('❌ ffmpeg not found. brew install ffmpeg'); process.exit(1); }

  // Verify app
  try {
    const http = require('http');
    await new Promise((resolve, reject) => {
      const req = http.get(`${BASE_URL}/health`, (res) => {
        res.statusCode === 200 ? resolve() : reject(new Error(`${res.statusCode}`));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    console.log('✅ App is running at ' + BASE_URL);
  } catch (e) {
    console.error(`❌ App not reachable at ${BASE_URL}. Start with: npm start`);
    process.exit(1);
  }

  console.log('🚀 Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: VIEWPORT,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);

  try {
    // ═══ INTRO ═══
    console.log('📹 INTRO');
    await titleCard(page, {
      heading: 'Tashkheesa',
      subheading: 'Expert Medical Second Opinions',
      icon: '🩺',
      bg: '#0f172a'
    });
    await titleCard(page, { heading: 'How It Works', subheading: 'كيف يعمل', bg: '#0f172a' });

    // ═══ SCENE 1: Landing Page ═══
    console.log('📹 SCENE 1: Landing page');
    await goto(page, BASE_URL);
    await hold(page, HOLD_MS);
    await slowScroll(page, 900, 200, 400);
    await hold(page, 2000);
    await scrollToTop(page);
    await highlight(page, 'a[href="/services"], a[href*="services"], .btn-primary', 2000);
    await hold(page, 1500);

    // ═══ SCENE 2: Services Page ═══
    console.log('📹 SCENE 2: Services & Pricing');
    await goto(page, `${BASE_URL}/services`);
    await hold(page, HOLD_MS);
    await slowScroll(page, 700, 150, 350);
    await hold(page, 2000);
    await scrollToTop(page);
    await hold(page, 1500);

    // ═══ SCENE 3: Registration ═══
    console.log('📹 SCENE 3: Registration');
    await goto(page, `${BASE_URL}/register`);
    await hold(page, 1500);

    try {
      // Fill in form fields (try common selectors)
      for (const [sel, val] of [
        ['input[name="name"]', PATIENT.name],
        ['input[name="email"]', PATIENT.email],
        ['input[name="phone"]', '+201234567890'],
        ['input[name="password"]', PATIENT.password],
        ['input[name="confirm_password"]', PATIENT.password],
      ]) {
        const el = await page.$(sel);
        if (el) {
          await typeSlowly(page, sel, val, 50);
          await screenshot(page, 300);
        }
      }
      await hold(page, 2000);

      // Submit
      const btn = await page.$('button[type="submit"], input[type="submit"]');
      if (btn) {
        await btn.click();
        await sleep(2000);
        await hold(page, 2000);
      }
    } catch (e) {
      console.warn('  [warn] Registration:', e.message);
      await hold(page, 2000);
    }

    // ═══ SCENE 4: Login as patient ═══
    console.log('📹 SCENE 4: Login');
    await goto(page, `${BASE_URL}/login`);
    await hold(page, 1500);

    try {
      await page.evaluate(() => {
        document.querySelectorAll('input').forEach(el => { el.value = ''; });
      });
      const emailSel = 'input[name="email"], input[type="email"]';
      const passSel = 'input[name="password"], input[type="password"]';
      if (await page.$(emailSel)) await typeSlowly(page, emailSel, PATIENT.email, 50);
      await screenshot(page, 200);
      if (await page.$(passSel)) await typeSlowly(page, passSel, PATIENT.password, 30);
      await screenshot(page, 200);
      await hold(page, 1000);

      const btn = await page.$('button[type="submit"]');
      if (btn) { await btn.click(); await sleep(2000); }
    } catch (e) {
      console.warn('  [warn] Login:', e.message);
    }
    await hold(page, 2000);

    // ═══ SCENE 5: Patient Dashboard ═══
    console.log('📹 SCENE 5: Patient dashboard');
    await goto(page, `${BASE_URL}/dashboard`);
    await hold(page, HOLD_MS);
    await slowScroll(page, 500, 150, 300);
    await hold(page, 2000);
    await scrollToTop(page);
    await hold(page, 1500);

    // ═══ SCENE 6: Case creation ═══
    console.log('📹 SCENE 6: New case');
    await titleCard(page, {
      heading: 'Submit a New Case',
      subheading: 'Upload medical files for expert review',
      icon: '📋', bg: '#0f172a'
    });

    // Try the case creation paths
    await goto(page, `${BASE_URL}/patient/new-case`);
    const url1 = page.url();
    if (url1.includes('coming-soon') || url1.includes('coming_soon')) {
      console.log('  ℹ️  Pre-launch mode — showing Coming Soon');
      await hold(page, 3000);
    } else {
      await slowScroll(page, 600, 150, 300);
      await hold(page, 2000);
    }

    // Also show intake form
    await goto(page, `${BASE_URL}/intake`);
    const url2 = page.url();
    if (!url2.includes('coming-soon') && !url2.includes('login')) {
      console.log('  📋 Showing intake form');
      await hold(page, 2000);
      await slowScroll(page, 600, 150, 300);
      await hold(page, 1500);
    }

    // ═══ TRANSITION ═══
    console.log('📹 TRANSITION: Doctor receives case');
    await titleCard(page, {
      heading: 'Meanwhile...',
      subheading: 'Your specialist receives the case',
      icon: '👨‍⚕️', bg: '#0f172a'
    });

    // ═══ SCENE 7: Doctor Login ═══
    console.log('📹 SCENE 7: Doctor login');
    await goto(page, `${BASE_URL}/logout`);
    await sleep(500);
    await goto(page, `${BASE_URL}/login`);
    await hold(page, 1000);

    try {
      await page.evaluate(() => {
        document.querySelectorAll('input').forEach(el => { el.value = ''; });
      });
      const emailSel = 'input[name="email"], input[type="email"]';
      const passSel = 'input[name="password"], input[type="password"]';
      if (await page.$(emailSel)) await typeSlowly(page, emailSel, DOCTOR.email, 50);
      await screenshot(page, 200);
      if (await page.$(passSel)) await typeSlowly(page, passSel, DOCTOR.password, 30);
      await screenshot(page, 200);
      await hold(page, 1000);

      const btn = await page.$('button[type="submit"]');
      if (btn) { await btn.click(); await sleep(2000); }
    } catch (e) {
      console.warn('  [warn] Doctor login:', e.message);
    }
    await hold(page, 2000);

    // ═══ SCENE 8: Doctor Dashboard ═══
    console.log('📹 SCENE 8: Doctor dashboard');
    await goto(page, `${BASE_URL}/portal/doctor`);
    await hold(page, HOLD_MS);
    await slowScroll(page, 600, 150, 300);
    await hold(page, 2000);
    await scrollToTop(page);
    await hold(page, 1500);

    // ═══ SCENE 9: Doctor Queue ═══
    console.log('📹 SCENE 9: Doctor case queue');
    await goto(page, `${BASE_URL}/portal/doctor/queue`);
    await hold(page, HOLD_MS);
    await slowScroll(page, 400, 150, 300);
    await hold(page, 2000);

    // ═══ SCENE 10: Doctor Alerts & Analytics ═══
    console.log('📹 SCENE 10: Doctor alerts & analytics');
    await goto(page, `${BASE_URL}/portal/doctor/alerts`);
    await hold(page, HOLD_MS);
    await slowScroll(page, 300, 150, 300);
    await hold(page, 1500);

    await goto(page, `${BASE_URL}/portal/doctor/analytics`);
    await hold(page, HOLD_MS);
    await slowScroll(page, 400, 150, 300);
    await hold(page, 1500);

    // Doctor reviews
    await goto(page, `${BASE_URL}/portal/doctor/reviews`);
    await hold(page, HOLD_MS);
    await hold(page, 1500);

    // ═══ TRANSITION: Report ready ═══
    console.log('📹 TRANSITION: Report ready');
    await titleCard(page, {
      heading: 'Your Report is Ready!',
      subheading: 'Expert medical second opinion delivered',
      icon: '🔔', bg: '#0f172a'
    });

    // ═══ SCENE 11: Trust Pages ═══
    console.log('📹 SCENE 11: About & trust pages');
    await goto(page, `${BASE_URL}/about`);
    await hold(page, 2000);
    await slowScroll(page, 400, 200, 300);
    await hold(page, 1500);

    // ═══ OUTRO ═══
    console.log('📹 OUTRO');
    await titleCard(page, {
      heading: 'Tashkheesa',
      subheading: 'Second opinions, done right.',
      icon: '🩺', bg: '#0f172a'
    });
    await titleCard(page, {
      heading: 'tashkheesa.com',
      subheading: 'Coming February 28, 2026',
      bg: '#0f172a', color: '#60a5fa', subColor: '#94a3b8'
    });

    // Final black
    await page.setContent(`<html><body style="margin:0;background:#0f172a;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;"></body></html>`);
    await hold(page, 2000);

  } finally {
    await browser.close();
  }

  // ═══ COMPILE VIDEO ═══
  console.log('');
  console.log(`📸 Captured ${frameCount} frames`);
  console.log('🎞️  Compiling video with FFmpeg...');

  try {
    const cmd = [
      'ffmpeg -y',
      `-framerate ${FPS_CAPTURE}`,
      `-i "${FRAMES_DIR}/frame_%05d.png"`,
      '-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p',
      `-r ${FPS_OUTPUT}`,
      `-vf "scale=${VIEWPORT.width}:${VIEWPORT.height}:flags=lanczos,format=yuv420p"`,
      '-movflags +faststart',
      `"${OUTPUT_FILE}"`
    ].join(' ');

    console.log(`  > ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });

    const stats = fs.statSync(OUTPUT_FILE);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);

    console.log('');
    console.log('═'.repeat(50));
    console.log(`✅ Demo video saved: ${OUTPUT_FILE}`);
    console.log(`   Size: ${sizeMB} MB | Frames: ${frameCount} | Duration: ~${Math.round(frameCount / FPS_CAPTURE)}s`);
    console.log('═'.repeat(50));
  } catch (e) {
    console.error('❌ FFmpeg failed:', e.message);
    console.log(`   Frames saved at: ${FRAMES_DIR}/`);
    console.log(`   Manual: ffmpeg -framerate ${FPS_CAPTURE} -i "${FRAMES_DIR}/frame_%05d.png" -c:v libx264 -pix_fmt yuv420p "${OUTPUT_FILE}"`);
    process.exit(1);
  }

  // Cleanup
  try { execSync(`rm -rf "${FRAMES_DIR}"`); } catch (e) {}
  console.log('🎬 Done!');
}

recordDemo().catch((err) => {
  console.error('❌ Recording failed:', err);
  process.exit(1);
});
