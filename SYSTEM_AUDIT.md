# Tashkheesa System Audit
**Date:** April 28, 2026
**Branch at audit:** `main` after Phase 1 doctor-portal v2 ship
**Author:** Claude (post-audit grounding session)

This doc replaces speculation with measured reality. Where the prior chat thread had me guessing about what existed, this is what the code, schema, and live database actually say.

---

## 1. Scale (what we're actually working with)

| Metric | Count |
|---|---|
| JS lines of code | 37,830 |
| Route files | 35 |
| EJS views | 117 |
| SQL migrations | 23 (+ 019b variant) |
| DB tables | 40+ |
| Env vars (prod-relevant) | 76 |
| Top-3 largest routes | doctor.js (3,667 LOC), patient.js (2,897), superadmin.js (2,855) |

This is a much bigger system than the chat thread reflected. Doctor portal is one surface among many.

---

## 2. Functional surfaces (every workstream this codebase contains)

### 2.1 Patient flow (B2C)
- Public landing (`index.ejs`, `landing/`) + bilingual marketing pages (about, contact, services, terms, privacy, refund, delivery)
- Help-me-choose wizard (`help_me_choose.ejs`)
- Order intake → upload → review → payment → confirmation (`order_*.ejs` × 6 views)
- Patient portal (21 patient_* views): cases list, case detail, files, alerts, prescriptions list+detail, appointments, medical records, referrals, reviews, profile, payment, new-case
- Login / signup / forgot-password / reset-password / set-password flow

### 2.2 Doctor flow (B2B)
- Doctor self-service signup (`doctor_signup.ejs`, `doctor_signup_submitted.ejs`)
- Pending approval state (`doctor_pending_approval.ejs`)
- Doctor login (`doctor_login_v2.ejs`)
- Doctor portal (12 doctor_* + 7 portal_doctor_* views): today, cases, case detail, prescribe form, prescriptions list+detail, alerts, profile, messages, earnings, dashboard, guide, analytics, appointments, case_intelligence, reviews

### 2.3 Admin / Hospital ops (B2B internal)
- Admin portal (19 admin_* views) — hospital-side workflows for triaging, reviewing, escalating
- Superadmin portal (12 superadmin_* views) — platform-level controls, doctor approvals, service catalogue, analytics
- Ops command centre (`ops-dashboard.ejs`, `ops-errors.ejs`, `ops-error-detail.ejs`, `ops-login.ejs`) — agent heartbeat monitoring, error drill-down, OpenClaw integration
- Help guides per role (admin/doctor/patient guide views)

### 2.4 Real-time / async services
- Video consultation (Twilio Video SDK; `video_call_room.ejs`, `video_appointment.ejs`, `video_call_ended.ejs`; `src/routes/video.js` is 1,445 LOC)
- Appointments (booking / availability / detail; `appointments.js` route)
- Messaging (1:1 case-scoped chat; `conversations`, `messages`, `chat_reports` tables; `messaging.js` route)
- Notifications (multi-channel: internal, email, WhatsApp, with worker + retry; gated by env flags)
- AI assistant (Anthropic SDK in `ai_assistant.js` — pattern recognition / case intelligence beta)
- Patient-facing AI triage (Claude Haiku in `patient.js` for the new-case wizard)

### 2.5 Commercial / growth
- Add-on services system (`addon_services` + `order_addons` + `addon_earnings` tables; `services/addons/` registry with VideoConsult + Prescription instances; gated behind `ADDON_SYSTEM_V2` flag — currently dormant in production but code is live)
- Referral codes + redemptions (`referrals.js`)
- Email campaigns (`campaigns.js`, `email_campaigns` + `campaign_recipients` tables)
- Regional service pricing (`service_regional_prices` table — Egypt vs Gulf vs Western multipliers)
- Reviews (`reviews.js` route, `reviews` table)

### 2.6 Platform infrastructure
- Auth: JWT (`jsonwebtoken`), bcryptjs hashing, OTP via Twilio Verify + WhatsApp template, password reset tokens, role-based middleware
- File storage: Cloudflare R2 (`@aws-sdk/client-s3` + `s3-request-presigner`), 5 MB photo cap, signed-URL serve pattern
- Image validation: AI checks via `file_ai_checks` table; `image-size` for dimensions
- CSRF: `csrf-csrf` (double-submit token, mode-switchable)
- Rate limiting: `express-rate-limit`
- Helmet for security headers + CSP nonces
- Error logging: `error_logs` table (212 rows currently), structured logger
- DB: PostgreSQL on Neon.tech (migrated from Render PG late March)
- Cache: in-process; no Redis
- Webhooks: Paymob payment callback (HMAC-verified via `paymob-hmac.js`)

### 2.7 Automation (OpenClaw integration)
- `agent_heartbeats` (285 rows — agents are active), `agent_token_log`, `agent_config` tables
- Ops dashboard polls Mac mini SSH for OpenClaw process status
- IG scheduled posts (`ig_scheduled_posts` table for the bilingual content pipeline)
- This is **separate from this repo** but integrates via DB tables and the ops dashboard

---

## 3. Live data snapshot (production DB)

```
users:           43       (37 patients, 3 doctors, 2 superadmin, 1 admin)
orders:          92       (54 expired_unpaid, 26 completed, 7 breached, 2 in_review, 2 assigned, 1 reassigned)
prescriptions:   1
services:        155
specialties:     16
reviews:         7
appointments:    7
video_calls:     0
conversations:   3
messages:        9
referral_codes:  1
medical_records: 1
agent_heartbeats: 285
error_logs:      212
```

**What this means in plain English:**
- The platform is **post-launch but pre-traction**. 92 total orders ever, 26 completed, conversion gap is the unpaid drop-off (54 expired_unpaid out of 92 = ~59%).
- 3 real doctors, 37 patient accounts.
- Video consultation table exists but **0 video calls have ever happened** — feature is wired but nobody has used it. `VIDEO_CONSULTATION_ENABLED=false` in env.
- Referrals table has 1 code; messaging has 9 messages across 3 conversations.

---

## 4. Feature flags currently in production

| Flag | State | Effect |
|---|---|---|
| `ADDON_SYSTEM_V2` | off | Add-on services system dormant — V1 prescription/video flows still active |
| `VIDEO_CONSULTATION_ENABLED` | false | Video calls disabled platform-wide |
| `NOTIFICATION_WORKER_ENABLED` | true | Notifications fire normally |
| `EMAIL_ENABLED` | true | SMTP active |
| `WHATSAPP_ENABLED` | true | WhatsApp Cloud API active |
| `SLA_ENFORCEMENT_ENABLED` | 1 | Auto-reassign on SLA breach |
| `NOTIFICATION_DRY_RUN` | (env-driven) | Probably false in prod |
| `SLA_DRY_RUN` | (env-driven) | Probably false in prod |

---

## 5. What I had wrong in the chat thread

For the record, so we don't repeat:

- I called Earnings + Messages "SOON / placeholders." **Wrong** — both have full backing tables, route handlers, and real data. The sidebar SOON badge is misleading; the features are live.
- I treated this as a doctor-portal-only project. **Wrong** — patient portal, admin, superadmin, ops, video, addons, AI assistant, messaging, referrals, campaigns are all in scope.
- I speculated about a "Patient portal Phase 2." **Wrong** — there's no committed plan; I was making things up.
- I had Paymob onboarding flagged as the next priority. **Worth re-evaluating** in light of the 59% expired_unpaid rate — it's still a real blocker because patients aren't completing payment.
- I had hospital call-centre AI on my map. **Correct** that it's separate, and you confirmed.

---

## 6. What's actually missing or broken (measured)

### 6.1 Functional gaps inside the doctor portal (Phase 2 backlog)
- Doctor signature upload (in progress — Claude Code working on it now)
- Profile autocomplete (queued)
- 6 legacy doctor pages need decision: redesign or delete (queued audit)
- 4 partial-v2 doctor pages need polish (queued)
- Topbar bell dropdown for alerts (architectural shift)

### 6.2 Sidebar misleading badges (visual bug, not functional)
- `Messages` shows "SOON" but `portal_doctor_messages.ejs` exists, `messaging.js` route exists, `messages` table has data. **Remove the SOON badge.**
- `Earnings` shows "SOON" but `portal_doctor_earnings.ejs` exists, `doctor_earnings` table has 4 rows. **Remove the SOON badge.**

### 6.3 Conversion / business problem
- 54/92 orders (59%) hit `expired_unpaid` — patients start orders, never pay, expire. This is the platform's single biggest health metric.
- Video consultation built but disabled (`VIDEO_CONSULTATION_ENABLED=false`).
- Add-on system built but dormant (`ADDON_SYSTEM_V2=off`).

### 6.4 Production health
- 212 error_logs entries — worth grepping for repeating patterns to see what's failing in prod.
- 285 agent_heartbeats — automation is alive.

### 6.5 Surfaces that need verification (haven't audited their UX state)
- Admin portal (19 views) — chrome state unknown, no v2 marker check done
- Superadmin portal (12 views) — same
- Ops dashboard (4 views) — same
- Video call surfaces (3 views) — same
- Help guide pages (3 views per role) — likely legacy, low traffic

---

## 7. Recommended priority re-stack

Based on what the audit actually shows, not what I was guessing:

### A. Immediate (today/tomorrow)
1. Finish Phase 2 round 1 (Claude Code is on signature upload right now)
2. **Remove the SOON badges from Messages + Earnings** in the sidebar — they're lies, not roadmap
3. Audit the 6 legacy doctor pages → decide redesign vs delete

### B. Short-term (this week)
4. Verify Paymob payment flow end-to-end on production — the 59% unpaid rate is the biggest business risk
5. Decide whether to flip `VIDEO_CONSULTATION_ENABLED=true` (the feature exists; turning it on adds revenue surface)
6. Decide whether to flip `ADDON_SYSTEM_V2=true` (same reasoning)

### C. Medium-term (this month)
7. Admin / superadmin portal v2 audit — same chrome migration the doctor portal just got
8. Error logs review — 212 entries should be triaged for repeating issues
9. Patient portal post-launch UX issues — driven by data, not speculation

### D. Defer until data justifies
- Profile autocomplete (nice-to-have, no business case proven)
- Topbar bell dropdown (architectural improvement, no user complaints)
- Help guide redesigns (low traffic)

---

## 8. Open questions for Ziad

- Is the 59% expired_unpaid rate a known problem you're already working on, or news?
- Why is `VIDEO_CONSULTATION_ENABLED=false` in prod? Tech blocker or business decision?
- Why is `ADDON_SYSTEM_V2=off`? Same question.
- Admin / superadmin portals — are they being used in production now? By whom? Do they need v2 chrome?
- Is there a launch-quality dashboard somewhere tracking these metrics, or should we build one?

