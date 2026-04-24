'use strict';

// Central registry of add-on services. Maps addon_services.id → instance.
// Add new addons by:
//   1. Migration: insert a row into addon_services.
//   2. Code: add a new subclass of AddonService in this folder.
//   3. Here: import + register under the id key.

const VideoConsultAddon = require('./video_consult');
const PrescriptionAddon = require('./prescription');

const instances = {
  [VideoConsultAddon.id]: new VideoConsultAddon(),
  [PrescriptionAddon.id]: new PrescriptionAddon()
};

/**
 * Look up the AddonService instance for a given addon_services.id.
 * @param {string} id
 * @returns {import('./base')|null}
 */
function getAddon(id) {
  return instances[id] || null;
}

/**
 * All registered addon instances (stable order).
 * @returns {Array<import('./base')>}
 */
function all() {
  return Object.values(instances);
}

/**
 * Feature-flag gate. Every code path that touches the new system first
 * calls isEnabled(); returns false by default (Phase 2 dormant).
 * Phase 3 flips ADDON_SYSTEM_V2 to true in Render env.
 * @returns {boolean}
 */
function isEnabled() {
  return String(process.env.ADDON_SYSTEM_V2 || '').toLowerCase() === 'true';
}

/**
 * Emit a one-line JSON structured-log event for V2 dual-write operations.
 * Successes go to stdout, failures to stderr, so Render logs separate
 * them naturally. Self-insulated — any error inside the logger itself
 * is swallowed so it can never break the caller.
 * @param {'addon_v2_write_ok'|'addon_v2_write_failed'} event
 * @param {object} payload
 */
function logV2Event(event, payload) {
  try {
    const line = JSON.stringify(Object.assign(
      { event: event, ts: new Date().toISOString() },
      payload || {}
    ));
    if (event.endsWith('_failed')) console.warn(line);
    else console.log(line);
  } catch (_) { /* never let logging break anything */ }
}

/**
 * Wrap a V2 write: gate on the feature flag, try/catch-log any error,
 * and NEVER rethrow. V1 checkouts must complete regardless of V2 state.
 *
 * @param {string} addonId          addon_services.id the operation targets
 * @param {string} operation        e.g. 'onPurchase' | 'onFulfill' | 'onComplete'
 * @param {string|null} orderId     order the write is for (for log correlation)
 * @param {() => Promise<any>} fn   the actual V2 write
 * @returns {Promise<any|undefined>}
 */
async function safeDualWrite(addonId, operation, orderId, fn) {
  if (!isEnabled()) return undefined;
  try {
    const result = await fn();
    logV2Event('addon_v2_write_ok', {
      addon:     addonId,
      operation: operation,
      order_id:  orderId || null
    });
    return result;
  } catch (err) {
    logV2Event('addon_v2_write_failed', {
      addon:     addonId,
      operation: operation,
      order_id:  orderId || null,
      err:       (err && err.message) ? err.message : String(err)
    });
    return undefined;
  }
}

module.exports = { getAddon, all, isEnabled, logV2Event, safeDualWrite };
