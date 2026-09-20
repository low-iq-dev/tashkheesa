'use strict';
// Batch A (fix plan 2026-09-15), A7 + A8 — pin the copy fixes so they cannot
// silently regress. The tiers are exactly Standard 48h / VIP 18h / Urgent 4h;
// "fast track" (and its 'priority' alias) is the retired name for VIP, and
// 24h / 72h are not tiers. The report PDF's signature block says Consultant,
// not Doctor Signature. Every entry here is a string the 2026-09-20 batch
// fixed; the allowlist below names the survivors that are NOT copy (legacy
// value normalisation, tier-spelling synonym sets, the registered WhatsApp
// HSM identifier) and must stay.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('A7: the fixed strings say VIP / the real numbers, not fast-track / 24h', () => {
  const cases = [
    // [file, must contain, must NOT contain]
    ['src/services/case_intake_pricing.js', 'Please select Standard or VIP.', 'fast-track'],
    ['src/notify/notification_titles.js', 'VIP case available in your specialty', 'Fast-track case available'],
    ['src/notify/openclawTemplates.js', 'VIP case available (', 'Fast-track case available ('],
    ['src/services/emailService.js', 'marked VIP and will be prioritised', 'Fast Track'],
    ['src/notify.js', 'Urgent turnaround has been added', 'Priority turnaround has been added'],
    ['src/views/help_doctor_guide.ejs', null, '>72h<'],
    ['src/views/services.ejs', null, "'24-hour'"],
  ];
  for (const [rel, want, ban] of cases) {
    const src = read(rel);
    if (want) assert.ok(src.includes(want), rel + ' lost the fixed copy: ' + JSON.stringify(want));
    if (ban) assert.ok(!src.includes(ban), rel + ' regressed to the retired copy: ' + JSON.stringify(ban));
  }
});

test('A7: the receipt never claims a tier whose window the case does not carry', () => {
  const src = read('src/views/patient_payment_success.ejs');
  // The tier NAMES are claimed only on exact sla_hours matches; a 24h/72h
  // legacy row prints its real number. The old '=== 24' Priority mapping and
  // the fix round's own over-broad '<= 24 → VIP' band are both banned shapes.
  assert.ok(/__slaH === 4\)/.test(src) && /__slaH === 18\)/.test(src), 'the receipt no longer keys tier names on exact sla_hours');
  assert.ok(!/Priority — within 24 hours/.test(src), 'the retired 24-hour "Priority" tier is back on the receipt');
  assert.ok(!/__slaH > 4 && __slaH <= 24/.test(src), 'the receipt bucketes 19-24h rows into VIP again — a promise shorter than the SLA');
});

test('A7: legacy fast_track rows read as VIP everywhere the dashboard shows or counts them', () => {
  const src = read('src/services/superadmin_dashboard.js');
  assert.ok(!/fast_track: 'Urgent'/.test(src), 'a display map calls fast_track "Urgent" again');
  assert.ok(!/fast_track: '1\.6×'/.test(src), 'a display map gives fast_track the 1.6× urgent multiplier again');
  assert.ok(!/IN \('urgent',\s*'fast_track'\)/i.test(src), 'a KPI predicate counts fast_track inside URGENT again');
});

test('A7: the retired vocabulary does not reappear in live patient/doctor copy', () => {
  // String-literal scan of the notify surfaces, which is where every regression
  // in this family has landed. The HSM template IDENTIFIER
  // tashkheesa_new_case_fasttrack is registered with Meta and exempt.
  for (const rel of ['src/notify/notification_titles.js', 'src/notify/openclawTemplates.js', 'src/notify.js']) {
    const src = read(rel)
      .replace(/tashkheesa_new_case_fasttrack/g, '')
      .replace(/NEW_CASE_FASTTRACK/g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/fast.?track/i.test(src), rel + ' carries fast-track copy again');
  }
});

test('A8: the report PDF signature block says Consultant, signed electronically — on both generators', () => {
  const src = read('src/report-generator.js');
  // The banned strings are scanned with comments stripped — the code may
  // still NAME the old heading while explaining why it changed.
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!code.includes("'Doctor Signature'") && !code.includes("'Doctor Signature /'"), 'a generator prints "Doctor Signature" again');
  assert.ok(!code.includes('توقيع الطبيب'), 'a generator prints "توقيع الطبيب" again');
  assert.ok(src.includes("sectionHeader('Consultant'"), 'the PDFKit path lost its Consultant heading');
  assert.ok(src.includes("'Consultant /'"), 'the raw-PDF fallback lost its Consultant heading');
  assert.ok(src.includes('الاستشاري'), 'the Arabic Consultant label is gone');
  const signedCount = (src.match(/Signed electronically/g) || []).length;
  assert.ok(signedCount >= 2, 'the "Signed electronically" subline is missing from one of the two generators');
  assert.ok(src.includes('موقّع إلكترونياً'), 'the Arabic signed-electronically label is gone');
});
