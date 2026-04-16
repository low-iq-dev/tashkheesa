async function loadDoctors() {
  const grid = document.getElementById('doctors-grid');
  const q = document.getElementById('q');

  let list = [];
  try {
    list = await fetch('data/doctors.json').then(r => r.json());
  } catch (e) {
    grid.innerHTML = '<p style="color:#718096">Could not load doctor profiles.</p>';
    return;
  }

  function card(d) {
    return `
      <article class="doctor-card">
        <div class="doctor-meta">
          <h3>${d.name}</h3>
          <p class="doctor-specialty">${d.specialty}</p>
          <p class="doctor-sub">${d.sub}</p>
        </div>
        <ul class="doctor-tags">
          ${(d.tags || []).map(t => `<li>${t}</li>`).join('')}
        </ul>
      </article>
    `;
  }

  function render(items) {
    grid.innerHTML = items.length
      ? items.map(card).join('')
      : '<p style="color:#718096;padding:20px 0">No matching doctors found.</p>';
  }

  render(list);

  q.addEventListener('input', () => {
    const term = q.value.toLowerCase().trim();
    if (!term) { render(list); return; }
    render(list.filter(d =>
      [d.name, d.specialty, d.sub, ...(d.tags || [])].join(' ').toLowerCase().includes(term)
    ));
  });
}

loadDoctors();
