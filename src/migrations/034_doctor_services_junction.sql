-- 034: doctor_services junction table
--
-- Backs the redesigned /doctor/signup form's "services I'm willing to
-- review" multi-checkbox section AND fixes a latent bug at
-- src/routes/superadmin.js:2003 where the existing "Create Doctor"
-- handler tries to INSERT into this table — which didn't exist on prod.
-- Production has 1 active doctor and zero superadmin-created service
-- assignments, so the bug never surfaced. This migration creates the
-- table so the existing INSERT starts working AND the new signup form
-- has somewhere to write.
--
-- Schema kept minimal — no foreign keys (consistent with the rest of the
-- schema, which uses TEXT ids and application-level integrity rather
-- than DB-level cascades). PRIMARY KEY (doctor_id, service_id) gives us
-- the natural uniqueness constraint plus a covering index for the most
-- common read shape ("which services has this doctor opted into?").

CREATE TABLE IF NOT EXISTS doctor_services (
  doctor_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (doctor_id, service_id)
);
CREATE INDEX IF NOT EXISTS idx_doctor_services_doctor ON doctor_services(doctor_id);
