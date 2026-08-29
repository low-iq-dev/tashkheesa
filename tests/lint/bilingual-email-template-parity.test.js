'use strict';
// Guard: a bilingual email template must carry the SAME fields in both files
// and in both language blocks.
//
// The history this exists for. doctor-welcome.hbs holds both languages in one
// file, twice — en/ leads with English, ar/ leads with Arabic — so a single
// edit has to be made in four places. In August an edit made in two of them
// shipped an email that named the 18-hour tier "VIP" in one half and "fast
// track" in the other. It was caught in review, not by any test.
//
// There is an older assertion (tests/admin/doctor-approval.test.js) that the
// two files be BYTE-identical. That invariant was deliberately broken when the
// block order was made language-dependent, so it fails and tells nobody
// anything. This checks what actually matters instead: the same variables and
// both language blocks present in both files. A field added to one file and
// not the other is the defect; the order of the blocks is not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EN_DIR = path.join(ROOT, 'src', 'templates', 'email', 'en');
const AR_DIR = path.join(ROOT, 'src', 'templates', 'email', 'ar');

// Templates that deliberately carry BOTH languages in a single file.
const BILINGUAL = ['doctor-welcome.hbs', 'doctor-confirm-services.hbs'];

function stripComments(src) {
  // Handlebars comments first (they legitimately mention variable names in
  // prose), then HTML comments.
  return src.replace(/\{\{!--[\s\S]*?--\}\}/g, '').replace(/<!--[\s\S]*?-->/g, '');
}

function variablesIn(src) {
  const out = new Set();
  // {{foo}}, {{{foo}}}, {{#if foo}}, {{else}} ... take the first identifier.
  for (const m of stripComments(src).matchAll(/\{\{[{~]?\s*(?:#\w+\s+|\/)?([A-Za-z_][A-Za-z0-9_.]*)/g)) {
    const name = m[1];
    if (['if', 'unless', 'each', 'else', 'with', 'eq', 'year'].includes(name)) continue;
    out.add(name);
  }
  return out;
}

for (const file of BILINGUAL) {
  const enPath = path.join(EN_DIR, file);
  const arPath = path.join(AR_DIR, file);

  test(`${file}: exists in both language directories`, () => {
    assert.ok(fs.existsSync(enPath), `missing ${path.relative(ROOT, enPath)}`);
    assert.ok(fs.existsSync(arPath), `missing ${path.relative(ROOT, arPath)}`);
  });

  test(`${file}: both files carry the same variables`, () => {
    const en = variablesIn(fs.readFileSync(enPath, 'utf8'));
    const ar = variablesIn(fs.readFileSync(arPath, 'utf8'));
    const onlyEn = [...en].filter((v) => !ar.has(v)).sort();
    const onlyAr = [...ar].filter((v) => !en.has(v)).sort();
    assert.deepEqual(
      { onlyEn, onlyAr }, { onlyEn: [], onlyAr: [] },
      `${file} has drifted between en/ and ar/.\n` +
      `  only in en/: ${onlyEn.join(', ') || '(none)'}\n` +
      `  only in ar/: ${onlyAr.join(', ') || '(none)'}\n` +
      'Both files carry BOTH languages — edit all four blocks.'
    );
  });

  test(`${file}: both files contain an Arabic block and a Latin block`, () => {
    for (const p of [enPath, arPath]) {
      const body = stripComments(fs.readFileSync(p, 'utf8'));
      assert.ok(/[؀-ۿ]/.test(body),
        `${path.relative(ROOT, p)} has no Arabic text — a language block was dropped`);
      assert.ok(/[A-Za-z]{4,}/.test(body.replace(/<[^>]*>/g, ' ')),
        `${path.relative(ROOT, p)} has no Latin text — a language block was dropped`);
      assert.ok(/dir="rtl"/.test(body) && /dir="ltr"/.test(body),
        `${path.relative(ROOT, p)} is missing one of the dir="rtl" / dir="ltr" wrappers`);
    }
  });

  test(`${file}: is a body partial, not a document`, () => {
    for (const p of [enPath, arPath]) {
      const markup = stripComments(fs.readFileSync(p, 'utf8'));
      assert.ok(!/<!DOCTYPE|<html[\s>]|<body[\s>]/i.test(markup),
        `${path.relative(ROOT, p)} contains document tags — renderEmail supplies the shell`);
    }
  });
}
