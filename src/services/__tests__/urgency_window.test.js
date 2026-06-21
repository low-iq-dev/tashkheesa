'use strict';

// DST regression for the Urgent-tier Cairo window + next-7am SLA anchor.
// Egypt reinstated DST in 2023 (UTC+2 winter, ~UTC+3 Apr–Oct). The old
// fixed +2h math sold Urgent 7–8pm Cairo all summer and anchored the SLA
// an hour late. These tests inject a fixed clock (both exports accept an
// optional `now`) and assert BOTH seasons, the 19:00 bug boundary, the
// 07:00/19:00 inclusivity, and the April/October DST transitions.
//
// Run: node --test src/services/__tests__/urgency_window.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { isUrgentWindowOpen, nextSevenAmCairoUtc } = require('../urgency_window');

const Z = (s) => new Date(s);

// Independent Cairo wall-clock read (does NOT use the service under test),
// used to verify the anchor lands on the real Cairo 07:00.
function cairoHM(d) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d);
  return {
    h: Number(p.find((x) => x.type === 'hour').value) % 24,
    m: Number(p.find((x) => x.type === 'minute').value)
  };
}

test('ICU precondition: runtime tz database knows Egypt 2023 DST (UTC+2 winter / UTC+3 summer)', () => {
  // 12:00Z → Cairo 14:00 in winter (+2), 15:00 in summer (+3).
  assert.equal(cairoHM(Z('2026-01-15T12:00:00Z')).h, 14, 'winter Cairo should be UTC+2');
  assert.equal(cairoHM(Z('2026-07-15T12:00:00Z')).h, 15, 'summer Cairo should be UTC+3 — stale tz database?');
});

test('WINTER (UTC+2): urgent gate', () => {
  assert.equal(isUrgentWindowOpen(Z('2026-01-15T09:00:00Z')), true,  '11:00 Cairo → open');
  assert.equal(isUrgentWindowOpen(Z('2026-01-15T17:30:00Z')), false, '19:30 Cairo → closed');
});

test('WINTER (UTC+2): next-7am anchor = 05:00Z (Cairo 07:00)', () => {
  const a = nextSevenAmCairoUtc(Z('2026-01-15T09:00:00Z')); // 11:00 Cairo → tomorrow 07:00
  assert.equal(a.toISOString(), '2026-01-16T05:00:00.000Z');
  assert.deepEqual(cairoHM(a), { h: 7, m: 0 });
});

test('SUMMER (UTC+3): urgent gate — the bug boundary now closes', () => {
  assert.equal(isUrgentWindowOpen(Z('2026-07-15T15:30:00Z')), true,  '18:30 Cairo → open');
  assert.equal(isUrgentWindowOpen(Z('2026-07-15T16:00:00Z')), false, '19:00 Cairo → CLOSED (old fixed+2 wrongly sold this hour)');
  assert.equal(isUrgentWindowOpen(Z('2026-07-15T16:30:00Z')), false, '19:30 Cairo → closed');
});

test('SUMMER (UTC+3): next-7am anchor = 04:00Z (Cairo 07:00) — 1h earlier than the old +2 bug', () => {
  const a = nextSevenAmCairoUtc(Z('2026-07-15T11:00:00Z')); // 14:00 Cairo → tomorrow 07:00
  assert.equal(a.toISOString(), '2026-07-16T04:00:00.000Z');
  assert.deepEqual(cairoHM(a), { h: 7, m: 0 });
});

test('Boundary inclusivity: 07:00 open, 19:00 closed — both seasons', () => {
  // winter: 07:00 Cairo = 05:00Z ; 19:00 Cairo = 17:00Z
  assert.equal(isUrgentWindowOpen(Z('2026-01-15T05:00:00Z')), true,  'winter 07:00 → open (inclusive)');
  assert.equal(isUrgentWindowOpen(Z('2026-01-15T04:59:00Z')), false, 'winter 06:59 → closed');
  assert.equal(isUrgentWindowOpen(Z('2026-01-15T17:00:00Z')), false, 'winter 19:00 → closed (exclusive)');
  assert.equal(isUrgentWindowOpen(Z('2026-01-15T16:59:00Z')), true,  'winter 18:59 → open');
  // summer: 07:00 Cairo = 04:00Z ; 19:00 Cairo = 16:00Z
  assert.equal(isUrgentWindowOpen(Z('2026-07-15T04:00:00Z')), true,  'summer 07:00 → open (inclusive)');
  assert.equal(isUrgentWindowOpen(Z('2026-07-15T03:59:00Z')), false, 'summer 06:59 → closed');
  assert.equal(isUrgentWindowOpen(Z('2026-07-15T16:00:00Z')), false, 'summer 19:00 → closed (exclusive)');
});

test('DST transition weeks: anchor still lands exactly on Cairo 07:00 and stays in the future', () => {
  const probes = [
    '2026-04-23T20:00:00Z', '2026-04-24T03:00:00Z', '2026-04-25T23:30:00Z', // around spring-forward
    '2026-10-29T20:00:00Z', '2026-10-30T03:00:00Z', '2026-10-31T23:30:00Z'  // around fall-back
  ];
  for (const iso of probes) {
    const a = nextSevenAmCairoUtc(Z(iso));
    assert.deepEqual(cairoHM(a), { h: 7, m: 0 }, `anchor for ${iso} must be Cairo 07:00`);
    assert.ok(a.getTime() > Z(iso).getTime(), `anchor for ${iso} must be in the future`);
  }
});
