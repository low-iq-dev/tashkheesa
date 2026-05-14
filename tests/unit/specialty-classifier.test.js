// tests/unit/specialty-classifier.test.js
//
// Theme 14 Phase 1 (Sub-issue A) + Phase 3 polish — unit suite for
// src/services/specialty_classifier.js.
//
// Phase 3 polish extends the return contract from
//   { specialty_id, confidence, reasoning }
// to
//   { specialty_id, service_id, confidence, reasoning }
// and changes the third param shape from a flat
//   [{id, name}]
// to a nested
//   [{id, name, services: [{id, name, price}]}].
//
// Mocks the Anthropic client via the module's `_setClientForTests` seam so
// no live API calls happen during the test run. Covers:
//   - SYSTEM_PROMPT guardrail invariants (routing-tone, diagnostic ban,
//     plus Phase 3 polish additions: confidence-as-min rule, service-in-
//     specialty rule, ambiguity binds both fields)
//   - _buildUserPrompt shape (nested enum injection, services per specialty)
//   - Happy path returns the 4-field shape; ambiguous path has both ids null
//   - Validation: service_id must be in chosen specialty's services[];
//     specialty_id=null forces service_id=null; service-without-specialty
//     rejected
//   - Input validation: empty enum, malformed specialty, specialty with
//     empty services[], malformed service entry
//   - Output validation: confidence bounds, reasoning length, JSON-only,
//     empty response
//   - SDK wiring: Haiku model, SYSTEM_PROMPT as system arg, single user
//     message, nested-enum injection visible in the user content
//
// Async pattern: each test is wrapped in an async IIFE that awaits the
// classifier call. Per side issue #62 (known pre-existing): async-IIFE
// assertions print after the runner's totals line — they pass when the
// file is run standalone (`node tests/unit/specialty-classifier.test.js`).

'use strict';

const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🧭 Theme 14 — specialty_classifier.classifyCase contract (Phase 3 polish: nested enum + service_id)\n');

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

// Canonical mini-enum used across tests — mirrors the post-057 prod shape
// (nested services per specialty).
const SAMPLE_SPECIALTIES = [
  { id: 'spec-cardiology', name: 'Cardiology', services: [
    { id: 'card_ecg_12lead', name: '12-Lead ECG Interpretation', price: 'EGP 1250' },
    { id: 'card_echo',        name: 'Echocardiogram Review',       price: 'EGP 1380' }
  ]},
  { id: 'spec-pulmonology', name: 'Pulmonology', services: [
    { id: 'pulm_cxr_review', name: 'Chest X-Ray Review',           price: 'EGP 1100' }
  ]},
  { id: 'spec-neurology', name: 'Neurology', services: [
    { id: 'neuro_mri_brain', name: 'Brain MRI Review',             price: 'EGP 2200' }
  ]},
  { id: 'spec-dermatology', name: 'Dermatology', services: [
    { id: 'derm_lesion',     name: 'Skin Lesion Review',           price: 'EGP 900'  }
  ]}
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
// distinction + Phase 3 polish additions cannot.
(function () {
  assert(SYSTEM_PROMPT.includes('You are routing, NOT diagnosing'),                 'SYSTEM_PROMPT asserts routing-not-diagnosing identity');
  assert(SYSTEM_PROMPT.includes('ROUTING tone') && SYSTEM_PROMPT.includes('DIAGNOSTIC tone'), 'SYSTEM_PROMPT shows both ROUTING and DIAGNOSTIC tone sections');
  assert(SYSTEM_PROMPT.includes('BANNED'),                                          'SYSTEM_PROMPT marks diagnostic tone as BANNED');
  assert(/cardi(ac|ology).*Cardiology specialty review/s.test(SYSTEM_PROMPT),       'SYSTEM_PROMPT contains the Cardiology routing-tone example pair');
  assert(SYSTEM_PROMPT.includes('treatment plan') && SYSTEM_PROMPT.includes('medication'), 'SYSTEM_PROMPT explicitly bans treatment plans and medication recommendations');
  assert(SYSTEM_PROMPT.includes('JSON object'),                                     'SYSTEM_PROMPT specifies JSON-only output');
  assert(SYSTEM_PROMPT.includes(String(AMBIGUITY_SPREAD_THRESHOLD)),                'SYSTEM_PROMPT references the ambiguity-spread threshold');
  // Phase 3 polish invariants:
  assert(SYSTEM_PROMPT.includes('specialty_id') && SYSTEM_PROMPT.includes('service_id'), 'SYSTEM_PROMPT names both specialty_id AND service_id in the output schema');
  assert(/Confidence rule.*lower of your specialty-level/s.test(SYSTEM_PROMPT),    'SYSTEM_PROMPT enforces confidence-as-min-of-two-dimensions');
  assert(SYSTEM_PROMPT.includes("services[]"),                                      'SYSTEM_PROMPT instructs service_id MUST belong to the chosen specialty\'s services[]');
  assert(/BOTH specialty_id AND service_id as null/s.test(SYSTEM_PROMPT),           'SYSTEM_PROMPT binds the ambiguity rule across both fields');
})();

// ── 2. _buildUserPrompt: nested enum injection + case data ──────────────
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
  assert(prompt.includes('spec-cardiology'),       '_buildUserPrompt injects every specialty id (cardiology)');
  assert(prompt.includes('spec-pulmonology'),      '_buildUserPrompt injects every specialty id (pulmonology)');
  assert(prompt.includes('card_ecg_12lead'),       '_buildUserPrompt injects services within each specialty (cardiology service)');
  assert(prompt.includes('pulm_cxr_review'),       '_buildUserPrompt injects services within each specialty (pulmonology service)');
  assert(prompt.includes('EGP 1250'),              '_buildUserPrompt injects service prices');
  assert(prompt.includes('Chest pain'),            '_buildUserPrompt includes patient complaint');
  assert(prompt.includes('troponin'),              '_buildUserPrompt includes lab abnormalities');
  assert(prompt.includes('54'),                    '_buildUserPrompt includes patient age');
  assert(prompt.includes('male'),                  '_buildUserPrompt includes patient gender');
  assert(prompt.includes('lab_report'),            '_buildUserPrompt includes document inventory');
})();

(function () {
  const prompt = _buildUserPrompt('', null, SAMPLE_SPECIALTIES);
  assert(prompt.includes('(not provided)'),        '_buildUserPrompt handles empty complaint');
  assert(prompt.includes('(none uploaded)'),       '_buildUserPrompt handles empty document inventory');
  assert(prompt.includes('(none)'),                '_buildUserPrompt handles empty lab abnormalities');
})();

// ── 3. Input validation throws ──────────────────────────────────────────
(async function () {
  await expectThrows(
    () => classifyCase('x', {}, []),
    'rejects empty specialtiesWithServices list', 'non-empty array'
  );
})();
(async function () {
  await expectThrows(
    () => classifyCase('x', {}, [{ id: 'spec-foo' /* missing name */, services: [{ id: 's1', name: 'S1' }] }]),
    'rejects specialty entry without name', 'string {id, name}'
  );
})();
(async function () {
  await expectThrows(
    () => classifyCase('x', {}, [{ id: 'spec-foo', name: 'Foo', services: [] }]),
    'rejects specialty with empty services[] array', 'non-empty services'
  );
})();
(async function () {
  await expectThrows(
    () => classifyCase('x', {}, [{ id: 'spec-foo', name: 'Foo', services: [{ id: 's1' /* missing name */ }] }]),
    'rejects service entry without name', 'every service must have'
  );
})();

// ── 4. Happy path — returns 4-field shape including service_id ─────────
(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: 'spec-cardiology',
    service_id:   'card_ecg_12lead',
    confidence:   0.91,
    reasoning:    'Cardiac symptoms with elevated troponin fit ECG review under Cardiology.'
  })));
  try {
    const result = await classifyCase(
      'Chest pain, shortness of breath',
      { patient_info: { age: 54 }, lab_abnormalities: [{ test: 'troponin', value: '0.5', status: 'above' }] },
      SAMPLE_SPECIALTIES
    );
    assert(result.specialty_id === 'spec-cardiology',  'happy path returns specialty_id');
    assert(result.service_id === 'card_ecg_12lead',    'happy path returns service_id');
    assert(result.confidence === 0.91,                 'happy path returns confidence verbatim');
    assert(typeof result.reasoning === 'string' && result.reasoning.length <= REASONING_MAX_CHARS,
                                                       'happy path returns reasoning under length cap');
    const keys = Object.keys(result).sort().join(',');
    assert(keys === 'confidence,reasoning,service_id,specialty_id',
                                                       'caller-visible return shape is exactly {specialty_id, service_id, confidence, reasoning}');
  } catch (err) {
    t.fail(fileTag + ': happy path', err);
  }
})();

// ── 5. Ambiguous path — both ids null, confidence 0 ────────────────────
(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: null,
    service_id:   null,
    confidence:   0,
    reasoning:    'Top candidates are too close in confidence — manual review needed.'
  })));
  try {
    const result = await classifyCase('Headaches and chest tightness', {}, SAMPLE_SPECIALTIES);
    assert(result.specialty_id === null,               'ambiguous: specialty_id null');
    assert(result.service_id === null,                 'ambiguous: service_id null');
    assert(result.confidence === 0,                    'ambiguous: confidence is 0');
  } catch (err) {
    t.fail(fileTag + ': ambiguous path', err);
  }
})();

// ── 6. Ambiguity binds: specialty_id=null → service_id MUST be null ────
(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: null,
    service_id:   'card_ecg_12lead',  // illegal — can't pair a service with a null specialty
    confidence:   0,
    reasoning:    'r'
  })));
  await expectThrows(
    () => classifyCase('x', {}, SAMPLE_SPECIALTIES),
    'rejects service_id when specialty_id is null (ambiguity binds)', 'must be null when specialty_id is null'
  );
})();

// ── 7. Service-in-specialty enum guard ──────────────────────────────────
(async function () {
  // Cardiology + a Pulmonology service id — illegal cross-specialty pair.
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: 'spec-cardiology',
    service_id:   'pulm_cxr_review',
    confidence:   0.85,
    reasoning:    'r'
  })));
  await expectThrows(
    () => classifyCase('x', {}, SAMPLE_SPECIALTIES),
    'rejects service_id from a different specialty', 'not in specialty'
  );
})();

// ── 8. Out-of-enum specialty rejection ─────────────────────────────────
(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: 'spec-orthopedics',  // not in SAMPLE_SPECIALTIES
    service_id:   'ortho_knee_xray',
    confidence:   0.88,
    reasoning:    'Knee injury fits Orthopedics.'
  })));
  await expectThrows(
    () => classifyCase('Knee pain after fall', {}, SAMPLE_SPECIALTIES),
    'rejects out-of-enum specialty_id', 'not in provided list'
  );
})();

// ── 9. Out-of-enum service rejection (service id not in any specialty) ─
(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: 'spec-cardiology',
    service_id:   'totally_made_up_service',
    confidence:   0.9,
    reasoning:    'r'
  })));
  await expectThrows(
    () => classifyCase('x', {}, SAMPLE_SPECIALTIES),
    'rejects service_id not in chosen specialty\'s services[]', 'not in specialty'
  );
})();

// ── 10. Reasoning length overflow ───────────────────────────────────────
(async function () {
  const longReasoning = 'x'.repeat(REASONING_MAX_CHARS + 1);
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: 'spec-dermatology',
    service_id:   'derm_lesion',
    confidence:   0.90,
    reasoning:    longReasoning
  })));
  await expectThrows(
    () => classifyCase('Rash', {}, SAMPLE_SPECIALTIES),
    'rejects reasoning > REASONING_MAX_CHARS', 'exceeds ' + REASONING_MAX_CHARS
  );
})();

// ── 11. Confidence bounds ──────────────────────────────────────────────
(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: 'spec-cardiology',
    service_id:   'card_ecg_12lead',
    confidence:   1.4,
    reasoning:    'r'
  })));
  await expectThrows(() => classifyCase('x', {}, SAMPLE_SPECIALTIES), 'rejects confidence > 1', 'confidence');
})();
(async function () {
  _setClientForTests(makeMockClient(JSON.stringify({
    specialty_id: 'spec-cardiology',
    service_id:   'card_ecg_12lead',
    confidence:   -0.1,
    reasoning:    'r'
  })));
  await expectThrows(() => classifyCase('x', {}, SAMPLE_SPECIALTIES), 'rejects confidence < 0', 'confidence');
})();

// ── 12. Output-shape failures ───────────────────────────────────────────
(async function () {
  _setClientForTests(makeMockClient('not even close to JSON'));
  await expectThrows(() => classifyCase('x', {}, SAMPLE_SPECIALTIES), 'rejects non-JSON model output', 'not valid JSON');
})();
(async function () {
  _setClientForTests(makeMockClient(''));
  await expectThrows(() => classifyCase('x', {}, SAMPLE_SPECIALTIES), 'rejects empty model response', 'empty response');
})();

// ── 13. SDK wiring ──────────────────────────────────────────────────────
(async function () {
  const mock = makeMockClient(JSON.stringify({
    specialty_id: 'spec-cardiology',
    service_id:   'card_ecg_12lead',
    confidence:   0.9,
    reasoning:    'r'
  }));
  _setClientForTests(mock);
  try {
    await classifyCase('x', {}, SAMPLE_SPECIALTIES);
    const call = mock.calls[0];
    assert(call && /^claude-haiku/.test(call.model || ''),         'classifyCase calls Anthropic with a Haiku model');
    assert(call && call.system === SYSTEM_PROMPT,                  'classifyCase passes SYSTEM_PROMPT as the system arg');
    assert(call && Array.isArray(call.messages) && call.messages[0].role === 'user',
                                                                    'classifyCase sends a single user message');
    assert(call && call.messages[0].content.includes('spec-cardiology'),
                                                                    'classifyCase injects the live specialty enum into the user message');
    assert(call && call.messages[0].content.includes('card_ecg_12lead'),
                                                                    'classifyCase injects services (nested) within the specialty enum');
  } catch (err) {
    t.fail(fileTag + ': SDK call wiring', err);
  }
})();
