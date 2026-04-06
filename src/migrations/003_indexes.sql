-- 003: Performance indexes (all idempotent)
-- Tables created in later migrations are wrapped in exception handlers.

-- orders
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_deadline_at ON orders(deadline_at);
CREATE INDEX IF NOT EXISTS idx_orders_patient_id ON orders(patient_id);
CREATE INDEX IF NOT EXISTS idx_orders_doctor_id ON orders(doctor_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_service_id ON orders(service_id);
CREATE INDEX IF NOT EXISTS idx_orders_specialty_id ON orders(specialty_id);

-- notifications
CREATE INDEX IF NOT EXISTS idx_notifications_to_user_id ON notifications(to_user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_order_id ON notifications(order_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
CREATE INDEX IF NOT EXISTS idx_notifications_channel ON notifications(channel);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- users
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- order_events
CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);

-- messages (created in 005_messaging.sql)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- conversations (created in 005_messaging.sql)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_conversations_patient_id ON conversations(patient_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_doctor_id ON conversations(doctor_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_order_id ON conversations(order_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- referral_codes (created in 006_referrals.sql)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
  CREATE INDEX IF NOT EXISTS idx_referral_codes_user_id ON referral_codes(user_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- referral_redemptions (created in 006_referrals.sql)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_referral_redemptions_referrer_id ON referral_redemptions(referrer_id);
  CREATE INDEX IF NOT EXISTS idx_referral_redemptions_order_id ON referral_redemptions(order_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- appointments (created in 004_video_consultation.sql)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_appointments_patient_id ON appointments(patient_id);
  CREATE INDEX IF NOT EXISTS idx_appointments_doctor_id ON appointments(doctor_id);
  CREATE INDEX IF NOT EXISTS idx_appointments_scheduled_at ON appointments(scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- video_calls (created in 004_video_consultation.sql)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_video_calls_appointment_id ON video_calls(appointment_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- doctor_earnings (created in 004_video_consultation.sql)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_doctor_earnings_doctor_id ON doctor_earnings(doctor_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- appointment_payments (created in 004_video_consultation.sql)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_appointment_payments_appointment_id ON appointment_payments(appointment_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- doctor_availability (created in 004_video_consultation.sql)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_doctor_availability_doctor_id ON doctor_availability(doctor_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- appointment_slots (created in 004_video_consultation.sql)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_appointment_slots_doctor_id ON appointment_slots(doctor_id);
  CREATE INDEX IF NOT EXISTS idx_appointment_slots_available_at ON appointment_slots(available_at);
  CREATE INDEX IF NOT EXISTS idx_appointment_slots_is_booked ON appointment_slots(is_booked);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- case_annotations
CREATE INDEX IF NOT EXISTS idx_case_annotations_case_id ON case_annotations(case_id);
CREATE INDEX IF NOT EXISTS idx_case_annotations_image_id ON case_annotations(image_id);
CREATE INDEX IF NOT EXISTS idx_case_annotations_doctor_id ON case_annotations(doctor_id);

-- report_exports
CREATE INDEX IF NOT EXISTS idx_report_exports_case_id ON report_exports(case_id);

-- reviews
CREATE INDEX IF NOT EXISTS idx_reviews_doctor_id ON reviews(doctor_id);
CREATE INDEX IF NOT EXISTS idx_reviews_patient_id ON reviews(patient_id);
CREATE INDEX IF NOT EXISTS idx_reviews_order_id ON reviews(order_id);

-- error_logs
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_error_logs_level ON error_logs(level);
CREATE INDEX IF NOT EXISTS idx_error_logs_user_id ON error_logs(user_id);

-- prescriptions
CREATE INDEX IF NOT EXISTS idx_prescriptions_order_id ON prescriptions(order_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_id ON prescriptions(patient_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_doctor_id ON prescriptions(doctor_id);

-- medical_records
CREATE INDEX IF NOT EXISTS idx_medical_records_patient_id ON medical_records(patient_id);

-- campaign_recipients (may not exist yet)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_id ON campaign_recipients(campaign_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- service_regional_prices (may not exist yet)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_srp_service_id ON service_regional_prices(service_id);
  CREATE INDEX IF NOT EXISTS idx_srp_country_code ON service_regional_prices(country_code);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- pre_launch_leads
CREATE INDEX IF NOT EXISTS idx_pre_launch_leads_email ON pre_launch_leads(email);
CREATE INDEX IF NOT EXISTS idx_pre_launch_leads_created_at ON pre_launch_leads(created_at);
CREATE INDEX IF NOT EXISTS idx_pre_launch_leads_service_interest ON pre_launch_leads(service_interest);

-- agent_heartbeats (may not exist yet)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_agent_name ON agent_heartbeats(agent_name);
  CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_pinged_at ON agent_heartbeats(pinged_at);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- agent_token_log (may not exist yet)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_agent_token_log_agent_name ON agent_token_log(agent_name);
  CREATE INDEX IF NOT EXISTS idx_agent_token_log_logged_at ON agent_token_log(logged_at);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- chat_reports (may not exist yet)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_chat_reports_conversation ON chat_reports(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_chat_reports_status ON chat_reports(status);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
