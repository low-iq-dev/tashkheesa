-- 110_orders_is_practice.sql
--
-- Practice cases for doctor onboarding: real rows in the doctor's real queue,
-- so they learn the real interface rather than a mock of it - but invisible to
-- money, to metrics and to the automated machinery.
--
-- NOT NULL DEFAULT FALSE means every existing row and every future real case is
-- untouched. Only a row explicitly marked TRUE is a practice case.
alter table public.orders
  add column if not exists is_practice boolean not null default false;

comment on column public.orders.is_practice is
  'TRUE = a seeded training case for doctor onboarding. Never produces doctor_earnings, never counts in dashboard stats, never suppresses the account-complete panel. Real cases are always FALSE.';

-- orders_active is what the doctor queue, the SLA sweeps, the load balancer and
-- earnings_writer all read, so the flag has to be visible through it or none of
-- the exclusions can be written. Appended last to keep the column order stable.
create or replace view public.orders_active as
 select id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
        language, urgency_flag, price, doctor_fee, created_at, updated_at,
        accepted_at, deadline_at, completed_at, breached_at, reassigned_count,
        report_url, notes, diagnosis_text, impression_text, recommendation_text,
        uploads_locked, additional_files_requested, medical_history,
        current_medications, payment_status, payment_method, payment_reference,
        payment_link, pre_breach_notified, sla_reminder_sent,
        video_consultation_selected, video_consultation_price, addons_json,
        total_price_with_addons, sla_24hr_selected, sla_24hr_price,
        sla_24hr_deadline, referral_code, referral_discount, intelligence_status,
        reference_id, clinical_question, base_price, currency, sla_deadline,
        broadcast_sent_at, broadcast_count, acceptance_deadline_at, tier,
        case_files_url, test_type, source, country, urgency_tier, paid_at,
        draft_step, deleted_at, urgency_uplift_amount, reassigned_to_doctor_id,
        reassigned_at, reassignment_reason, paymob_intention_id,
        paymob_transaction_id, hmac_verified_at, sla_paused_at,
        sla_remaining_seconds, assignment_status, no_sla_refund_eligibility,
        display_price, display_currency, locked_price, locked_currency,
        price_snapshot_json,
        is_practice
   from public.orders
  where deleted_at is null;

-- The exclusions are all "doctor_id = $1 and not is_practice", so the partial
-- index keeps those counts cheap without touching the real-case path.
create index if not exists orders_practice_idx
  on public.orders (doctor_id) where is_practice;
