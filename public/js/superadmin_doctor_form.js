(function () {
  "use strict";

  // Hard debug flags (so we can prove whether JS is running + why it exits)
  window.__subSpecialtiesInitOk = false;
  window.__subSpecialtiesInitError = null;

  function qs(sel) {
    return document.querySelector(sel);
  }

  function safeParseJson(text, fallback) {
    try {
      const v = JSON.parse(text);
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function init() {
    try {
      // Specialty select
      const specialtySelect =
        document.getElementById("specialtySelect") ||
        qs('select[name="specialty_id"]');

      // Multi-select UI
      const subsDetails = document.getElementById("subSpecialties"); // <details>
      const subsSummary = document.getElementById("subSpecialtiesSummary"); // <summary> text span
      const subsEmpty = document.getElementById("subSpecialtiesEmpty"); // empty-state div
      const subsCsv = document.getElementById("subSpecialtiesCsv"); // hidden input: service_ids_csv
      const subsCsvLegacy = document.getElementById("subSpecialtiesCsvLegacy"); // hidden input legacy
      const listEl = document.getElementById("subSpecialtiesList"); // checkbox container

      // JSON sources
      const optionsJsonEl = document.getElementById("subSpecialtyOptionsJson");
      const selectedJsonEl = document.getElementById("subSpecialtySelectedJson");

      // If anything is missing, expose EXACTLY what’s missing and stop.
      const missing = {
        specialtySelect: !!specialtySelect,
        subSpecialties: !!subsDetails,
        subSpecialtiesSummary: !!subsSummary,
        subSpecialtiesList: !!listEl,
        subSpecialtyOptionsJson: !!optionsJsonEl,
        subSpecialtySelectedJson: !!selectedJsonEl,
      };

      const hardMissing = Object.entries(missing).filter(([, ok]) => !ok);
      if (hardMissing.length) {
        window.__subSpecialtiesInitError = {
          reason: "missing_dom_nodes",
          missing,
        };
        return;
      }

      // NOTE: the JSON is rendered in hidden <textarea> nodes. Depending on how EJS renders,
      // the payload may live in `.value` (most common) or `.textContent`.
      const optionsText = (
        (optionsJsonEl.value || optionsJsonEl.textContent || "").trim() || "[]"
      );
      const selectedText = (
        (selectedJsonEl.value || selectedJsonEl.textContent || "").trim() || "[]"
      );

      // Expected shape: [{ id, name, parentId }]
      const rawOptions = safeParseJson(optionsText, []);
      const rawSelected = safeParseJson(selectedText, []);

      const allOptions = Array.isArray(rawOptions)
        ? rawOptions
            .map((o) => {
              const id = String(o && o.id != null ? o.id : "").trim();
              const name = String(o && o.name != null ? o.name : "").trim();

              // We store sub-specialties as rows in `services`. Different callers may serialize
              // the specialty linkage with different key names. Normalize to `parentId`.
              const parentId = String(
                (o && (o.parentId ?? o.specialty_id ?? o.specialtyId ?? o.specialty ?? o.parent_id ?? o.parentSpecialtyId ?? o.parent_specialty_id)) ??
                  ""
              ).trim();

              return { id, name, parentId };
            })
            .filter((o) => o.id && o.name && o.parentId)
        : [];

      // Debug visibility in DevTools (safe in prod; just data on window)
      window.__subSpecialtiesAllOptionsCount = allOptions.length;

      const initialSelected = Array.isArray(rawSelected)
        ? rawSelected.map((x) => String(x).trim()).filter(Boolean)
        : [];

      const selectedSet = new Set(initialSelected);

      function getSelectedSpecialtyId() {
        return String(specialtySelect.value || "").trim();
      }

      function setEmptyVisible(show) {
        if (!subsEmpty) return;
        subsEmpty.style.display = show ? "block" : "none";
      }

      function syncCsvAndSummary() {
        const selected = Array.from(selectedSet);
        const csv = selected.join(",");

        if (subsCsv) subsCsv.value = csv;
        if (subsCsvLegacy) subsCsvLegacy.value = csv;

        const count = selected.length;
        const placeholder =
          (subsDetails.dataset && subsDetails.dataset.placeholder) || "Select sub-specialties";
        const countLabel =
          (subsDetails.dataset && subsDetails.dataset.countLabel) || "Sub-specialties";

        subsSummary.textContent = count ? `${countLabel} (${count} selected)` : placeholder;
      }

      function clearList() {
        listEl.innerHTML = "";
      }

      function renderForSpecialty(spId) {
        clearList();

        if (!spId) {
          selectedSet.clear();
          setEmptyVisible(true);
          syncCsvAndSummary();
          return;
        }

        const options = allOptions.filter((o) => String(o.parentId).trim() === String(spId).trim());
        setEmptyVisible(options.length === 0);

        // Remove any selected items that do not belong to this specialty
        const allowed = new Set(options.map((o) => o.id));
        for (const id of Array.from(selectedSet)) {
          if (!allowed.has(id)) selectedSet.delete(id);
        }

        // Render checkboxes
        options.forEach((o) => {
          const label = document.createElement("label");
          label.className = "multi-select-item";
          label.setAttribute("data-parent-id", o.parentId);

          const input = document.createElement("input");
          input.type = "checkbox";
          input.value = o.id;
          input.checked = selectedSet.has(o.id);

          input.addEventListener("change", () => {
            if (input.checked) selectedSet.add(o.id);
            else selectedSet.delete(o.id);
            syncCsvAndSummary();
          });

          const span = document.createElement("span");
          span.textContent = o.name;

          label.appendChild(input);
          label.appendChild(span);
          listEl.appendChild(label);
        });

        syncCsvAndSummary();
      }

      // Close dropdown when clicking outside
      document.addEventListener("click", (e) => {
        if (!subsDetails.hasAttribute("open")) return;
        if (subsDetails.contains(e.target)) return;
        subsDetails.removeAttribute("open");
      });

      function onSpecialtyChange() {
        renderForSpecialty(getSelectedSpecialtyId());
      }

      specialtySelect.addEventListener("change", onSpecialtyChange);
      specialtySelect.addEventListener("input", onSpecialtyChange);

      subsDetails.addEventListener("toggle", () => {
        if (!subsDetails.hasAttribute("open")) return;
        renderForSpecialty(getSelectedSpecialtyId());
      });

      renderForSpecialty(getSelectedSpecialtyId());
      syncCsvAndSummary();

      // Success flag
      window.__subSpecialtiesInitOk = true;
      window.__subSpecialtiesInitError = null;
    } catch (err) {
      window.__subSpecialtiesInitError = {
        reason: "exception",
        message: String(err && err.message ? err.message : err),
      };
    }
  }

  // DOM-safe: run after HTML exists
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();