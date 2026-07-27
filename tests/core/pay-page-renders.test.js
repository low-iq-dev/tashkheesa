'use strict';
// tests/core/pay-page-renders.test.js
//
// Audit blocker B1 regression guard — src/views/patient_payment_required.ejs
// referenced `hasSlaAddon` (line ~278) without defining it, so the page threw
// a ReferenceError and 500'd for ANY service with a video/prescription add-on
// price (the add-on summary block is only reached when hasAddons is true).
//
// This test renders the real template with add-on prices > 0 (add-on flow) and
// asserts it renders without throwing. Partials are stubbed via ejs.cache so
// the test targets the page's own logic, not the portal chrome. A negative
// control removes the hasSlaAddon definition and asserts the render DOES throw,
// proving the render path actually exercises the once-crashing line.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🧾 patient_payment_required.ejs renders with add-ons (B1)\n');

function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');
const PAY_PATH = path.join(VIEWS, 'patient_payment_required.ejs');
const SRC = fs.readFileSync(PAY_PATH, 'utf8');

// Stub the portal-chrome partials so the render exercises only the page's own
// logic (where hasSlaAddon lives), not every included partial's locals.
['partials/patient/head', 'partials/patient/topbar', 'partials/patient/whats-happening-card',
 'partials/patient/need-help-card', 'partials/patient/foot'].forEach(function (p) {
  ejs.cache.set(path.join(VIEWS, p + '.ejs'), function () { return ''; });
});

function makeLocals(overrides) {
  return Object.assign({
    isAr: false,
    lang: 'en',
    user: { id: 'u1', name: 'Test Patient' },
    order: {
      id: 'order-abc12345',
      service_name: 'Cardiology Review',
      specialty_name: 'Cardiology',
      price: 500,
      locked_price: null,
      locked_currency: null
    },
    t: function (k, fb) { return fb || k; },
    tt: function (k, en /*, ar */) { return en; },
    currency: 'EGP',
    videoConsultationPrice: 200,
    prescriptionPrice: 350,
    sla24hrPrice: 100,
    videoEnabled: true,
    paymentUrl: null,
    paymentLink: null,
    error: null,
    cspNonce: 'testnonce',
    csrfToken: 'testcsrf'
  }, overrides || {});
}

// Each render gets a UNIQUE filename inside VIEWS so (a) includes still resolve
// to the stubbed partials, but (b) the main template is not cache-collided
// across renders (cache is keyed by filename; the negative control must
// recompile its mutated source, not reuse a cached good one).
let __rc = 0;
function renderSrc(src, locals) {
  const fname = path.join(VIEWS, '__paytest_' + (++__rc) + '.ejs');
  return ejs.render(src, locals, { filename: fname, cache: true });
}

// 1. Add-on flow (video + prescription priced) renders without throwing.
let html = null;
let threw = null;
try { html = renderSrc(SRC, makeLocals()); } catch (e) { threw = e; }
assert(!threw, 'renders with video + prescription add-on prices (no ReferenceError)',
  threw && threw.message);
assert(!!html && html.indexOf('500') !== -1, 'renders the base price in the summary', 'total not found in output');

// 2. Simple flow (no add-on prices) still renders.
let html2 = null, threw2 = null;
try { html2 = renderSrc(SRC, makeLocals({ videoConsultationPrice: 0, prescriptionPrice: 0 })); }
catch (e) { threw2 = e; }
assert(!threw2, 'renders with NO add-ons (simple flow)', threw2 && threw2.message);

// 3. Negative control — without the hasSlaAddon definition the render MUST throw,
//    proving this test genuinely exercises the once-crashing reference.
const brokenSrc = SRC.replace(/const hasSlaAddon = false;/, '/* hasSlaAddon intentionally undefined */');
assert(brokenSrc !== SRC, 'negative control: hasSlaAddon definition located for removal',
  'could not find `const hasSlaAddon = false;` — update the test if the definition changed');
let brokeThrew = null;
try { renderSrc(brokenSrc, makeLocals()); } catch (e) { brokeThrew = e; }
assert(!!brokeThrew && /hasSlaAddon/.test(String(brokeThrew && brokeThrew.message)),
  'negative control: undefined hasSlaAddon throws a ReferenceError on render',
  'expected a ReferenceError mentioning hasSlaAddon; got: ' + (brokeThrew && brokeThrew.message));
