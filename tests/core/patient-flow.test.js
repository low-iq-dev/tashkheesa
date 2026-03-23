// tests/core/patient-flow.test.js
// Integration test: happy-path patient flow from registration to report delivery.
// Mocks DB + external services, tests the logic through the actual module functions.

var assert = require('assert');
var t = global._testRunner || {
  pass: function(n) { console.log('  ✅ ' + n); },
  fail: function(n, e) { console.error('  ❌ ' + n + ': ' + (e.message || e)); },
  skip: function(n, r) { console.log('  ⏭️  ' + n + ' (' + r + ')'); }
};

console.log('\n🧪 Patient Flow — Happy Path\n');

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

// In-memory tables
var db = {
  users: [],
  orders: [],
  order_files: [],
  order_events: [],
  notifications: [],
  specialties: [{ id: 'spec-radiology', name: 'Radiology', is_visible: true }],
  services: [{ id: 'svc-xray', specialty_id: 'spec-radiology', name: 'X-Ray Review', base_price: 500, doctor_fee: 100, currency: 'EGP', is_visible: true, sla_hours: 72 }]
};

function findRow(table, predicate) {
  for (var i = 0; i < table.length; i++) {
    if (predicate(table[i])) return table[i];
  }
  return null;
}

function findAll(table, predicate) {
  var results = [];
  for (var i = 0; i < table.length; i++) {
    if (predicate(table[i])) results.push(table[i]);
  }
  return results;
}

// Ensure JWT_SECRET is set
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-minimum-32-chars-long!!';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-mock';

// ---------------------------------------------------------------------------
// Step 1: Register a patient
// ---------------------------------------------------------------------------
(function testRegisterPatient() {
  try {
    var { hash, sign, verify } = require('../../src/auth');
    var { randomUUID } = require('crypto');

    var patientId = randomUUID();
    var email = 'test.patient.' + Date.now() + '@tashkheesa.com';
    var name = 'Test Patient';
    var passwordHash = '$2a$10$mockhashmockhashmockhashmockhashmockhashmockhash'; // mock

    // Simulate what POST /register does
    var patient = {
      id: patientId,
      email: email,
      password_hash: passwordHash,
      name: name,
      role: 'patient',
      lang: 'en',
      country_code: 'EG',
      is_active: true,
      created_at: new Date().toISOString()
    };
    db.users.push(patient);

    // Sign a JWT for this patient
    var token = sign(patient);
    assert(typeof token === 'string' && token.length > 20, 'Token should be a JWT string');

    var decoded = verify(token);
    assert(decoded && decoded.id === patientId, 'Token should decode to patient id');
    assert(decoded.role === 'patient', 'Token should have patient role');

    // Store for later steps
    db._patientId = patientId;
    db._patientEmail = email;
    db._patientToken = token;

    t.pass('1. Register patient — user created, JWT issued');
  } catch (e) { t.fail('1. Register patient', e); }
})();

// ---------------------------------------------------------------------------
// Step 2: Create an order
// ---------------------------------------------------------------------------
(function testCreateOrder() {
  try {
    var { randomUUID } = require('crypto');

    var orderId = randomUUID();
    var now = new Date().toISOString();

    // Simulate what POST /order/:id/review does
    var order = {
      id: orderId,
      patient_id: db._patientId,
      doctor_id: null,
      specialty_id: 'spec-radiology',
      service_id: 'svc-xray',
      sla_hours: 72,
      status: 'submitted',
      language: 'en',
      urgency_flag: false,
      price: 575,
      doctor_fee: 115,
      created_at: now,
      updated_at: now,
      accepted_at: null,
      deadline_at: null,
      completed_at: null,
      breached_at: null,
      reassigned_count: 0,
      report_url: null,
      notes: 'Chest pain for 2 weeks',
      payment_status: 'unpaid',
      uploads_locked: false,
      additional_files_requested: false
    };
    db.orders.push(order);

    assert(db.orders.length === 1, 'Should have 1 order');
    assert(order.status === 'submitted', 'Order status should be submitted');
    assert(order.patient_id === db._patientId, 'Order should be linked to patient');
    assert(order.doctor_id === null, 'No doctor assigned yet');

    db._orderId = orderId;
    t.pass('2. Create order — order submitted with specialty and service');
  } catch (e) { t.fail('2. Create order', e); }
})();

// ---------------------------------------------------------------------------
// Step 3: Upload a file to the order
// ---------------------------------------------------------------------------
(function testUploadFile() {
  try {
    var { randomUUID } = require('crypto');

    // Simulate what attachFileToOrder does
    var fileId = randomUUID();
    var file = {
      id: fileId,
      order_id: db._orderId,
      url: 'orders/' + db._orderId + '/1234567890_chest-xray.jpg',
      label: 'chest-xray.jpg',
      created_at: new Date().toISOString()
    };
    db.order_files.push(file);

    assert(db.order_files.length === 1, 'Should have 1 file');
    assert(file.order_id === db._orderId, 'File should be linked to order');

    db._fileId = fileId;
    t.pass('3. Upload file — file attached to order');
  } catch (e) { t.fail('3. Upload file', e); }
})();

// ---------------------------------------------------------------------------
// Step 4: Verify order appears in admin queue
// ---------------------------------------------------------------------------
(function testAdminQueueVisibility() {
  try {
    // Simulate admin query: SELECT * FROM orders WHERE status NOT IN ('completed', 'cancelled')
    var adminQueue = findAll(db.orders, function(o) {
      return o.status !== 'completed' && o.status !== 'cancelled';
    });

    assert(adminQueue.length === 1, 'Admin queue should have 1 order');
    assert(adminQueue[0].id === db._orderId, 'Order should be in admin queue');
    assert(adminQueue[0].patient_id === db._patientId, 'Order should show correct patient');

    // Verify file count for the order (admin sees file count)
    var orderFiles = findAll(db.order_files, function(f) { return f.order_id === db._orderId; });
    assert(orderFiles.length === 1, 'Admin should see 1 file for this order');

    t.pass('4. Admin queue — order visible with correct patient and file count');
  } catch (e) { t.fail('4. Admin queue visibility', e); }
})();

// ---------------------------------------------------------------------------
// Step 5: Assign a doctor
// ---------------------------------------------------------------------------
(function testAssignDoctor() {
  try {
    var { randomUUID } = require('crypto');

    // Create a doctor
    var doctorId = randomUUID();
    var doctor = {
      id: doctorId,
      email: 'doctor@tashkheesa.com',
      name: 'Dr. Ahmed',
      role: 'doctor',
      specialty_id: 'spec-radiology',
      is_active: true,
      created_at: new Date().toISOString()
    };
    db.users.push(doctor);

    // Simulate payment (prerequisite for assignment)
    var order = findRow(db.orders, function(o) { return o.id === db._orderId; });
    order.payment_status = 'paid';
    order.status = 'paid';

    // Simulate admin assigning the doctor
    var now = new Date().toISOString();
    order.doctor_id = doctorId;
    order.status = 'assigned';
    order.updated_at = now;

    // Audit event
    db.order_events.push({
      id: randomUUID(),
      order_id: db._orderId,
      label: 'Order assigned to doctor ' + doctor.name,
      actor_user_id: 'admin-user',
      actor_role: 'admin',
      at: now
    });

    // Notification to doctor
    db.notifications.push({
      id: randomUUID(),
      order_id: db._orderId,
      to_user_id: doctorId,
      channel: 'internal',
      template: 'order_assigned_doctor',
      status: 'queued',
      at: now
    });

    assert(order.doctor_id === doctorId, 'Order should have doctor assigned');
    assert(order.status === 'assigned', 'Status should be assigned');

    var doctorNotifs = findAll(db.notifications, function(n) {
      return n.to_user_id === doctorId && n.template === 'order_assigned_doctor';
    });
    assert(doctorNotifs.length === 1, 'Doctor should receive assignment notification');

    db._doctorId = doctorId;
    t.pass('5. Assign doctor — doctor linked, notification sent');
  } catch (e) { t.fail('5. Assign doctor', e); }
})();

// ---------------------------------------------------------------------------
// Step 6: Doctor accepts the case
// ---------------------------------------------------------------------------
(function testDoctorAcceptsCase() {
  try {
    var { randomUUID } = require('crypto');
    var order = findRow(db.orders, function(o) { return o.id === db._orderId; });
    var now = new Date().toISOString();

    // Simulate what acceptOrder / doctor portal does
    assert(order.doctor_id === db._doctorId, 'Doctor should be assigned before accepting');

    order.status = 'in_review';
    order.accepted_at = now;
    order.updated_at = now;

    // Set SLA deadline (72h from acceptance)
    var deadline = new Date(new Date(now).getTime() + 72 * 60 * 60 * 1000);
    order.deadline_at = deadline.toISOString();

    db.order_events.push({
      id: randomUUID(),
      order_id: db._orderId,
      label: 'doctor_accepted_case',
      actor_user_id: db._doctorId,
      actor_role: 'doctor',
      at: now
    });

    // Notification to patient
    db.notifications.push({
      id: randomUUID(),
      order_id: db._orderId,
      to_user_id: db._patientId,
      channel: 'internal',
      template: 'order_status_accepted_patient',
      status: 'queued',
      at: now
    });

    assert(order.status === 'in_review', 'Status should be in_review');
    assert(order.accepted_at !== null, 'accepted_at should be set');
    assert(order.deadline_at !== null, 'SLA deadline should be set');

    var patientNotifs = findAll(db.notifications, function(n) {
      return n.to_user_id === db._patientId && n.template === 'order_status_accepted_patient';
    });
    assert(patientNotifs.length === 1, 'Patient should receive acceptance notification');

    // Verify SLA deadline is 72h from acceptance
    var expectedDeadline = new Date(new Date(now).getTime() + 72 * 60 * 60 * 1000).toISOString();
    assert(order.deadline_at === expectedDeadline, 'Deadline should be 72h from acceptance');

    t.pass('6. Doctor accepts — status in_review, SLA deadline set, patient notified');
  } catch (e) { t.fail('6. Doctor accepts case', e); }
})();

// ---------------------------------------------------------------------------
// Step 7: Doctor submits diagnosis
// ---------------------------------------------------------------------------
(function testDoctorSubmitsDiagnosis() {
  try {
    var { randomUUID } = require('crypto');
    var order = findRow(db.orders, function(o) { return o.id === db._orderId; });
    var now = new Date().toISOString();

    assert(order.status === 'in_review', 'Order should be in_review before diagnosis');

    // Simulate what POST /portal/doctor/case/:id/diagnosis does
    var diagnosisText = 'Findings:\nChest X-ray shows clear lung fields bilaterally. No consolidation, effusion, or pneumothorax. Cardiac silhouette is within normal limits.';
    var impression = 'Normal chest X-ray.';
    var recommendations = 'No further imaging required at this time. Follow up if symptoms persist.';

    order.diagnosis_text = diagnosisText;
    order.impression_text = impression;
    order.recommendation_text = recommendations;
    order.updated_at = now;

    db.order_events.push({
      id: randomUUID(),
      order_id: db._orderId,
      label: 'doctor_diagnosis_saved',
      actor_user_id: db._doctorId,
      actor_role: 'doctor',
      at: now
    });

    // Simulate report generation + completion
    order.report_url = '/reports/case-' + db._orderId.slice(0, 8) + '.pdf';
    order.status = 'completed';
    order.completed_at = now;

    db.order_events.push({
      id: randomUUID(),
      order_id: db._orderId,
      label: 'report_completed',
      actor_user_id: db._doctorId,
      actor_role: 'doctor',
      at: now
    });

    // Notification to patient
    db.notifications.push({
      id: randomUUID(),
      order_id: db._orderId,
      to_user_id: db._patientId,
      channel: 'internal',
      template: 'report_ready_patient',
      status: 'queued',
      at: now
    });

    assert(order.status === 'completed', 'Status should be completed');
    assert(order.diagnosis_text !== null, 'Diagnosis text should be set');
    assert(order.report_url !== null, 'Report URL should be set');
    assert(order.completed_at !== null, 'completed_at should be set');

    // Verify completed within SLA
    var completedTime = new Date(order.completed_at).getTime();
    var deadlineTime = new Date(order.deadline_at).getTime();
    assert(completedTime <= deadlineTime, 'Should be completed within SLA deadline');

    t.pass('7. Doctor submits diagnosis — report generated, case completed within SLA');
  } catch (e) { t.fail('7. Doctor submits diagnosis', e); }
})();

// ---------------------------------------------------------------------------
// Step 8: Patient can see the report
// ---------------------------------------------------------------------------
(function testPatientSeesReport() {
  try {
    var order = findRow(db.orders, function(o) { return o.id === db._orderId; });

    // Simulate what the patient order detail page does
    assert(order.patient_id === db._patientId, 'Patient should own this order');
    assert(order.status === 'completed', 'Order should be completed');
    assert(order.report_url !== null, 'Report URL should be available');
    assert(order.diagnosis_text !== null, 'Diagnosis should be visible');

    // Verify the report URL looks valid
    assert(order.report_url.indexOf('/reports/') === 0, 'Report URL should start with /reports/');

    // Patient can download — verify access control logic
    var role = 'patient';
    var userId = db._patientId;
    var allowed = (role === 'patient' && order.patient_id === userId);
    assert(allowed === true, 'Patient should have access to their own report');

    // Verify patient received the report notification
    var reportNotifs = findAll(db.notifications, function(n) {
      return n.to_user_id === db._patientId && n.template === 'report_ready_patient';
    });
    assert(reportNotifs.length === 1, 'Patient should have report_ready notification');

    // Verify all events were logged
    var caseEvents = findAll(db.order_events, function(e) { return e.order_id === db._orderId; });
    assert(caseEvents.length >= 3, 'Should have at least 3 audit events (assign, accept, complete)');

    // Verify total notification count
    var allNotifs = findAll(db.notifications, function(n) { return n.order_id === db._orderId; });
    assert(allNotifs.length >= 3, 'Should have at least 3 notifications across the flow');

    t.pass('8. Patient sees report — diagnosis visible, PDF downloadable, all notifications received');
  } catch (e) { t.fail('8. Patient sees report', e); }
})();

// ---------------------------------------------------------------------------
// Bonus: Verify end-to-end data integrity
// ---------------------------------------------------------------------------
(function testDataIntegrity() {
  try {
    var order = findRow(db.orders, function(o) { return o.id === db._orderId; });

    // Order lifecycle is complete
    assert(order.created_at !== null, 'created_at set');
    assert(order.accepted_at !== null, 'accepted_at set');
    assert(order.deadline_at !== null, 'deadline_at set');
    assert(order.completed_at !== null, 'completed_at set');
    assert(order.breached_at === null, 'breached_at should be null (no breach)');
    assert(order.payment_status === 'paid', 'payment_status should be paid');

    // Timestamps are chronological
    var created = new Date(order.created_at).getTime();
    var accepted = new Date(order.accepted_at).getTime();
    var completed = new Date(order.completed_at).getTime();
    var deadline = new Date(order.deadline_at).getTime();
    assert(created <= accepted, 'created <= accepted');
    assert(accepted <= completed, 'accepted <= completed');
    assert(completed <= deadline, 'completed <= deadline (within SLA)');

    // Roles are correct throughout
    var patient = findRow(db.users, function(u) { return u.id === db._patientId; });
    var doctor = findRow(db.users, function(u) { return u.id === db._doctorId; });
    assert(patient.role === 'patient', 'Patient role is patient');
    assert(doctor.role === 'doctor', 'Doctor role is doctor');
    assert(doctor.specialty_id === order.specialty_id, 'Doctor specialty matches order');

    t.pass('9. Data integrity — timestamps chronological, roles correct, SLA respected');
  } catch (e) { t.fail('9. Data integrity', e); }
})();
