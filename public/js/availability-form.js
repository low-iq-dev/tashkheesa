document.getElementById('availabilityForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const availability = [];
  const formData = new FormData(e.target);
  
  for (let day = 0; day < 7; day++) {
    const startTime = formData.get(`start_${day}`);
    const endTime = formData.get(`end_${day}`);
    
    if (startTime && endTime) {
      availability.push({
        day_of_week: day,
        start_time: startTime,
        end_time: endTime
      });
    }
  }

  const timezone = formData.get('timezone');

  try {
    const res = await fetch('/portal/appointments/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        availability_data: availability,
        timezone
      })
    });

    const result = await res.json();
    if (result.ok) {
      alert('Availability saved!');
      location.reload();
    } else {
      alert(result.error || 'Failed to save');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
});
