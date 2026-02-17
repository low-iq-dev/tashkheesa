document.addEventListener('DOMContentLoaded', function() {
  var portalGrid = document.querySelector('.portal-grid');
  var videoPrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-video-price') || '0') : 0;
  var slaPrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-sla-price') || '0') : 0;
  var prescriptionPrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-prescription-price') || '0') : 0;
  var basePrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-base-price') || '0') : 0;
  var currency = portalGrid ? (portalGrid.getAttribute('data-currency') || 'SAR') : 'SAR';

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

  if (!videoCheckbox && !slaCheckbox && !prescriptionCheckbox) return;

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

    if (totalPrice) {
      totalPrice.innerHTML = '<strong>' + total + ' ' + currency + '</strong>';
    }
  }

  if (videoCheckbox) videoCheckbox.addEventListener('change', updatePrice);
  if (slaCheckbox) slaCheckbox.addEventListener('change', updatePrice);
  if (prescriptionCheckbox) prescriptionCheckbox.addEventListener('change', updatePrice);
  updatePrice();
});
