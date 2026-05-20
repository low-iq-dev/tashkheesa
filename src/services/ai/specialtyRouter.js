// ─────────────────────────────────────────────────────────────────────
// PARKED — Not wired into production. Reference implementation for
// future AI features (urgency triage, similar-case retrieval, etc.).
//
// The live specialty-routing system is src/services/specialty_classifier.js.
// Do not mount this route in server.js without explicit instruction.
// ─────────────────────────────────────────────────────────────────────
//
// services/ai/specialtyRouter.js
//
// Suggests the most appropriate specialty for a new case based on the patient's
// complaint and symptoms. First production AI feature in Tashkheesa.
//
// Behavior:
//   - Calls Claude with a strict JSON schema
//   - Falls back to null on any error (caller should treat as "no suggestion")
//   - Writes an ai_suggestions row regardless of success/failure
//   - Respects AI_SPECIALTY_ROUTING_ENABLED kill switch
//
// Caller is responsible for capturing human_action later via recordHumanAction().

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
// Adjust this path to point at your db.js. CC confirmed it lives at src/db.js,
// so if this file ships at src/services/ai/specialtyRouter.js, use '../../db'.
const { pool } = require('../../db');

const FEATURE = 'specialty_routing';
const PROMPT_VERSION = 'v1-2026-05-19';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Loaded once on boot from DB. See loadSpecialties() at bottom.
let SPECIALTY_CACHE = null;

/**
 * Suggest a specialty for a case.
 *
 * @param {Object} input
 * @param {number} input.orderId
 * @param {number} input.patientId
 * @param {string} input.complaint      Free-text chief complaint
 * @param {string} input.symptoms       Additional symptom description
 * @param {number} [input.patientAge]
 * @param {string} [input.patientGender]
 * @param {string} [input.locale]       'ar' | 'en'
 * @returns {Promise<Object|null>}      Suggestion object or null on failure/disabled
 */
async function suggestSpecialty(input) {
  const enabled = process.env.AI_SPECIALTY_ROUTING_ENABLED === 'true';
  if (!enabled) return null;

  const model = process.env.AI_SPECIALTY_ROUTING_MODEL || 'claude-opus-4-7';
  const timeoutMs = parseInt(process.env.AI_SPECIALTY_ROUTING_TIMEOUT_MS || '8000', 10);

  const specialties = await getSpecialties();
  if (!specialties || specialties.length === 0) {
    console.error('[specialtyRouter] No specialties loaded');
    return null;
  }

  const inputPayload = {
    complaint: (input.complaint || '').trim().slice(0, 4000),
    symptoms: (input.symptoms || '').trim().slice(0, 4000),
    patient_age: input.patientAge ?? null,
    patient_gender: input.patientGender ?? null,
    locale: input.locale || 'ar',
  };

  const inputHash = sha256(JSON.stringify(inputPayload));
  const startedAt = Date.now();

  let suggestion = null;
  let confidence = null;
  let errorMsg = null;

  try {
    const systemPrompt = buildSystemPrompt(specialties);
    const userMessage = buildUserMessage(inputPayload);

    const response = await withTimeout(
      client.messages.create({
        model,
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      timeoutMs
    );

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const parsed = extractJson(text);
    if (!parsed) throw new Error('Model returned non-JSON output');

    const validId = specialties.find((s) => s.id === parsed.suggested_specialty_id);
    if (!validId) throw new Error(`Invalid specialty_id: ${parsed.suggested_specialty_id}`);

    suggestion = {
      suggested_specialty_id: parsed.suggested_specialty_id,
      suggested_specialty_name_ar: validId.name_ar || validId.name,
      suggested_specialty_name_en: validId.name,
      confidence: clampConfidence(parsed.confidence),
      reasoning: (parsed.reasoning || '').slice(0, 1000),
      alternatives: Array.isArray(parsed.alternatives)
        ? parsed.alternatives
            .filter((a) => specialties.find((s) => s.id === a.specialty_id))
            .map((a) => ({
              specialty_id: a.specialty_id,
              confidence: clampConfidence(a.confidence),
            }))
            .slice(0, 3)
        : [],
      red_flags: Array.isArray(parsed.red_flags) ? parsed.red_flags.slice(0, 5) : [],
    };
    confidence = suggestion.confidence;
  } catch (err) {
    errorMsg = err.message || String(err);
    console.error('[specialtyRouter] Failed:', errorMsg);
  }

  const latencyMs = Date.now() - startedAt;

  // Always log — success or failure — for monitoring.
  const suggestionId = await insertAuditRow({
    orderId: input.orderId,
    patientId: input.patientId,
    model,
    inputHash,
    inputPayload,
    suggestion,
    confidence,
    latencyMs,
    error: errorMsg,
  });

  if (!suggestion) return null;
  return { ...suggestion, suggestion_id: suggestionId };
}

/**
 * Record the patient's actual choice against an earlier suggestion.
 * Call this when the wizard step that uses the suggestion is submitted.
 */
async function recordHumanAction({ suggestionId, chosenSpecialtyId, suggestedSpecialtyId }) {
  if (!suggestionId) return;
  const action = chosenSpecialtyId === suggestedSpecialtyId ? 'accepted' : 'overridden';
  await pool.query(
    `UPDATE ai_suggestions
        SET human_action = $1,
            human_value = $2,
            resolved_at = now()
      WHERE id = $3`,
    [action, JSON.stringify({ chosen_specialty_id: chosenSpecialtyId }), suggestionId]
  );
}

// ─── internals ───────────────────────────────────────────────────────────────

function buildSystemPrompt(specialties) {
  const list = specialties
    .map((s) => `- ${s.id}: ${s.name} (${s.name_ar || ''}) — ${s.description || ''}`)
    .join('\n');

  return `You are a clinical triage assistant for Tashkheesa, a medical second-opinion platform operating in Egypt and MENA. Your job is to suggest the most appropriate medical specialty for a patient case based on their chief complaint and symptoms.

You are NOT diagnosing. You are routing. The patient will choose, a doctor will review.

Available specialties (use the exact id):
${list}

Output ONLY a single JSON object, no prose, no markdown fences. Schema:
{
  "suggested_specialty_id": "<one id from the list>",
  "confidence": <number between 0 and 1>,
  "reasoning": "<one short sentence explaining the choice, in the same language as the patient input>",
  "alternatives": [
    { "specialty_id": "<id>", "confidence": <number> }
  ],
  "red_flags": ["<short keyword>", "..."]
}

Rules:
- confidence reflects how clearly the case maps to ONE specialty. If symptoms are vague or could fit multiple, lower it.
- alternatives: 0 to 3 other plausible specialties, descending confidence. Omit if confidence > 0.9.
- red_flags: short tokens for emergency-suggestive symptoms (e.g. "chest_pain_exertional", "neurological_deficit", "pediatric_fever_under_3mo"). Empty array if none.
- If the input is empty, gibberish, or clearly non-medical, return confidence 0 and your best guess specialty_id (default to internal_medicine if no signal).
- Never invent specialty ids that aren't in the list above.`;
}

function buildUserMessage(p) {
  const lines = [];
  if (p.patient_age != null) lines.push(`Patient age: ${p.patient_age}`);
  if (p.patient_gender) lines.push(`Patient gender: ${p.patient_gender}`);
  lines.push(`Locale: ${p.locale}`);
  lines.push('');
  lines.push('Chief complaint:');
  lines.push(p.complaint || '(empty)');
  if (p.symptoms) {
    lines.push('');
    lines.push('Additional symptoms / context:');
    lines.push(p.symptoms);
  }
  return lines.join('\n');
}

function extractJson(text) {
  if (!text) return null;
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch (_) {}
  // Try to find a JSON object substring
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

function clampConfidence(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ]);
}

async function insertAuditRow(row) {
  const { rows } = await pool.query(
    `INSERT INTO ai_suggestions
        (order_id, patient_id, feature, model, model_version,
         input_hash, input_payload, suggestion, confidence,
         latency_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      row.orderId,
      row.patientId,
      FEATURE,
      row.model,
      PROMPT_VERSION,
      row.inputHash,
      JSON.stringify(row.inputPayload),
      row.suggestion ? JSON.stringify(row.suggestion) : JSON.stringify({}),
      row.confidence,
      row.latencyMs,
      row.error,
    ]
  );
  return rows[0].id;
}

async function getSpecialties() {
  if (SPECIALTY_CACHE) return SPECIALTY_CACHE;
  await loadSpecialties();
  return SPECIALTY_CACHE;
}

async function loadSpecialties() {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, name_ar, description
         FROM specialties
        WHERE is_visible = true
        ORDER BY id`
    );
    SPECIALTY_CACHE = rows;
    console.log(`[specialtyRouter] Loaded ${rows.length} specialties`);
  } catch (err) {
    console.error('[specialtyRouter] Failed to load specialties:', err.message);
    SPECIALTY_CACHE = [];
  }
}

// Refresh cache every 10 minutes in case admin edits specialties table.
setInterval(loadSpecialties, 10 * 60 * 1000).unref?.();

module.exports = {
  suggestSpecialty,
  recordHumanAction,
  _internal: { loadSpecialties }, // for tests
};
