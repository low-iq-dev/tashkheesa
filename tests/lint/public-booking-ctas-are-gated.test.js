'use strict';
// Guard: no public page may link into the booking wizard without the gate.
//
// WHY THIS FILE EXISTS
//
// 2026-08-30. Booking is deliberately held shut on the public site until Ziad
// opens it — no card payment has ever settled through Paymob, so a visitor who
// reaches the wizard reaches a dead end with their medical files already
// uploaded. The switch is services/public_cta.js and every CTA consults it.
//
// The failure this guards is not the switch breaking. It is someone adding a
// new "Book now" button six weeks from now, in good faith, that links straight
// to /patient/new-case — and the site is then 95% shut and 5% open, which is
// worse than either, because the one live path is the one nobody tested.
//
// Source-text, because there is nothing to render: the defect is a link that
// exists in the template at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');

// Public marketing pages. The portal and the wizard's own views are NOT here:
// they are behind a login and gating them would lock out the patient mid-case.
const PUBLIC_VIEWS = [
  'index.ejs',
  'services.ejs',
  'specialties_index.ejs',
  'specialty_detail.ejs',
  'about.ejs',
  'faq.ejs',
  'blog_how_tashkheesa_works.ejs',
  'blog_when_to_get_second_opinion.ejs'
];

// An href into the wizard, or into registration via the submitUrl helper.
const BOOKING_HREF = /href\s*=\s*"(?:<%=\s*submitUrl\s*%>|\/patient\/new-case|\/register)\b/;

function readIfExists(rel) {
  const p = path.join(VIEWS, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

test('every public link into booking sits behind the CTA gate', () => {
  const ungated = [];
  for (const rel of PUBLIC_VIEWS) {
    const src = readIfExists(rel);
    if (src === null) continue;
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!BOOKING_HREF.test(line)) return;
      // The gate may be on this line or open on a recent preceding line.
      // Five lines is generous for the formatting used in these templates and
      // still tight enough that an unrelated earlier `if` will not launder a
      // new ungated link.
      const window = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
      if (/__ctaOn|bookingCtaEnabled/.test(window)) return;
      ungated.push(rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 110));
    });
  }
  assert.deepStrictEqual(ungated, [],
    'These public links open the booking wizard with no CTA gate around them.\n' +
    'Booking is held shut on purpose (src/services/public_cta.js) — wrap the\n' +
    'link in `<% if (__ctaOn) { %> … <% } else { %> <span class="is-cta-locked">\n' +
    '… </span> <% } %>`, or if booking is now permanently open, delete the gate\n' +
    'everywhere rather than leaving half the site behind it.\n  ' +
    ungated.join('\n  '));
});

test('the gate fails closed', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'public_cta.js'), 'utf8');
  // Must be an explicit opt-in comparison, never a truthiness test on the env
  // var — `PUBLIC_BOOKING_CTA=off` is a non-empty string and would open it.
  assert.ok(/===\s*'on'/.test(src),
    'public_cta.js must open booking only on an exact "on", so that a typo, ' +
    '"off", "false" or "0" all leave it shut.');

  const prev = process.env.PUBLIC_BOOKING_CTA;
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'src', 'services', 'public_cta.js'))];
    const { bookingCtaEnabled } = require(path.join(ROOT, 'src', 'services', 'public_cta.js'));
    for (const v of [undefined, '', 'off', 'false', '0', 'ON ', 'yes', 'true']) {
      if (v === undefined) delete process.env.PUBLIC_BOOKING_CTA;
      else process.env.PUBLIC_BOOKING_CTA = v;
      const open = bookingCtaEnabled();
      // "ON " with whitespace SHOULD open (we trim + lowercase); everything
      // else in this list must not.
      const expected = String(v || '').trim().toLowerCase() === 'on';
      assert.strictEqual(open, expected,
        'PUBLIC_BOOKING_CTA=' + JSON.stringify(v) + ' gave ' + open + ', expected ' + expected);
    }
    process.env.PUBLIC_BOOKING_CTA = 'on';
    assert.strictEqual(bookingCtaEnabled(), true, 'PUBLIC_BOOKING_CTA=on must open booking');
  } finally {
    if (prev === undefined) delete process.env.PUBLIC_BOOKING_CTA;
    else process.env.PUBLIC_BOOKING_CTA = prev;
  }
});
