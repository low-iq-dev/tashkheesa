// Temporary file - we'll merge this back

// POST /portal/appointments/availability - Save doctor's availability
router.post('/portal/appointments/availability', requireRole('doctor'), (req, res) => {
  const doctorId = req.user.id;
  const { timezone: tz } = req.body;

  if (!tz || !TIMEZONES.includes(tz)) {
    return res.status(400).json({ ok: false, error: 'Invalid timezone' });
  }

  try {
    // Parse availability from form data (start_0, end_0, start_1, end_1, etc)
    const availability = [];
    for (let day = 0; day < 7; day++) {
      const startKey = `start_${day}`;
      const endKey = `end_${day}`;
      
      if (req.body[startKey] && req.body[endKey]) {
        availability.push({
          day_of_week: day,
          start_time: req.body[startKey],
          end_time: req.body[endKey]
        });
      }
    }

    // Clear existing availability for this doctor
    db.prepare('DELETE FROM doctor_availability WHERE doctor_id = ?').run(doctorId);

    // Save new availability
    const stmt = db.prepare(`
      INSERT INTO doctor_availability 
      (id, doctor_id, day_of_week, start_time, end_time, timezone, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);

    for (const slot of availability) {
      stmt.run(
        randomUUID(),
        doctorId,
        slot.day_of_week,
        slot.start_time,
        slot.end_time,
        tz
      );
    }

    res.json({ ok: true, message: 'Availability updated' });
  } catch (err) {
    console.error('Availability save error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
