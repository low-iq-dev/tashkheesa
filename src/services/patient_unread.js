// src/services/patient_unread.js
//
// AUDIT-UNREAD-2026-09-06 — "the patient never sees their doctor replied".
//
// The dashboard's unread-messages badge was computed by this query:
//
//     SELECT COUNT(*) FROM messages
//      WHERE case_id = $1 AND sender_id <> $2 AND read_at IS NULL
//
// `messages` has neither of those columns. It has `conversation_id` and
// `is_read`; the case id lives on `conversations.order_id`. Verified against
// production: the statement raises `column "case_id" does not exist`. It was
// wrapped in a bare `catch (_) {}` that reset the count to 0, so the badge read
// zero on every render, for every patient, since the day it was written — and
// the failure that caused it was invisible, because the catch also swallowed the
// error that named the missing column.
//
// Every OTHER patient page did not even try: patient_cases, patient_new_case,
// patient_order, patient_onboarding, patient_payment_success and messages all
// passed the literal `unreadCount: 0` into the chrome. So the one badge that
// tells a patient their consultant has replied was hardcoded off across the
// whole portal. In a second-opinion product where the doctor's reply IS the
// product, that is the notification that matters most.
//
// This module is the single definition of the count, so the six views and the
// dashboard cannot drift apart again. It DOES NOT swallow errors — the caller
// decides, and every caller logs. A silent catch is exactly what hid this.

'use strict';

const { queryOne } = require('../pg');

// Unread messages addressed to this patient, across all of their conversations.
//
// "Unread" = not sent by them and not marked read. `IS DISTINCT FROM` rather
// than `<>` because a NULL sender_id (system/automated message) must count as
// "not from the patient" — with `<>` the comparison is NULL, the row is
// filtered out, and system messages would silently never be counted.
//
// COALESCE(is_read, false): the column is nullable and older rows carry NULL,
// which means never read, not "unknown, so ignore it".
//
// The count is portal-wide rather than per-case because that is what it labels:
// the "Messages" entry in the patient sidebar and mobile tab bar, which links to
// the whole inbox at /portal/messages.
async function countPatientUnreadMessages(patientId) {
  const id = String(patientId || '').trim();
  if (!id) return 0;
  const row = await queryOne(
    `SELECT COUNT(*)::int AS c
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.patient_id = $1
        AND m.sender_id IS DISTINCT FROM $1
        AND COALESCE(m.is_read, false) = false`,
    [id]
  );
  return row ? (Number(row.c) || 0) : 0;
}

// The same count narrowed to one case. Used by the dashboard, which shows a
// "your specialist replied" CTA against the ACTIVE case specifically — a
// portal-wide number there would point the patient at a case they are not
// looking at. `conversations.order_id` is the join to a case; there is no
// case_id on messages, which is the whole origin of this bug.
async function countPatientUnreadMessagesForCase(patientId, orderId) {
  const id = String(patientId || '').trim();
  const oid = String(orderId || '').trim();
  if (!id || !oid) return 0;
  const row = await queryOne(
    `SELECT COUNT(*)::int AS c
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.patient_id = $1
        AND c.order_id = $2
        AND m.sender_id IS DISTINCT FROM $1
        AND COALESCE(m.is_read, false) = false`,
    [id, oid]
  );
  return row ? (Number(row.c) || 0) : 0;
}

module.exports = {
  countPatientUnreadMessages,
  countPatientUnreadMessagesForCase
};
