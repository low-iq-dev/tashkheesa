document.addEventListener('DOMContentLoaded', function() {
  var portalGrid = document.querySelector('.portal-grid');
  var videoPrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-video-price') || '0') : 0;
  var slaPrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-sla-price') || '0') : 0;
  var prescriptionPrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-prescription-price') || '0') : 0;
  var basePrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-base-price') || '0') : 0;
  var currency = portalGrid ? (portalGrid.getAttribute('data-currency') || 'SAR') : 'SAR';
  var orderId = portalGrid ? (portalGrid.getAttribute('data-order-id') || '') : '';

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

    if (videoCheckbox && videoCheckbox.checked) {
      total += videoPrice;
      if (addonVideoHidden) addonVideoHidden.value = '1';
      if (addonVideoRow) addonVideoRow.style.display = '';
    } else {
      if (addonVideoHidden) addonVideoHidden.value = '0';
      if (addonVideoRow) addonVideoRow.style.display = 'none';
    }

    if (slaCheckbox && slaCheckbox.checked) {
      total += slaPrice;
      if (addonSlaHidden) addonSlaHidden.value = '1';
      if (addonSlaRow) addonSlaRow.style.display = '';
    } else {
      if (addonSlaHidden) addonSlaHidden.value = '0';
      if (addonSlaRow) addonSlaRow.style.display = 'none';
    }

    if (prescriptionCheckbox && prescriptionCheckbox.checked) {
      total += prescriptionPrice;
      if (addonPrescriptionHidden) addonPrescriptionHidden.value = '1';
      if (addonPrescriptionRow) addonPrescriptionRow.style.display = '';
    } else {
      if (addonPrescriptionHidden) addonPrescriptionHidden.value = '0';
      if (addonPrescriptionRow) addonPrescriptionRow.style.display = 'none';
    }

    // Apply referral discount
    if (referralDiscount > 0) {
      total = Math.max(0, total - referralDiscount);
      if (referralDiscountRow) referralDiscountRow.style.display = '';
      if (referralDiscountValue) referralDiscountValue.textContent = '-' + referralDiscount + ' ' + currency;
    } else {
      if (referralDiscountRow) referralDiscountRow.style.display = 'none';
    }

    if (totalPrice) {
      totalPrice.innerHTML = '<strong>' + total + ' ' + currency + '</strong>';
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
          referralDiscount = data.discount_amount || 0;
          basePrice = data.new_price;
          if (refResult) {
            refResult.style.color = '#065f46';
            refResult.textContent = (data.reward_type === 'discount' ? data.reward_value + '% ' : '') + 'discount applied!';
          }
          refInput.readOnly = true;
          refBtn.style.display = 'none';
          // Update base price display
          var basePriceEl = document.getElementById('breakdown-base');
          if (basePriceEl) basePriceEl.textContent = data.new_price;
          var basePriceEl2 = document.getElementById('base-price');
          if (basePriceEl2) basePriceEl2.textContent = data.new_price;
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
