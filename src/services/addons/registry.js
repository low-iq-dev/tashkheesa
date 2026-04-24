'use strict';

// Central registry of add-on services. Maps addon_services.id → instance.
// Add new addons by:
//   1. Migration: insert a row into addon_services.
//   2. Code: add a new subclass of AddonService in this folder.
//   3. Here: import + register under the id key.

const VideoConsultAddon = require('./video_consult');
const Sla24hrAddon      = require('./sla_24hr');
const PrescriptionAddon = require('./prescription');

const instances = {
  [VideoConsultAddon.id]: new VideoConsultAddon(),
  [Sla24hrAddon.id]:      new Sla24hrAddon(),
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

module.exports = { getAddon, all, isEnabled };
