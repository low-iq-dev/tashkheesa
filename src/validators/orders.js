/**
 * Order validation utilities
 */

function validateOrderCreation(data) {
  const errors = [];

  if (!data.sla_hours) {
    errors.push('SLA hours is required');
  } else if (typeof data.sla_hours !== 'number') {
    errors.push('SLA hours must be a number');
  } else if (data.sla_hours < 1 || data.sla_hours > 720) {
    errors.push('SLA hours must be between 1 and 720');
  }

  if (data.price === undefined || data.price === null) {
    errors.push('Price is required');
  } else if (typeof data.price !== 'number') {
    errors.push('Price must be a number');
  } else if (data.price < 0) {
    errors.push('Price cannot be negative');
  }

  if (data.doctor_fee !== undefined && data.doctor_fee !== null) {
    if (typeof data.doctor_fee !== 'number') {
      errors.push('Doctor fee must be a number');
    } else if (data.doctor_fee < 0) {
      errors.push('Doctor fee cannot be negative');
    }
  }

  if (!data.service_id) {
    errors.push('Service ID is required');
  }

  if (!data.patient_id) {
    errors.push('Patient ID is required');
  }

  return errors.length > 0 ? errors : null;
}

module.exports = { validateOrderCreation };
