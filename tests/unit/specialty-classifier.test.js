// tests/unit/specialty-classifier.test.js
//
// Theme 14 Phase 1 (Sub-issue A) — unit suite for src/services/specialty_classifier.js.
//
// Mocks the Anthropic client via the module's `_setClientForTests` seam so
// no live API calls happen during the test run. Covers the Ziad-locked
// contract:
//   - Return shape { specialty_id, confidence, reasoning } on happy path
//   - specialty_id must be in the runtime-supplied enum (or null)
//   - confidence ∈ [0, 1]
//   - reasoning ≤ REASONING_MAX_CHARS (140 chars)
//   - null specialty_id is a valid ambiguous-case path
//   - Empty / invalid JSON / out-of-enum specialty / overflow reasoning all throw
//   - SYSTEM_PROMPT contains the routing-tone guardrail + diagnostic-tone ban
//     (snapshot-shaped: substring checks, not full-prompt diff — prompt
//     wording can evolve, the *invariants* cannot)
//
// Async pattern: each test is wrapped in an async IIFE that awaits the
// classifier call. NB side issue #62: async-IIFE assertions print after
// the runner's totals line — this is a pre-existing known issue across
// the codebase, not a Theme 14 regression.

'use strict';

const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🧭 Theme 14 Phase 1 — specialty_classifier.classifyCase contract\n');

const cls = require('../../src/services/specialty_classifier');
const {
  classifyCase,
  SYSTEM_PROMPT,
  REASONING_MAX_CHARS,
  AMBIGUITY_SPREAD_THRESHOLD,
  _setClientForTests,
  _buildUserPrompt
} = cls;

// ── Mock client factory ─────────────────────────────────────────────────
// Each test constructs a fresh mock with a scripted .messages.create that
// returns whatever JSON shape the test wants to assert against. The mock
// also captures the call args so we can assert on prompt content.
function makeMockClient(scriptedTextOrFn) {
  const calls = [];
  return {
    calls: calls,
    messages: {
      create: async function (args) {
        calls.push(args);
        const text = typeof scriptedTextOrFn === 'function' ? scriptedTextOrFn(args) : scriptedTextOrFn;
        return { content: [{ type: 'text', text: text }] };
      }
    }
  };
}

// Canonical mini-enum used across tests (a subset of prod's 22 visible).
const SAMPLE_SPECIALTIES = [
  { id: 'spec-cardiology',   name: 'Cardiology' },
  { id: 'spec-pulmonology',  name: 'Pulmonology' },
  { id: 'spec-neurology',    name: 'Neurology' },
  { id: 'spec-dermatology',  name: 'Dermatology' }
];

function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

async function expectThrows(fn, labelPrefix, contains) {
  try {
    await fn();
    t.fail(fileTag + ': ' + labelPrefix, new Error('expected throw, got success'));
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (contains && !msg.includes(contains)) {
      t.fail(fileTag + ': ' + labelPrefix, new Error('threw but missing "' + contains + '" in: ' + msg));
    } else {
      t.pass(fileTag + ': ' + labelPrefix);
    }
  }
}

// ── 1. SYSTEM_PROMPT guardrail snapshot ─────────────────────────────────
// The prompt is the legal/clinical guardrail. Drift here is silent and
// dangerous. Lock the invariants by substring; the wording can evolve
// without breaking these assertions, but the routing-vs-diagnostic
// distinction cannot.
(function () {
  assert(
    SYSTEM_PROMPT.includes('You are routing, NOT diagnosing'),
    'SYSTEM_PROMPT asserts routing-not-diagnosing identity'
  );
  assert(
    SYSTEM_PROMPT.includes('ROUTING tone') && SYSTEM_PROMPT.includes('DIAGNOSTIC tone'),
    'SYSTEM_PROMPT shows both ROUTING and DIAGNOSTIC tone sections'
  );
  assert(
    SYSTEM_PROMPT.includes('BANNED'),
    'SYSTEM_PROMPT marks diagnostic tone as BANNED'
  );
  assert(
    /cardi(ac|ology).*Cardiology specialty review/s.test(SYSTEM_PROMPT),
    'SYSTEM_PROMPT contains the Cardiology routing-tone example pair'
  );
  assert(
    SYSTEM_PROMPT.includes('treatment plan') && SYSTEM_PROMPT.includes('medication'),
    'SYSTEM_PROMPT explicitly bans treatment plans and medication recommendations'
  );
  assert(
    SYSTEM_PROMPT.includes('JSON object'),
    'SYSTEM_PROMPT specifies JSON-only output'
  );
  assert(
    SYSTEM_PROMPT.includes(String(AMBIGUITY_SPREAD_THRESHOLD)),
    'SYSTEM_PROMPT references the ambiguity-spread threshold'
  );
})();

// ── 2. _buildUserPrompt: shape + injection of dynamic enum ──────────────
(function () {
  const prompt = _buildUserPrompt(
    'Chest pain and shortness of breath after climbing stairs',
    {
      patient_info: { age: 54, gender: 'male' },
      documents_inventory: [{ type: 'lab_report' }, { type: 'imaging' }],
      lab_abnormalities: [{ test: 'troponin', value: '0.5 ng/mL', status: 'above' }]
    },
    SAMPLE_SPECIALTIES
  );
  assert(prompt.includes('spec-cardiology'),  '_buildUserPrompt injects every specialty id (cardiology)');
  assert(prompt.includes('spec-pulmonology'), '_buildUserPrompt injects every specialty id (pulmonology)');
  assert(prompt.includes('Chest pain'),       '_buildUserPrompt includes patient complaint');
  assert(prompt.includes('troponin'),         '_buildUserPrompt includes lab abnormalities');
  assert(prompt.includes('54'),               '_buildUserPrompt includes patient age');
  assert(prompt.includes('male'),             '_buildUserPrompt includes patient gender');
  assert(prompt.includes('lab_report'),       '_buildUserPrompt includes document inventory');
})();

(function () {
  // Empty/null inputs degrade gracefully — no crash, sensible placeholders.
  const prompt = _buildUserPrompt('', null, SAMPLE_SPECIALTIES);
  assert(prompt.includes('(not provided)'),  '_buildUserPrompt handles empty complaint');
  assert(prompt.includes('(none uploaded)'), '_buildUserPrompt handles empty document inventory');
  assert(prompt.includes('(none)'),          '_buildUserPrompt handles empty lab abnormalities');
})();

// ── 3. classifyCase happy path ──────────────────────────────────────────
(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: 'spec-cardiology',
    confidence: 0.92,
    reasoning: 'Cardiac symptoms with elevated troponin fit Cardiology review.',
    alternates: [{ specialty_id: 'spec-pulmonology', confidence: 0.41 }]
  })));

  try {
    const result = await classifyCase(
      'Chest pain, shortness of breath',
      { patient_info: { age: 54 }, lab_abnormalities: [{ test: 'troponin', value: '0.5', status: 'above' }] },
      SAMPLE_SPECIALTIES
    );

    assert(result.specialty_id === 'spec-cardiology', 'happy path returns correct specialty_id');
    assert(result.confidence === 0.92,                'happy path returns confidence verbatim');
    assert(typeof result.reasoning === 'string' && result.reasoning.length <= REASONING_MAX_CHARS,
                                                      'happy path returns reasoning under length cap');
    assert(!('alternates' in result),                 'caller-visible return shape excludes alternates (Phase 1 lock)');
  } catch (err) {
    t.fail(fileTag + ': happy path', err);
  }
})();

// ── 4. classifyCase: null specialty_id is the ambiguous path ────────────
(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: null,
    confidence: 0,
    reasoning: 'Top candidates are too close in confidence — manual review needed.',
    alternates: [
      { specialty_id: 'spec-neurology',   confidence: 0.42 },
      { specialty_id: 'spec-cardiology',  confidence: 0.40 }
    ]
  })));

  try {
    const result = await classifyCase('Headaches and chest tightness', {}, SAMPLE_SPECIALTIES);
    assert(result.specialty_id === null, 'null specialty_id passes validation (ambiguous-case path)');
    assert(result.confidence === 0,      'ambiguous case carries confidence 0');
  } catch (err) {
    t.fail(fileTag + ': ambiguous-case path', err);
  }
})();

// ── 5. classifyCase: enum guard — model returns out-of-enum specialty ──
(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: 'spec-orthopedics',  // not in SAMPLE_SPECIALTIES
    confidence: 0.88,
    reasoning: 'Knee injury fits Orthopedics.',
    alternates: []
  })));
  await expectThrows(
    () => classifyCase('Knee pain after fall', {}, SAMPLE_SPECIALTIES),
    'rejects out-of-enum specialty_id',
    'not in provided list'
  );
})();

// ── 6. classifyCase: reasoning length overflow ──────────────────────────
(async function () {
  const longReasoning = 'x'.repeat(REASONING_MAX_CHARS + 1);
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: 'spec-dermatology',
    confidence: 0.90,
    reasoning: longReasoning,
    alternates: []
  })));
  await expectThrows(
    () => classifyCase('Rash', {}, SAMPLE_SPECIALTIES),
    'rejects reasoning > REASONING_MAX_CHARS',
    'exceeds ' + REASONING_MAX_CHARS
  );
})();

// ── 7. classifyCase: confidence out of [0, 1] ───────────────────────────
(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: 'spec-cardiology',
    confidence: 1.4,
    reasoning: 'Cardiac.',
    alternates: []
  })));
  await expectThrows(
    () => classifyCase('x', {}, SAMPLE_SPECIALTIES),
    'rejects confidence > 1',
    'confidence'
  );
})();

(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: 'spec-cardiology',
    confidence: -0.1,
    reasoning: 'Cardiac.',
    alternates: []
  })));
  await expectThrows(
    () => classifyCase('x', {}, SAMPLE_SPECIALTIES),
    'rejects confidence < 0',
    'confidence'
  );
})();

// ── 8. classifyCase: invalid JSON from model ────────────────────────────
(async function () {
  _setClientForTests(makeMockClient('not even close to JSON'));
  await expectThrows(
    () => classifyCase('x', {}, SAMPLE_SPECIALTIES),
    'rejects non-JSON model output',
    'not valid JSON'
  );
})();

// ── 9. classifyCase: empty model response ───────────────────────────────
(async function () {
  _setClientForTests(makeMockClient(''));
  await expectThrows(
    () => classifyCase('x', {}, SAMPLE_SPECIALTIES),
    'rejects empty model response',
    'empty response'
  );
})();

// ── 10. classifyCase: empty specialties list ────────────────────────────
(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: null, confidence: 0, reasoning: 'x', alternates: []
  })));
  await expectThrows(
    () => classifyCase('x', {}, []),
    'rejects empty specialties list',
    'non-empty array'
  );
})();

// ── 11. classifyCase: malformed specialty entry ─────────────────────────
(async function () {
  await expectThrows(
    () => classifyCase('x', {}, [{ id: 'spec-foo' /* missing name */ }]),
    'rejects specialty entry without name',
    'must have string'
  );
})();

// ── 12. classifyCase: model + system args wired through to Anthropic ────
(async function () {
  const mock = makeMockClient(JSON.stringify({
    specialty_id: 'spec-cardiology', confidence: 0.9, reasoning: 'r', alternates: []
  }));
  _setClientForTests(mock);
  try {
    await classifyCase('x', {}, SAMPLE_SPECIALTIES);
    const call = mock.calls[0];
    assert(call && /^claude-haiku/.test(call.model || ''), 'classifyCase calls Anthropic with a Haiku model');
    assert(call && call.system === SYSTEM_PROMPT,          'classifyCase passes SYSTEM_PROMPT as the system arg');
    assert(call && Array.isArray(call.messages) && call.messages[0].role === 'user',
                                                            'classifyCase sends a single user message');
    assert(call && call.messages[0].content.includes('spec-cardiology'),
                                                            'classifyCase injects the live specialty enum into the user message');
  } catch (err) {
    t.fail(fileTag + ': SDK call wiring', err);
  }
})();
