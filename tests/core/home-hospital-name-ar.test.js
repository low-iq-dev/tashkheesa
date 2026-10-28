'use strict';

// 28 Oct 2026 — the hospital's Arabic name is «شفاء», with the hamza:
// «مستشفى شفاء», «مجموعة مستشفيات شفاء». Never «شفا» (the spelling the portal
// used until Ziad's 27 Oct decision) and never «الشفاء». The home page carries
// the name more often than any other page, so it is pinned here as rendered,
// through the real request pipeline (tests/_helpers/public_site_app.js, no
// database), in both languages.
//
// «شفا» is matched only as a whole word, the same rule the 28 Oct sweep used:
// not when another Arabic letter or haraka touches it — «شفاء» (the right
// spelling), «شفاف», «شفاه», «شفاعة», «إشفاق». «مستشفى» itself is spelled with
// ى and never matches.
//
// Run: node --test tests/core/home-hospital-name-ar.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('../_helpers/public_site_app');

const OLD_SPELLING = /(?<![\u0621-\u064A\u064B-\u0652\u0640])شفا(?![\u0621-\u064A\u064B-\u0652\u0640])/;
const WITH_AL = /الشفاء?(?![ء-ي])/;

function around(body, re) {
  const m = re.exec(body);
  return m ? '…' + body.slice(Math.max(0, m.index - 50), m.index + 20).replace(/\s+/g, ' ') + '…' : '';
}

let app;
test.before(async () => { app = await helper.startPublicSiteApp({ bookingCtaEnabled: true }); });
test.after(async () => { if (app) await app.close(); });

test('/ar renders the hospital as «شفاء» in each of its name forms', async () => {
  const bare = await app.get('/ar');
  assert.equal(bare.status, 301, '/ar should send the visitor to /ar/');
  assert.equal(bare.location, '/ar/');

  const ar = await app.get('/ar/');
  assert.equal(ar.status, 200);
  assert.ok(ar.body.includes('مجموعة مستشفيات شفاء'), 'the group\'s name, «مجموعة مستشفيات شفاء»');
  assert.ok(ar.body.includes('سرير في مستشفى شفاء'), 'the hospital\'s name in the beds figure, «مستشفى شفاء»');
  assert.ok(ar.body.includes('مستشفى شفاء، '), 'the hospital\'s name in the footer address');
});

test('/ar never writes «شفا» or «الشفاء» — markup, JSON-LD and scripts included', async () => {
  const ar = await app.get('/ar/');
  assert.ok(!OLD_SPELLING.test(ar.body), 'the old spelling «شفا» on /ar/: ' + around(ar.body, OLD_SPELLING));
  assert.ok(!WITH_AL.test(ar.body), '«الشفاء» on /ar/: ' + around(ar.body, WITH_AL));
});

test('/ never writes «شفا» or «الشفاء» either; its name is the English one', async () => {
  // The English page names the hospital in English only. If Arabic for it is
  // ever added (a bilingual lockup, an alternateName in the JSON-LD), it is
  // held to the same spelling.
  const en = await app.get('/');
  assert.equal(en.status, 200);
  assert.ok(en.body.includes('Shifa Hospital Group'), 'the English name');
  assert.ok(!OLD_SPELLING.test(en.body), 'the old spelling «شفا» on /: ' + around(en.body, OLD_SPELLING));
  assert.ok(!WITH_AL.test(en.body), '«الشفاء» on /: ' + around(en.body, WITH_AL));
});

test('a visitor outside Egypt gets the same spelling', async () => {
  // The market-aware lines (emergency number, price) are worked out per
  // visitor; none of them may bring back the old name.
  const ar = await app.get('/ar/', { 'cf-ipcountry': 'GB' });
  assert.ok(ar.body.includes('مجموعة مستشفيات شفاء'));
  assert.ok(!OLD_SPELLING.test(ar.body) && !WITH_AL.test(ar.body), around(ar.body, OLD_SPELLING) || around(ar.body, WITH_AL));
});
