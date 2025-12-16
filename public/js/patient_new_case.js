document.addEventListener('DOMContentLoaded', () => {
  const specialtySelect = document.getElementById('specialtySelect');
  const serviceSelect = document.getElementById('serviceSelect');

  function filterServices() {
    const selectedSpec = specialtySelect.value;
    let firstVisible = null;
    Array.from(serviceSelect.options).forEach((opt) => {
      if (!opt.value) return;
      const spec = opt.getAttribute('data-specialty');
      const visible = !selectedSpec || spec === selectedSpec;
      opt.style.display = visible ? 'block' : 'none';
      if (visible && !firstVisible) firstVisible = opt;
    });
    if (firstVisible) {
      serviceSelect.value = firstVisible.value;
    } else {
      serviceSelect.value = '';
    }
  }

  if (specialtySelect && serviceSelect) {
    specialtySelect.addEventListener('change', filterServices);
    filterServices();
  }
});
