#!/usr/bin/env node
'use strict';

/**
 * Phone layout guard for the doctor portal — `npm run mobile:check`.
 *
 * Why (2026-09-13): every consultant was invited by WhatsApp and opens the
 * portal on a phone. On a 390px screen every doctor page opened on a blank
 * cream screen with the sidebar rendered IN FLOW as the first 844px, because
 * doctor-portal.css overrode the off-canvas drawer in portal-global.css with
 * `position: relative !important` at <=640px. Nothing caught it: no test ever
 * rendered the portal at a phone width. This does, in a real browser.
 *
 * What it does:
 *   1. Seeds local-only fixtures (scripts/mobile-fixtures.js — refuses a
 *      non-local database).
 *   2. Boots src/server.js on :3100 against that database with every external
 *      channel disabled and every third-party credential blanked, so nothing
 *      it renders can send an email, a WhatsApp message or a payment call.
 *      (Pass MOBILE_BASE_URL to use a server you already started instead.)
 *   3. Signs a session for the fixture doctor and visits each doctor page in
 *      Arabic and English at 390x844, 430x932, 768x1024 and 1440x900.
 *   4. Asserts, per phone-width page:
 *        - no horizontal scroll (documentElement.scrollWidth <= clientWidth)
 *        - .portal-content itself AND its first visible text start inside the
 *          first screen (top < 600px before any scroll). Measuring only the
 *          first text node is not enough: it can sit at top:20 inside a
 *          content column that the grid has pushed below an in-flow sidebar.
 *        - the sidebar is out of the layout flow (computed position: fixed)
 *          and off screen until opened
 *      and on the desktop width: no horizontal scroll and the sidebar visible.
 *      Plus, on Today at 390px: the drawer opens fully on screen, locks body
 *      scroll, and Escape closes it.
 *   5. Writes screenshots. 390px (all pages) and 1440px (report pages) go to
 *      docs/audits/mobile/<label>/; the rest to the OS temp dir.
 *
 * Usage:  npm run mobile:check -- [--label after] [--only today,cases]
 * Env:    MOBILE_DATABASE_URL (default postgresql://localhost:5432/tashkheesa_mobile)
 *         MOBILE_BASE_URL     (skip booting a server)
 *         CHROME_PATH         (default: newest Chrome for Testing in ~/.cache/puppeteer)
 *         PUPPETEER_CORE_DIR  (default: require('puppeteer-core'), then ~/mobile_audit)
 * Exit:   0 all assertions pass, 1 any fail, 2 harness could not run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
function argVal(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const LABEL = argVal('label', 'current');
const ONLY = argVal('only', '') ? argVal('only', '').split(',') : null;
const PORT = Number(process.env.MOBILE_PORT || 3100);

const fixtures = require('./mobile-fixtures');

const PAGES = [
  { key: 'today', path: '/portal/doctor/today', report: true },
  { key: 'queue', path: '/portal/doctor/queue' },
  { key: 'cases', path: '/portal/doctor/cases', report: true },
  { key: 'case', path: '/portal/doctor/case/' + fixtures.IDS.orderReview, report: true },
  { key: 'services', path: '/portal/doctor/services', report: true },
  { key: 'profile', path: '/portal/doctor/profile' },
  { key: 'earnings', path: '/portal/doctor/earnings' },
  { key: 'messages', path: '/portal/messages', report: true },
  { key: 'alerts', path: '/portal/doctor/alerts' },
  { key: 'appointments', path: '/portal/doctor/appointments' },
  { key: 'guide', path: '/portal/doctor/guide' }
].filter((p) => !ONLY || ONLY.includes(p.key));

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const VIEWPORTS = [
  { w: 390, h: 844, phone: true, ua: IPHONE_UA },
  { w: 430, h: 932, phone: true, ua: IPHONE_UA },
  { w: 768, h: 1024, phone: true, ua: IPHONE_UA },
  { w: 1440, h: 900, phone: false }
];
const LANGS = ['ar', 'en'];

function loadPuppeteer() {
  const tries = [
    'puppeteer-core',
    process.env.PUPPETEER_CORE_DIR,
    path.join(os.homedir(), 'mobile_audit', 'node_modules', 'puppeteer-core')
  ].filter(Boolean);
  for (const t of tries) {
    try { return require(t); } catch (_) { /* next */ }
  }
  throw new Error('puppeteer-core not found. Install it (npm i -D puppeteer-core) or set PUPPETEER_CORE_DIR.');
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const dir = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  const versions = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const num = (v) => (v.split('-')[1] || '').split('.').map((n) => Number(n) || 0);
  versions.sort((a, b) => {
    const x = num(a); const y = num(b);
    for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  });
  for (const v of versions) {
    const candidates = [
      path.join(dir, v, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(dir, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(dir, v, 'chrome-linux64', 'chrome')
    ];
    const hit = candidates.find((c) => fs.existsSync(c));
    if (hit) return hit;
  }
  throw new Error('No Chrome for Testing under ' + dir + ' — set CHROME_PATH.');
}

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(3000, () => { req.destroy(); resolve(0); });
  });
}

async function bootServer(dbUrl) {
  const logFile = path.join(os.tmpdir(), 'tashkheesa-mobile-server.log');
  const out = fs.openSync(logFile, 'w');
  // Start from the real env (JWT_SECRET etc.) and switch OFF everything that
  // can leave this machine.
  const env = Object.assign({}, process.env, {
    PORT: String(PORT), DATABASE_URL: dbUrl, PG_SSL: 'false', NODE_ENV: 'development', MODE: 'development',
    SLA_MODE: 'passive', ALLOW_PRIMARY_IN_DEV: '', SLA_DRY_RUN: 'true',
    EMAIL_ENABLED: 'false', WHATSAPP_ENABLED: 'false', APP_URL: 'http://localhost:' + PORT
  });
  for (const k of Object.keys(env)) {
    if (/^(SMTP_|WHATSAPP_ACCESS|WHATSAPP_PHONE|TWILIO_|STRIPE_|OPENAI_|ANTHROPIC_|IG_|META_|FB_|CLOUDINARY_|PAYMOB_|R2_|AWS_|UPLOADCARE_|RESEND_|DATABASE_URL_DIRECT|REDIS)/.test(k)) env[k] = '';
  }
  // Boot refuses to start without it. An inert value: nothing on these pages
  // calls the API, and if something did it would fail auth, not spend money.
  env.ANTHROPIC_API_KEY = 'mobile-check-placeholder-not-a-key';
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', out, out] });
  const base = 'http://localhost:' + PORT;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('server exited early — see ' + logFile);
    if (await get(base + '/health') === 200) return { child, base, logFile };
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill('SIGKILL');
  throw new Error('server did not answer /health in 120s — see ' + logFile);
}

// Runs inside the page.
function measure() {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const vh = window.innerHeight;
  const content = document.querySelector('.portal-content');
  const sidebar = document.querySelector('.portal-sidebar');
  function visible(el) {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    return true;
  }
  let textTop = null;
  let textSample = '';
  if (content) {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (!visible(p)) return NodeFilter.FILTER_REJECT;
        const r = document.createRange(); r.selectNodeContents(n);
        const b = r.getBoundingClientRect();
        return (b.width > 0 && b.height > 0) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const n = walker.nextNode();
    if (n) {
      const r = document.createRange(); r.selectNodeContents(n);
      textTop = Math.round(r.getBoundingClientRect().top);
      textSample = n.nodeValue.trim().slice(0, 40);
    }
  }
  const sr = sidebar ? sidebar.getBoundingClientRect() : null;
  return {
    path: location.pathname,
    vw, vh,
    overflowX: de.scrollWidth - de.clientWidth,
    docHeight: de.scrollHeight,
    contentTop: content ? Math.round(content.getBoundingClientRect().top) : null,
    textTop, textSample,
    sidebarPos: sidebar ? getComputedStyle(sidebar).position : null,
    sidebarOnScreen: sr ? (sr.width > 0 && sr.right > 1 && sr.left < vw - 1 && sr.bottom > 0 && sr.top < vh) : false,
    sidebarFullyOnScreen: sr ? (sr.left >= -1 && sr.right <= vw + 1 && sr.width > 0) : false,
    scrollLockY: getComputedStyle(document.body).overflowY + '/' + getComputedStyle(de).overflowY,
    focusInDrawer: !!(sidebar && document.activeElement && sidebar.contains(document.activeElement)),
    toggleExpanded: (document.querySelector('[data-action="toggle-sidebar"]') || { getAttribute: () => null }).getAttribute('aria-expanded'),
    hasPublicFooter: !!document.querySelector('.site-footer'),
    tierBanners: document.querySelectorAll('.v2-tier-nudge').length
  };
}

async function main() {
  const puppeteer = loadPuppeteer();
  const chrome = findChrome();
  const dbUrl = fixtures.resolveDbUrl();

  // Fixtures in a child process: src/pg binds DATABASE_URL at require time.
  await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'mobile-fixtures.js'), '--migrate'], {
      cwd: ROOT, env: Object.assign({}, process.env, { MOBILE_DATABASE_URL: dbUrl }), stdio: 'inherit'
    });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('fixtures failed'))));
  });

  let server = null;
  let base = process.env.MOBILE_BASE_URL;
  if (!base) { server = await bootServer(dbUrl); base = server.base; }

  const jwt = require('jsonwebtoken');
  const cookieName = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';
  const docsDir = path.join(ROOT, 'docs', 'audits', 'mobile', LABEL);
  const tmpDir = path.join(os.tmpdir(), 'tashkheesa-mobile-shots', LABEL);
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: chrome, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars']
  });
  const failures = [];
  const rows = [];
  try {
    for (const lang of LANGS) {
      const token = jwt.sign({
        id: fixtures.IDS.doctor, role: 'doctor', email: 'mobilefx-doctor@example.com',
        name: 'Ahmed Mobile Fixture', lang, phone: '+201000000001', country_code: 'EG', specialty_id: null
      }, process.env.JWT_SECRET, { expiresIn: '30m' });

      for (const vp of VIEWPORTS) {
        const page = await browser.newPage();
        await page.setViewport({ width: vp.w, height: vp.h, isMobile: vp.phone, hasTouch: vp.phone, deviceScaleFactor: 1 });
        if (vp.ua) await page.setUserAgent(vp.ua);
        const host = new URL(base).hostname;
        await page.setCookie({ name: cookieName, value: token, domain: host, path: '/', httpOnly: true });
        await page.goto(base + '/lang/' + lang + '?next=' + encodeURIComponent('/portal/doctor/today'), { waitUntil: 'domcontentloaded' });

        for (const pg of PAGES) {
          const resp = await page.goto(base + pg.path, { waitUntil: 'networkidle2', timeout: 45000 }).catch((e) => ({ status: () => 0, err: e }));
          // Let entry animations settle so the screenshot shows the resting layout.
          await new Promise((r) => setTimeout(r, 700));
          const m = await page.evaluate(measure);
          const status = resp && resp.status ? resp.status() : 0;
          const id = `${lang} ${pg.key} @${vp.w}`;
          const fails = [];
          if (status !== 200) fails.push('HTTP ' + status);
          if (!m.path.startsWith(pg.path.split('?')[0])) fails.push('landed on ' + m.path);
          if (m.overflowX > 0) fails.push('horizontal scroll ' + m.overflowX + 'px');
          if (vp.phone) {
            if (m.contentTop === null || m.contentTop >= 600) fails.push('.portal-content starts at ' + m.contentTop + 'px');
            if (m.textTop === null || m.textTop >= 600) fails.push('first text at ' + m.textTop + 'px');
            if (m.sidebarPos !== 'fixed') fails.push('sidebar position ' + m.sidebarPos);
            if (m.sidebarOnScreen) fails.push('sidebar visible before opening');
          } else if (!m.sidebarOnScreen) {
            fails.push('desktop sidebar not visible');
          }
          rows.push({ id, status, ...m, fails });
          if (fails.length) failures.push(id + ': ' + fails.join('; '));

          const name = `${lang}-${pg.key}-${vp.w}.png`;
          const toDocs = vp.w === 390 || (vp.w === 1440 && pg.report);
          await page.screenshot({ path: path.join(toDocs ? docsDir : tmpDir, name) });

          if (pg.key === 'today' && vp.w === 390) {
            const toggle = await page.$('[data-action="toggle-sidebar"]');
            if (!toggle) {
              failures.push(`${lang} drawer @390: no toggle button`);
            } else {
              // Compare against the page's own resting overflow: the site CSS
              // already sets overflow-x on body, so "contains hidden" proves
              // nothing. The lock is about the vertical axis.
              const before = await page.evaluate(measure);
              await toggle.click();
              await new Promise((r) => setTimeout(r, 450));
              const open = await page.evaluate(measure);
              const dfails = [];
              if (!open.sidebarFullyOnScreen) dfails.push('drawer not fully on screen when open');
              if (!/hidden/.test(open.scrollLockY)) dfails.push('body scroll not locked (' + open.scrollLockY + ')');
              if (!open.focusInDrawer) dfails.push('focus did not move into the drawer');
              if (open.toggleExpanded !== 'true') dfails.push('toggle aria-expanded=' + open.toggleExpanded);
              await page.screenshot({ path: path.join(docsDir, `${lang}-nav_open-390.png`) });
              await page.keyboard.press('Escape');
              await new Promise((r) => setTimeout(r, 450));
              const closed = await page.evaluate(measure);
              if (closed.sidebarOnScreen) dfails.push('Escape did not close the drawer');
              if (closed.scrollLockY !== before.scrollLockY) dfails.push('scroll lock not released (' + closed.scrollLockY + ' vs ' + before.scrollLockY + ')');
              if (closed.toggleExpanded !== 'false') dfails.push('toggle aria-expanded=' + closed.toggleExpanded + ' after close');
              rows.push({ id: `${lang} drawer @390`, status: 200, fails: dfails });
              if (dfails.length) failures.push(`${lang} drawer @390: ` + dfails.join('; '));
            }
          }
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
    if (server) { server.child.kill('SIGTERM'); setTimeout(() => { try { server.child.kill('SIGKILL'); } catch (_) {} }, 3000).unref(); }
  }

  console.log('\nmobile:check — label "' + LABEL + '", ' + rows.length + ' checks\n');
  for (const r of rows) {
    const meta = r.docHeight != null
      ? `content@${r.contentTop} text@${r.textTop} sidebar=${r.sidebarPos} h=${r.docHeight} ovX=${r.overflowX} footer=${r.hasPublicFooter ? 'public' : 'no'} tierBanner=${r.tierBanners}`
      : '';
    console.log((r.fails.length ? '  FAIL ' : '  ok   ') + r.id.padEnd(26) + ' ' + meta + (r.fails.length ? '\n         ↳ ' + r.fails.join('; ') : ''));
  }
  console.log('\nScreenshots: ' + path.relative(ROOT, docsDir) + ' (390px + 1440px report pages), ' + tmpDir + ' (rest)');
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error('mobile:check could not run:', err.stack || err.message); process.exit(2); });
