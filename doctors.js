async function loadDoctors() {
  const grid = document.getElementById('doctors-grid');
  const q = document.getElementById('q');
  const list = await fetch('data/doctors.json').then(r => r.json());

  function card(d) {
    return `
      <div class="card">
        <h3>${d.name}</h3>
        <p>${d.dept} • ${d.years} yrs • ${d.location}</p>
        <p style="color:#64748b">Tags: ${(d.tags || []).join(', ')}</p>
      </div>
    `;
  }

  function render(items) {
    grid.innerHTML = items.map(card).join('');
  }

  render(list);

  q.addEventListener('input', () => {
    const term = q.value.toLowerCase();
    const filtered = list.filter(d =>
      [d.name, d.dept, d.location, ...(d.tags || [])]
        .join(' ')
        .toLowerCase()
        .includes(term)
    );
    render(filtered);
  });
}

loadDoctors();