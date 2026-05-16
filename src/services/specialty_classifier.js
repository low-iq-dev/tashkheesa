/**
 * Theme 14 Sub-issue A — AI specialty + service classifier.
 *
 * Reads patient case data (chief complaint + structured intake) and routes
 * the case to BOTH a specialty AND a priced service within that specialty
 * via Claude Haiku. The enum of specialties + their nested services is
 * passed in at call time (Q-extra locked: dynamic runtime enum, not a
 * baked-in constant). At Phase 3 polish ship time, the production enum
 * is 21 visible specialties each carrying ≥1 visible service.
 *
 * ROUTING, NOT DIAGNOSIS. The system prompt explicitly bans diagnostic
 * framing and includes a routing-vs-diagnostic example pair. The reasoning
 * field surfaces to the patient verbatim via the Step 3 "Why?" toggle
 * (Q3 locked decision), so a diagnostic-tone bleed would be a clinical
 * liability surfaced in patient-facing UI. Phase 6 (Sub-issue G) adds a
 * snapshot test on SYSTEM_PROMPT to prevent a future edit silently
 * weakening this guardrail.
 *
 * Caller-visible return shape (Phase 3 polish — adds service_id):
 *   { specialty_id, service_id, confidence, reasoning }
 *
 * Both `specialty_id` and `service_id` may be null when the model returns
 * genuine ambiguity (top-1 vs top-2 confidence spread < AMBIGUITY_SPREAD_THRESHOLD).
 * The downstream POST step3 handler treats both-null as the manual-review
 * path (confidence < classifier_threshold_minimum → operator triage).
 *
 * Confidence semantics: the model outputs a single confidence representing
 * the LOWER of its specialty-level and service-level certainty. Locked tier
 * (≥0.95) therefore requires the model to be ≥0.95 on BOTH dimensions —
 * the prompt enforces this explicitly.
 *
 * No DB writes inside this module — the audit insert into
 * `specialty_classifications` (now including service_id post-058) is a
 * call-site concern. Keeping the helper pure-function-shaped makes it
 * trivially testable with mocked Anthropic responses.
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { modelHaiku } = require('../config/anthropic');

const REASONING_MAX_CHARS = 140;
const AMBIGUITY_SPREAD_THRESHOLD = 0.10;
const MAX_OUTPUT_TOKENS = 500;

const SYSTEM_PROMPT = [
  'You are a medical triage routing assistant for Tashkheesa, a remote-consultation platform.',
  'Your sole job is to recommend the single best specialty AND a single best priced service within that specialty for case review, from a fixed list provided in the user message.',
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
  '  "service_id":   "<id from the chosen specialty\'s services[], or null if ambiguous>",',
  '  "confidence":   <number between 0.0 and 1.0>,',
  '  "reasoning":    "<one sentence, max ' + REASONING_MAX_CHARS + ' characters, routing-tone>"',
  '}',
  '',
  'Confidence rule: your overall `confidence` MUST be the lower of your specialty-level certainty and your service-level certainty. If you are 0.95 sure of the specialty but only 0.70 sure which service fits within it, return 0.70.',
  '',
  'Service rule: `service_id` MUST belong to the chosen specialty\'s services[] list. Never pair a service with a different specialty.',
  '',
  'Ambiguity rule: if your top-1 and top-2 specialty candidates differ by less than ' + AMBIGUITY_SPREAD_THRESHOLD + ' in certainty, return BOTH specialty_id AND service_id as null with confidence=0 to signal genuine ambiguity for manual operator review.',
  '',
  'Never invent ids that are not in the provided lists.',
  'Never output anything except the JSON object — no preamble, no markdown fences, no explanation outside the JSON.'
].join('\n');

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// Test seam — lets the Phase 6 unit suite inject a mock Anthropic client
// without monkey-patching the SDK or hitting the live API.
function _setClientForTests(client) {
  _client = client;
}

function _buildUserPrompt(caseText, fileMetadata, specialtiesWithServices) {
  // Render the nested enum as compact JSON. Each specialty entry carries
  // its services array; the model picks one specialty + one service from
  // within that specialty's services[].
  const enumJson = JSON.stringify(
    specialtiesWithServices.map(function (s) {
      return {
        id: s.id,
        name: s.name,
        services: (Array.isArray(s.services) ? s.services : []).map(function (sv) {
          return { id: sv.id, name: sv.name, price: sv.price || '' };
        })
      };
    }),
    null,
    2
  );

  const fm = fileMetadata || {};
  const patientInfo = fm.patient_info || {};
  const lab = Array.isArray(fm.lab_abnormalities) ? fm.lab_abnormalities : [];
  const docs = Array.isArray(fm.documents_inventory) ? fm.documents_inventory : [];

  const docSummary = docs.length
    ? docs.map(function (d) { return d.type || d.document_category || 'unknown'; }).join(', ')
    : '(none uploaded)';

  const labSummary = lab.length
    ? lab.map(function (l) {
        return (l.test || 'test') + ' = ' + (l.value || '?') + ' (' + (l.status || 'unknown') + ')';
      }).join('; ')
    : '(none)';

  return [
    'Available specialties with services (choose ONE specialty_id from the top level AND ONE service_id from that specialty\'s services[]):',
    enumJson,
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

async function classifyCase(caseText, fileMetadata, specialtiesWithServices) {
  if (!Array.isArray(specialtiesWithServices) || specialtiesWithServices.length === 0) {
    throw new Error('classifyCase: specialtiesWithServices must be a non-empty array');
  }
  for (const s of specialtiesWithServices) {
    if (!s || typeof s.id !== 'string' || typeof s.name !== 'string') {
      throw new Error('classifyCase: every specialty must have string {id, name}');
    }
    if (!Array.isArray(s.services) || s.services.length === 0) {
      throw new Error('classifyCase: specialty "' + s.id + '" must have a non-empty services[] array');
    }
    for (const sv of s.services) {
      if (!sv || typeof sv.id !== 'string' || typeof sv.name !== 'string') {
        throw new Error('classifyCase: every service must have string {id, name}');
      }
    }
  }

  // Build a per-specialty service-id set for the post-parse validation.
  const validSpecialtyIds = new Set(specialtiesWithServices.map(function (s) { return s.id; }));
  const servicesBySpecialty = {};
  for (const s of specialtiesWithServices) {
    servicesBySpecialty[s.id] = new Set(s.services.map(function (sv) { return sv.id; }));
  }

  const userPrompt = _buildUserPrompt(caseText, fileMetadata, specialtiesWithServices);

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

  // Side issue #77 — Haiku frequently wraps JSON in markdown fences despite
  // the SYSTEM_PROMPT's "no markdown fences" instruction. Strip them defensively
  // before parsing. Observed in prod 2026-05-16: a perfectly-shaped locked-tier
  // recommendation was rejected because the model added ```json … ``` around
  // the JSON body. Prompt-only enforcement is unreliable for this guardrail;
  // the parser-side strip is the durable fix.
  let cleaned = raw;
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('classifyCase: model output is not valid JSON (head: ' + cleaned.slice(0, 200) + ')');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('classifyCase: model output is not a JSON object');
  }

  // specialty_id may be null OR a string from the enum.
  if (parsed.specialty_id !== null && typeof parsed.specialty_id !== 'string') {
    throw new Error('classifyCase: specialty_id must be a string or null');
  }
  if (parsed.specialty_id !== null && !validSpecialtyIds.has(parsed.specialty_id)) {
    throw new Error('classifyCase: specialty_id "' + parsed.specialty_id + '" not in provided list');
  }

  // service_id may be null OR a string. If non-null, must be in the chosen
  // specialty's services[]. If specialty_id is null (ambiguous), service_id
  // MUST also be null (the ambiguity rule binds both fields together).
  if (parsed.service_id !== null && typeof parsed.service_id !== 'string') {
    throw new Error('classifyCase: service_id must be a string or null');
  }
  if (parsed.specialty_id === null && parsed.service_id !== null) {
    throw new Error('classifyCase: service_id must be null when specialty_id is null (ambiguity binds both)');
  }
  if (parsed.specialty_id !== null && parsed.service_id !== null) {
    const allowed = servicesBySpecialty[parsed.specialty_id];
    if (!allowed || !allowed.has(parsed.service_id)) {
      throw new Error('classifyCase: service_id "' + parsed.service_id + '" not in specialty "' + parsed.specialty_id + '" services[]');
    }
  }

  // confidence must be a number in [0, 1].
  if (typeof parsed.confidence !== 'number' || !isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
    throw new Error('classifyCase: confidence must be a finite number in [0, 1]');
  }

  // reasoning must be a non-empty string ≤ 140 chars.
  if (typeof parsed.reasoning !== 'string' || parsed.reasoning.length === 0) {
    throw new Error('classifyCase: reasoning must be a non-empty string');
  }
  if (parsed.reasoning.length > REASONING_MAX_CHARS) {
    throw new Error('classifyCase: reasoning exceeds ' + REASONING_MAX_CHARS + ' chars (got ' + parsed.reasoning.length + ')');
  }

  // Caller-visible return shape (Phase 3 polish locked):
  return {
    specialty_id: parsed.specialty_id,
    service_id:   parsed.service_id,
    confidence:   parsed.confidence,
    reasoning:    parsed.reasoning
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
