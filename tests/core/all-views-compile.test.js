// tests/core/all-views-compile.test.js
//
// Every .ejs must COMPILE. 2026-08-25.
//
// WHY THIS EXISTS. Five templates in this repo could not be parsed at all, and
// four of them were wired to live routes. They had been failing in production
// and the only evidence was an error_logs row nobody had read.
//
// The cause in every case was the same and is worth stating plainly, because it
// is deeply counter-intuitive:
//
//   EJS SCANS THE RAW FILE FOR DELIMITERS. IT DOES NOT KNOW WHAT A COMMENT IS.
//
// So a JavaScript comment written to EXPLAIN some EJS — the exact kind of
// comment a careful author writes — is executed. Two ways it goes wrong:
//
//   * inside a scriptlet, the '%>' in the comment ENDS the scriptlet early and
//     the rest of the block leaks out as literal HTML;
//   * a raw output tag in the comment is EVALUATED, so
//     superadmin_manual_queue_detail.ejs threw "v is not defined" and returned
//     500 — the operator's triage page for a stuck case, taken down by the
//     comment documenting how it had been secured against XSS.
//
// The worst of the five was video_appointment.ejs: an entire section had a
// closing brace and no opening `if`, so it swallowed the enclosing block and
// the whole video-consultation page 500'd for every patient and doctor.
//
// A parse error cannot hide from this test the way it hid from a code review.

'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🧩 Every EJS template compiles\n');

const VIEWS = path.join(__dirname, '..', '..', 'src', 'views');

function walk(dir, out) {
  out = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.ejs')) out.push(p);
  }
  return out;
}

try {
  const files = walk(VIEWS);
  if (files.length < 100) {
    throw new Error('only ' + files.length + ' templates found — the walk is probably broken, ' +
                    'and a test that scans nothing passes for the wrong reason');
  }

  const broken = [];
  for (const f of files) {
    try {
      // compile(), not render(): this asks "is this parseable", which needs no
      // locals. Render failures are a different (and much noisier) question.
      ejs.compile(fs.readFileSync(f, 'utf8'), { filename: f });
    } catch (err) {
      broken.push(path.relative(VIEWS, f) + '  ::  ' + String((err && err.message) || err).split('\n')[0]);
    }
  }

  if (broken.length) {
    throw new Error(broken.length + ' template(s) do not compile — each one is a 500 for ' +
                    'whoever opens it:\n    ' + broken.join('\n    '));
  }
  t.pass('all ' + files.length + ' EJS templates compile');
} catch (e) { t.fail('ejs templates compile', e); }

// Belt and braces: catch the specific shape BEFORE it becomes a parse error,
// because not every instance breaks the parse — some just leak the rest of a
// scriptlet into the page as text, which renders "successfully" and looks wrong.
try {
  const files = walk(VIEWS);
  const offenders = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      // A single-line JS comment (not a URL) that contains an EJS delimiter.
      if (/^\/\//.test(trimmed) && /<%|%>/.test(trimmed)) {
        offenders.push(path.relative(VIEWS, f) + ':' + (i + 1));
      }
    });
  }
  if (offenders.length) {
    throw new Error('EJS delimiter inside a JS comment — EJS executes these:\n    ' +
                    offenders.join('\n    '));
  }
  t.pass('no EJS delimiters hiding inside JS comments');
} catch (e) { t.fail('delimiters in comments', e); }
