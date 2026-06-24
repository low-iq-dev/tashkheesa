/* Public /apply form — progressive enhancement.
 *
 * Without JS the form fully works: specialty_other shows for all (server
 * required-if-"other"), and sub-specialties are entered as comma/newline text in
 * the `sub_specialties_text` textarea. This script enhances both:
 *   1) shows/hides the "Other specialty" field based on the specialty select;
 *   2) turns the sub-specialties textarea into a chip input with per-specialty
 *      suggestions, submitting `sub_specialties[]` hidden inputs and disabling
 *      the textarea so the server sees exactly the chips.
 *
 * The server merges `sub_specialties[]` and `sub_specialties_text`, so even if
 * this script half-runs nothing is lost.
 */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  ready(function () {
    var form = document.querySelector('.apply-form');
    if (!form) return;

    // ── 1) Other-specialty toggle ──────────────────────────────────────────
    var specSelect = form.querySelector('#specialty_id');
    var otherGroup = form.querySelector('#specialty_other_group');
    var otherInput = form.querySelector('#specialty_other');
    function syncOther() {
      if (!specSelect || !otherGroup) return;
      var isOther = specSelect.value === 'other';
      otherGroup.hidden = !isOther;
      if (otherInput) otherInput.required = isOther;
    }
    if (specSelect) {
      specSelect.addEventListener('change', function () { syncOther(); refreshSuggestions(); });
      syncOther();
    }

    // ── 2) Sub-specialty chip input ────────────────────────────────────────
    var taxoEl = document.getElementById('apply-taxonomy');
    var taxonomy = [];
    try { taxonomy = JSON.parse((taxoEl && taxoEl.textContent) || '[]'); } catch (e) { taxonomy = []; }

    var tagsBox = document.getElementById('subspec-tags');
    var textarea = document.getElementById('sub_specialties_text');
    if (!tagsBox || !textarea) return;

    // Localized aria-labels for JS-injected controls (EN fallback). The taxonomy
    // sub_specialties themselves are English-only (canonical data, suggestions
    // only) — bilingual suggestion labels are a known slice-1 gap.
    var addLabel = tagsBox.getAttribute('data-add-label') || 'Add a sub-specialty';
    var removeLabel = tagsBox.getAttribute('data-remove-label') || 'Remove';

    // Seed chips from any existing textarea content (e.g. a 400 re-render).
    var chips = [];
    (textarea.value || '').split(/[\n,]/).forEach(function (raw) {
      var v = raw.trim();
      if (v && chips.indexOf(v) === -1) chips.push(v);
    });

    // Build the chip UI.
    var chipsWrap = document.createElement('div');
    chipsWrap.className = 'subspec-chips';

    var entry = document.createElement('input');
    entry.type = 'text';
    entry.className = 'form-input';
    entry.setAttribute('aria-label', addLabel);
    entry.placeholder = textarea.getAttribute('placeholder') || 'Type and press Enter';

    var suggBox = document.createElement('div');
    suggBox.className = 'subspec-suggestions';

    var hiddenWrap = document.createElement('div');

    tagsBox.appendChild(chipsWrap);
    tagsBox.appendChild(entry);
    tagsBox.appendChild(suggBox);
    tagsBox.appendChild(hiddenWrap);
    tagsBox.hidden = false;

    // Disable the textarea fallback so only chips submit (no duplicates server-side).
    textarea.disabled = true;
    textarea.hidden = true;
    textarea.removeAttribute('name');
    // Hide its visible label too (keep DOM for no-JS).
    var taLabel = form.querySelector('label[for="sub_specialties_text"]');
    if (taLabel) taLabel.hidden = true;

    var MAX = 20, MAX_LEN = 100;

    function renderHidden() {
      hiddenWrap.innerHTML = '';
      chips.forEach(function (c) {
        var h = document.createElement('input');
        h.type = 'hidden';
        h.name = 'sub_specialties[]';
        h.value = c;
        hiddenWrap.appendChild(h);
      });
    }

    function renderChips() {
      chipsWrap.innerHTML = '';
      chips.forEach(function (c, idx) {
        var chip = document.createElement('span');
        chip.className = 'subspec-chip';
        var label = document.createElement('span');
        label.textContent = c;
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.setAttribute('aria-label', removeLabel + ' ' + c);
        rm.textContent = '×';
        rm.addEventListener('click', function () {
          chips.splice(idx, 1);
          renderChips(); renderHidden(); refreshSuggestions();
        });
        chip.appendChild(label);
        chip.appendChild(rm);
        chipsWrap.appendChild(chip);
      });
      renderHidden();
    }

    function addChip(value) {
      var v = String(value || '').trim().slice(0, MAX_LEN);
      if (!v) return;
      var exists = chips.some(function (c) { return c.toLowerCase() === v.toLowerCase(); });
      if (exists) return;
      if (chips.length >= MAX) return;
      chips.push(v);
      renderChips(); refreshSuggestions();
    }

    function currentSuggestions() {
      var sel = specSelect ? specSelect.value : '';
      var sp = taxonomy.filter(function (s) { return s.id === sel; })[0];
      var list = (sp && sp.sub_specialties) ? sp.sub_specialties : [];
      return list.filter(function (s) {
        return !chips.some(function (c) { return c.toLowerCase() === String(s).toLowerCase(); });
      });
    }

    function refreshSuggestions() {
      suggBox.innerHTML = '';
      currentSuggestions().forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'subspec-suggestion';
        b.textContent = '+ ' + s;
        b.addEventListener('click', function () { addChip(s); });
        suggBox.appendChild(b);
      });
    }

    entry.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addChip(entry.value);
        entry.value = '';
      } else if (e.key === 'Backspace' && entry.value === '' && chips.length) {
        chips.pop();
        renderChips(); refreshSuggestions();
      }
    });
    // Commit a typed value on blur too.
    entry.addEventListener('blur', function () {
      if (entry.value.trim()) { addChip(entry.value); entry.value = ''; }
    });

    renderChips();
    refreshSuggestions();
  });
})();
