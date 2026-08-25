'use strict';
// Guard: no EJS scriptlet may be closed by a delimiter sitting inside a
// // comment.
//
// 2026-08-25 — /superadmin/manual-queue/:id returned 500 on every case with
// "v is not defined". The cause was a code comment that QUOTED the syntax it
// was warning about:
//
//     // doctor-controlled free text into an inline script. [output tag
//     // wrapping JSON.stringify(v)] is not safe here: ...
//
// EJS scans the raw template for its delimiters. It does not tokenise
// JavaScript and has no concept of a comment, so the closing delimiter inside
// that prose ENDED the scriptlet, and the text after it was re-parsed as
// template markup — turning the quoted example into a live output tag that
// evaluated an undefined variable.
//
// The failure is not a syntax error. Everything after the premature close
// becomes string output, which compiles fine and simply renders the wrong
// page — or throws at runtime on the first undefined reference. So a compile
// check does not catch it; this shape check does.
//
// Three more instances were found by this rule the day it was written
// (admin_pricing, admin_campaign_new, admin_campaign_detail — all of which
// would have dumped raw JS into the page and thrown on __nonce), plus a dead
// partial. Write comments that DESCRIBE EJS syntax; never quote it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEWS = path.join(__dirname, '..', '..', 'src', 'views');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ejs')) out.push(p);
  }
  return out;
}

test('no // comment contains an EJS delimiter', () => {
  // TWO distinct shapes, both of which have shipped:
  //
  // A. A scriptlet whose closing delimiter sits inside a // comment. Everything
  //    after it stops being code. (admin_pricing, admin_campaign_new,
  //    admin_campaign_detail, c_card — all found by this rule on 2026-08-25.)
  //
  // B. An EJS tag written inside a // comment in raw template text, e.g. inside
  //    a <script> block. EJS parses it as a REAL tag and evaluates it. This is
  //    what 500'd /superadmin/manual-queue/:id with "v is not defined".
  //
  // One check covers both: a line whose code begins with // must not contain an
  // EJS opening delimiter. Describe the syntax, never quote it.
  const bad = [];
  for (const file of walk(VIEWS)) {
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (!t.startsWith('//')) return;
      if (!t.includes('<%')) return;
      bad.push(
        `${path.relative(VIEWS, file)}:${i + 1} — a // comment contains an EJS ` +
        `delimiter. EJS does not tokenise JavaScript: it will either close the ` +
        `enclosing scriptlet here, or evaluate the quoted example as a real tag. ` +
        `Line: ${t.slice(0, 90)}`
      );
    });
  }
  assert.deepEqual(bad, [], 'EJS delimiters quoted inside comments:\n  ' + bad.join('\n  '));
});
