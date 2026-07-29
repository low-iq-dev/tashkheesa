document.addEventListener('DOMContentLoaded', function() {
  // The pay page carries the add-on price data-attributes on `.p-pay-cols`
  // (patient_payment_required.ejs). The legacy `.portal-grid` selector matched
  // nothing there, so add-on prices read as 0 and the displayed total never
  // moved when a box was ticked — while the server now charges base + add-ons.
  // Match `.p-pay-cols` so the DISPLAYED total equals what is CHARGED.
  var portalGrid = document.querySelector('.p-pay-cols') || document.querySelector('.portal-grid');
  var videoPrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-video-price') || '0') : 0;
  var slaPrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-sla-price') || '0') : 0;
  var prescriptionPrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-prescription-price') || '0') : 0;
  var basePrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-base-price') || '0') : 0;
  var currency = portalGrid ? (portalGrid.getAttribute('data-currency') || 'SAR') : 'SAR';
  var orderId = portalGrid ? (portalGrid.getAttribute('data-order-id') || '') : '';

  // Always-charge-EGP: for an international order the prices above are LOCAL (for
  // display); the card is charged in EGP. These parallel EGP figures keep the
  // "billed in EGP (≈ X)" disclosure reactive as add-ons toggle. For a domestic
  // order data-intl='0' and there is no #egp-charge-amount element → inert.
  var baseEgp = portalGrid ? parseFloat(portalGrid.getAttribute('data-base-price-egp') || '0') : 0;
  var videoEgp = portalGrid ? parseFloat(portalGrid.getAttribute('data-video-price-egp') || '0') : 0;
  var slaEgp = portalGrid ? parseFloat(portalGrid.getAttribute('data-sla-price-egp') || '0') : 0;
  var prescriptionEgp = portalGrid ? parseFloat(portalGrid.getAttribute('data-prescription-price-egp') || '0') : 0;
  var egpChargeAmountEl = document.getElementById('egp-charge-amount');
  // Intl orders show LOCAL prices but are charged EGP; the referral discount comes
  // back from the server (referrals.js) in EGP, computed off the EGP charge.
  var isIntl = portalGrid ? (portalGrid.getAttribute('data-intl') === '1') : false;

  var videoCheckbox = document.getElementById('addon_video_consultation');
  var slaCheckbox = document.getElementById('addon_sla_24hr');
  var prescriptionCheckbox = document.getElementById('addon_prescription');
  var totalPrice = document.getElementById('total-price');
  var addonVideoHidden = document.getElementById('addon_video_hidden');
  var addonSlaHidden = document.getElementById('addon_sla_hidden');
  var addonPrescriptionHidden = document.getElementById('addon_prescription_hidden');

  // Breakdown rows
  var addonVideoRow = document.getElementById('addon-video-row');
  var addonSlaRow = document.getElementById('addon-sla-row');
  var addonPrescriptionRow = document.getElementById('addon-prescription-row');
  var referralDiscountRow = document.getElementById('referral-discount-row');
  var referralDiscountValue = document.getElementById('referral-discount-value');

  var referralDiscount = 0;

  function updatePrice() {
    var total = basePrice;
    var egpTotal = baseEgp;   // parallel EGP charge total (base + selected add-ons)

    if (videoCheckbox && videoCheckbox.checked) {
      total += videoPrice;
      egpTotal += videoEgp;
      if (addonVideoHidden) addonVideoHidden.value = '1';
      if (addonVideoRow) addonVideoRow.style.display = '';
    } else {
      if (addonVideoHidden) addonVideoHidden.value = '0';
      if (addonVideoRow) addonVideoRow.style.display = 'none';
    }

    if (slaCheckbox && slaCheckbox.checked) {
      total += slaPrice;
      egpTotal += slaEgp;
      if (addonSlaHidden) addonSlaHidden.value = '1';
      if (addonSlaRow) addonSlaRow.style.display = '';
    } else {
      if (addonSlaHidden) addonSlaHidden.value = '0';
      if (addonSlaRow) addonSlaRow.style.display = 'none';
    }

    if (prescriptionCheckbox && prescriptionCheckbox.checked) {
      total += prescriptionPrice;
      egpTotal += prescriptionEgp;
      if (addonPrescriptionHidden) addonPrescriptionHidden.value = '1';
      if (addonPrescriptionRow) addonPrescriptionRow.style.display = '';
    } else {
      if (addonPrescriptionHidden) addonPrescriptionHidden.value = '0';
      if (addonPrescriptionRow) addonPrescriptionRow.style.display = 'none';
    }

    // Apply referral discount (base fee only, per referrals.js). The server returns
    // discount_amount in EGP (it discounts the EGP charge), so reduce the EGP
    // disclosure by it directly, and reduce the LOCAL total by the EGP→local
    // equivalent (base ratio). Domestic: EGP === local, so no conversion. Without
    // this, the ≈ EGP figure ignored the discount (overstating the charge) and the
    // local total wrongly subtracted EGP units.
    if (referralDiscount > 0) {
      egpTotal = Math.max(0, egpTotal - referralDiscount);
      var localDiscount = (isIntl && baseEgp > 0) ? (referralDiscount * (basePrice / baseEgp)) : referralDiscount;
      total = Math.max(0, total - localDiscount);
      if (referralDiscountRow) referralDiscountRow.style.display = '';
      if (referralDiscountValue) referralDiscountValue.textContent = '-' + Math.round(localDiscount) + ' ' + currency;
    } else {
      if (referralDiscountRow) referralDiscountRow.style.display = 'none';
    }

    if (totalPrice) {
      totalPrice.innerHTML = '<strong>' + Math.round(total) + ' ' + currency + '</strong>';
    }
    // Keep the "billed in EGP (≈ X)" disclosure in sync (intl orders only).
    if (egpChargeAmountEl) {
      egpChargeAmountEl.textContent = Math.round(egpTotal).toLocaleString('en-GB');
    }
  }

  if (videoCheckbox) videoCheckbox.addEventListener('change', updatePrice);
  if (slaCheckbox) slaCheckbox.addEventListener('change', updatePrice);
  if (prescriptionCheckbox) prescriptionCheckbox.addEventListener('change', updatePrice);

  // Referral code handling
  var refInput = document.getElementById('referral_code_input');
  var refBtn = document.getElementById('referral_apply_btn');
  var refResult = document.getElementById('referral_result');

  if (refBtn && refInput && orderId) {
    refBtn.addEventListener('click', function() {
      var code = (refInput.value || '').trim().toUpperCase();
      if (!code) return;
      refBtn.disabled = true;
      refBtn.textContent = '...';

      var csrfMeta = document.querySelector('meta[name="csrf-token"]');
      var csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : '';

      fetch('/api/referral/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        credentials: 'same-origin',
        body: JSON.stringify({ code: code, order_id: orderId })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (refResult) refResult.style.display = 'block';
        if (data.ok) {
          // The server discounts ONLY the base fee (referrals.js), so the
          // charged total is new_price + add-ons. Keep basePrice at the ORIGINAL
          // base and let updatePrice() subtract the discount exactly once via the
          // discount row → displayed total === charged total. Do NOT also set
          // basePrice = new_price: new_price already has the discount baked in,
          // so combined with the row subtraction it would deduct the discount
          // twice and show LESS than Paymob actually charges.
          referralDiscount = data.discount_amount || 0;
          if (refResult) {
            refResult.style.color = '#065f46';
            refResult.textContent = (data.reward_type === 'discount' ? data.reward_value + '% ' : '') + 'discount applied!';
          }
          refInput.readOnly = true;
          refBtn.style.display = 'none';
          updatePrice();
        } else {
          if (refResult) {
            refResult.style.color = '#991b1b';
            refResult.textContent = data.error || 'Invalid code';
          }
        }
        refBtn.disabled = false;
        refBtn.textContent = 'Apply';
      })
      .catch(function() {
        if (refResult) {
          refResult.style.display = 'block';
          refResult.style.color = '#991b1b';
          refResult.textContent = 'Network error';
        }
        refBtn.disabled = false;
        refBtn.textContent = 'Apply';
      });
    });
  }

  updatePrice();
});
