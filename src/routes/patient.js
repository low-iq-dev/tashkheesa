// src/routes/patient.js
const express = require('express');
const { requireRole } = require('../middleware');
const { db } = require('../db');
const { queueNotification } = require('../notify');
const { randomUUID } = require('crypto');
const { logOrderEvent } = require('../audit');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');




const router = express.Router();

function sameId(a, b) {
  return String(a) === String(b);
}


// --- schema helpers (keep routes tolerant across DB versions)
const _schemaCache = new Map();
function hasColumn(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (_schemaCache.has(key)) return _schemaCache.get(key);
  try {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const ok = Array.isArray(cols) && cols.some((c) => c && c.name === columnName);
    _schemaCache.set(key, ok);
    return ok;
  } catch (e) {
    _schemaCache.set(key, false);
    return false;
  }
}

function servicesSlaExpr(alias) {
  // tolerate older/newer DB schemas
  // prefer `sla_hours`, but fall back to `sla` if that's what exists
  if (hasColumn('services', 'sla_hours')) return alias ? `${alias}.sla_hours` : 'sla_hours';
  if (hasColumn('services', 'sla')) return alias ? `${alias}.sla` : 'sla';
  return 'NULL';
}

// --- safe schema helpers ---
function _forceSchema(tableName, columnName, value) {
  const key = `${tableName}.${columnName}`;
  _schemaCache.set(key, value);
}

function insertAdditionalFile(orderId, url, labelValue, nowIso) {
  const withLabelSql =
    `INSERT INTO order_additional_files (id, order_id, file_url, label, uploaded_at)
     VALUES (?, ?, ?, ?, ?)`;
  const noLabelSql =
    `INSERT INTO order_additional_files (id, order_id, file_url, uploaded_at)
     VALUES (?, ?, ?, ?)`;

  const runWithLabel = () => {
    db.prepare(withLabelSql).run(randomUUID(), orderId, url, labelValue || null, nowIso);
  };
  const runNoLabel = () => {
    db.prepare(noLabelSql).run(randomUUID(), orderId, url, nowIso);
  };

  const addHasLabel = hasColumn('order_additional_files', 'label');
  if (!addHasLabel) return runNoLabel();

  try {
    return runWithLabel();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // Schema cache can be stale across DB variants; retry safely without label.
    if ((/no such column:/i.test(msg) || /no column named/i.test(msg)) && /label/i.test(msg)) {
      _forceSchema('order_additional_files', 'label', false);
      return runNoLabel();
    }
    throw err;
  }
}

function safeAll(sqlFactory, params = []) {
  // sqlFactory: (slaExpr: string) => string
  try {
    return db.prepare(sqlFactory(servicesSlaExpr())).all(...params);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // If DB schema doesn’t actually have sla_hours, retry after forcing cache false
    if (/no such column:/i.test(msg) && /sla_hours/i.test(msg)) {
      _forceSchema('services', 'sla_hours', false);
      return db.prepare(sqlFactory(servicesSlaExpr())).all(...params);
    }
    throw err;
  }
}

function safeGet(sqlFactory, params = []) {
  // sqlFactory: (slaExpr: string) => string
  try {
    return db.prepare(sqlFactory(servicesSlaExpr())).get(...params);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/no such column:/i.test(msg) && /sla_hours/i.test(msg)) {
      _forceSchema('services', 'sla_hours', false);
      return db.prepare(sqlFactory(servicesSlaExpr())).get(...params);
    }
    throw err;
  }
}

function formatDisplayDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  let hh = d.getHours();
  const min = pad(d.getMinutes());
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${dd}/${mm}/${yyyy} ${hh}:${min} ${ampm}`;
}

// GET /dashboard – patient home with order list (with filters)
router.get('/dashboard', requireRole('patient'), (req, res) => {
  const patientId = req.user.id;
  const { status = '', specialty = '', q = '' } = req.query || {};
  const selectedStatus = status === 'all' ? '' : status;
  const selectedSpecialty = specialty === 'all' ? '' : specialty;
  const searchTerm = q && q.trim() ? q.trim() : '';

  const where = ['o.patient_id = ?'];
  const params = [patientId];

  if (selectedStatus) {
    where.push('o.status = ?');
    params.push(selectedStatus);
  }
  if (selectedSpecialty) {
    where.push('o.specialty_id = ?');
    params.push(selectedSpecialty);
  }
  if (searchTerm) {
    where.push('(sv.name LIKE ? OR o.notes LIKE ? OR o.id LIKE ?)');
    params.push(`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`);
  }

  const orders = db
    .prepare(
      `SELECT o.*,
              s.name AS specialty_name,
              sv.name AS service_name,
              d.name AS doctor_name
       FROM orders o
       LEFT JOIN specialties s ON o.specialty_id = s.id
       LEFT JOIN services sv ON o.service_id = sv.id
       LEFT JOIN users d ON d.id = o.doctor_id
       WHERE ${where.join(' AND ')}
       ORDER BY o.created_at DESC`
    )
    .all(...params);

  const enhancedOrders = orders.map((o) => {
    enforceBreachIfNeeded(o);
    const computed = computeSla(o);
    return { ...o, status: computed.effectiveStatus || o.status, effectiveStatus: computed.effectiveStatus, sla: computed.sla };
  });

  const specialties = db
    .prepare('SELECT id, name FROM specialties ORDER BY name ASC')
    .all();

  res.render('patient_dashboard', {
    user: req.user,
    orders: enhancedOrders || [],
    specialties: specialties || [],
    filters: {
      status: selectedStatus,
      specialty: selectedSpecialty,
      q: searchTerm
    }
  });
});

// New case page (UploadCare)
router.get('/patient/new-case', requireRole('patient'), (req, res) => {
  const qs = req.query && req.query.specialty_id
    ? `?specialty_id=${encodeURIComponent(String(req.query.specialty_id))}`
    : '';
  return res.redirect(`/patient/orders/new${qs}`);
});

// Create new case (UploadCare)
router.post('/patient/new-case', requireRole('patient'), (req, res) => {
  const patientId = req.user.id;
  const { specialty_id, service_id, notes, file_urls, sla_type } = req.body || {};

  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const services = safeAll(
    (slaExpr) =>
      `SELECT id, specialty_id, name, base_price, doctor_fee, currency, payment_link, ${slaExpr} AS sla_hours
       FROM services
       ORDER BY name ASC`
  );

  const service = safeGet(
    (slaExpr) =>
      `SELECT id, specialty_id, name, base_price, doctor_fee, currency, payment_link, ${slaExpr} AS sla_hours
       FROM services
       WHERE id = ?`,
    [service_id]
  );

  const validSpecialty = specialty_id && db.prepare('SELECT 1 FROM specialties WHERE id = ?').get(specialty_id);
  const serviceMatchesSpecialty = service && String(service.specialty_id) === String(specialty_id);

  let fileList = [];
  if (Array.isArray(file_urls)) {
    fileList = file_urls.filter(Boolean);
  } else if (typeof file_urls === 'string' && file_urls.trim()) {
    fileList = file_urls
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
  }

  if (!validSpecialty || !service || !serviceMatchesSpecialty || fileList.length === 0) {
    return res.status(400).render('patient_new_case', {
      user: req.user,
      specialties,
      services,
      error: 'Please choose a valid specialty/service and upload at least one file.',
      form: req.body || {}
    });
  }

  const serviceSla = service && (service.sla_hours != null ? service.sla_hours : (service.sla != null ? service.sla : null));
  const slaHours =
    serviceSla != null
      ? serviceSla
      : sla_type === '24'
        ? 24
        : 72;

  const orderId = randomUUID();
  const nowIso = new Date().toISOString();
  const deadlineAt =
    slaHours != null
      ? new Date(new Date(nowIso).getTime() + Number(slaHours) * 60 * 60 * 1000).toISOString()
      : null;
  const price = service.base_price != null ? service.base_price : 0;
  const doctorFee = service.doctor_fee != null ? service.doctor_fee : 0;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (
        id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
        price, doctor_fee, created_at, accepted_at, deadline_at, completed_at,
        breached_at, reassigned_count, report_url, notes,
        uploads_locked, additional_files_requested, payment_status, payment_method,
        payment_reference, payment_link, updated_at
      ) VALUES (
        @id, @patient_id, NULL, @specialty_id, @service_id, @sla_hours, 'new',
        @price, @doctor_fee, @created_at, NULL, @deadline_at, NULL,
        NULL, 0, NULL, @notes,
        0, 0, 'unpaid', NULL,
        NULL, @payment_link, @created_at
      )`
    ).run({
      id: orderId,
      patient_id: patientId,
      specialty_id,
      service_id,
      sla_hours: slaHours,
      price,
      doctor_fee: doctorFee,
      created_at: nowIso,
      deadline_at: deadlineAt,
      notes: notes || null,
      payment_link: service.payment_link || null
    });

    const insertFile = db.prepare(
      `INSERT INTO order_files (id, order_id, url, label, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    fileList.forEach((url) => {
      insertFile.run(randomUUID(), orderId, url, null, nowIso);
    });

    logOrderEvent({
      orderId,
      label: 'Order created by patient',
      actorUserId: patientId,
      actorRole: 'patient'
    });
  });

  try {
    tx();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[patient new-case] failed', err);
    return res.status(500).render('patient_new_case', {
      user: req.user,
      specialties,
      services,
      error: 'Could not submit case. Please try again.',
      form: req.body || {}
    });
  }

  return res.redirect('/dashboard?submitted=1');
});

// New order form
router.get('/patient/orders/new', requireRole('patient'), (req, res) => {
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const selectedSpecialtyId =
    (req.query && req.query.specialty_id) ||
    (specialties && specialties.length ? specialties[0].id : null);

  let services = [];
  if (selectedSpecialtyId) {
    services = safeAll(
      (slaExpr) =>
        `SELECT sv.id, sv.specialty_id, sv.name, sv.base_price, sv.doctor_fee, sv.currency, sv.payment_link, ${slaExpr} AS sla_hours,
                sp.name AS specialty_name
         FROM services sv
         LEFT JOIN specialties sp ON sp.id = sv.specialty_id
         WHERE sv.specialty_id = ?
         ORDER BY sv.name ASC`,
      [selectedSpecialtyId]
    );
  }

  res.render('patient_order_new', {
    user: req.user,
    specialties,
    services,
    selectedSpecialtyId,
    error: null,
    form: {}
  });
});

// Create order (patient)
router.post('/patient/orders', requireRole('patient'), (req, res) => {
  const patientId = req.user.id;
  const {
    service_id,
    specialty_id,
    sla_option,
    sla,
    sla_type, // legacy support
    notes,
    primary_file_url,
    initial_file_url,
    clinical_question,
    file_url,
    medical_history,
    current_medications
  } = req.body || {};

  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const services = safeAll(
    (slaExpr) =>
      `SELECT sv.id, sv.specialty_id, sv.name, sv.base_price, sv.doctor_fee, sv.currency, sv.payment_link, ${slaExpr} AS sla_hours,
              sp.name AS specialty_name
       FROM services sv
       LEFT JOIN specialties sp ON sp.id = sv.specialty_id
       ORDER BY sp.name ASC, sv.name ASC`
  );

  const service = safeGet(
    (slaExpr) =>
      `SELECT id, specialty_id, name, base_price, doctor_fee, currency, payment_link, ${slaExpr} AS sla_hours
       FROM services
       WHERE id = ?`,
    [service_id]
  );

  const serviceMatchesSpecialty =
    service && specialty_id && String(service.specialty_id) === String(specialty_id);

  if (!service_id || !service || !specialty_id || !serviceMatchesSpecialty) {
    return res.status(400).render('patient_order_new', {
      user: req.user,
      specialties,
      services,
      error: 'Please choose a valid specialty and service.',
      form: req.body || {}
    });
  }

  // Fail-fast: don't create broken orders when uploader isn't configured.
  const uploaderConfigured = String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim().length > 0;

  const primaryUrlRaw = initial_file_url || primary_file_url || file_url;
  const primaryUrl = primaryUrlRaw && primaryUrlRaw.trim ? primaryUrlRaw.trim() : null;

  if (!uploaderConfigured) {
    return res.status(400).render('patient_order_new', {
      user: req.user,
      specialties,
      services,
      error: 'Uploads are not configured yet. Please contact support and try again later.',
      form: req.body || {}
    });
  }

  if (!primaryUrl) {
    return res.status(400).render('patient_order_new', {
      user: req.user,
      specialties,
      services,
      error: 'Please upload at least one file before submitting your order.',
      form: req.body || {}
    });
  }

  // Basic URL validation: accept only http/https URLs (prevents junk strings)
  if (!/^https?:\/\//i.test(primaryUrl)) {
    return res.status(400).render('patient_order_new', {
      user: req.user,
      specialties,
      services,
      error: 'Invalid file URL. Please re-upload your file and try again.',
      form: req.body || {}
    });
  }

  const serviceSla = service && (service.sla_hours != null ? service.sla_hours : (service.sla != null ? service.sla : null));
  const slaHours =
    serviceSla != null
      ? serviceSla
      : sla_option === '24' || sla_type === 'vip' || sla_type === '24' || sla === '24'
        ? 24
        : 72;

  const orderId = randomUUID();
  const nowIso = new Date().toISOString();
  const price = service.base_price != null ? service.base_price : 0;
  const doctorFee = service.doctor_fee != null ? service.doctor_fee : 0;
  const orderNotes = clinical_question || notes || null;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (
        id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
        price, doctor_fee, created_at, accepted_at, deadline_at, completed_at,
        breached_at, reassigned_count, report_url, notes, medical_history, current_medications,
        uploads_locked, additional_files_requested, payment_status, payment_method,
        payment_reference, payment_link, updated_at
      ) VALUES (
        @id, @patient_id, NULL, @specialty_id, @service_id, @sla_hours, 'new',
        @price, @doctor_fee, @created_at, NULL, NULL, NULL,
        NULL, 0, NULL, @notes, @medical_history, @current_medications,
        0, 0, 'unpaid', NULL,
        NULL, @payment_link, @created_at
      )`
    ).run({
      id: orderId,
      patient_id: patientId,
      specialty_id,
      service_id,
      sla_hours: slaHours,
      price,
      doctor_fee: doctorFee,
      created_at: nowIso,
      notes: orderNotes,
      medical_history: medical_history || null,
      current_medications: current_medications || null,
      payment_link: service.payment_link || null
    });

    if (primaryUrl) {
      db.prepare(
        `INSERT INTO order_files (id, order_id, url, label, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), orderId, primaryUrl, 'Initial upload', nowIso);
      logOrderEvent({
        orderId,
        label: 'Initial files uploaded by patient',
        actorUserId: patientId,
        actorRole: 'patient'
      });
    }

    logOrderEvent({
      orderId,
      label: 'Order created by patient',
      actorUserId: patientId,
      actorRole: 'patient'
    });

    const superadmins = db
      .prepare("SELECT id FROM users WHERE role = 'superadmin' AND is_active = 1")
      .all();
    superadmins.forEach((admin) => {
      queueNotification({
        orderId,
        toUserId: admin.id,
        channel: 'internal',
        template: 'order_created_patient',
        status: 'queued'
      });
    });
  });

  try {
    tx();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[patient order create] failed', err);
    return res.status(500).render('patient_order_new', {
      user: req.user,
      specialties,
      services,
      error: 'Could not create order. Please try again.',
      form: req.body || {}
    });
  }

  return res.redirect(`/patient/orders/${orderId}`);
});

// Order detail
router.get('/patient/orders/:id', requireRole('patient'), (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const uploadClosed = req.query && req.query.upload_closed === '1';

  const order = db
    .prepare(
      `SELECT o.*,
              s.name AS specialty_name,
              sv.name AS service_name,
              sv.payment_link AS service_payment_link,
              sv.base_price AS service_price,
              sv.currency AS service_currency,
              sv.doctor_fee AS service_doctor_fee,
              d.name AS doctor_name
       FROM orders o
       LEFT JOIN specialties s ON o.specialty_id = s.id
       LEFT JOIN services sv ON o.service_id = sv.id
       LEFT JOIN users d ON d.id = o.doctor_id
       WHERE o.id = ? AND o.patient_id = ?`
    )
    .get(orderId, patientId);

  if (!order) return res.redirect('/dashboard');

  enforceBreachIfNeeded(order);
  const computed = computeSla(order);
  order.effectiveStatus = computed.effectiveStatus;
  order.status = order.effectiveStatus || order.status;
  const sla = computed.sla;

  const files = db
    .prepare(
      `SELECT id, url, label, created_at
       FROM order_files
       WHERE order_id = ?
       ORDER BY created_at DESC`
    )
    .all(orderId);

  const addHasLabel = hasColumn('order_additional_files', 'label');
  const additionalFiles = db
    .prepare(
      `SELECT id,
              file_url AS url,
              ${addHasLabel ? 'label' : 'NULL'} AS label,
              uploaded_at AS created_at
       FROM order_additional_files
       WHERE order_id = ?
       ORDER BY uploaded_at DESC`
    )
    .all(orderId);

  const allFiles = [...files, ...additionalFiles].sort((a, b) => {
    const aDate = new Date(a.created_at || 0).getTime();
    const bDate = new Date(b.created_at || 0).getTime();
    return bDate - aDate;
  });

  const events = db
    .prepare(
      `SELECT id, label, at
       FROM order_events
       WHERE order_id = ?
       ORDER BY at DESC
       LIMIT 25`
    )
    .all(orderId);
  const timeline = events.map((ev) => ({ ...ev, formattedAt: formatDisplayDate(ev.at) }));

  const messages = db
    .prepare(
      `SELECT id, label, meta, at
       FROM order_events
       WHERE order_id = ?
         AND label IN ('doctor_request', 'patient_reply')
       ORDER BY at ASC`
    )
    .all(orderId)
    .map((msg) => ({ ...msg, atFormatted: formatDisplayDate(msg.at) }));

  const paymentLink = order.payment_link || order.service_payment_link || null;
  const displayPrice = order.price != null ? order.price : order.service_price;
  const displayCurrency = order.currency || order.service_currency || 'EGP';
  const statusLower = String(order.status || '').toLowerCase();
  const uploadsLocked = Number(order.uploads_locked) === 1;
  const isCompleted = statusLower === 'completed';
  const canUploadMore = !isCompleted && !uploadsLocked;
  const isUnpaid = order.payment_status === 'unpaid';
  const hasPaymentLink = !!paymentLink;

  res.render('patient_order', {
    user: req.user,
    order: {
      ...order,
      payment_link: paymentLink,
      display_price: displayPrice,
      display_currency: displayCurrency
    },
    sla,
    doctor_photo: null,
    files: allFiles,
    order_additional_files: additionalFiles,
    timeline,
    events,
    messages,
    uploadClosed,
    canUploadMore,
    isUnpaid,
    hasPaymentLink
  });
});

// Patient replies to doctor's clarification request
router.post('/patient/orders/:id/submit-info', requireRole('patient'), (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const message = (req.body && req.body.message ? String(req.body.message) : '').trim();

  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND patient_id = ?')
    .get(orderId, patientId);

  if (!order) {
    return res.redirect('/dashboard');
  }

  const nowIso = new Date().toISOString();
  const meta = message || 'File uploaded';

  logOrderEvent({
    orderId,
    label: 'patient_reply',
    meta,
    actorUserId: patientId,
    actorRole: 'patient'
  });

  db.prepare(
    `UPDATE orders
     SET additional_files_requested = 0,
         updated_at = ?
     WHERE id = ?`
  ).run(nowIso, orderId);

  if (order.doctor_id) {
    queueNotification({
      orderId,
      toUserId: order.doctor_id,
      channel: 'internal',
      template: 'patient_reply_info',
      status: 'queued'
    });
  }

  // Placeholder: file upload handling can be added here if needed.
  return res.redirect(`/patient/orders/${orderId}`);
});

// GET upload page
router.get('/patient/orders/:id/upload', requireRole('patient'), (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const { locked = '', uploaded = '', error = '' } = req.query || {};

  const order = db
    .prepare(
      `SELECT o.*, s.name AS specialty_name, sv.name AS service_name
       FROM orders o
       LEFT JOIN specialties s ON o.specialty_id = s.id
       LEFT JOIN services sv ON o.service_id = sv.id
       WHERE o.id = ? AND o.patient_id = ?`
    )
    .get(orderId, patientId);

  if (!order) {
    return res.redirect('/dashboard');
  }

  const files = db
    .prepare(
      `SELECT id, url, label, created_at
       FROM order_files
       WHERE order_id = ?
       ORDER BY created_at DESC`
    )
    .all(orderId);

  const addHasLabel = hasColumn('order_additional_files', 'label');
  const additionalFiles = db
    .prepare(
      `SELECT id,
              file_url AS url,
              ${addHasLabel ? 'label' : 'NULL'} AS label,
              uploaded_at AS created_at
       FROM order_additional_files
       WHERE order_id = ?
       ORDER BY uploaded_at DESC`
    )
    .all(orderId);

  res.render('patient_order_upload', {
    user: req.user,
    order,
    files: [...files, ...additionalFiles],
    errorCode:
      error === '1'
        ? 'missing'
        : error === 'missing_uploader'
          ? 'missing_uploader'
          : error === 'invalid_url'
            ? 'invalid_url'
            : error === 'too_many'
              ? 'too_many'
              : error === 'locked'
                ? 'locked'
                : null,
    locked: locked === '1',
    uploaded: uploaded === '1'
  });
});

// POST upload
router.post('/patient/orders/:id/upload', requireRole('patient'), (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const { file_url, file_urls, label } = req.body || {};

  const uploaderConfigured = String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim().length > 0;
  const cleanLabel = (label && String(label).trim()) ? String(label).trim().slice(0, 120) : null;

  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND patient_id = ?')
    .get(orderId, patientId);

  if (!order) {
    return res.redirect('/dashboard');
  }

  const uploadsLocked = Number(order.uploads_locked) === 1;
  const isCompleted = String(order.status || '').toLowerCase() === 'completed';

  if (uploadsLocked || isCompleted) {
    return res.redirect(`/patient/orders/${orderId}/upload?error=locked`);
  }

  const urls = [];
  if (file_url && String(file_url).trim()) urls.push(String(file_url).trim());
  if (Array.isArray(file_urls)) {
    file_urls.forEach((u) => {
      if (u && String(u).trim()) urls.push(String(u).trim());
    });
  }

  if (urls.length === 0) {
    // If uploader isn’t configured, fail with a clear message.
    if (!uploaderConfigured) {
      return res.redirect(`/patient/orders/${orderId}/upload?error=missing_uploader`);
    }
    return res.redirect(`/patient/orders/${orderId}/upload?error=missing`);
  }

  // Basic URL validation: accept only http/https to avoid junk strings
  const filtered = urls
    .map((u) => u.slice(0, 2048))
    .filter((u) => /^https?:\/\//i.test(u));

  const MAX_FILES_PER_REQUEST = 10;
  if (filtered.length > MAX_FILES_PER_REQUEST) {
    return res.redirect(`/patient/orders/${orderId}/upload?error=too_many`);
  }

  if (filtered.length === 0) {
    return res.redirect(`/patient/orders/${orderId}/upload?error=invalid_url`);
  }

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    filtered.forEach((u) => {
      insertAdditionalFile(orderId, u, cleanLabel, now);
    });

    logOrderEvent({
      orderId,
      label: 'patient_uploaded_additional_files',
      meta: `count=${filtered.length}${cleanLabel ? `;label=${cleanLabel}` : ''}`,
      actorUserId: patientId,
      actorRole: 'patient'
    });

    // If doctor requested more files, clear the flag once patient uploads.
    db.prepare(
      `UPDATE orders
       SET additional_files_requested = 0,
           updated_at = ?
       WHERE id = ?`
    ).run(now, orderId);
  });

  try {
    tx();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[patient upload] failed', err);
    return res.redirect(`/patient/orders/${orderId}/upload?error=invalid_url`);
  }

  return res.redirect(`/patient/orders/${orderId}/upload?uploaded=1`);
});

module.exports = router;
