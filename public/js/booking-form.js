document.getElementById('bookingForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const formData = new FormData(e.target);
  const data = {}; formData.forEach((v, k) => data[k] = v);

  try {
    const res = await fetch('/portal/appointments/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    const result = await res.json();
    if (result.ok) {
      window.location.href = '/portal/appointments/' + result.appointment_id;
    } else {
      alert(result.error || 'Booking failed');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
});
