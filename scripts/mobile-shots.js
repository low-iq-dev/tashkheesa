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
  { key: 'queue-new', path: '/portal/doctor/queue?bucket=new' },
  { key: 'cases', path: '/portal/doctor/cases', report: true },
  { key: 'case', path: '/portal/doctor/case/' + fixtures.IDS.orderReview, report: true },
  { key: 'case-new', path: '/portal/doctor/case/' + fixtures.IDS.orderNew },
  { key: 'services', path: '/portal/doctor/services', report: true },
  { key: 'profile', path: '/portal/doctor/profile' },
  { key: 'earnings', path: '/portal/doctor/earnings' },
  { key: 'messages', path: '/portal/messages', report: true },
  { key: 'alerts', path: '/portal/doctor/alerts' },
  { key: 'appointments', path: '/portal/doctor/appointments' },
  { key: 'guide', path: '/portal/doctor/guide' }
].filter((p) => !ONLY || ONLY.includes(p.key));

// Part C (refunds) — the patient request form in each eligibility state, the
// refund timeline on the patient case page, and the operator queue/create.
// `kind` is what the shared eligibility helper must say for that fixture.
const REFUND_PAGES = [
  { key: 'rf-request-pre', as: 'patient', path: '/portal/patient/orders/' + fixtures.IDS.rfPre + '/request-refund', kind: 'full' },
  { key: 'rf-request-std', as: 'patient', path: '/portal/patient/orders/' + fixtures.IDS.rfStd + '/request-refund', kind: 'review' },
  { key: 'rf-request-breach', as: 'patient', path: '/portal/patient/orders/' + fixtures.IDS.rfBreach + '/request-refund', kind: 'surcharge_only' },
  { key: 'rf-request-partial', as: 'patient', path: '/portal/patient/orders/' + fixtures.IDS.rfPartial + '/request-refund', kind: 'remainder' },
  { key: 'rf-case-pending', as: 'patient', path: '/portal/patient/orders/' + fixtures.IDS.rfPending, timeline: 'pending' },
  { key: 'rf-case-partial', as: 'patient', path: '/portal/patient/orders/' + fixtures.IDS.rfPartial, timeline: 'paid', cta: true },
  { key: 'rf-case-breach', as: 'patient', path: '/portal/patient/orders/' + fixtures.IDS.rfBreach, timeline: 'paid' },
  { key: 'rf-case-denied', as: 'patient', path: '/portal/patient/orders/' + fixtures.IDS.rfDenied, timeline: 'denied' },
  { key: 'rf-queue', as: 'ops', path: '/superadmin/refunds', desktop: true },
  { key: 'rf-create', as: 'ops', path: '/superadmin/refunds/create?order_id=' + fixtures.IDS.rfPartial, max: '1800.00' }
].filter((p) => !ONLY || ONLY.includes(p.key) || ONLY.includes('rf'));

const IPHONE_UA ='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const VIEWPORTS = [
  { w: 390, h: 844, phone: true, ua: IPHONE_UA },
  { w: 430, h: 932, phone: true, ua: IPHONE_UA },
  { w: 768, h: 1024, phone: true, ua: IPHONE_UA },
  { w: 1440, h: 900, phone: false }
];
const LANGS = ['ar', 'en'];

const { loadPuppeteer, findChrome } = require('./lib/chrome');

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
  // B10: interactive elements under 44px. Inline text links are exempt (WCAG
  // 2.5.8 inline exception); a checkbox inside its label is exempt (the label
  // is the target).
  const smallTargets = [];
  document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="tab"], summary').forEach((el) => {
    if (!visible(el)) return;
    // Not a target: disabled controls and decorative controls hidden from assistive tech.
    if (el.disabled || el.closest('[aria-hidden="true"]')) return;
    if (getComputedStyle(el).display === 'inline') return;
    if (el.matches('input[type="checkbox"], input[type="radio"]') && el.closest('label')) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (r.height < 43.5 || r.width < 43.5) {
      const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.tagName) + '';
      smallTargets.push(label.replace(/\s+/g, ' ').trim().slice(0, 24) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
  });
  // B7: every Google Fonts family the page asked for (link tags and @imports).
  const fontFamilies = Array.from(new Set(performance.getEntriesByType('resource').map((e) => e.name)
    .concat(Array.from(document.querySelectorAll('link[href*="fonts.googleapis.com/css"]')).map((l) => l.href))
    .filter((n) => /fonts\.googleapis\.com\/css/.test(n))
    .flatMap((href) => { try { return new URL(href).searchParams.getAll('family').map((f) => f.split(':')[0].replace(/\+/g, ' ')); } catch (_) { return []; } })));
  // B1: the tab bar.
  const tabbar = document.querySelector('.portal-tabbar');
  const tabs = Array.from(document.querySelectorAll('.portal-tabbar .portal-tabbar__item'));
  const tabbarInfo = tabbar ? {
    shown: getComputedStyle(tabbar).display !== 'none',
    count: tabs.length,
    bottomGap: Math.round(vh - tabbar.getBoundingClientRect().bottom),
    mirrored: tabs.length > 1 ? (document.documentElement.dir === 'rtl'
      ? tabs[0].getBoundingClientRect().left > tabs[tabs.length - 1].getBoundingClientRect().left
      : tabs[0].getBoundingClientRect().left < tabs[tabs.length - 1].getBoundingClientRect().left) : null,
    minHeight: tabs.length ? Math.min.apply(null, tabs.map((x) => x.getBoundingClientRect().height)) : 0
  } : null;
  // B8: Arabic-Indic digits in counts and money.
  const numericText = Array.from(document.querySelectorAll('.dd-stat-value, .dd-card-count, .dd-widget-value, .dd-perf-value, [data-numeric], .portal-tabbar__badge, .portal-topbar__badge'))
    .filter(visible).map((e) => e.textContent).join(' ');
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
    portalFooters: document.querySelectorAll('.portal-footer').length,
    tierBanners: document.querySelectorAll('.v2-tier-nudge').length,
    smallTargets, fontFamilies, tabbarInfo,
    arabicIndicDigits: /[\u0660-\u0669\u06F0-\u06F9]/.test(numericText),
    manifestLink: !!document.querySelector('link[rel="manifest"]'),
    themeColor: (document.querySelector('meta[name="theme-color"]') || {}).content || null
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
    for (const lang of (PAGES.length ? LANGS : [])) {
      const token = jwt.sign({
        id: fixtures.IDS.doctor, role: 'doctor', email: 'mobilefx-doctor@example.com',
        name: 'Ahmed Mobile Fixture', lang, phone: '+201000000001', country_code: 'EG', specialty_id: null
      }, process.env.JWT_SECRET, { expiresIn: '30m' });

      for (const vp of VIEWPORTS) {
        const page = await browser.newPage();
        // The app rate-limits page requests to 100/min per client IP (static assets
        // are mounted before the limiter and do not count). One run makes ~100
        // navigations from one machine, so each language x viewport pass presents
        // its own client address. Local harness only: the server runs with
        // trust proxy 1, exactly as in production; no app code is bypassed.
        await page.setExtraHTTPHeaders({ 'X-Forwarded-For': '10.13.' + LANGS.indexOf(lang) + '.' + VIEWPORTS.indexOf(vp) });
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
          // B6: never the public marketing footer inside the doctor portal.
          if (m.hasPublicFooter) fails.push('public site footer rendered inside the portal');
          // B4: the tier-confirm banner appears on Today only.
          if (pg.key !== 'today' && m.tierBanners > 0) fails.push('tier banner repeated off Today');
          // B7 / B8 / B9
          if (m.fontFamilies.length > 2 || m.fontFamilies.some((f) => !['Inter', 'Noto Sans Arabic'].includes(f))) fails.push('fonts requested: ' + m.fontFamilies.join(', '));
          if (m.arabicIndicDigits) fails.push('Arabic-Indic digits in counts/money');
          if (!m.manifestLink || !m.themeColor) fails.push('no manifest link / theme-color');
          if (vp.phone) {
            if (m.contentTop === null || m.contentTop >= 600) fails.push('.portal-content starts at ' + m.contentTop + 'px');
            if (m.textTop === null || m.textTop >= 600) fails.push('first text at ' + m.textTop + 'px');
            if (m.sidebarPos !== 'fixed') fails.push('sidebar position ' + m.sidebarPos);
            if (m.sidebarOnScreen) fails.push('sidebar visible before opening');
            // B10: every touch target on a phone is at least 44px.
            if (m.smallTargets.length) fails.push(m.smallTargets.length + ' target(s) under 44px: ' + m.smallTargets.slice(0, 4).join(' | '));
            const tb = m.tabbarInfo;
            // The case screens hand the bottom of the screen to their action bar (checked below).
            if (!tb || !tb.shown) { if (pg.key !== 'case' && pg.key !== 'case-new') fails.push('no tab bar'); }
            else {
              if (tb.count !== 5) fails.push('tab bar has ' + tb.count + ' items');
              if (Math.abs(tb.bottomGap) > 1) fails.push('tab bar not pinned to the bottom (' + tb.bottomGap + 'px)');
              if (tb.mirrored === false) fails.push('tab order not mirrored for ' + lang);
              if (tb.minHeight < 44) fails.push('tab under 44px (' + tb.minHeight + ')');
            }
          } else {
            if (!m.sidebarOnScreen) fails.push('desktop sidebar not visible');
            if (m.tabbarInfo && m.tabbarInfo.shown) fails.push('tab bar visible on desktop');
          }
          if (pg.key === 'today') {
            // B2: phone order and the collapsed secondary cards; desktop order unchanged.
            const o = await page.evaluate(() => {
              const top = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return r.height ? Math.round(r.top + window.scrollY) : -1; };
              const b = document.querySelector('[data-dd-more]');
              return { newA: top('.dd-m-new'), due: top('.dd-m-due'), unread: top('.dd-m-unread'), stats: top('.dd-m-stats'),
                restShown: Array.from(document.querySelectorAll('.dd-m-rest')).filter((e) => e.getBoundingClientRect().height > 0).length,
                more: b ? { hidden: b.hidden, expanded: b.getAttribute('aria-expanded') } : null };
            });
            if (vp.phone) {
              if (!(o.newA < o.due && o.due < o.unread && o.unread < o.stats)) fails.push('Today phone order: ' + JSON.stringify(o));
              if (o.restShown) fails.push(o.restShown + ' secondary Today card(s) not collapsed');
              if (!o.more || o.more.hidden || o.more.expanded !== 'false') fails.push('no collapsed More disclosure');
            } else {
              if (!(o.stats < o.newA && o.newA < o.due)) fails.push('desktop Today order changed: ' + JSON.stringify(o));
              if (o.more && !o.more.hidden) fails.push('More disclosure visible on desktop');
            }
          }
          if ((pg.key === 'cases' || pg.key === 'queue' || pg.key === 'queue-new') && vp.phone) {
            // B3: compact cards with one action; filter tabs stick under the top bar.
            const c = await page.evaluate(() => ({
              heights: Array.from(document.querySelectorAll('.v2-case-row')).map((r) => Math.round(r.getBoundingClientRect().height)),
              ctas: Array.from(document.querySelectorAll('.v2-case-row__cta')).filter((x) => x.getBoundingClientRect().height > 0).length,
              tabs: (() => { const t = document.querySelector('.v2-tabs'); return t ? getComputedStyle(t).position : null; })()
            }));
            if (!c.heights.length) fails.push('no case cards rendered (fixture?)');
            const tall = c.heights.filter((h) => h > 120);
            if (tall.length) fails.push('case card(s) over 120px: ' + tall.join(', '));
            if (c.ctas !== c.heights.length) fails.push(c.ctas + ' actions for ' + c.heights.length + ' cards');
            if (c.tabs && c.tabs !== 'sticky') fails.push('filter tabs are ' + c.tabs);
          }
          if (pg.key === 'case' || pg.key === 'case-new') {
            // B5: the pinned action bar with tier + countdown, and the tab bar yielding to it.
            const b = await page.evaluate(() => {
              const bar = document.querySelector('[data-actionbar]');
              const shown = !!bar && getComputedStyle(bar).display !== 'none';
              const r = bar ? bar.getBoundingClientRect() : null;
              const btns = bar ? Array.from(bar.querySelectorAll('button')).map((x) => ({ text: x.textContent.trim(), h: Math.round(x.getBoundingClientRect().height), form: x.getAttribute('form') })) : [];
              const tab = document.querySelector('.portal-tabbar');
              const meta = bar && bar.querySelector('.v2-actionbar__meta');
              return {
                shown, bottomGap: r ? Math.round(window.innerHeight - r.bottom) : null, btns,
                meta: meta ? meta.textContent.trim() : null,
                tabShown: !!tab && getComputedStyle(tab).display !== 'none',
                fields16: Array.from(document.querySelectorAll('#report-form textarea')).every((t) => parseFloat(getComputedStyle(t).fontSize) >= 16)
              };
            });
            if (vp.phone) {
              if (!b.shown) fails.push('no action bar');
              else {
                if (Math.abs(b.bottomGap) > 1) fails.push('action bar not pinned (' + b.bottomGap + 'px)');
                if (!b.meta || !/(VIP|Urgent|Standard|عاجل|قياسي)/.test(b.meta)) fails.push('tier/countdown not in the action bar: ' + b.meta);
                if (b.btns.some((x) => x.h < 44)) fails.push('action under 44px');
                if (pg.key === 'case' && !(b.btns.some((x) => x.form === 'report-form' && /Submit|إرسال/.test(x.text)) && b.btns.some((x) => x.form === 'report-form' && /Save|حفظ/.test(x.text)))) fails.push('Save/Submit missing from the bar');
                if (pg.key === 'case-new' && !b.btns.some((x) => x.form === 'acceptCaseForm')) fails.push('Accept missing from the bar');
              }
              if (b.tabShown) fails.push('tab bar still shown over the case actions');
              if (pg.key === 'case' && !b.fields16) fails.push('report fields under 16px (iOS zooms on focus)');
            } else if (b.shown) {
              fails.push('action bar visible on desktop');
            }
          }
          if (!vp.phone) m.smallTargets = []; // the 44px rule is for touch widths
          rows.push({ id, status, ...m, fails });
          if (fails.length) failures.push(id + ': ' + fails.join('; '));

          const name = `${lang}-${pg.key}-${vp.w}.png`;
          const toDocs = vp.w === 390 || (vp.w === 1440 && pg.report);
          await page.screenshot({ path: path.join(toDocs ? docsDir : tmpDir, name) });

          if (pg.key === 'case' && vp.w === 390 && lang === 'en') {
            // B5 end to end: type, blur, "Draft saved HH:MM", reload shows the text; then
            // an unsaved change raises the beforeunload guard when leaving the page.
            const afails = [];
            const marker = 'autosave-check-' + Date.now();
            await page.click('#rep-impr');
            await page.keyboard.type(' ' + marker);
            await page.evaluate(() => document.getElementById('rep-impr').blur());
            await page.waitForFunction(() => { const s = document.querySelector('[data-autosave-stamp]'); return s && !s.hidden && s.textContent.length > 0; }, { timeout: 15000 }).catch(() => null);
            const stampText = await page.evaluate(() => { const s = document.querySelector('[data-autosave-stamp]'); return s && !s.hidden ? s.textContent : null; });
            const labelText = await page.evaluate(() => { const l = document.querySelector('[data-autosave-label]'); return l ? l.textContent : null; });
            if (!stampText || !/^Draft saved \d\d:\d\d$/.test(stampText)) afails.push('stamp after blur: ' + stampText);
            if (labelText !== 'Drafts save automatically') afails.push('card label: ' + labelText);
            await page.goto(base + pg.path, { waitUntil: 'networkidle2' });
            const persisted = await page.evaluate((mk) => ((document.getElementById('rep-impr') || {}).value || '').includes(mk), marker);
            if (!persisted) afails.push('autosaved text not there after reload');
            await page.click('#rep-rec');
            await page.keyboard.type('unsaved');
            let sawGuard = false;
            const onDialog = async (d) => { if (d.type() === 'beforeunload') sawGuard = true; try { await d.accept(); } catch (_) {} };
            page.on('dialog', onDialog);
            await page.goto(base + '/portal/doctor/today', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
            page.off('dialog', onDialog);
            if (!sawGuard) afails.push('no beforeunload guard with unsaved changes');
            rows.push({ id: 'en autosave @390', status: 200, fails: afails });
            if (afails.length) failures.push('en autosave @390: ' + afails.join('; '));
          }
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
        // A PUBLIC page visited by a signed-in doctor keeps the public chrome:
        // the portal footer/top bar are for the portal frame only.
        if (vp.w === 390) {
          await page.goto(base + '/refund-policy', { waitUntil: 'domcontentloaded', timeout: 45000 });
          const pub = await page.evaluate(() => ({
            publicFooter: !!document.querySelector('.site-footer'),
            portalFooter: !!document.querySelector('.portal-footer'),
            topbar: !!document.querySelector('.portal-topbar')
          }));
          const pfails = [];
          if (!pub.publicFooter) pfails.push('public footer missing on /refund-policy for a signed-in doctor');
          if (pub.portalFooter || pub.topbar) pfails.push('portal chrome leaked onto a public page');
          if (lang === 'en') {
            // B9: the manifest is served and its icons resolve.
            const man = await page.evaluate(async () => {
              const out = { icons: [] };
              const r = await fetch('/manifest.webmanifest');
              out.status = r.status; out.type = r.headers.get('content-type') || '';
              try { out.json = await r.json(); } catch (e) { out.parseError = String(e); }
              for (const ic of ((out.json && out.json.icons) || [])) { const ir = await fetch(ic.src); out.icons.push(ic.src + ':' + ir.status); }
              return out;
            });
            if (man.status !== 200 || man.parseError) pfails.push('manifest not served (' + man.status + ' ' + (man.parseError || '') + ')');
            else if (!man.json.icons || man.json.icons.length < 2 || man.icons.some((x) => !/:200$/.test(x))) pfails.push('manifest icons: ' + man.icons.join(', '));
            rows.push({ id: 'manifest', status: man.status, fails: [] , note: man.type });
          }
          rows.push({ id: `${lang} public page @390`, status: 200, fails: pfails });
          if (pfails.length) failures.push(`${lang} public page @390: ` + pfails.join('; '));
        }
        await page.close();
      }
    }
    if (REFUND_PAGES.length) await refundPass({ browser, base, jwt, cookieName, docsDir, rows, failures });
  } finally {
    await browser.close();
    if (server) { server.child.kill('SIGTERM'); setTimeout(() => { try { server.child.kill('SIGKILL'); } catch (_) {} }, 3000).unref(); }
  }

  console.log('\nmobile:check — label "' + LABEL + '", ' + rows.length + ' checks\n');
  for (const r of rows) {
    const meta = r.docHeight != null
      ? `content@${r.contentTop} text@${r.textTop} sidebar=${r.sidebarPos} h=${r.docHeight} ovX=${r.overflowX} footer=${r.hasPublicFooter ? 'public' : 'no'} tierBanner=${r.tierBanners} small=${(r.smallTargets || []).length}`
      : '';
    console.log((r.fails.length ? '  FAIL ' : '  ok   ') + r.id.padEnd(26) + ' ' + meta + (r.fails.length ? '\n         ↳ ' + r.fails.join('; ') : '') +
      ((r.smallTargets && r.smallTargets.length) ? '\n         · under 44px: ' + r.smallTargets.slice(0, 6).join(' | ') : ''));
  }
  console.log('\nScreenshots: ' + path.relative(ROOT, docsDir) + ' (390px + 1440px report pages), ' + tmpDir + ' (rest)');
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
}

// Part C — refund screens, as the fixture patient and the fixture operator.
async function refundPass({ browser, base, jwt, cookieName, docsDir, rows, failures }) {
  const who = {
    patient: { id: fixtures.IDS.patient, role: 'patient', email: 'mobilefx-patient@example.com', name: 'Mona Fixture', phone: '+201000000002' },
    ops: { id: fixtures.IDS.ops, role: 'superadmin', email: 'mobilefx-ops@example.com', name: 'Omar Ops Fixture' }
  };
  for (const lang of LANGS) {
    const widths = [{ w: 390, h: 844, phone: true }, { w: 1440, h: 900, phone: false }];
    for (const vp of widths) {
      const page = await browser.newPage();
      await page.setExtraHTTPHeaders({ 'X-Forwarded-For': '10.14.' + LANGS.indexOf(lang) + '.' + vp.w % 250 });
      await page.setViewport({ width: vp.w, height: vp.h, isMobile: vp.phone, hasTouch: vp.phone, deviceScaleFactor: 1 });
      if (vp.phone) await page.setUserAgent(IPHONE_UA);
      const host = new URL(base).hostname;
      for (const pg of REFUND_PAGES) {
        if (!vp.phone && !pg.desktop) continue;
        const token = jwt.sign(Object.assign({ lang }, who[pg.as]), process.env.JWT_SECRET, { expiresIn: '30m' });
        await page.setCookie({ name: cookieName, value: token, domain: host, path: '/', httpOnly: true },
          { name: 'lang', value: lang, domain: host, path: '/' });
        const resp = await page.goto(base + pg.path, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null);
        await new Promise((r) => setTimeout(r, 500));
        const status = resp ? resp.status() : 0;
        const m = await page.evaluate(() => {
          const q = (s) => document.querySelector(s);
          const elig = q('[data-refund-eligibility]');
          const tl = q('[data-refund-timeline]');
          const submit = q('[data-refund-submit]');
          const bar = submit && submit.closest('[data-refund-submitbar]');
          const smallInputs = Array.from(document.querySelectorAll('main input:not([type=hidden]), main textarea'))
            .filter((el) => el.getBoundingClientRect().width && parseFloat(getComputedStyle(el).fontSize) < 16).length;
          const block = q('[data-refund-block]');
          return {
            path: location.pathname,
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            kind: elig ? elig.getAttribute('data-kind') : null,
            eligText: elig ? elig.textContent.replace(/\s+/g, ' ').trim() : '',
            submitDisabled: submit ? submit.disabled : null,
            submitBarPos: bar ? getComputedStyle(bar).position : null,
            instapay: (q('[name=instapay_handle]') || {}).value || null,
            smallInputs,
            timeline: tl ? tl.getAttribute('data-refund-timeline') : null,
            timelineSteps: tl ? tl.querySelectorAll('[data-step]').length : 0,
            blockText: block ? block.textContent.replace(/\s+/g, ' ').trim() : '',
            cta: !!q('[data-refund-cta]'),
            cancelConfirm: !!q('form[action$="/refund-request/cancel"] [data-confirm], form[action$="/refund-request/cancel"][data-confirm]'),
            tabs: document.querySelectorAll('[data-refund-tab]').length,
            rowsWithBdi: Array.from(document.querySelectorAll('[data-refund-id]')).filter((r) => r.querySelector('bdi')).length,
            rowCount: document.querySelectorAll('[data-refund-id]').length,
            confirmForms: document.querySelectorAll('form[data-confirm][action*="/superadmin/refunds/"]').length,
            amountMax: (q('#amount') || {}).max || null
          };
        });
        const id = `${lang} ${pg.key} @${vp.w}`;
        const fails = [];
        // 304: the same page revisited at the next width, served from the ETag.
        if (status !== 200 && status !== 304) fails.push('HTTP ' + status);
        if (!m.path.startsWith(pg.path.split('?')[0])) fails.push('landed on ' + m.path);
        if (m.overflowX > 0) fails.push('horizontal scroll ' + m.overflowX + 'px');
        if (pg.kind) {
          if (m.kind !== pg.kind) fails.push('eligibility kind ' + m.kind + ' (expected ' + pg.kind + ')');
          if (!m.eligText) fails.push('no eligibility text');
          const nothing = pg.kind === 'surcharge_only' || pg.kind === 'nothing';
          if (m.submitDisabled !== nothing) fails.push('submit disabled=' + m.submitDisabled);
          if (!nothing && m.instapay !== '+201000000002') fails.push('InstaPay not prefilled from the profile (' + m.instapay + ')');
          if (vp.phone && !['sticky', 'fixed'].includes(m.submitBarPos)) fails.push('submit not sticky (' + m.submitBarPos + ')');
          if (m.smallInputs) fails.push(m.smallInputs + ' field(s) under 16px');
        }
        if (pg.timeline) {
          if (m.timeline !== pg.timeline) fails.push('timeline state ' + m.timeline + ' (expected ' + pg.timeline + ')');
          if (m.timelineSteps < 2) fails.push('timeline has ' + m.timelineSteps + ' steps');
          if (/•/.test(m.blockText)) fails.push('a "•" placeholder in the refund block');
          if (pg.timeline === 'denied' && !/consultant has already reviewed|راجع/.test(m.blockText)) fails.push('denial reason not shown');
          if (pg.timeline === 'paid' && !/0002/.test(m.blockText)) fails.push('paid-to last 4 digits not shown');
          if (pg.timeline === 'pending' && !m.cancelConfirm) fails.push('no confirm on cancel');
          if (!!pg.cta !== m.cta) fails.push('request CTA shown=' + m.cta);
        }
        if (pg.key === 'rf-queue') {
          if (m.tabs !== 4) fails.push(m.tabs + ' filter tabs');
          if (!m.rowCount || m.rowsWithBdi !== m.rowCount) fails.push('patient names not in <bdi> (' + m.rowsWithBdi + '/' + m.rowCount + ')');
          if (m.confirmForms < 3) fails.push('actions without a confirm step');
        }
        if (pg.max && m.amountMax !== pg.max) fails.push('create max ' + m.amountMax + ' (expected ' + pg.max + ')');
        rows.push({ id, status, fails });
        if (fails.length) failures.push(id + ': ' + fails.join('; '));
        const full = !pg.timeline;
        if (pg.timeline) {
          await page.evaluate(() => {
            const el = document.querySelector('[data-refund-block],[data-refund-status],[data-refund-cta]');
            if (el) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 80));
          });
          await new Promise((r) => setTimeout(r, 200));
        }
        await page.screenshot({ path: path.join(docsDir, `${lang}-${pg.key}-${vp.w}.png`), fullPage: full });
      }
      await page.close();
    }
  }
}

module.exports = { bootServer, measure };

if (require.main === module) {
  main().catch((err) => { console.error('mobile:check could not run:', err.stack || err.message); process.exit(2); });
}
