const express = require('express');
const { randomUUID } = require('crypto');
const {
  createDraftCase,
  attachFileToCase,
  submitCase,
  markCasePaid,
  getCase
} = require('../case_lifecycle');

const router = express.Router();

const INTAKE_COOKIE = 'intake_token';
const intakeSessions = new Map();

function parseFileNames(raw) {
  if (!raw) return [];
  return raw
    .split('|')
    .map((name) => name.trim())
    .filter(Boolean);
}

function createSession(token) {
  return {
    token,
    caseId: null,
    files: [],
    language: 'en',
    urgency: 'no',
    reason: '',
    filesLocked: false
  };
}

function ensureSession(req, res) {
  let token = req.cookies[INTAKE_COOKIE] || (req.body && req.body.intake_token);
  if (!token || !intakeSessions.has(token)) {
    token = randomUUID();
    intakeSessions.set(token, createSession(token));
  }
  res.cookie(INTAKE_COOKIE, token, { httpOnly: true, sameSite: 'lax' });
  return token;
}

function getSession(token) {
  if (!intakeSessions.has(token)) {
    intakeSessions.set(token, createSession(token));
  }
  return intakeSessions.get(token);
}

function clearSession(token, res) {
  intakeSessions.delete(token);
  res.clearCookie(INTAKE_COOKIE);
}

router.get('/order/start', (req, res) => {
  ensureSession(req, res);
  return res.render('order_start');
});

router.get('/order/upload', (req, res) => {
  const token = ensureSession(req, res);
  const session = getSession(token);
  return res.render('order_upload', { sessionToken: token, existingFiles: session.files });
});

router.post('/order/review', (req, res) => {
  const token = ensureSession(req, res);
  const session = getSession(token);
  const reason = (req.body.reason || '').trim();
  const language = (req.body.language || 'en').trim();
  const urgency = req.body.urgency === 'yes' ? 'yes' : 'no';
  const providedFiles = parseFileNames(req.body.file_names);

  session.language = language;
  session.urgency = urgency;
  session.reason = reason;
  session.files = providedFiles;

  let caseId = session.caseId;
  if (!caseId) {
    caseId = createDraftCase({
      language,
      urgency_flag: urgency === 'yes',
      reason_for_review: reason
    });
    session.caseId = caseId;
  }

  providedFiles.forEach((filename) => {
    attachFileToCase(caseId, {
      filename,
      file_type: filename.split('.').pop() || 'unknown'
    });
  });

  return res.render('order_review', {
    sessionToken: token,
    reason,
    language,
    urgency,
    files: providedFiles
  });
});

router.post('/order/payment', (req, res) => {
  const token = ensureSession(req, res);
  const session = getSession(token);
  const caseId = session.caseId;
  if (!caseId) {
    return res.status(400).send('Case not initialized');
  }

  const reason = session.reason;
  const urgency = session.urgency;
  const language = session.language;
  const files = session.files;

  submitCase(caseId);
  session.filesLocked = true;

  const currentCase = getCase(caseId);

  return res.render('order_payment', {
    sessionToken: token,
    reason,
    urgency,
    language,
    files,
    caseData: currentCase
  });
});

router.post('/order/confirmation', (req, res) => {
  const token = ensureSession(req, res);
  const session = getSession(token);
  const caseId = session.caseId;
  if (!caseId) {
    return res.status(400).send('Case not found');
  }

const currentCase = getCase(caseId);
const paymentStatus = String(currentCase?.payment_status || '').toLowerCase();

  clearSession(token, res);

 if (paymentStatus === 'paid') {
  clearSession(token, res);
  return res.render('order_confirmation', {
    reference: currentCase.reference_code,
    slaType: currentCase.sla_type,
    slaDeadline: currentCase.sla_deadline,
    status: currentCase.status
  });
}

return res.render('order_confirmation', {
  reference: currentCase.reference_code || currentCase.id || caseId,
  status: 'PAYMENT_PENDING'
});
});

module.exports = router;
