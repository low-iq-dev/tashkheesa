document.addEventListener('DOMContentLoaded', function() {
  var portalGrid = document.querySelector('.portal-grid');
  var videoPrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-video-price') || '0') : 0;
  var slaPrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-sla-price') || '0') : 0;
  var basePrice = portalGrid ? parseFloat(portalGrid.getAttribute('data-base-price') || '0') : 0;
  var currency = portalGrid ? (portalGrid.getAttribute('data-currency') || 'SAR') : 'SAR';

  var videoCheckbox = document.getElementById('addon_video_consultation');
  var slaCheckbox = document.getElementById('addon_sla_24hr');
  var addonCostRow = document.getElementById('addon-cost-row');
  var addonCostValue = document.getElementById('addon-cost-value');
  var totalPrice = document.getElementById('total-price');
  var addonVideoHidden = document.getElementById('addon_video_hidden');
  var addonSlaHidden = document.getElementById('addon_sla_hidden');

  if (!videoCheckbox && !slaCheckbox) return;

  function updatePrice() {
    var total = basePrice;
    var addonCost = 0;

    if (videoCheckbox && videoCheckbox.checked) {
      addonCost += videoPrice;
      if (addonVideoHidden) addonVideoHidden.value = '1';
    } else {
      if (addonVideoHidden) addonVideoHidden.value = '0';
    }

    if (slaCheckbox && slaCheckbox.checked) {
      addonCost += slaPrice;
      if (addonSlaHidden) addonSlaHidden.value = '1';
    } else {
      if (addonSlaHidden) addonSlaHidden.value = '0';
    }

    total += addonCost;

    if (addonCostRow && addonCostValue && addonCost > 0) {
      addonCostRow.style.display = 'flex';
      addonCostValue.innerHTML = '<strong>' + addonCost + ' EGP</strong>';
    } else if (addonCostRow) {
      addonCostRow.style.display = 'none';
    }

    if (totalPrice) {
      totalPrice.innerHTML = '<strong>' + total + ' ' + currency + '</strong>';
    }
  }

  if (videoCheckbox) videoCheckbox.addEventListener('change', updatePrice);
  if (slaCheckbox) slaCheckbox.addEventListener('change', updatePrice);
  updatePrice();
});
