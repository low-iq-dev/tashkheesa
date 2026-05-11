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

module.exports = { modelSonnet, modelHaiku, modelVision };
