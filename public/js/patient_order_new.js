// public/js/patient_order_new.js
// Purpose: keep "Service" dropdown strictly scoped to selected Specialty (no mismatches),
// without relying on a page refresh.

(function () {
  function $(sel) { return document.querySelector(sel); }

  function normalizeId(v) {
    return String(v == null ? "" : v).trim();
  }

  document.addEventListener("DOMContentLoaded", function () {
    const specialtySelect = $('select[name="specialty_id"]');
    const serviceSelect = $('select[name="service_id"]');

    if (!specialtySelect || !serviceSelect) return;

    // Capture initial options (as rendered by server)
    const originalOptions = Array.from(serviceSelect.options).map((opt) => ({
      value: normalizeId(opt.value),
      text: (opt.textContent || "").trim(),
      // IMPORTANT: EJS must render data-specialty-id on each service option
      specialtyId: normalizeId(opt.getAttribute("data-specialty-id")),
      isPlaceholder: normalizeId(opt.value) === "",
      disabled: !!opt.disabled,
      selected: !!opt.selected,
    }));

    // Placeholder + no-services text (fallback-safe)
    const placeholderText =
      (originalOptions.find((o) => o.isPlaceholder && o.text) || {}).text ||
      "Choose service";

    const noServicesText =
      (originalOptions.find((o) => /no services/i.test(String(o.text || ""))) || {}).text ||
      "No services available for this specialty";

    // Filterable options = real value options
    const servicePool = originalOptions.filter((o) => !!o.value);

    // Hard fallback: if server did NOT provide data-specialty-id on options,
    // we cannot safely client-filter. In that case, we force a reload with specialty_id.
    // Client filtering only works if the page includes services across multiple specialties.
    // If the server rendered only the currently-selected specialty's services, we must hard-reload on change.
    const distinctSpecialtyIds = new Set(servicePool.map((o) => normalizeId(o.specialtyId)).filter(Boolean));

    const supportsClientFilter =
      servicePool.length > 0 &&
      servicePool.every((o) => !!normalizeId(o.specialtyId)) &&
      distinctSpecialtyIds.size > 1;

    function setUrlSpecialtyParam(spId) {
      try {
        const url = new URL(window.location.href);
        const sp = normalizeId(spId);
        if (sp) url.searchParams.set("specialty_id", sp);
        else url.searchParams.delete("specialty_id");
        window.history.replaceState({}, "", url.toString());
      } catch (_) {}
    }

    function hardReloadToSpecialty(spId) {
      try {
        const url = new URL(window.location.href);
        const sp = normalizeId(spId);
        if (sp) url.searchParams.set("specialty_id", sp);
        else url.searchParams.delete("specialty_id");
        window.location.href = url.toString();
      } catch (_) {
        // last-resort
        const sp = normalizeId(spId);
        window.location.href = "/patient/orders/new" + (sp ? ("?specialty_id=" + encodeURIComponent(sp)) : "");
      }
    }

    function rebuildServiceOptions(selectedSpecialtyId) {
      const spId = normalizeId(selectedSpecialtyId);

      // Clear all
      serviceSelect.innerHTML = "";

      // Add placeholder
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = placeholderText;
      serviceSelect.appendChild(placeholder);

      // Add matching services
      const matches = servicePool.filter((o) => normalizeId(o.specialtyId) === spId);

      if (!spId || matches.length === 0) {
        const none = document.createElement("option");
        none.value = "";
        none.textContent = noServicesText;
        none.disabled = true;
        serviceSelect.appendChild(none);
        serviceSelect.value = "";
        return;
      }

      matches.forEach((o) => {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.text;
        opt.setAttribute("data-specialty-id", spId);
        serviceSelect.appendChild(opt);
      });

      // Reset selection after specialty change (prevents mismatches)
      serviceSelect.value = "";
    }

    // Initial behavior on load
    if (supportsClientFilter) {
      rebuildServiceOptions(specialtySelect.value);
      setUrlSpecialtyParam(specialtySelect.value);
    } else {
      // Server rendered only one specialty (or missing tags). Keep server-rendered options,
      // but ensure future specialty changes hard-reload to avoid mismatches.
      setUrlSpecialtyParam(specialtySelect.value);
    }

    // Re-filter on specialty change
    specialtySelect.addEventListener("change", function () {
      if (!supportsClientFilter) {
        hardReloadToSpecialty(specialtySelect.value);
        return;
      }

      rebuildServiceOptions(specialtySelect.value);
      setUrlSpecialtyParam(specialtySelect.value);
    });
  });
})();