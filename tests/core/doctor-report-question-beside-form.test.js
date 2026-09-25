'use strict';

// 2026-09-26 — the patient's question sits beside the report form, and a soft
// pre-submit panel shows it next to the doctor's recommendation. Soft: the
// panel never blocks (it has a Submit button that replays the original click),
// and there is no window.confirm (CSP / mobile-friendly inline panel instead).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src/views/portal_doctor_case.ejs'), 'utf8');

test('question is quoted inside #report-form, above the Findings field', () => {
  const form = src.indexOf('<form id="report-form"');
  const quote = src.indexOf('data-report-question', form);
  const findings = src.indexOf('id="rep-diag"', form);
  assert.ok(form > 0 && quote > form, 'quote block is inside the report form');
  assert.ok(quote < findings, 'quote block precedes the Findings textarea');
});

test('soft confirm panel: rendered only with a question, both buttons present', () => {
  const at = src.indexOf('id="report-confirm"');
  assert.ok(at > 0);
  const block = src.slice(src.lastIndexOf('<% if (_ctx && _ctx.question) { %>', at), at);
  assert.ok(block.length > 0 && block.length < 400, 'panel is wrapped in the question guard');
  assert.match(src, /data-confirm-back/);
  assert.match(src, /data-confirm-send/);
});

test('submit handler: validation first, then the panel; confirm replays the same button', () => {
  assert.match(src, /if \(panel && !confirmed\) \{/);
  assert.match(src, /pendingBtn = btn;/);
  assert.match(src, /if \(pendingBtn\) pendingBtn\.click\(\);/);
  assert.doesNotMatch(src.slice(src.indexOf("var panel = document.getElementById('report-confirm')")), /window\.confirm|[^.]confirm\(/,
    'no blocking browser confirm()');
});
