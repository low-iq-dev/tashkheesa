# Doctor app — P0 API audit (read-only recon)

**Date:** 2026-09-15 · **Portal HEAD:** `d255cf4b` (main, rebased onto origin/main, zero local commits) · **Machine:** MacBook (`whoami` = `ziadelwahsh`)
**Brief:** `docs/DOCTOR_APP_BUILD_BRIEF.md` §A + §P0 · **Status:** uncommitted, awaiting gate.

**Method.** Code read at HEAD, split across parallel read-only passes (doctor.js 1–3400, doctor.js 3400–end, the seven sibling route files, `api/admin.js` end to end, acceptance window + earnings), then the load-bearing claims were re-checked by hand against source. Schema facts come from production via the Supabase MCP (`information_schema` / `pg_catalog` / aggregate counts only — no row data, no connection string). No code, branches, migrations or pushes. `/Users/ziadelwahsh/tashkheesa-launchfix` was not touched.

---

## 0 · Read this first — findings that change the plan

These are the items Ziad should rule on at the gate. Everything below the fold is supporting evidence.

| # | Finding | Why it matters | Brief section affected |
|---|---|---|---|
| **G1** | **Earnings is NOT one code path. There are at least 8 independent SQL aggregations and they disagree.** See §4. | Brief §A says two paths = a bug. It is several. P6's "matches to the piastre" DoD is currently unmeetable. | §A payouts, P1 earnings, P6 |
| **G2** | **The payout code does not implement the signed-off policy.** Reassigned-away writes a **10% token** row (policy: 0). "SLA breach reverses only the uplift" is stage 1; stage 2 (refund mark-paid) does a **full clawback**, and the policy doc contradicts itself (§4.A vs §5 Ex. D). `status='paid'` is set **at report submit**, not at month-end payout. `addon_earnings` rows are **never** moved off `pending`. | Building earnings screens on top would render wrong money. Needs a policy/code decision before P1 earnings endpoints. | §A payouts, P6 |
| **G3** | **There is no doctor "decline case" action anywhere.** Cases leave an unaccepting doctor only by timeout (`case_sla_worker.handleDoctorTimeout` → `reassignCase`). | P1 "decline (with reason)" and P3 "declined case back in the pool" are **new business logic**, not a wrapper — contradicts P1's "no new business logic". Needs a design decision. | P1, P3 |
| **G4** | **Report submit is a ~390-line orchestration living inside the route** (`handlePortalDoctorGenerateReport`, doctor.js:6387), not a service. It is also not idempotent (double POST → duplicate `report_exports`, `order_events`, `medical_records`, and a patient notification with no dedupe key), and a swallowed `transitionCase` error still lets the raw completion UPDATE run. | P1 must lift it into a service before the API can call "the same service". This is P5's critical path. | P1, P5 |
| **G5** | **The report PDF does not embed the stored signature.** `report-generator.js:768-771` draws a rule and the doctor's typed name. `users.signature_url` is read only by the prescription view. | Brief §A states the PDF "carries the consultant's stored signature". P5's "submitting with no signature is blocked" has no server rule to mirror. | §A, P5 |
| **G6** | **No measurement annotation tool exists.** Annotator tools are select / pen / circle(ellipse) / rect / arrow / text (`public/js/image-annotator.js:80-87`). Payload is fabric.js `canvas.toJSON`. | P4 "arrow, ellipse, measurement persisting through the existing annotations routes" — measurement is new, and a fabric.js JSON blob is not trivially renderable in React Native. | P4 |
| **G7** | **Doctors can already mint API tokens, with the wrong TTL and a dangerous fallback.** `POST /api/v1/auth/otp/verify` accepts `role in ['patient','doctor']` (`api/auth.js:457`) and mints **15m / 30d** (not 12h). If no user matches the phone it **creates a patient account** (`auth.js:551-563`). `requireJWT` does **not** check deactivated/pending doctors — only token staleness. | P1 auth must not reuse the patient OTP path as-is; a doctor with a mismatched phone would silently get a patient account. | P1 auth |
| **G8** | **One refresh-token slot per user.** `users.refresh_token` is a single plaintext column overwritten on every login/refresh. `users.push_token` is likewise single. | A doctor on two devices (or web + app later) will log the other session out on every refresh. | P1 auth, P3 push |
| **G9** | **No column for the appearance preference** on `users` (or anywhere). No phrase-library table. | Both need migrations in P1/P5 — the brief assumes storage exists. | P1, P2, P5 |
| **G10** | **Pre-existing doctor-side data exposure** (details §8): any doctor can open the pre-accept brief (clinical question, history, medications) of **any** unassigned case in **any** specialty, paid or not; a pool case with NULL specialty can be accepted by any doctor; the intelligence page shows patient name + extractions to an assigned-but-not-accepted doctor. | P1 must not copy these shapes into JSON — a JSON serialisation of the case-detail payload would also leak the file names the EJS currently hides. | P1 ownership rules |
| **G11** | **Acceptance deadline has two columns enforced by two different workers, and they can diverge.** Broadcast resolves tier differently from everyone else (15 min vs 120 min on the same order). The orders column is also reused as a retry timer. | P3 "the countdown is the real `accept_by_at`" — the dashboard/cases list today read the *other* column. | P3 |
| **G12** | Brief-vs-prod drift: prod has **67** public tables (not 59); **3 tables have RLS disabled** (`deleted_users`, `email_delivery_events`, `email_suppressions` — Supabase advisory, remediation SQL in §5.4, not applied); `orders.status` has **no CHECK constraint** and prod also holds `draft` and `expired_unpaid`; the annotations table is `case_annotations`; there is a legacy `cases` table alongside `orders`; the Arabic/English "fast-track" string still ships in the urgent-window error (`services/case_intake_pricing.js:157`). | Minor individually; the RLS one is a security item for P8. | §A, P8 |

Verified by hand at HEAD (not just agent-reported): G3 (grep of every `router.*(declin|reject)`), G2 add-on (`UPDATE addon_earnings` has zero hits; `UPDATE doctor_earnings` only in `earnings_writer.js`), `REASSIGN_PARTIAL_PCT = 10`, acceptance table 15/45/120, TTLs `15m/30d` and `15m/12h`, `OTP_ROLES`, G5, G6, G10 (doctor.js:2294, 2315, 3278, 2937).

---

## 1 · Doctor-facing route inventory

### 1.0 Mounting and gates

- `src/server.js:260,1139` — `app.use('/', doctorRoutes)`, mounted **before** `patientRoutes`. Sibling routers mounted at `/` at server.js:1161–1173.
- `server.js:1077-1104` — any path starting `/portal/doctor` requires `role === 'doctor'` (GET → redirect to login, others → 403). **Does not cover** `/doctor/*` or `/api/doctor/*`, which rely on `requireDoctor` alone.
- `requireDoctor = requireRole('doctor')` (doctor.js:162 → `middleware.js:384`): no user → 302 `/login`; erased tombstone → `/account-deleted`; `access_revocation.doctorBlockReason` blocks `pending_approval === true` or `is_active === false` from a 60 s per-instance cache and **fails open** on error (`middleware.js:414`); wrong role → 403. **Pause is deliberately not a gate.** `rejection_reason` is passed to `loginBlockReason` but never evaluated (`login_gate.js:79-80`). `onboarding_complete`, services and tiers are not gates.
- Path-less `router.use` blocks at doctor.js:167 and :1471 run for **every** request reaching this router, including patients and admins (sets `portalRole='doctor'`, runs a streak COUNT). doctor.js:1581 attaches unread/alert badge locals only to routes registered after it.
- All routes are cookie + CSRF (production enforce mode, `middleware/csrf.js`); `/api/v1/*` is CSRF-exempt. Logged-out JSON calls get a **302, not a 401**.
- Specialty for pool/queue/catalog comes from the **JWT** `req.user.specialty_id` (up to 7 days stale); only accept re-reads `users.specialty_id`.

### 1.1 `src/routes/doctor.js`

Status buckets used throughout (module-private): `ACCEPTED_STATUSES = in_review, review, awaiting_files, rejected_files, breached, sla_breach` (50); `UNACCEPTED_STATUSES = new, submitted, paid, assigned, accepted` (61); `MAX_ACTIVE_CASES = 4` (64). Reads use the `orders_active` view.

| Method | Path | Line | Reads | Writes | Responds | Ownership |
|---|---|---|---|---|---|---|
| GET | `/doctor/pending-approval` | 174 | — | — | view `doctor_pending_approval` | **No auth** (static) |
| GET | `/portal/doctor`, `/today`, `/dashboard` | 187–830 | orders_active (assigned-pending, specialty pool, review, completed, priority queue by `deadline_at`, perf/turnaround, SLA banner), specialties, services, `doctor_earnings` + `addon_earnings` month split (296–316), `order_events` activity, messages/conversations unread, latest paid earning, `users.first_login_at` | **`UPDATE users SET first_login_at` on GET** (643) | view `portal_doctor_dashboard` | `o.doctor_id = $1`; pool = null doctor + `specialtyMatchSql` (fail-closed on no specialty). Pool admits unpaid `new/submitted`. `mapPortalCaseItem` spreads the full row minus pricing |
| GET | `/portal/doctor/queue` | 833 | `?bucket=new\|review`, paged (≤100); UNION assigned-pending + pool; appointments | — | view `portal_doctor_cases` | as dashboard |
| GET | `/portal/doctor/completed` | 890 | completed, paged | — | view `portal_doctor_cases` | `o.doctor_id = $1` |
| GET | `/portal/doctor/cases` | 935 | `?tab=active\|completed\|all`, four counts + paged list | — | view `portal_doctor_cases` | `o.doctor_id = $1` |
| GET | `/portal/doctor/services` | 999 | `users.sub_specialties/sla_tiers_supported/sla_tiers_confirmed_at/onboarding_complete`, specialties, `loadDoctorServiceCatalog` | — | view `portal_doctor_services` | self |
| POST | `/portal/doctor/turnaround` | 1108 | body `sla_tiers` | `users.sla_tiers_supported, sla_tiers_confirmed_at` | 302 `/services#turnaround` | `id=me AND role='doctor'`; whitelist, empty → `['standard']` |
| POST | `/portal/doctor/services` | 1167 | `service_ids`, `confirm_empty`; catalog recomputed server-side; `diffServiceSelection` | **txn:** `doctor_services` insert/delete, `users.onboarding_complete=true`, `resyncComingSoon` → `services.coming_soon` | 302 / 400 / 500 re-render | self; ticks outside allowed set rejected |
| GET | `/portal/doctor/messages` | 1318 | — | — | **301** `/portal/messages` | server.js prefix guard only |
| GET | `/portal/doctor/earnings` | 1324 | `doctor_earnings` + `addon_earnings` monthly (UTC `date_trunc` on `created_at`, 24 mo) and lifetime, split paid/pending/reassigned; merged in-route (1427–1452) | — | view `portal_doctor_earnings` | `doctor_id = me`. Query errors swallowed → shows **0 EGP** |
| GET | `/portal/doctor/alerts` | 1962 | `fetchDoctorNotifications` (information_schema column probe) | **marks all read on GET** | tries 4 view names, inline fallback | owner clause `user_id=me OR to_user_id=me OR to_user_id=<email>` |
| POST | `/portal/doctor/onboarding/dismiss` | 2051 | — | `users.first_login_at` | 204 | self |
| POST | `/portal/doctor/alerts/:id/read` | 2077 | probe | `notifications.is_read=true` (or legacy `status='seen'`) | JSON `{ok}` | owner clause, rowCount must be >0 |
| GET | `/api/doctor/alerts/recent` | 2090 | 8 recent + unseen count, severity by template regex | — | JSON `{alerts, unseenCount}` | owner clause |
| POST | `/api/doctor/alerts/mark-all-read` | 2136 | — | mark all read | JSON | owner clause |
| GET | `/portal/doctor/case/:caseId` | 2173–2916 | orders_active `o.*` + specialty/service/patient (name, dob, gender); **`order_files` + `order_additional_files` loaded before the access check**; `case_annotations` (+ other doctors' names), `conversations`, `file_ai_checks`, appointments, `doctor_assignments` (assigned_at, **accept_by_at**, reassigned_from), `doctor_services`, `prescriptions`; `computeSla`, paused-SLA display, report draft rehydration | — | view `portal_doctor_case`; 403 same view with `accessDenied` | **see §8 C1** — viewable if accepted-by-me **or any unaccepted status** |
| GET | `/doctor/cases/:caseId/intelligence` | 2920–3049 | orders_active, patient `users.name`, `case_extractions` (all 5 jsonb), `case_files`, `order_files`, `order_additional_files` (does **not** call `bridgeOrderFilesToCaseFiles`) | — | view `doctor_case_intelligence`; 403 text | `!order.doctor_id \|\| doctor_id !== me` → 403 (fixed fail-open). **No `accepted_at` check** (§8 C2) |
| POST | `/portal/doctor/case/:caseId/request-prescription` | 3084–3211 | flag, `resolvePrescriptionAccess`, quote, commission pct | `order_addons` insert ON CONFLICT DO NOTHING; `order_events`; `notifyAdmins` dedupe `rx-request:<id>` | 302 `?rx=…` | `doctor_id === me` + `accepted_at`; no status check |
| POST | `/portal/doctor/case/:caseId/accept` | 3213–3537 | orders_active; payment gate; idempotent repeat; anti-steal; status gate; specialty check (**only if case has a specialty**); capacity (`countActiveCasesForDoctor`, max 4) | at capacity → **hands the case to another doctor** (`assignDoctor`/`reassignCase`). PAID → `assignDoctor` (**outside** the txn; conditional claim UPDATE). `withTransaction`: `transitionCase(IN_REVIEW)` → `accepted_at`, `deadline_at = accepted_at + sla_hours`, `closeOpenDoctorAssignments`, `case_events`. Post-commit best-effort: `order_events`, **`writePendingForCase`**, `markSlaBreach`, `ensureConversation`, appointments/video_calls backfill, patient notification (dedupe `order_accepted:<id>:patient`) | 302 dashboard / case `?msg=` | §8 C3/C4 |
| POST | `/portal/doctor/case/:caseId/reject-files` | 3580 | orders_active | `UPDATE orders SET status='rejected_files', additional_files_requested=true` **WHERE id only**; `pauseSla`; `order_events`; `notifyAdmins` dedupe `reject_files:<id>` | 302 | `doctor_id === me`; **no status guard**; raw write instead of `case_lifecycle.markOrderRejectedFiles` |
| POST | `/portal/doctor/case/:caseId/diagnosis` | 3709 | orders_active; column probes | `orders.diagnosis_text / impression_text / recommendation_text` WHERE id only; `order_events` on explicit save | autosave (`autosave=1` + JSON accept) → `{ok,savedAt}`; else 302 | `doctor_id === me`; blocks only `completed` |
| GET | `/portal/doctor/case/:caseId/report` | 3845 | — | — | 302 to case | — |
| POST | `/portal/doctor/case/:caseId/report` | 3851 → **6387** | `handlePortalDoctorGenerateReport`: orders_active, patient + doctor users, specialty, `case_annotations`, service, prescription add-on | 1 persist text · 2 empty check (findings + impression required) · 3 PDF → R2 · 4 `transitionCase(IN_REVIEW)` (error **swallowed**) · 5 raw completion UPDATE (`report_url`, `status='completed'`, `completed_at`, `doctor_id = COALESCE(doctor_id,$)`) + `report_exports` + `order_events` + prescription `onComplete` · 6 `doctor_assignments.completed_at` · 7 `CASE_COMPLETED` event · 8 **`markCaseEarningsPaid`** · 9 `medical_records` (type `case_report`) · 10 patient notification email/WhatsApp/internal, **no dedupe_key** | 302 `?error=…` | `doctor_id === me` → 403; early return on `completed` |
| GET | `/portal/doctor/guide` | 3855 | streak count | — | view `portal_doctor_guide` | self |
| GET | `/portal/doctor/profile` | 3875 | `users` profile columns incl. `signature_url`; specialties; visible `reviews` (12, anon names nulled) + avg/count | — | view `portal_doctor_profile` | self |
| POST | `/portal/doctor/profile` | 3977 | specialty validation, affiliations | `users` name/name_ar/phone/country_code/dob/specialty_id/years/sub_specialties/licence/school/grad year/affiliations/certifications/bio/bio_ar/spoken_languages; `refreshSessionCookie` | 302 / 400 / 500 | self. Doctor can **self-select any specialty** (founder decision); no service/onboarding re-sync |
| POST | `/portal/doctor/profile/photo` | 4309 | image size (JPEG/PNG/WebP ≤5 MB, ≥400×400) | R2 `doctor-photos/<id>/<ts>`, delete prev, `users.profile_photo_url` | 302 | self |
| POST | `/portal/doctor/profile/photo/remove` | 4401 | — | delete + NULL | 302 | self |
| GET | `/portal/doctor/profile/photo/:id` | 4426 | `profile_photo_url` | — | 302 signed URL (3600 s) | `:id === me` |
| POST | `/portal/doctor/profile/signature` | 4478 | PNG/JPG ≤2 MB | R2 `doctor-signatures/<id>/<ts>`, delete prev, `users.signature_url` | 302 | self |
| POST | `/portal/doctor/profile/signature/remove` | 4559 | — | delete + NULL | 302 | self |
| GET | `/portal/doctor/profile/signature/:id` | 4584 | `signature_url` | — | 302 signed URL | `:id === me` |

Doctor-relevant routes that live **outside** these files: `GET /files/:fileId` (`server.js:716`; doctor rule 809–812 requires `doctor_id === me && accepted_at`), help (`routes/help.js:26,50`).

**Dead code in doctor.js** (no callers, not exported): `resolvePatientPhoneFromOrder` 3540, `idsEqual` 5382, `isUnacceptedStatus` 5408, `statusDbValues` 5428, `sqlIn` 5438, `setOrderStatusCanon` 5467, `portalCaseActionFromStatus` 5493, `extractFileName` 5512, `readLatestDiagnosisFromEvents` 5782, `redirectIfLocked` 5895 (so `isOrderReportLocked` too), `getAdditionalFilesRequestState` 5936.

### 1.2 `src/routes/appointments.js` (availability — **not flag-gated**)

| Method | Path | Line | Reads | Writes | Responds | Ownership |
|---|---|---|---|---|---|---|
| GET | `/portal/appointments/availability` | 30 | `doctor_availability *` | — | view `appointment_availability` | self |
| POST | `/portal/appointments/availability` | 59 | body `timezone` (6 allowed), `start_N/end_N` | DELETE all + INSERT per day — **no txn, times unvalidated** | JSON `{ok}`; 500 leaks `err.message` | self |
| GET | `/portal/appointments`, `/portal/appointments/:id` | 100, 109 | — | — | 302 to `/portal/video/…` | role patient/doctor |

### 1.3 `src/routes/video.js` (flag `VIDEO_CONSULTATION_ENABLED` via `services/video_flag.js`; prod has **0** appointments)

Flag is checked only at book (322), pay (574), payment callback (694), token (1273), list (2071). Participant rule `ensureParticipant` (75): `patient_id === me || doctor_id === me` — ignores current case assignment.

| Method | Path | Line | Writes (summary) | Responds | Note |
|---|---|---|---|---|---|
| GET | `/portal/video/appointment/:id` | 879 | — | view | reads `doctor_earnings` by appointment |
| POST | `…/:id/reschedule` | 948 | `appointments.scheduled_at…`, notify, `order_events` | 302 / JSON err | conflict check uses `pending`, lifecycle uses `pending_doctor` |
| POST | `…/:id/cancel` | 1058 | pending_payment → **hard DELETE** 3 tables (before doctor restriction at 1096); else refund/entitlement release, cancel | 302 / JSON | |
| GET | `/portal/video/call/:appointmentId` | 1210 | — | view `video_call_room` | |
| POST | `/api/video/token/:appointmentId` | 1262 | `appointments.status='started'`, `video_calls` | JSON `{token, roomName, identity}` | flag-gated |
| POST | `/api/video/end/:appointmentId` | 1358 | txn: complete, `video_calls`, `doctor_earnings` insert; `order_addons` fulfil/complete → `addon_earnings` | JSON | |
| GET | `/portal/video/ended/:appointmentId` | 1629 | — | view | |
| POST | `…/:id/no-show` | 1671 | status + refund or **doctor_earnings + addon_earnings** | 302 / JSON | **no server-side time check** |
| POST | `…/:id/accept-slot` | 1883 | `status='confirmed'`, notify | 302 / JSON | no availability re-check |
| POST | `…/:id/propose-slot` | 1928 | `reschedule_proposed`, notify | 302 / JSON | |
| GET | `/portal/video/appointments` | 2053 | — | view | **undefined `${joinCol}` → always empty** |
| GET | `/portal/doctor/appointments` | 2164 | — | view `doctor_appointments` | joins `services ON s.id = a.specialty_id` (wrong key); not flag-gated |

### 1.4 `src/routes/prescriptions.js` (flag `PRESCRIPTIONS_ENABLED` via `services/prescriptions_flag.js`)

| Method | Path | Line | Writes | Responds | Ownership / flag |
|---|---|---|---|---|---|
| GET | `/portal/doctor/case/:caseId/prescribe` | 44 | — | view `doctor_prescribe` or locked (403/409) | `o.id AND o.doctor_id = me`; flagged |
| POST | `/portal/doctor/case/:caseId/prescribe` | 158 | R2 upload; `prescriptions`; add-on rows → `order_addons`/`addon_earnings`; `prescribed_medications_log`; `medical_records` (shared=true); notify patient | 302 | same; flagged |
| GET | `/portal/doctor/prescription/:id/download` | 558 | — | 302 signed URL | **author only**, not flagged |
| PUT | `/portal/doctor/prescription/:id` | 582 | `prescriptions` meds/diagnosis/notes; no log/record update, no notify | JSON | **author only; no flag, add-on, status or assignment check** |
| GET | `/portal/doctor/prescription/:id` | 635 | — | view | author only, not flagged |
| GET | `/portal/doctor/prescriptions` | 689 | — | view | `doctor_id = me`, not flagged |

### 1.5 `src/routes/messaging.js` (not flagged; no doctor JSON API exists — `/api/v1/conversations` is patient-only behind `api_v1.js:114`)

Rule `getConversationForUser` (15): `c.patient_id = me OR (c.doctor_id = me AND o.doctor_id = me)` — current-doctor rule, fail-closed on soft-deleted orders.

| Method | Path | Line | Writes | Responds |
|---|---|---|---|---|
| GET | `/portal/messages` | 90 | — | view `messages` (list with last message + unread) |
| GET | `/portal/messages/:conversationId` | 148 | **marks others' messages read on GET** | view |
| POST | `/portal/messages/:conversationId/send` | 236 | `messages` (text only), `conversations.updated_at`, notify `new_message` (10-min dedupe); rejects closed / muted | JSON `{ok, message}` |
| POST | `/portal/messages/:conversationId/read` | 314 | `is_read` | JSON |
| GET | `/api/messages/:conversationId/unread-count` | 336 | — | JSON `{count}` (bigint may be string) |
| GET | `/api/messages/total-unread` | 358 | — | JSON `{count}` (active conversations only) |
| GET | `/api/messages/:conversationId/poll?after=` | 382 | marks read if any returned | JSON `{messages}` |
| POST | `/portal/messages/report` | 485 | `chat_reports`, `order_events`, ops push | 302 — **missing current-doctor join** |

Model: one conversation per (order, patient, doctor) via `ensureConversation` (messaging.js:61, called on accept at doctor.js:3480) — a reassignment creates a new conversation. Single `is_read` flag per message (works only because conversations are two-party). Attachments are written by `patient.js:4588`, not here. `closeStaleConversations` closes 2 days after completion.

### 1.6 `src/routes/medical_records.js`

| Method | Path | Line | Reads | Responds | Ownership |
|---|---|---|---|---|---|
| GET | `/portal/doctor/case/:caseId/patient-records` | 209 | `medical_records` WHERE `patient_id AND is_shared_with_doctors AND NOT is_hidden` | JSON `{ok, records}` | `orders_active id AND doctor_id = me`; no accepted/status check |

Sharing is **per patient, not per case** — one boolean; `medical_records.order_id/doctor_id` exist but are unused here. Auto-imported prescriptions store an R2 **key** in `file_url` (unopenable as a URL). No caller in views/js was found.

### 1.7 `src/routes/annotations.js` (all JSON)

| Method | Path | Line | Writes | Ownership |
|---|---|---|---|---|
| POST | `/api/annotations/save` | 67 | upsert `case_annotations` by **(image_id, doctor_id)** — select-then-insert, no unique index | `doctorOwnsCase` on the **client-supplied** caseId; **imageId never checked against caseId** |
| GET | `/api/annotations/:imageId` | 145 | — | `userCanViewCase` on latest row's case (any doctor's row) |
| GET | `/api/annotations/case/:caseId` | 205 | — | `userCanViewCase` |
| GET | `/api/annotations/:imageId/image` | 250 | — (streams decoded base64 PNG) | `userCanViewCase` |
| DELETE | `/api/annotations/:annotationId` | 293 | delete | **author only**, not current assignee |

Model: `case_annotations(id, case_id, image_id, doctor_id, annotation_data TEXT(json), annotated_image_data TEXT(base64 PNG data URL, 2× — large), annotations_count, created_at, updated_at)`, no FKs. Payload = fabric.js `canvas.toJSON(['_annotationType'])`; arrow = Group(Line + head) tagged `arrow`; circle = `fabric.Ellipse`; text = IText + untagged backing Rect. **No measurement tool** (G6).

### 1.8 `src/routes/reviews.js`

| Method | Path | Line | Responds | Ownership |
|---|---|---|---|---|
| GET | `/portal/doctor/:doctorId/reviews` | 162 | view `doctor_reviews` (visible reviews, **patient names unless anonymous**) | **no middleware — public** |
| GET | `/api/doctors/:doctorId/rating` | 219 | JSON avg/count/distribution | public |
| GET | `/portal/doctor/reviews` | 347 | 302 to own page | self |

### 1.9 Business rules that live only in a route or view (must be lifted before a JSON API "calls the same service")

1. Report completion orchestration (G4); empty-report rule (findings + impression required, dash/"—" counts as empty, doctor.js:6367/6500); combined-vs-split storage of the three fields duplicated 3× (3768, 6091, 6161).
2. Accept eligibility (payment, idempotency, anti-steal, allowed status, specialty-only-if-set, capacity overflow **reassigning** the case rather than refusing) — doctor.js:3232–3352; `canAccept` at 2390.
3. Pre-accept redaction whitelist (2626–2653) **plus** a second layer only in EJS (`portal_doctor_case.ejs:147-160, 469-486`) — the server payload is not redacted.
4. Paused-SLA display (frozen remainder when `sla_paused_at` + `sla_remaining_seconds`), countdown hiding (2551–2586); dashboard SLA banner thresholds (≤25% red, ≤50% amber, max 3) (554–610); `buildDashboardAlerts` thresholds (5257).
5. Earnings month merge (1427–1452) and "Approved / Not yet approved" tile semantics (296–316, `portal_doctor_earnings.ejs:7-8, 65-116`).
6. Turnaround whitelist + `standard` floor + legacy `priority`/`fast_track` → VIP (1122–1139, 1528); services save sets `onboarding_complete=true` on any save (1236–1281).
7. Reject-files: reason required, `additional_files_requested=true`, SLA pause, admin fan-out (3580–3672) — bypasses `case_lifecycle.markOrderRejectedFiles`.
8. Profile validation (years 0–60, grad year 1960–2030, specialty must exist), photo/signature size rules, R2 key conventions (4049–4110, 4300–4302, 4470–4471).
9. Error/flash code maps that form the de-facto error contract: `REPORT_SUBMIT_ERRORS` (2410), `RX_FLASH` (2478), accept `?msg=` codes (2178–2196).
10. Module-private helpers a JSON API would need (none exported): status constants, `specialtyMatchSql` 82, `countActiveCasesForDoctor` 88, `findNextAvailableDoctor` 98, `stripPricingFields` 140, case list builders 4785–5103, `mapPortalCaseItem` 4678, `enrichOrders` 4701, notification helpers 1671–1959 (duplicating the imported-but-unused `utils/notifications`), file/column probes 5555–5704, report text helpers 5720–5834, `persistReportTextOrThrow` 6076, `markOrderCompletedFallback` 6123. `formatDisplayDate` (5518) uses the **server's** local timezone.

Reusable services already outside routes: `case_lifecycle` (`transitionCase` 2112, `assignDoctor` 2954, `reassignCase` 3128, `pauseSla` 2727, `resumeSla` 2757, `markSlaBreach` 2489, `closeOpenDoctorAssignments` 2903, `slaHoursForTier` 1126), `sla_status.computeSla`, `acceptance_window`, `earnings_writer`, `earnings_calc.computeDoctorEarnings`, `doctor_service_catalog`, `services_coming_soon_sync`, `doctor_landing`, `addons/prescription_access`, `prescriptions_flag`, `video_flag`, `notify` (`queueNotification` 816, `notifyAdmins` 1323, `queueMultiChannelNotification` 1409), `audit.logOrderEvent`, `storage` (`uploadFile` 43, `getSignedDownloadUrl` 69, `deleteFile` 106), `report-generator.generateMedicalReportPdf` 1042, `case-intelligence.bridgeOrderFilesToCaseFiles` 62, `messaging.ensureConversation` 61.

---

## 2 · Conventions established by `src/routes/api/admin.js` (the pattern P1 must mirror)

### 2.1 Mounting
`server.js:1234` `app.use('/api/v1', apiV1)`. In `api_v1.js`: `apiResponse` (27) → `express.json({limit:'5mb'})` (30; **ineffective** — the global 1 MB parser at `middleware.js:100-118` runs first) → wildcard CORS, OPTIONS 204 (36–42) → `authLimiter` 20/15 min (47–54), `apiLimiter` 100/15 min per IP (57–81; exempts `/health`, `/cases/:id/payment`) → public `/auth` + `/health` → `router.use('/admin/auth', authLimiter)` + `router.use('/admin', adminRoutes)` (107–109) → **then** `requireJWT` + `requireRole('patient')` (113–114) → JSON error handler (204–213) → JSON 404 (217–219). A doctor router must mount beside `/admin`, **before** line 113. Also note the global 100/min limiter (`middleware.js:122-129`) — a polling app will hit the 15-minute `apiLimiter` first.

Inside `admin.js`: public `/auth/login` and `/auth/refresh`, then `router.use(requireJWT); router.use(requireRole('superadmin'))` (632–633).

### 2.2 Auth
- `generateAdminTokens(user)` (`middleware/requireJWT.js:105-124`): access `{id,email,role,name}` **15m**, refresh `{id,type:'refresh'}` **12h**, `JWT_SECRET`. Patient/doctor `generateTokens` (77–96): 15m / **30d**.
- Login (`admin.js:524-571`): email allowlist before any DB read; one generic 401 `INVALID_CREDENTIALS`; DB error → 500 `LOGIN_UNAVAILABLE` (never 401); bcrypt; stores refresh token; returns `{user:{id,email,name,role}, accessToken, refreshToken}`.
- Refresh with rotation (574–629): 401 `NO_REFRESH_TOKEN` / `INVALID_REFRESH` / `REFRESH_REVOKED`; lookup `WHERE id AND refresh_token AND role`; DB error → 500 `REFRESH_UNAVAILABLE` so the client can tell a blip from a logout; rotation-write failure → 500 and the client keeps old tokens.
- Revocation: rotation; `users.tokens_valid_after` vs `iat` via `access_revocation.isTokenStale` (60 s cache, fails open); password reset sets `tokens_valid_after = NOW()`.
- `requireJWT` (28–56): Bearer required → 401 `AUTH_REQUIRED` / `TOKEN_REVOKED` / `TOKEN_EXPIRED` / `INVALID_TOKEN`; attaches decoded payload as `req.user` **without a DB read**. `requireRole(role)` (62–72): wrong role → **403 `FORBIDDEN`**.
- **Gaps for doctors (G7, G8):** no `doctorBlockReason` in the API gate; single `users.refresh_token` slot; `refresh_token_expires_at` is never written; admin has no logout endpoint (app clears push token with `POST /push-token {token:null}`).
- Existing patient/doctor endpoints: `/api/v1/auth/{register,login,otp/request,otp/verify,refresh,me,logout,forgot-password,reset-password}`. Password login and reset are patient-only; OTP verify and refresh accept doctors. OTP limits: 60 s cooldown, 3 sends / 15 min, 5 verifies / 15 min (`auth.js:44-71`). **No magic-link exchange endpoint exists in the API** (the web `/magic-login/:token` is cookie-based).
- `tests/core/login-gate-coverage.test.js` is referenced in `login_gate.js` but **does not exist**.

### 2.3 Error shape
`res.fail(message, status=400, code)` → `{ "success": false, "error": "<message>", "code": "<CODE>" }` (`middleware/apiResponse.js:29-33`). 400 specific codes (`REASON_REQUIRED`, `TOO_MANY`…), 401 auth codes, 403 `FORBIDDEN`, 404 `NOT_FOUND`/`<ENTITY>_NOT_FOUND`, **409 for business-state conflicts** (`NOT_ASSIGNABLE`, `DOCTOR_AT_CAPACITY`, `ALREADY_PAUSED`, `DEADLINE_IN_PAST`…), 422 `VALIDATION_ERROR` (auth.js only), 429 `RATE_LIMITED`, 500 `<NOUN>_ERROR`. Business errors are thrown via `af(msg, http, code)` and mapped in every catch with `if (err && err.http) return res.fail(err.message, err.http, err.code)`. Unexpected errors: per-handler `try/catch` → `console.error('[admin/<slug>] failed:', err.message)` → generic 500; `logErrorToDb` used only for post-commit routing failures. Inconsistency: `inviteIpLimiter` returns `{ok:false, error:'too_many_requests'}` (321).

### 2.4 Success envelope
`res.ok(data, meta)` → `{ "success": true, "data": … }` (`apiResponse.js:17-21`); admin never passes `meta`. **Output keys camelCase**, hand-mapped from snake_case, nested objects (`payment`, `sla`, `assignment`, `counts`, `basis`). Input keys are mixed (camelCase `doctorId`, `dryRun`; snake_case on refund/doctor lifecycle; manual-queue accepts both). Dates via `toIso` → ISO-8601 UTC or `null` (273–276); business-day bucketing in Cairo via SQL constants (66–99, 391–393). Money via `money()` → Number EGP 2 dp, empty SUM → 0 (283–286); newer fields suffixed `Egp`; payment events use integer cents. Unknown is `null`, never a fabricated 0. Several endpoints return a `basis` object documenting definitions.

### 2.5 Pagination
Offset-based, no cursors. `GET /cases`: `limit` default 25, clamped 1–100, `offset ≥ 0`, response `{cases, total, limit, offset, counts}`; `total` from a real `COUNT(*)` over the same WHERE. Fixed caps elsewhere (`/events` ≤200, manual-queue 200, payouts 200) with true counts.

### 2.6 Validation
Hand-written; shallow checks (types, integer ranges, `.slice(0,N)`, allowlists) **before** `db.connect()` — tests assert `BEGIN` was never sent on invalid input. Deep checks inside the txn on a locked re-read. Dynamic filters push `$n` params; only module constants are interpolated.

### 2.7 Audit logging
No helper — inline SQL, **two rows per write, on the txn client, before COMMIT**: `order_events (id, order_id, label, meta json-string, at, actor_user_id, actor_role)` and `error_logs (id, level='audit', category='admin_audit', message, user_id, context{action,…})` (e.g. `admin.js:1919-1930`, `2178-2189`; `services/admin_refund.js:141-158`). Non-order writes write only the `error_logs` row. `GET /errors` filters out `level='audit'`. Exception: reassign commits via `case_lifecycle` first, audit best-effort after.

### 2.8 Idempotency & concurrency
No Idempotency-Key header. Pattern = `SELECT … FOR UPDATE` + status-guarded `UPDATE … WHERE <state> RETURNING` (0 rows → 409) + unique indexes. **A repeat call returns 409, not a silent no-op** (`ALREADY_PAUSED`, `REFUND_ALREADY_EXISTS`, `ALREADY_ASSIGNED_TO_DOCTOR`). `dryRun` on bulk assign runs the plan then `ROLLBACK`. SAVEPOINT per case in bulk. Notifications strictly **post-commit, best-effort** via `safeQueue`, reported per target in the response; dedupe keys fixed per event or timestamped for resends (`doctor_invite:<id>:<Date.now()>`). Side-effect services injected through the factory's 4th arg for test stubbing (485–519).

### 2.9 Transactions
Preferred for new writes: route opens `db.connect()`, calls `service(client, {…, actorId})`; the **service owns BEGIN/COMMIT/ROLLBACK**; route maps `err.http` and releases in `finally` (`admin.js:2299-2311`; `services/admin_doctor_pause.js:45-109`). When a write calls `case_lifecycle` (which takes its own pool connections), release the lock first to avoid self-deadlock (1835–1846). `pg.withTransaction` exists but admin.js doesn't use it.

### 2.10 Tests
- Tier 1 hermetic route tests — `tests/admin/admin_command_api.test.js`: `makeApp(stubs)` with the router factory on port 0; `txClient(handler)` records SQL and returns canned rows by regex; `failOn` regex injects a throw; asserts COMMIT-without-ROLLBACK on success, the reverse on fault, no BEGIN on invalid input, notification failure still commits.
- Tier 2 service tests on real local Postgres — `tests/admin/admin_doctor_pause.test.js`: per-process `SUFFIX` fixtures; `throwingClient(real, /error_logs/i)` Proxy faults the audit insert → assert the UPDATE rolled back and no audit row; repeat call → 409, row unchanged. Same in `admin_refund*.test.js`; `admin_bulk_assign.test.js` covers dryRun, savepoint fault, COMMIT fault.
- Source lint guards a doctor router will trip: `tests/lint/kpi-endpoints-fail-loud.test.js` (money reads must use `mustGet/mustAll`), `kpi-predicates-shared`, `orders-table-readers-allowlist` (`-- include-deleted-ok:` comment), `paused-doctors-excluded-everywhere`.
- Prod proof: `BEGIN; <writes>; SELECT asserts; ROLLBACK` via Supabase MCP (caught a real type bug the mocks missed).
- Local baseline: gate on `env DATABASE_URL= node tests/run.js` (see memory `project_test_suite_baseline`).

### 2.11 Style
`/** … */` header naming namespace/mount/gates/factory signature; `'use strict'`; top-level `const` requires, lazy requires to break cycles; `module.exports = function (db, helpers, deploy, deps) { … return router; }`; section dividers `// ─── METHOD /path (description) ───` followed by a "why" comment; change notes tagged `AUDIT-<TOPIC> (YYYY-MM-DD)`; SCREAMING_SNAKE constants; SQL in template literals, uppercase keywords, `$n` params, aliases `o/p/d/sp/sv`, case-folded status compares `LOWER(COALESCE(status,''))`, reads on `orders_active`, writes on `orders … AND deleted_at IS NULL`, `COALESCE(SUM(…),0)`, `::timestamptz` casts. Log prefix `[admin/<slug>]`. **Stale header** (`admin.js:4-8`) still calls the router "READ-ONLY"; it has 17 writes.

### 2.12 `admin.js` endpoint list
Public: `POST /auth/login` 524, `POST /auth/refresh` 574. Gated: `GET /health` 639 · `GET /pulse` 734 · `GET /refunds` 870 · `GET /revenue` 1055 · `GET /ai-usage` 1127 · `GET /cases` 1181 · `GET /cases/:id` 1354 · `GET /cases/:id/candidates` 1546 · `GET /doctors` 1613 · `POST /cases/:id/assign` 1738 · `POST /cases/:id/sla-override` 2113 · `POST /cases/bulk-auto-assign` 2224 · `POST /cases/:id/refund` 2261 · `POST /doctors/:id/pause` 2296 · `/reactivate` 2314 · `/approve` 2335 · `/reject` 2360 · `/invite` 2420 · `POST /refunds/:id/approve` 2513 · `/deny` 2587 · `/mark-paid` 2663 · `GET /payment-events` 2761 · `POST /payment-events/:id/review` 2830 · `POST /push-token` 2858 · `GET /files/:fileId` 2909 · `GET /breach-cost` 3010 · `GET /manual-queue` 3264 · `POST /manual-queue/:id/approve` 3442 · `/unsuitable` 3789 · `GET /events` 4001 · `GET /payouts` 4149 · `GET /errors` 4330.

---

## 3 · Acceptance window: computed, written, swept

### 3.1 Computation
Single table `src/acceptance_window.js:38-42`: **urgent 15 min · vip 45 min · standard 120 min**. No env override. Tier resolution `acceptanceMinutesForOrder`: `urgency_tier || tier`, else `sla_hours` buckets (≤4 urgent, ≤24 vip, else standard); aliases `fast_track/fasttrack/24hr → vip`, `normal/regular/'' → standard`, unknown → standard. SLA hours are separately canonical in `case_lifecycle.js:1119-1129` (urgent 4 · vip 18 · fast_track 18 · standard 48) — matches the brief.

Callers: `case_lifecycle.assignDoctor` (3019–3020; reached from `auto_assign.js:331`, `services/assign_case.js:188`, `routes/admin.js:2360`, doctor accept), `notify/broadcast.js:124-125`, `workers/acceptance_watcher.js:168` (alert copy) and 391–392, `routes/api/_assign_helpers.js:226-228` (`acceptByIsoForOrder`, used by `api/admin.js:1901` and `services/admin_bulk_assign.js:193`). The old per-file tables are gone.

**⚠ Divergence A — broadcast resolves tier differently.** `broadcast.determineTier` (43–71) reads `urgency_tier → sla_hours → sla_24hr_selected → urgency_flag → standard`. Everyone else reads `urgency_tier || tier`, and `orders.tier` defaults to `'standard'` (always truthy, `migrations/010:24`). An order with NULL `urgency_tier` and `sla_hours=4` gets **15 min** from broadcast but **120 min** from an assign that runs first. Migration 105 reportedly backfilled existing rows; new NULL-`urgency_tier` rows remain exposed. Stale comments still say `tier || urgency_tier` (acceptance_watcher.js:23, _assign_helpers.js:221, admin_bulk_assign.js:82, api/admin.js:1758, broadcast.js:31,39).

### 3.2 Writes

| Site | Function | Writes | Both columns atomic? |
|---|---|---|---|
| `case_lifecycle.js:3033` (+ INSERT 3059–3080) | `assignDoctor` | `orders.acceptance_deadline_at` and `doctor_assignments.accept_by_at` = now + window | **No** — separate statements; INSERT failure **swallowed** (3081–3083) |
| `api/admin.js:1902-1911` | Command first-assign | both | Yes (BEGIN 1755 / COMMIT 1930) |
| `api/admin.js:1867` | Command reassign | via `reassignCase` → `assignDoctor` | No |
| `services/admin_bulk_assign.js:194-204` | bulk assign | both | Yes (+ SAVEPOINT) |
| `workers/acceptance_watcher.js:393-403`, INSERT 453–457 | `autoAssignOrder` | both | No, but compensating rollback UPDATE (471–483) |
| `notify/broadcast.js:127-137` | `broadcastOrderToSpecialty` | orders only, guarded `doctor_id IS NULL`; also writes `tier` | n/a |
| `workers/acceptance_watcher.js:354-361` | no-doctor backoff | orders only, **retry timer** `now + 4·2ⁿ` min (cap 30) | n/a |
| `case_lifecycle.js:3281-3287` | `reassignCase(id, null)` | orders only, **retry timer** | n/a |

### 3.3 Sweeps

- **`workers/acceptance_watcher.js`** (every 2 min; started `server.js:294,1496`) — selects `doctor_id IS NULL AND acceptance_deadline_at < NOW()` with paid/captured payment and status in (pending, available, submitted, new, paid, reassigned) (36–67). Per case: urgent-unaccepted alert, then `autoAssignOrder` (excludes last holder for 60 min, least-loaded eligible doctor); if none, back off the column. **Covers unassigned/broadcast cases only.**
- **`case_sla_worker.fetchDoctorTimeouts`** (433–474) — status `assigned`, `doctor_id` set, `accepted_at IS NULL`, open latest `doctor_assignments` row with `accept_by_at IS NOT NULL AND accept_by_at <= now`. `handleDoctorTimeout` (567–623) closes the row, finds an alternate, `reassignCase(id, next|null)`. **Covers assigned cases only, reads only `accept_by_at`.**
- Legacy NULL-`accept_by_at` rows are counted, never acted on (64–86, 481–501, 846–887); fix is a manual backfill.
- `fetchStrandedPaidCases` (653–667) re-broadcasts paid, doctor-less, NULL-deadline cases older than 10 min.
- `server.js:1413-1423`: old `sweepExpiredDoctorAccepts` removed; `handleDoctorTimeout` is sole owner.

**⚠ Divergence B — a case can fall between the two sweeps.** If `assignDoctor`'s swallowed INSERT fails, the case is ASSIGNED with a doctor and a future `acceptance_deadline_at` but no assignment row → matches neither sweep → never times out.

### 3.4 SLA clock start (acceptance)
doctor.js:3213 → (PAID) `assignDoctor` → `withTransaction` `transitionCase(IN_REVIEW)` → `case_lifecycle.js:2162-2166` sets `accepted_at` if missing; 2169–2237 sets `deadline_at = accepted_at + sla_hours` (only if missing/≤ acceptance and not paused); 2240 `closeOpenDoctorAssignments` stamps `doctor_assignments.completed_at`. **Nothing writes `doctor_assignments.accepted_at`**, so `completed_at` means accepted, timed-out and reassigned alike.

### 3.5 Types and timezone
Both created naive (`migrations/014`, `010`); `081_timestamptz_sla_columns.sql:108-137` converted them to `timestamptz` via `AT TIME ZONE 'UTC'` (prod confirms `tstz` for both). Writes are JS `toISOString()`; session pinned to UTC (`pg.js:122,231`). `doctor_earnings.created_at` / `paid_at` are still naive `timestamp`.

### 3.6 Decline
**No doctor decline action exists** (G3). A case leaves an unaccepting doctor only by timeout. `doctor.js:384` defines a `doctor_rejected` activity label that nothing writes for cases.

### 3.7 What the doctor UI reads (P3 countdown)
Dashboard (`portal_doctor_dashboard.ejs:81`) and cases list (`portal_doctor_cases.ejs:45`) read **`orders.acceptance_deadline_at`**; the case page (doctor.js:2763–2785) reads **`doctor_assignments.accept_by_at`** (latest row for *this doctor*, possibly a previous assignment). Equal on the happy path only; on unassigned pool cases the orders column may be a broadcast deadline or a **retry timer**. P1 must pick one server-owned field and define it.

---

## 4 · Earnings aggregation — ⚠⚠ NOT ONE CODE PATH ⚠⚠

> **Verdict: there is no shared aggregation.** The *writer* is shared (`services/earnings_writer.js` + `services/earnings_calc.computeDoctorEarnings`). The *reader* is hand-written SQL in at least eight places, with different status filters, different ledgers, different month boundaries and different timezones. The doctor's earnings page and finance's "owed" figure can and do disagree today. Per brief §A this is a bug, and per P6 fixing it is in scope — but see G2: the rules it should implement need a decision first.

### 4.1 Doctor-facing readers

| # | Location | Ledgers | Status filter | Bucketing |
|---|---|---|---|---|
| D1 | Earnings page `doctor.js:1324-1467` | `doctor_earnings` + `addon_earnings` | split paid / pending / reassigned | `date_trunc('month', created_at)` — **UTC, acceptance time** |
| D2 | Dashboard month tile `doctor.js:296-316` | both | "Approved" = paid; "Not yet approved" = pending **+ reassigned** | UTC month on `created_at` |
| D3 | Dashboard recent earning `doctor.js:725-740` | `doctor_earnings` | paid | latest |
| D4 | Doctor analytics `routes/analytics.js:300-316` | **`doctor_earnings` only** | **none** | `created_at >= startDate`, `TO_CHAR` month |
| D5 | Video doctor page `routes/video.js:2243-2253` | `doctor_earnings` only | total: pending+paid; month: **none** | dayjs start of month |

No doctor earnings endpoint exists under `routes/api/`.

### 4.2 Finance / "owed" readers

| # | Location | Ledgers | Filter | Bucketing |
|---|---|---|---|---|
| F1 | `services/superadmin_dashboard.js:579-599` (finance payouts) | both | pending | none (14-day cycle count) |
| F2 | `superadmin_dashboard.js:736-752` (leaderboard) | both | pending | none |
| F3 | **`api/admin.js:4149-4225` Command `GET /payouts`** | both | owed = pending; paid-this-month = paid with `COALESCE(paid_at, created_at)` | **Cairo month** |
| F4 | `routes/admin.js:1170-1178` (/admin tile) | both | pending | none |
| F5 | `superadmin_dashboard.js:527` gross profit MTD | **`orders.price - orders.doctor_fee`**, not the ledger | payment collected | month on `orders.created_at` |
| F6 | `api/admin.js:3123-3143` breach-cost clawback | `doctor_earnings` main rows | `clawback_applied_at` set | Cairo |
| F7 | `services/doctor_pause.js:83-92` | `earn-reassign-%` rows | reassigned, excl. `admin_manual` | 30 days |

### 4.3 Concrete disagreements

1. **Reassignment token.** `markPartialPayOnReassignment` zeroes the original row and inserts an `earn-reassign-*` row at 10% with `status='reassigned'` (`earnings_writer.js:789-806`). Nothing ever moves it to pending/paid. The doctor sees it (D2 counts it as "Not yet approved"; D1 shows "+ X EGP reassigned"); **F1–F4 filter `pending`, so finance never owes it.** The justification at `api/admin.js:4126-4129` ("avoid double count") became false when the original row started being zeroed.
2. **Add-ons never settle.** `addon_earnings` is only ever inserted `pending` (`addons/prescription.js:136-141`, `addons/video_consult.js:127-132`); zero `UPDATE addon_earnings` in the codebase. Finance shows add-ons owed forever; the doctor's "Approved" figure never includes them.
3. **Month boundary.** D1/D2 bucket by `created_at` (acceptance) in UTC; F3 buckets paid by `paid_at` (completion) in Cairo. A case accepted 31 Aug and completed 1 Sep lands in August for the doctor and September for Command; late-evening Cairo completions on the last day shift months too.
4. **Status filters differ** across D4/D5 vs D1/D2; D4 omits add-ons entirely.
5. **F5 ignores the ledger** (no uplift share, add-ons, clawbacks or partial pay) so it cannot reconcile.
6. **"Paid" ≠ money transferred.** `status='paid'` is set at report completion (`earnings_writer.js:317-326` via doctor.js:6679), acknowledged at `api/admin.js:4130-4134` and `portal_doctor_earnings.ejs:79-82`. So "owed" = accepted-not-completed, and **completed-but-not-yet-transferred money appears in no owed figure**. There is no payout-batch concept for "paid the last working day of the month".
7. **Video / no-show earnings** (`video.js:1453,1794`, `video_scheduler.js:142`) are only written pending and never updated (inert today — 0 appointments).

Prod snapshot (aggregate only): `doctor_earnings` = 2 rows, both `reassigned`; `addon_earnings` = 0; `refunds` = 1 `paid`. So today's figures are all near zero and a canonical module can be introduced before real money flows.

### 4.4 Policy (`docs/PAYOUT_AND_URGENCY_POLICY.md`) vs code

| Rule | Code | Status |
|---|---|---|
| Fixed `doctor_fee` per service + 30% of urgency uplift | `orders.doctor_fee` snapshot at creation (`api/cases.js:366,377`); `computeDoctorEarnings` base + `uplift × pct/100` with `services.urgency_uplift_doctor_pct` (default 30) | ✅ implemented. `recomputeOnRefund` hardcodes 30 (`earnings_writer.js:603-607`), ignoring per-service override. Doc §1 says "20% of base"; code trusts the catalog's absolute fee |
| Reassigned away = 0 | original row → 0, **plus a 10% token row** of `earned_amount` (base + uplift) (`earnings_writer.js:41, 761-806`); skipped if already paid; an unaccepted timeout has no row → 0 | ❌ not as stated |
| SLA breach refunds uplift, reverses only the uplift share; base stands if delivered | Stage 1 `recomputeOnBreach` zeroes the uplift share (368–461). Stage 2 at refund mark-paid (`reason='sla_breach'`) sets `earned_amount = 0` — **full clawback** (594–598). `handleBreach` also calls `reassignCase` → token row. Doc §4.A (full clawback) contradicts §5 Example D (keeps 600 base) | ⚠ partial; doc self-contradicts |
| Patient/operator refund clawback | code `full × (1 − 0.9 × ratio)` (599–652); doc says flat 90% | ⚠ diverges |
| Paid last working day of month | `paid` set at report submit; no payout batch | ❌ not implemented |
| Per-case component breakdown on earnings page (doc §7) | monthly rollups only | ❌ not implemented |

**Recommendation for P6 (not built):** one module, e.g. `src/services/earnings_ledger.js`, exposing a per-doctor summary (`pending`, `completed`/approved, `reassignedToken`, `addonPending`, `clawedBack`, per-case lines) with an explicit Cairo month boundary and an explicit bucketing basis, consumed by D1–D5 and F1–F4. `api/admin.js GET /payouts` is the most complete and best-documented query and the natural seed. **Blocked on decisions:** does the 10% token exist? when does a row become "paid" (report submit vs payout run)? do add-ons settle, and when? which clawback formula is canonical?

---

## 5 · Tables and columns the doctor app will touch

Source: production `information_schema` via Supabase MCP, 2026-09-15. `!` = NOT NULL. `ts` = timestamp without tz, `tstz` = with tz. Only columns the app needs are listed; full definitions are in prod.

### 5.1 Core case flow

| Table | Columns needed | Notes |
|---|---|---|
| `orders` (41 rows) | `id!`, `reference_id`, `patient_id`, `doctor_id` (text), `specialty_id`, `service_id`, `status`, `payment_status`, `urgency_tier`, `tier`, `sla_hours`, `urgency_uplift_amount!` (numeric), `doctor_fee`, `accepted_at` tstz, `deadline_at` tstz, `acceptance_deadline_at` tstz, `sla_paused_at` tstz, `sla_remaining_seconds`, `breached_at` tstz, `completed_at` tstz, `clinical_question`, `medical_history`, `current_medications`, `notes`, `language`, `diagnosis_text`, `impression_text`, `recommendation_text`, `report_url`, `additional_files_requested`, `uploads_locked`, `intelligence_status`, `addons_json`, `reassigned_to_doctor_id`, `reassigned_at`, `reassignment_reason`, `assignment_status`, `deleted_at`, `created_at`, `updated_at` | Read via **`orders_active`** view. **No CHECK on `status`**; prod values: `expired_unpaid` 34, `cancelled` 3, `draft` 2, `refunded` 1, `completed` 1. Mixed case (`IN_REVIEW` written upper by lifecycle). Only unique indexes: pk, `paymob_transaction_id` |
| `doctor_assignments` (2) | `id!`, `case_id`, `doctor_id`, `assigned_at` tstz, `accepted_at` tstz (**never written**), `completed_at` tstz, `accept_by_at` tstz, `reassigned_from_doctor_id` | pk only; no FK, no unique on open row |
| `case_events` (84) | `id!`, `case_id`, `event_type`, `event_payload` text, `created_at` ts | lifecycle log |
| `order_events` (33) | `id!`, `order_id`, `label`, `meta` text(json), `at` ts, `actor_user_id`, `actor_role` | **audit table** (admin pattern) + timeline |
| `order_timeline` (12) | `id!`, `order_id!`, `status!`, `description`, `actor`, `created_at` ts | patient-visible timeline |
| `error_logs` (1195) | `id`, `level` (`'audit'`), `category`, `message`, `user_id`, `context` | second audit row per write |
| `cases` (12), `case_context` (0) | legacy parallel case table | not used by doctor routes read here; do not build on |

### 5.2 Files and intelligence

| Table | Columns needed | Notes |
|---|---|---|
| `order_files` (27) | `id!`, `order_id`, `url`, `label`, `filename`, `mime_type`, `size`, `created_at` ts, `ai_quality_status`, `ai_quality_note`, `uploadcare_uuid` | pk only |
| `order_additional_files` (0) | `id!`, `order_id`, `file_url`, `file_key`, `label`, `uploaded_at` ts | pk only |
| `case_files` (4) | `id!`, `case_id`, `filename`, `file_type`, `mime_type`, `storage_path`, `file_size_bytes`, `document_category`, `language_detected`, `processing_status`, `processed_at` ts, `is_valid` | pipeline table; bridged by `bridgeOrderFilesToCaseFiles` |
| `file_ai_checks` (0) | `file_id`, `order_id`, `is_medical_image`, `image_quality`, `quality_issues`, `detected_scan_type`, `matches_expected`, `confidence`, `recommendation` | |
| `case_extractions` (9) | `id!`, `case_id!` (**UNIQUE**), `lab_values` jsonb, `patient_info` jsonb, `documents_inventory` jsonb, `missing_documents` jsonb, `extraction_metadata` jsonb, `created_at`, `updated_at` | librarian, not diagnostician |
| `case_annotations` (0) | `id!`, `case_id!`, `image_id!`, `doctor_id!`, `annotation_data` text(fabric JSON), `annotated_image_data` text(base64 PNG), `annotations_count`, `created_at`, `updated_at` | **no unique (image_id, doctor_id)**, no FKs |
| `report_exports` (0) | `id!`, `case_id!`, `file_path!`, `created_by!`, `created_at` | |
| `medical_records` (0) | `id!`, `patient_id!`, `record_type!`, `title!`, `description`, `file_url`, `file_name`, `date_of_record` text, `provider`, `tags`, `is_shared_with_doctors`, `is_hidden`, `order_id`, `doctor_id`, `created_at` | sharing is per patient |

### 5.3 Doctor, practice, money, comms

| Table | Columns needed | Notes |
|---|---|---|
| `users` (59: 32 doctor, 26 patient, 1 superadmin) | `id!`, `role`, `email` (UNIQUE), `phone` (UNIQUE partial), `country_code`, `name`, `name_ar`, `display_name`, `lang`, `specialty_id`, `sub_specialties` jsonb, `bio`, `bio_ar`, `years_of_experience`, `medical_license_number`, `license_country`, `medical_school`, `graduation_year`, `affiliations` jsonb, `certifications` jsonb, `spoken_languages` jsonb, `profile_photo_url`, `signature_url`, `date_of_birth`, `gender`, `is_active`, `pending_approval`, `rejection_reason`, `is_paused`, `paused_at`, `pause_reason`, `onboarding_complete`, `first_login_at`, `sla_tiers_supported` jsonb, `sla_tiers_confirmed_at` tstz, `max_active_cases`, `max_active_cases_urgent`, `is_available`, `last_seen_at`, `notify_whatsapp`, `muted_until`, `push_token`, `refresh_token`, `refresh_token_expires_at`, `tokens_valid_after` tstz | **No appearance/theme column** (G9). Single `refresh_token` and `push_token` slots (G8). `national_id_encrypted` bytea — never expose |
| `specialties` (28) | `id!`, `name`, `name_ar`, `description`, `description_ar`, `is_visible` | |
| `services` (183) | `id!`, `specialty_id`, `code`, `name`, `name_ar`, `doctor_fee`, `sla_hours`, `vip_multiplier!`, `urgent_multiplier!`, `urgency_uplift_doctor_pct!`, `coming_soon!`, `is_visible` | |
| `doctor_services` (329) | `doctor_id!`, `service_id!`, `created_at` | pk (doctor_id, service_id) |
| `doctor_specialties` (37) | `id!`, `doctor_id!`, `specialty_id!` | cross-specialty union |
| `doctor_availability` (0) | `id!`, `doctor_id!`, `day_of_week!` int, `start_time!` text, `end_time!` text, `timezone`, `is_active` | times are text, unvalidated |
| `doctor_earnings` (2) | `id!` (`earn-main-*`, `earn-reassign-*`, `earn-*`, `earn-noshow-*`), `doctor_id!`, **`appointment_id!`** (holds the order id for case rows), `gross_amount!`, `commission_pct!`, `earned_amount!`, `status` (pending/paid/reassigned), `paid_at` ts, `created_at` ts, `reassigned_to_earning_id`, `reassignment_reason`, `clawback_reason`, `clawback_applied_at` ts | naive timestamps; only unique index is partial for video rows (excludes `earn-main-%`/`earn-reassign-%`) — **no DB-level one-main-row-per-case guarantee** |
| `addon_earnings` (0) | `id!` uuid, `order_addon_id!`, `doctor_id!`, `gross_amount_egp!`, `commission_pct!`, `earned_amount_egp!`, `status!`, `created_at!` tstz, `paid_at` tstz | never settled |
| `order_addons` (0), `addon_services` (2) | add-on status, commission snapshot | flagged off |
| `refunds` (1) | `order_id`, `reason`, `status`, `approved_amount`, `paid_at` | for clawback lines with reason |
| `conversations` (2) | `id!`, `order_id`, `patient_id!`, `doctor_id!`, `status`, `created_at`, `updated_at`, `closed_at` | |
| `messages` (1) | `id!`, `conversation_id!`, `sender_id!`, `sender_role!`, `content!`, `message_type`, `file_url`, `file_key`, `file_name`, `is_read`, `created_at` | single `is_read` |
| `chat_reports` (0) | `conversation_id!`, `message_id`, `reported_by!`, `reporter_role!`, `reason!`, `details` | |
| `notifications` (462: email 170, whatsapp 161, internal 131) | `id!`, `to_user_id`, `order_id`, `channel`, `template`, `type`, `title`, `message`, `data` text, `status`, `is_read`, `at` ts, `dedupe_key`, `attempts`, `retry_after` | **UNIQUE (dedupe_key, channel, to_user_id) WHERE dedupe_key IS NOT NULL** — fixed keys drop resends (brief §A rule) |
| `reviews` (0) | `id!`, `order_id!` (UNIQUE), `doctor_id!`, `rating!` (CHECK 1–5), `review_text`, `is_anonymous`, `is_visible`, `created_at` | |
| `otp_codes` (11), `password_reset_tokens` (40) | auth | |
| `admin_settings` (5) | `key!`, `value!` | platform flags live here and in env |

Flagged-off, build-disabled: `appointments`, `appointment_payments`, `video_calls`, `prescriptions`, `prescribed_medications_log`.

**Storage that does not exist yet** (needs migrations in later phases): appearance preference (G9), multi-device refresh tokens / push tokens (G8), phrase library (P5), doctor decline record with reason (G3), measurement annotations (G6), report-draft local-autosave server copy (today autosave writes straight into the three `orders` text columns).

### 5.4 Security advisory (surfaced, not applied)
Supabase reports RLS **disabled** on `public.deleted_users`, `public.email_delivery_events`, `public.email_suppressions`. Remediation offered by the advisory (do not run blindly — enabling with no policies default-denies, which is the intended posture elsewhere but must be checked against whatever reads these tables through a non-owner role):
```sql
ALTER TABLE "public"."deleted_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."email_delivery_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."email_suppressions" ENABLE ROW LEVEL SECURITY;
```
The portal connects as owner and bypasses RLS, so app behaviour is unaffected; the exposure is via the Supabase anon/authenticated roles. Belongs with P8.

---

## 6 · Local checkouts

| Repo | Local path | Branch @ HEAD | Working tree | Notes |
|---|---|---|---|---|
| `low-iq-dev/tashkheesa-command` | `/Users/ziadelwahsh/Desktop/01 WORK/Tashkheesa/App/tashkheesa-command` | `main` @ `034608d` (2026-07-28, "feat(push): superadmin push registration…") | **3 uncommitted**: `app.json`, `eas.json`, `tsconfig.json` | bundle `com.tashkheesa.admin`, `expo ^54.0.0` |
| `low-iq-dev/Tashkheesa-app` | `/Users/ziadelwahsh/Desktop/01 WORK/Tashkheesa/App/tashkheesa-app` | `fix/app-audit-2026-08` @ `e1f6047f` (2026-08-25) | clean | bundle `com.tashkheesa.patient`, `expo ~54.0.35`. **Not on main.** |
| `tashkheesa-doctor` | — | — | — | **Not on disk.** (`/Users/ziadelwahsh/tashkheesa-doctors` is the PR #21 `/api/v1/admin/doctors` worktree, unrelated.) |

- Neither app repo was fetched, so "behind remote" is unknown; states above are local only.
- `/Users/ziadelwahsh/Desktop/01 WORK/Tashkheesa/App/→ app-code (live repo)` is a **broken symlink to `/Users/macmini/Desktop/Tashkheesa/App/tashkheesa-app`**. The "live" patient-app checkout appears to be on the Mac mini; the MacBook copy may be stale. Confirm which machine holds the current patient app before P2 copies patterns from it.
- Also in that folder: `tashkheesa-app.tar.gz` and loose icon/splash PNGs.

---

## 7 · Brief corrections (for §A before P1)

| Brief says | Reality at `d255cf4b` |
|---|---|
| 59 public tables, RLS on all | 67 tables; RLS off on 3 (§5.4) |
| Order statuses: paid, assigned, accepted, in_progress, awaiting_files, completed, auto_approved, refunded, cancelled | No CHECK constraint. Code also uses `new`, `submitted`, `in_review`, `review`, `rejected_files`, `breached`, `sla_breach`, `reassigned`, `draft`, `expired_unpaid`; case-mixed (`IN_REVIEW`). `in_progress`/`auto_approved` not seen in the doctor routes read |
| PDF carries the consultant's stored signature | Typed name on a rule (G5) |
| Annotation tools arrow, ellipse, measurement | No measurement (G6) |
| Decline with reason | Does not exist (G3) |
| Doctor JWT: 12h rotating refresh | Doctor tokens today mint 30d refresh via patient OTP path (G7) |
| Passwordless magic-link exchange mints tokens | No API magic-link exchange exists; web `/magic-login/:token` is cookie-only (and has open items per memory `project_magic_login_backdoor`: T25/T27/T28) |
| Earnings and owed read one shared aggregation | 8+ readers (§4) |
| Reassigned away earns 0 | 10% token (§4.4) |
| "Acceptance watcher sweeps the orders column" | True, but only for unassigned cases; assigned-case timeouts are `case_sla_worker` on `accept_by_at` (§3.3) |
| Appearance stored on profile | No column (G9) |
| "never fast track" | Still in `case_intake_pricing.js:157` error copy |

---

## 8 · Security findings that constrain P1's ownership rules

Fail-closed rule in P1 ("every case route asserts `String(order.doctor_id) === doctorId`") is right, but it is **not sufficient on its own** — several existing leaks are about *accepted vs assigned*, *author vs current assignee*, and *pool visibility*.

- **C1 — pre-accept brief visible to any doctor** (doctor.js:2294, 2315). `isViewableByThisDoctor = isAcceptedByThisDoctor || isUnaccepted` — any doctor with a case id can open any unassigned case in `new/submitted/paid/assigned/accepted`, any specialty, paid or not. Brief shows clinical question, history, medications, age/sex; server payload also carries real file names/ids, other doctors' annotation names, `fileAiChecks`. File bytes stay protected by `/files/:id`. P3's offer screen must define exactly who may see an offer (assigned doctor + specialty-matched, paid pool) and what fields.
- **C2 — intelligence page skips the accepted gate** (doctor.js:2937): assigned-not-accepted doctor sees patient name, extractions, file names, raw `storage_path`; also readable on cancelled cases.
- **C3 — accept with NULL specialty** (doctor.js:3278): specialty check runs only `if (orderSpecialtyId && !assignedDoctorId)`, so a pool case with no specialty is acceptable by any doctor with the URL. `assignDoctor` commits outside the accept txn (partial state on transition failure).
- **C4 — no status gate on accept/pool**: paused, not-onboarded, service-mismatched and tier-mismatched doctors can self-accept pool cases. The assignment gate (memory `project_doctor_my_services`) is not applied to self-service accept.
- **C5 — revocation gate fails open** (`middleware.js:414`, 60 s cache); `rejection_reason` never evaluated. API `requireJWT` has no doctor-block check at all.
- **Report submit / reject-files / diagnosis save**: no status guard beyond `completed`; check-then-write races (`UPDATE … WHERE id` only, ownership read separately); report submit not idempotent (G4).
- **Author-not-assignee**: annotation delete (annotations.js:311), prescription PUT/detail/download (prescriptions.js:589, 563, 650), all video participant checks (video.js:75) — a reassigned doctor keeps access. Annotation save never ties `imageId` to `caseId` (annotations.js:80-129), allowing overwrite/hiding of another case's annotation with a guessable image id.
- **Medical records** shared per patient, not per case (medical_records.js:217-222).
- **Public** `GET /portal/doctor/:doctorId/reviews` exposes non-anonymous patient names without auth (reviews.js:162).
- **GET side effects** that break mobile prefetch: alerts page marks all read (doctor.js:1972), thread GET marks messages read (messaging.js:162), dashboard GET stamps `first_login_at` (643).

None of these were fixed (read-only phase). Several are pre-existing web issues independent of the app; they may deserve their own tickets rather than riding in P1.

---

## 9 · Decisions needed at the gate

1. **Payout rules (G2):** keep or remove the 10% reassignment token; when an earnings row becomes "paid" (report submit vs month-end payout run); whether/when add-ons settle; which SLA-breach clawback is canonical (§4.A full vs §5 Ex. D uplift-only); flat 90% vs `1 − 0.9 × ratio`. Then fix the policy doc's self-contradiction.
2. **Earnings canonical reader (G1):** approve building `earnings_ledger` (seeded from `GET /payouts`) as a P1 prerequisite, or defer to P6 and ship P1 without an earnings endpoint.
3. **Decline (G3):** is decline a new lifecycle action (state, who gets it next, earnings effect, cooldown, audit), and does it belong in P1 or P3?
4. **Report service extraction (G4):** approve lifting `handlePortalDoctorGenerateReport` into a service (with idempotency + status guard) as part of P1, with the EJS route switched to call it — this *is* a behaviour-preserving change to an EJS route and needs explicit OK against P1's "no change in behaviour" DoD.
5. **Signature on PDF (G5):** add the stored signature image to the report PDF, or change the brief.
6. **Measurement tool (G6):** new tool + payload format, or drop from v1.
7. **Doctor auth (G7/G8):** separate doctor OTP/magic-link endpoints that never create a patient account and mint 15m/12h; multi-device refresh storage (new table) vs single slot; add doctor-block check to the API gate.
8. **Acceptance countdown source (G11):** which field the API exposes as the offer deadline, and whether to fix Divergence A (broadcast tier) and B (swallowed INSERT) first.
9. **Pre-existing exposure (G10, §8):** fix in the web portal first as separate PRs, or only avoid replicating in the API.
10. **Patient-app source of truth (§6):** which machine holds the live `Tashkheesa-app`.
11. **RLS on 3 tables (§5.4):** apply now, or fold into P8.
