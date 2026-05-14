/**
 * Theme 14 Sub-issue A — AI specialty classifier.
 *
 * Reads patient case data (chief complaint + structured intake) and routes
 * the case to one of the live `is_visible = true` specialties via Claude
 * Haiku. The list of specialties is passed in at call time (Q-extra locked
 * decision: dynamic runtime enum, not a baked-in constant), so toggling a
 * specialty `is_visible = false` in the database removes it from the
 * classifier's choice set on the next case.
 *
 * ROUTING, NOT DIAGNOSIS. The system prompt explicitly bans diagnostic
 * framing and includes a routing-vs-diagnostic example pair. The reasoning
 * field surfaces to the patient verbatim via the Step 3 "Why?" toggle
 * (Q3 locked decision), so a diagnostic-tone bleed would be a clinical
 * liability surfaced in patient-facing UI. Phase 6 (Sub-issue G) adds a
 * snapshot test on SYSTEM_PROMPT to prevent a future edit silently
 * weakening this guardrail.
 *
 * Caller-visible return shape (Ziad-locked Phase 1 brief):
 *   { specialty_id, confidence, reasoning }
 *
 * `specialty_id` may be null when the model returns genuine ambiguity
 * (top-1 vs top-2 confidence spread < AMBIGUITY_SPREAD_THRESHOLD). The
 * downstream POST step3 handler treats `null` as "route to operator
 * manual queue" (Q2 locked: < 0.55 = manual review path).
 *
 * No DB writes inside this module — the audit insert into
 * `specialty_classifications` is a Phase 3 (Sub-issue C) concern at the
 * call site, after the migration that creates the table lands. Keeping
 * Phase 1 pure-function-shaped makes it trivially testable with mocked
 * Anthropic responses.
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { modelHaiku } = require('../config/anthropic');

const REASONING_MAX_CHARS = 140;
const AMBIGUITY_SPREAD_THRESHOLD = 0.10;
const MAX_OUTPUT_TOKENS = 500;

const SYSTEM_PROMPT = [
  'You are a medical triage routing assistant for Tashkheesa, a remote-consultation platform.',
  'Your sole job is to recommend the single best specialty for case review from a fixed list provided in the user message.',
  '',
  'You are routing, NOT diagnosing.',
  '',
  'ROUTING tone (allowed examples):',
  '  - "Your case mentions cardiac symptoms, which fall under Cardiology specialty review."',
  '  - "The uploaded chest X-ray and respiratory complaint fit Pulmonology review."',
  '',
  'DIAGNOSTIC tone (BANNED — never produce):',
  '  - "You have cardiac arrhythmia."',
  '  - "Your symptoms suggest pneumonia."',
  '  - Any diagnosis, treatment plan, medication recommendation, or clinical advice.',
  '',
  'Output ONLY a single JSON object matching this exact schema:',
  '{',
  '  "specialty_id": "<id from the provided list, or null if ambiguous>",',
  '  "confidence": <number between 0.0 and 1.0>,',
  '  "reasoning": "<one sentence, max ' + REASONING_MAX_CHARS + ' characters, routing-tone>",',
  '  "alternates": [',
  '    { "specialty_id": "<id>", "confidence": <number> }',
  '  ]',
  '}',
  '',
  'Ambiguity rule: if your top-1 and top-2 candidates differ by less than ' + AMBIGUITY_SPREAD_THRESHOLD + ' in confidence,',
  'return specialty_id=null and confidence=0 to signal genuine ambiguity for manual operator review.',
  '',
  'Never invent specialty_id values that are not in the provided list.',
  'Never output anything except the JSON object — no preamble, no markdown fences, no explanation outside the JSON.'
].join('\n');

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// Test seam — lets the Phase 1 unit suite inject a mock Anthropic client
// without monkey-patching the SDK or hitting the live API.
function _setClientForTests(client) {
  _client = client;
}

function _buildUserPrompt(caseText, fileMetadata, specialtiesList) {
  const enumLines = specialtiesList
    .map(s => '  - id: "' + s.id + '" — name: "' + s.name + '"')
    .join('\n');

  const fm = fileMetadata || {};
  const patientInfo = fm.patient_info || {};
  const lab = Array.isArray(fm.lab_abnormalities) ? fm.lab_abnormalities : [];
  const docs = Array.isArray(fm.documents_inventory) ? fm.documents_inventory : [];

  const docSummary = docs.length
    ? docs.map(d => d.type || d.document_category || 'unknown').join(', ')
    : '(none uploaded)';

  const labSummary = lab.length
    ? lab.map(l => (l.test || 'test') + ' = ' + (l.value || '?') + ' (' + (l.status || 'unknown') + ')').join('; ')
    : '(none)';

  return [
    'Available specialties — choose exactly one specialty_id from this list (or null if ambiguous per the rule in the system prompt):',
    enumLines,
    '',
    'Case data:',
    '  Patient complaint: ' + (caseText && String(caseText).trim() ? String(caseText).trim() : '(not provided)'),
    '  Patient age: ' + (patientInfo.age != null ? String(patientInfo.age) : 'not specified'),
    '  Patient gender: ' + (patientInfo.gender || 'not specified'),
    '  Document inventory: ' + docSummary,
    '  Lab abnormalities: ' + labSummary,
    '',
    'Return the JSON object now.'
  ].join('\n');
}

async function classifyCase(caseText, fileMetadata, specialtiesList) {
  if (!Array.isArray(specialtiesList) || specialtiesList.length === 0) {
    throw new Error('classifyCase: specialtiesList must be a non-empty array');
  }
  for (const s of specialtiesList) {
    if (!s || typeof s.id !== 'string' || typeof s.name !== 'string') {
      throw new Error('classifyCase: every specialty must have string {id, name}');
    }
  }

  const validIds = new Set(specialtiesList.map(s => s.id));
  const userPrompt = _buildUserPrompt(caseText, fileMetadata, specialtiesList);

  const response = await getClient().messages.create({
    model: modelHaiku(),
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const first = (response && response.content && response.content[0]) || {};
  const raw = typeof first.text === 'string' ? first.text.trim() : '';
  if (!raw) {
    throw new Error('classifyCase: empty response from model');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('classifyCase: model output is not valid JSON (head: ' + raw.slice(0, 200) + ')');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('classifyCase: model output is not a JSON object');
  }

  if (parsed.specialty_id !== null && typeof parsed.specialty_id !== 'string') {
    throw new Error('classifyCase: specialty_id must be a string or null');
  }
  if (parsed.specialty_id !== null && !validIds.has(parsed.specialty_id)) {
    throw new Error('classifyCase: specialty_id "' + parsed.specialty_id + '" not in provided list');
  }

  if (typeof parsed.confidence !== 'number' || !isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
    throw new Error('classifyCase: confidence must be a finite number in [0, 1]');
  }

  if (typeof parsed.reasoning !== 'string' || parsed.reasoning.length === 0) {
    throw new Error('classifyCase: reasoning must be a non-empty string');
  }
  if (parsed.reasoning.length > REASONING_MAX_CHARS) {
    throw new Error('classifyCase: reasoning exceeds ' + REASONING_MAX_CHARS + ' chars (got ' + parsed.reasoning.length + ')');
  }

  return {
    specialty_id: parsed.specialty_id,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning
  };
}

module.exports = {
  classifyCase,
  SYSTEM_PROMPT,
  REASONING_MAX_CHARS,
  AMBIGUITY_SPREAD_THRESHOLD,
  _setClientForTests,
  _buildUserPrompt
};
