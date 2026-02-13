// src/validators/orders.js
// Order validation utilities

const { sanitizeHtml, sanitizeString, sanitizePhone, isValidEmail } = require('./sanitize');
const { db } = require('../db');

const ALLOWED_FILE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.pdf', '.dcm', '.doc', '.docx']);
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB per file
const MAX_TOTAL_FILES = 20;

/**
 * Validate order creation data (internal/admin use).
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

/**
 * Validate patient-facing intake form data.
 * Returns { valid: boolean, errors: string[], sanitized: object }
 */
function validateIntakeForm(data, lang) {
  var isAr = lang === 'ar';
  var errors = [];
  var sanitized = {};

  // specialty_id — required, must exist in DB
  var specialtyId = sanitizeString(data.specialty_id, 100);
  if (!specialtyId) {
    errors.push(isAr ? 'التخصص مطلوب' : 'Specialty is required');
  } else {
    try {
      var spec = db.prepare('SELECT id FROM specialties WHERE id = ?').get(specialtyId);
      if (!spec) errors.push(isAr ? 'التخصص غير صالح' : 'Invalid specialty');
    } catch (e) {
      // DB error — let it pass and handle downstream
    }
  }
  sanitized.specialty_id = specialtyId;

  // service_id — required, must exist in DB
  var serviceId = sanitizeString(data.service_id, 100);
  if (!serviceId) {
    errors.push(isAr ? 'الخدمة مطلوبة' : 'Service is required');
  } else {
    try {
      var svc = db.prepare('SELECT id FROM services WHERE id = ?').get(serviceId);
      if (!svc) errors.push(isAr ? 'الخدمة غير صالحة' : 'Invalid service');
    } catch (e) {
      // DB error
    }
  }
  sanitized.service_id = serviceId;

  // reason_for_review — required, 10-5000 chars
  var reason = sanitizeHtml(sanitizeString(data.reason || data.reason_for_review, 5000));
  if (!reason || reason.length < 10) {
    errors.push(isAr ? 'سبب المراجعة مطلوب (10 أحرف على الأقل)' : 'Reason for review is required (at least 10 characters)');
  }
  sanitized.reason_for_review = reason;

  // language — must be 'en' or 'ar'
  var language = sanitizeString(data.language, 5);
  if (language !== 'en' && language !== 'ar') language = 'en';
  sanitized.language = language;

  // urgency_flag — must be 0 or 1
  var urgencyFlag = data.urgency === 'priority' || data.urgency_flag === 1 || data.urgency_flag === '1' ? 1 : 0;
  sanitized.urgency_flag = urgencyFlag;

  // medical_history — optional, max 10000 chars
  if (data.medical_history) {
    sanitized.medical_history = sanitizeHtml(sanitizeString(data.medical_history, 10000));
  }

  // current_medications — optional, max 5000 chars
  if (data.current_medications) {
    sanitized.current_medications = sanitizeHtml(sanitizeString(data.current_medications, 5000));
  }

  // patient_name — required
  var patientName = sanitizeString(data.patient_name, 200);
  if (!patientName) {
    errors.push(isAr ? 'اسم المريض مطلوب' : 'Patient name is required');
  }
  sanitized.patient_name = patientName;

  // patient_email — required, valid format
  var patientEmail = sanitizeString(data.patient_email, 320);
  if (!patientEmail) {
    errors.push(isAr ? 'البريد الإلكتروني مطلوب' : 'Email is required');
  } else if (!isValidEmail(patientEmail)) {
    errors.push(isAr ? 'البريد الإلكتروني غير صالح' : 'Invalid email format');
  }
  sanitized.patient_email = patientEmail;

  // patient_phone — required
  var patientPhone = sanitizePhone(data.patient_phone);
  if (!patientPhone) {
    errors.push(isAr ? 'رقم الهاتف مطلوب' : 'Phone number is required');
  }
  sanitized.patient_phone = patientPhone;

  return { valid: errors.length === 0, errors: errors, sanitized: sanitized };
}

/**
 * Validate uploaded files.
 * Returns { valid: boolean, errors: string[] }
 */
function validateFiles(files, existingFileCount, lang) {
  var isAr = lang === 'ar';
  var errors = [];

  if (!files || !Array.isArray(files)) return { valid: true, errors: [] };

  var totalFiles = (existingFileCount || 0) + files.length;
  if (totalFiles > MAX_TOTAL_FILES) {
    errors.push(isAr ? ('الحد الأقصى ' + MAX_TOTAL_FILES + ' ملف') : ('Maximum ' + MAX_TOTAL_FILES + ' files allowed'));
  }

  var dangerousExtensions = new Set(['.exe', '.bat', '.cmd', '.sh', '.ps1', '.vbs', '.js', '.msi', '.com', '.scr', '.pif']);

  files.forEach(function(file) {
    var name = String(file.originalname || file.filename || '').toLowerCase();
    var ext = name.lastIndexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')) : '';

    if (dangerousExtensions.has(ext)) {
      errors.push(isAr ? ('نوع الملف غير مسموح: ' + name) : ('File type not allowed: ' + name));
    }

    if (file.size && file.size > MAX_FILE_SIZE) {
      var sizeMB = Math.round(file.size / (1024 * 1024));
      errors.push(isAr ? ('الملف كبير جدا: ' + name + ' (' + sizeMB + 'MB)') : ('File too large: ' + name + ' (' + sizeMB + 'MB, max 50MB)'));
    }
  });

  return { valid: errors.length === 0, errors: errors };
}

module.exports = { validateOrderCreation, validateIntakeForm, validateFiles };
