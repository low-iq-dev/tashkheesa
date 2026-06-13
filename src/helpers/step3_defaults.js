// src/helpers/step3_defaults.js
//
// Computes the Step-3 hidden specialty_id / service_id input defaults for the
// new-case wizard. The recommended pick MUST pre-fill the inputs for every tier
// that shows an "accept the recommendation" Continue button — locked, auto, AND
// recommend — not just locked. Gating the pre-fill to `locked` (the original
// bug) left the auto/recommend Continue button permanently disabled (empty
// inputs), so the accept-the-recommendation happy path could never advance.
// Manual / no-recommendation tiers fall back to the patient's existing draft
// selection (the grid flow). The override flow clears these client-side.
'use strict';

var ACCEPT_TIERS = ['locked', 'auto', 'recommend'];

function step3Defaults(tier, recSpecialtyId, recServiceId, selectedSpecialty, selectedService) {
  var acceptTier = ACCEPT_TIERS.indexOf(tier) !== -1;
  return {
    specialty: (acceptTier && recSpecialtyId) ? String(recSpecialtyId) : (selectedSpecialty || ''),
    service:   (acceptTier && recServiceId)   ? String(recServiceId)   : (selectedService   || '')
  };
}

module.exports = { step3Defaults: step3Defaults, ACCEPT_TIERS: ACCEPT_TIERS };
