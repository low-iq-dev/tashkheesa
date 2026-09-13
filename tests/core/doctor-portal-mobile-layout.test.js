// tests/core/doctor-portal-mobile-layout.test.js
//
// 2026-09-13 (mobile A1–A4). Every doctor page opened on a blank phone screen:
// doctor-portal.css positioned the sidebar with rules that applied at EVERY
// width (position:fixed + left:0 + width, all !important), and at <=640px
// turned it into a full-width in-flow block; doctor-portal-v2.css made it
// sticky and 100vh tall with a selector that out-ranked the phone drawer rule.
// The drawer in portal-global.css never won. The browser guard for this is
// `npm run mobile:check` (scripts/mobile-shots.js) — it needs Chrome and a
// local server, so it cannot run here. This file pins the SOURCE shape of the
// fix so the cascade cannot quietly be reintroduced between browser runs.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n📱 doctor portal phone layout (mobile A1–A4)\n');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function check(name, fn) {
  try {
    const err = fn();
    if (err) t.fail(name, new Error(err)); else t.pass(name);
  } catch (e) { t.fail(name, e); }
}

// Split a stylesheet into { media, selector, body } rules, one level of @media deep.
function rules(css) {
  const out = [];
  const src = stripCssComments(css);
  let i = 0;
  function readBlock(start) {
    let depth = 0;
    for (let j = start; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) return j; }
    }
    return src.length;
  }
  function parse(chunk, media) {
    let k = 0;
    while (k < chunk.length) {
      const open = chunk.indexOf('{', k);
      if (open < 0) break;
      const prelude = chunk.slice(k, open).trim();
      let depth = 0; let close = open;
      for (let j = open; j < chunk.length; j++) {
        if (chunk[j] === '{') depth++;
        else if (chunk[j] === '}') { depth--; if (depth === 0) { close = j; break; } }
      }
      const body = chunk.slice(open + 1, close);
      if (prelude.startsWith('@media')) parse(body, prelude);
      else if (!prelude.startsWith('@')) out.push({ media, selector: prelude, body });
      k = close + 1;
    }
  }
  void readBlock; void i;
  parse(src, null);
  return out;
}

const minWidth = (media) => {
  const m = media && media.match(/min-width:\s*(\d+)px/);
  return m ? Number(m[1]) : 0;
};
const declares = (body, prop) => new RegExp('(^|[;\\s])' + prop + '\\s*:', 'i').test(body);

check('doctor-portal.css positions the sidebar and content column only at >=769px', () => {
  const bad = rules(read('public/css/doctor-portal.css')).filter((r) =>
    /\.doctor-theme\s+\.portal-(sidebar|content)\s*$/.test(r.selector.split(',').pop().trim()) &&
    ['position', 'width', 'left', 'top', 'margin-inline-start'].some((p) => declares(r.body, p)) &&
    minWidth(r.media) < 769
  );
  return bad.length
    ? 'layout declarations outside a min-width:769px block: ' + bad.map((r) => (r.media || '(no media)') + ' ' + r.selector).join(' | ')
    : null;
});

check('no doctor stylesheet puts the sidebar back in flow on a phone', () => {
  for (const f of ['public/css/doctor-portal.css', 'public/css/doctor-portal-v2.css']) {
    const hit = rules(read(f)).find((r) => /portal-sidebar|v2-sidebar/.test(r.selector) &&
      /position\s*:\s*(relative|static|sticky)/i.test(r.body) && minWidth(r.media) < 769);
    if (hit) return f + ': ' + (hit.media || '(no media)') + ' ' + hit.selector + ' sets an in-flow position below 769px';
  }
  return null;
});

check('portal-global.css owns the doctor drawer at <=768px (fixed, off-canvas, hidden until open)', () => {
  const rs = rules(read('public/css/portal-global.css')).filter((r) => r.media && /max-width:\s*768px/.test(r.media));
  const drawer = rs.find((r) => r.selector.trim() === '.doctor-theme .portal-sidebar');
  if (!drawer) return 'no `.doctor-theme .portal-sidebar` rule inside @media (max-width: 768px)';
  if (!/position\s*:\s*fixed/.test(drawer.body)) return 'the drawer is not position: fixed';
  if (!/inset-inline-start\s*:/.test(drawer.body)) return 'the drawer is not placed with inset-inline-start (RTL mirroring)';
  if (/(^|[;\s])(left|right)\s*:/.test(drawer.body)) return 'the drawer uses a physical left/right';
  if (!/visibility\s*:\s*hidden/.test(drawer.body)) return 'closed drawer is not visibility:hidden (links stay in the tab order)';
  const open = rs.find((r) => r.selector.trim() === '.doctor-theme .portal-sidebar.open');
  if (!open || !/visibility\s*:\s*visible/.test(open.body)) return 'no open state that makes the drawer visible';
  if (!rs.some((r) => /html\.portal-drawer-open/.test(r.selector) && /overflow\s*:\s*hidden/.test(r.body))) {
    return 'no scroll lock for html.portal-drawer-open';
  }
  return null;
});

check('the doctor frame renders a phone top bar that controls the drawer', () => {
  const layout = read('src/views/layouts/portal.ejs');
  if (!/class="portal-topbar"/.test(layout)) return 'portal.ejs has no .portal-topbar';
  if (!/data-action="toggle-sidebar"[^>]*aria-controls="portal-drawer"[^>]*aria-expanded="false"/.test(layout)) {
    return 'the top bar menu button is missing data-action / aria-controls / aria-expanded';
  }
  if (!/id="portal-drawer"/.test(read('src/views/partials/doctor/sidebar.ejs'))) return 'the doctor sidebar has no id="portal-drawer"';
  const css = rules(read('public/css/portal-global.css'));
  const hiddenByDefault = css.find((r) => !r.media && r.selector.trim() === '.portal-topbar' && /display\s*:\s*none/.test(r.body));
  if (!hiddenByDefault) return '.portal-topbar is not display:none outside the phone media query (desktop would change)';
  return null;
});

check('the drawer closes on Escape and releases its scroll lock', () => {
  const footer = read('src/views/partials/footer.ejs');
  if (!/e\.key\s*!==\s*'Escape'|e\.key\s*===\s*'Escape'/.test(footer)) return 'no Escape handler';
  if (!/classList\.toggle\('portal-drawer-open',\s*open\)/.test(footer)) return 'the scroll lock is not tied to the open state';
  if (!/overlay\.classList\.toggle\('active',\s*open\)/.test(footer)) return 'the overlay is not kept in step with the drawer';
  return null;
});

check('/portal/messages: the absolutely positioned list is contained by its shell on phones', () => {
  const rs = rules(read('public/css/messages.css')).filter((r) => r.media && /max-width:\s*768px/.test(r.media));
  return rs.some((r) => r.selector.trim() === '.msg-shell' && /position\s*:\s*relative/.test(r.body))
    ? null : '.msg-shell has no position: relative at <=768px (the list overflows the page)';
});

check('data tables in the doctor views stack on phones (pt-stack)', () => {
  // Tables that are allowed to stay tabular, with the reason.
  const allow = {
    'doctor_analytics.ejs': 'inside .dan-table-wrap (overflow-x: auto)',
    'doctor_case_intelligence.ejs': 'lab values table inside its own scroll container'
  };
  const dir = path.join(ROOT, 'src', 'views');
  const files = fs.readdirSync(dir).filter((f) => /^(portal_doctor_|doctor_)/.test(f) && f.endsWith('.ejs'));
  const bad = [];
  for (const f of files) {
    if (allow[f]) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const tables = src.match(/<table\b[^>]*>/g) || [];
    for (const tag of tables) if (!/pt-stack/.test(tag)) bad.push(f + ': ' + tag);
  }
  return bad.length ? 'tables without pt-stack: ' + bad.join(' | ') : null;
});
