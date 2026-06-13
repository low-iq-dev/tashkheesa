// src/config/anthropic.js — single source of truth for Anthropic model selection.
//
// Resolves the model id at call time so a Render env-var change takes effect
// on the next request without a code edit. Reads `process.env` per call (not
// at require-time) so swap-and-reload deploys pick up new values.
//
// Defaults track the canonical Claude family at deploy time. Anthropic's
// deprecation policy gives ≥60 days notice (see GR-CSP-1's sibling rule); the
// values below should outlive a launch window. Override per env when the
// in-code defaults rotate.
//
//   ANTHROPIC_MODEL_SONNET — text extraction + chat assistant
//   ANTHROPIC_MODEL_HAIKU  — fast triage / classification
//   ANTHROPIC_MODEL_VISION — image quality / OCR check (Sonnet-class)
//
// Per Theme 9 OQ-2 + the Anthropic deprecation table fetched 2026-05-11:
// - claude-sonnet-4-6   retention "not sooner than February 17, 2027"
// - claude-haiku-4-5    retention "not sooner than October 15, 2026"
// - claude-sonnet-4-20250514 retires June 15, 2026 (was the previous default
//   across 3 call sites — this module retires that literal).

'use strict';

const DEFAULT_SONNET = 'claude-sonnet-4-6';
const DEFAULT_HAIKU  = 'claude-haiku-4-5';
const DEFAULT_VISION = 'claude-sonnet-4-6';

function modelSonnet() {
  return (process.env.ANTHROPIC_MODEL_SONNET || '').trim() || DEFAULT_SONNET;
}

function modelHaiku() {
  return (process.env.ANTHROPIC_MODEL_HAIKU || '').trim() || DEFAULT_HAIKU;
}

function modelVision() {
  return (process.env.ANTHROPIC_MODEL_VISION || '').trim() || DEFAULT_VISION;
}

// True when an Anthropic SDK error is a BILLING failure (account out of
// credit / quota) — distinct from transient errors (429/529/timeout) or a
// generic bad-request. A $0 balance returns HTTP 400 (some plans: 402) with
// `invalid_request_error` and a "credit balance is too low" message; we key
// on the credit/billing phrase so a generic 400 (bad params) is NOT flagged.
// Used by the AI-health flag so an out-of-credit outage trips one alert
// instead of silently degrading every AI feature. Never throws.
function isAnthropicBillingError(err) {
  if (!err || typeof err !== 'object') return false;
  var status = err.status || err.statusCode || 0;
  if (status !== 400 && status !== 402) return false;
  var parts = [];
  if (typeof err.message === 'string') parts.push(err.message);
  // The SDK wraps the API body at err.error; the API error object is nested
  // one deeper at err.error.error ({type, message}).
  if (err.error && typeof err.error.message === 'string') parts.push(err.error.message);
  if (err.error && err.error.error && typeof err.error.error.message === 'string') parts.push(err.error.error.message);
  var blob = parts.join(' ').toLowerCase();
  return /credit balance|too low to access|insufficient[^.]*(credit|quota)|billing/.test(blob);
}

module.exports = { modelSonnet, modelHaiku, modelVision, isAnthropicBillingError };
