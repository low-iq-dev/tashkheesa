// tests/unit/portal-doctor-services-render-smoke.test.js
//
// Task 22 — render-smoke for portal_doctor_services.ejs.
// Verifies:
//   (a) NORMAL fixture  → checkboxes, "You earn"/doctor_fee, POST form
//   (b) isEmpty fixture → "finalising" note, NO form
//
// The local server cannot boot (migration 070 + no anon role), so we
// drive EJS directly via ejs.renderFile with stubbed partials. This
// test deliberately does NOT touch the DB.
//
// NB: the `partials/header` and `partials/doctor/topbar` and
// `partials/footer` includes will cascade through EJS. We stub them by
// temporarily writing minimal stand-in files to a temp views root using
// ejs.renderFile's `root` option. Actually, simpler: we use the real
// views root but mock the include chain by passing a fake tt + csrfField
// AND by using `views` + stubbing only what the test NEEDS to assert on
// (the core HTML is in portal_doctor_services.ejs itself; the
// include chain may produce a render error on deep sub-includes —
// in that case, we use `ejs.render` on the file content with
// mock `include` to isolate the view body).

'use strict';

const fs   = require('fs');
const path = require('path');
const ejs  = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (skipped: ' + r + ')'); },
};
const fileTag = 'portal-doctor-services-render-smoke';

console.log('\n🖼️  Task 22 — portal_doctor_services.ejs render smoke\n');

const VIEWS_ROOT = path.join(__dirname, '..', '..', 'src', 'views');
const VIEW_FILE  = path.join(VIEWS_ROOT, 'portal_doctor_services.ejs');

// ── Shared stub locals ────────────────────────────────────────────────
function stubLocals(overrides) {
  return Object.assign({
    isAr:          false,
    lang:          'en',
    user:          { name: 'Dr Test', specialty_name: 'Cardiology' },
    isEmpty:       false,
    groups: [{
      specialtyId:     's1',
      specialtyName:   'Cardiology',
      specialtyNameAr: 'قلب',
      services: [{
        id:          'x1',
        name:        'Echo',
        base_price:  500,
        doctor_fee:  200,
        sla_hours:   48,
        is_visible:  true,
        ticked:      true,
      }, {
        id:          'x2',
        name:        'Stress Test',
        base_price:  900,
        doctor_fee:  350,
        sla_hours:   24,
        is_visible:  false,  // coming-soon chip
        ticked:      false,
      }],
    }],
    subSpecialties:  ['Interventional'],
    specialtyName:   'Cardiology',
    specialtyNameAr: 'قلب',
    error:           null,
    warning:         null,
    confirmEmpty:    false,
    success:         null,
    // EJS helpers used in the view
    tt:        function (key, en, ar) { return en; },
    csrfField: function () { return '<!-- csrf -->'; },
    // partials/header + topbar + footer are included via <%- include(...) %>
    // We stub them as empty strings via the `locals` escape hatch below.
  }, overrides);
}

// ── Render helper: replaces include() with stubs so we exercise only
//    the view body without needing a full server boot. ──────────────────
function renderStubbed(locals, cb) {
  // Read the raw EJS source.
  var src;
  try { src = fs.readFileSync(VIEW_FILE, 'utf8'); } catch (e) { return cb(e); }

  // Strip out the three include calls (header / topbar / footer) so EJS
  // doesn't try to load partials that pull in layout engine / middleware
  // locals we don't have. The important thing we're testing is the view
  // body (form, checkboxes, isEmpty branch, warnings, etc.).
  var stripped = src
    .replace(/<%[-=]\s*include\s*\(\s*['"]partials\/header['"]\s*,[^)]*\)\s*%>/g, '<!-- header stub -->')
    .replace(/<%[-=]\s*include\s*\(\s*['"]partials\/doctor\/topbar['"]\s*,[^)]*\)\s*%>/g, '<!-- topbar stub -->')
    .replace(/<%[-=]\s*include\s*\(\s*['"]partials\/footer['"]\s*\)\s*%>/g, '<!-- footer stub -->');

  try {
    var html = ejs.render(stripped, locals, { filename: VIEW_FILE });
    cb(null, html);
  } catch (e) {
    cb(e);
  }
}

// ── Test (a): NORMAL fixture — populated groups ──────────────────────
(function testNormal() {
  var locals = stubLocals({});
  renderStubbed(locals, function (err, html) {
    // --- compile OK ---
    try {
      if (err) throw new Error('RENDER FAIL: ' + err.message);
      t.pass(fileTag + ': (a) normal fixture renders without error');
    } catch (e) { t.fail(fileTag + ': (a) normal fixture compiles', e); return; }

    // --- POST form present ---
    try {
      if (!/action="\/portal\/doctor\/services"/.test(html)) throw new Error('POST form action missing');
      if (!/method="post"/.test(html)) throw new Error('POST method missing');
      t.pass(fileTag + ': (a) POST form present');
    } catch (e) { t.fail(fileTag + ': (a) POST form present', e); }

    // --- checkbox inputs with name="service_ids" ---
    try {
      if (!/name="service_ids"/.test(html)) throw new Error('service_ids checkbox name missing');
      t.pass(fileTag + ': (a) service_ids checkbox inputs present');
    } catch (e) { t.fail(fileTag + ': (a) service_ids checkbox inputs', e); }

    // --- pre-ticked checkbox ---
    try {
      if (!/value="x1"\s+checked/.test(html) && !/value="x1"[^>]*checked/.test(html)) {
        throw new Error('pre-ticked checkbox (x1) not found');
      }
      t.pass(fileTag + ': (a) pre-ticked checkbox rendered checked');
    } catch (e) { t.fail(fileTag + ': (a) pre-ticked checkbox', e); }

    // --- "You earn" + doctor_fee shown ---
    try {
      if (!/You earn/.test(html)) throw new Error('"You earn" label missing');
      if (!/200/.test(html)) throw new Error('doctor_fee 200 missing');
      t.pass(fileTag + ': (a) "You earn" + doctor_fee visible');
    } catch (e) { t.fail(fileTag + ': (a) "You earn" / doctor_fee', e); }

    // --- confirm_empty zero-services row ---
    try {
      if (!/name="confirm_empty"/.test(html)) throw new Error('confirm_empty input missing');
      t.pass(fileTag + ': (a) confirm_empty zero-services row present');
    } catch (e) { t.fail(fileTag + ': (a) confirm_empty row', e); }

    // --- doctor_commission_pct MUST NOT appear ---
    try {
      if (/doctor_commission_pct/.test(html)) throw new Error('doctor_commission_pct must not be rendered');
      t.pass(fileTag + ': (a) doctor_commission_pct absent');
    } catch (e) { t.fail(fileTag + ': (a) doctor_commission_pct absent', e); }

    // --- coming-soon chip for is_visible=false service ---
    try {
      if (!/Coming Soon/.test(html)) throw new Error('Coming Soon chip missing for is_visible=false service');
      t.pass(fileTag + ': (a) Coming Soon chip renders for is_visible=false');
    } catch (e) { t.fail(fileTag + ': (a) Coming Soon chip', e); }

    // --- no isEmpty note ---
    try {
      if (/services are being finalised/i.test(html) || /being set up/i.test(html)) {
        throw new Error('isEmpty note should not appear in normal fixture');
      }
      t.pass(fileTag + ': (a) isEmpty note absent in normal fixture');
    } catch (e) { t.fail(fileTag + ': (a) isEmpty note absent', e); }

    // --- base_price shown in service row ---
    try {
      if (!/Patient pays/.test(html)) throw new Error('"Patient pays" label missing');
      if (!/500/.test(html)) throw new Error('base_price 500 missing from service row');
      t.pass(fileTag + ': (a) base_price "Patient pays" visible in service row');
    } catch (e) { t.fail(fileTag + ': (a) base_price in service row', e); }
  });
})();

// ── Test (b): isEmpty fixture — finalising note, no form ─────────────
(function testEmpty() {
  var locals = stubLocals({ isEmpty: true, groups: [] });
  renderStubbed(locals, function (err, html) {
    try {
      if (err) throw new Error('RENDER FAIL: ' + err.message);
      t.pass(fileTag + ': (b) isEmpty fixture renders without error');
    } catch (e) { t.fail(fileTag + ': (b) isEmpty fixture compiles', e); return; }

    // --- finalising note present ---
    try {
      if (!/being finalised/i.test(html) && !/being set up/i.test(html)) {
        throw new Error('finalising note not found in isEmpty branch');
      }
      t.pass(fileTag + ': (b) finalising note present');
    } catch (e) { t.fail(fileTag + ': (b) finalising note', e); }

    // --- no form in isEmpty branch ---
    try {
      if (/action="\/portal\/doctor\/services"/.test(html)) {
        throw new Error('POST form must not appear in isEmpty branch');
      }
      t.pass(fileTag + ': (b) no POST form in isEmpty branch');
    } catch (e) { t.fail(fileTag + ': (b) no form in isEmpty', e); }

    // --- no checkboxes ---
    try {
      if (/name="service_ids"/.test(html)) {
        throw new Error('service_ids checkboxes must not appear in isEmpty branch');
      }
      t.pass(fileTag + ': (b) no service_ids checkboxes in isEmpty branch');
    } catch (e) { t.fail(fileTag + ': (b) no service_ids checkboxes', e); }
  });
})();

// ── Test (c): warning banner renders ─────────────────────────────────
(function testWarning() {
  var locals = stubLocals({ warning: 'Please tick at least one service or confirm empty.' });
  renderStubbed(locals, function (err, html) {
    try {
      if (err) throw new Error('RENDER FAIL: ' + err.message);
      if (!/Please tick at least one service/.test(html)) throw new Error('warning text not rendered');
      t.pass(fileTag + ': (c) warning banner renders');
    } catch (e) { t.fail(fileTag + ': (c) warning banner', e); }
  });
})();

// ── Test (d): AR locale — Arabic labels ──────────────────────────────
(function testArabic() {
  var arLocals = stubLocals({
    isAr: true,
    tt: function (key, en, ar) { return ar; },
  });
  renderStubbed(arLocals, function (err, html) {
    try {
      if (err) throw new Error('RENDER FAIL: ' + err.message);
      // "You earn" Arabic = "تكسب"
      if (!/تكسب/.test(html)) throw new Error('"تكسب" label missing in AR fixture');
      t.pass(fileTag + ': (d) AR fixture shows Arabic "تكسب" label');
    } catch (e) { t.fail(fileTag + ': (d) AR fixture', e); }
  });
})();

// ── Test (e): success banner renders when success local is passed ─────
(function testSuccess() {
  var locals = stubLocals({ success: 'Services saved successfully.' });
  renderStubbed(locals, function (err, html) {
    try {
      if (err) throw new Error('RENDER FAIL: ' + err.message);
      if (!/Services saved successfully\./.test(html)) throw new Error('success banner text not rendered');
      t.pass(fileTag + ': (e) success banner renders when success local is set');
    } catch (e) { t.fail(fileTag + ': (e) success banner', e); }
  });
})();
