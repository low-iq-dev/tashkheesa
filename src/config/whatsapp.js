// src/config/whatsapp.js — single source of truth for Meta WhatsApp Cloud API
// version + related per-call env reads.
//
// Theme 9 Sub-issue B (OQ-7): three modules used to hardcode `v22.0`
// (critical-alert.js, notify/whatsapp.js, and a doc-string reference in
// services/whatsapp_otp.js). This module centralizes the version so a Meta
// rotation requires changing one env var, not a code edit.
//
// All resolvers read process.env at call time (not require time). A Render
// env flip takes effect on the next request.
//
//   WHATSAPP_API_VERSION — default 'v22.0'. Check Meta's API versioning page
//   before bumping; outdated calls return 400 with a code 100 (unsupported
//   request).

'use strict';

const DEFAULT_API_VERSION = 'v22.0';

function apiVersion() {
  return (process.env.WHATSAPP_API_VERSION || '').trim() || DEFAULT_API_VERSION;
}

module.exports = { apiVersion };
