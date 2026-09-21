# Claude Code brief — Tashkheesa doctor app

Build the third Tashkheesa app: a doctor-facing mobile app with the doctor portal's functionality, easier to navigate.

**How to use this file.** Section A is context — paste it at the top of every new CC session, or drop this file in the repo and tell CC to read it first. Sections P0–P8 are the phase prompts. Paste **one phase per session**, in order. Do not paste two phases at once; each phase ends at a gate that Ziad clears before the next begins.

---

# A · Context — paste this at the top of every session

You are working on Tashkheesa, an Egyptian medical second-opinion platform operated under MedTec within Shifa Hospital Group. Patients upload scans and reports; a named consultant writes a bilingual (Arabic/English) second-opinion report inside an SLA tier. We are building a doctor-facing mobile app — the third app after the patient app and the Command superadmin app.

## Repos and machines

- **Portal (backend + web):** `github.com/low-iq-dev/tashkheesa` — local `/Users/ziadelwahsh/tashkheesa-portal`. Node/Express/EJS, Supabase Postgres project `wvmhliweujmhlzknmuzh`, Cloudflare R2 for files, Paymob for payments, Render auto-deploys from `main`. ~20 sibling `tashkheesa-*` folders are per-feature worktrees — do not touch them.
- **Command app (the pattern to copy):** `github.com/low-iq-dev/tashkheesa-command`, Expo SDK 54, bundle `com.tashkheesa.admin`. Its backend lives in the portal at `src/routes/api/admin.js`, mounted at `/api/v1/admin`. Clone it if it is not on disk.
- **Patient app:** `github.com/low-iq-dev/Tashkheesa-app`, Expo, bundle `com.tashkheesa.patient`.
- **Doctor app (new, this brief):** `tashkheesa-doctor`, Expo + TypeScript, bundle `com.tashkheesa.doctor`, Apple team `GUB3WWYZN5`.
- Prefer the MacBook for git — SSH push is zero-setup there.

## Non-negotiable working rules

- **Investigate before building.** Report findings and wait for approval before writing code. This has twice caught scope that already existed.
- **Never push without explicit approval.** Never merge to `main` without approval.
- **Production DML:** write it, dry-run it inside `DO $$ BEGIN … RAISE EXCEPTION 'DRYRUN_ROLLBACK_OK: …' END $$`, show the output. Ziad runs the `COMMIT`.
- **One vertical fully proven before the next:** backend PR → prod dry-run → merge → deploy-verify → app screen → device round-trip → commit. Never bolt a new slice onto a long session tail.
- Separate commits per repo. Run `whoami` at the start of a shell session — the tooling silently switches between the MacBook and the Mac mini.
- Use unique timestamped dedupe keys for anything resendable: `'doctor_invite:' + id + ':' + Date.now()`. Fixed keys silently drop every resend.
- The `internal` channel (in-app bell) is always on; it is a system record, not a contact channel. Operators toggle email/WhatsApp only.

## Domain facts the app must not get wrong

- **SLA tiers, exact names:** Standard 48h · VIP 18h · Urgent 4h. Never "fast track", never 24h/72h.
- **The SLA clock starts at ACCEPTANCE, not assignment.** The acceptance window itself is per-tier and lives in both `doctor_assignments.accept_by_at` and `orders.acceptance_deadline_at`; the acceptance watcher sweeps the orders column.
- **Order statuses in play:** `paid`, `assigned`, `accepted`, `in_progress`, `awaiting_files`, `completed`, `auto_approved`, `refunded`, `cancelled`.
- **Report = three stored fields:** diagnosis (findings), impression, recommendations. Server-side generation is `handlePortalDoctorGenerateReport` in `src/routes/doctor.js`. The PDF is bilingual and carries the consultant's stored signature. Do not reimplement PDF generation in the app.
- **Case Intelligence is a librarian, not a diagnostician.** `case_extractions` holds `lab_values`, `patient_info`, `documents_inventory`, `missing_documents`. The app must show the "this does not diagnose" statement on every load of that screen. Never let AI output flow into a report field automatically.
- **Files:** patient uploads land in `order_files` and `order_additional_files`; `bridgeOrderFilesToCaseFiles()` is the explicit bridge into `case_files`, which is what the pipeline reads. The app shows both tables as one list.
- **Payouts (canonical: `docs/PAYOUT_AND_URGENCY_POLICY.md`, rules signed off 13 Sep 2026):** a fixed `doctor_fee` per service, plus 30% of the urgency uplift. A case reassigned away from a doctor earns **0**. An SLA breach refunds the uplift to the patient and reverses only the uplift share — the base fee stands if the doctor still delivers. Paid the last working day of the month by cash, InstaPay, or Shifa finance. Finance "owed" and the doctor's earnings screen must read from **one shared aggregation** — if they can disagree, it is a bug.
- Add-ons (video consultation, prescriptions) are switched off platform-wide until there is a patient base. Build the screens; ship them disabled behind a flag.
- **Security, open item:** the portal connects to Postgres as the owner role and bypasses RLS. RLS is enabled on all 59 public tables with zero policies (default-deny), so it is safe today, but the least-privilege `app_rw` role has never been built. The doctor app is a third client — see P8.

## Visual system — "Cairo Night"

Dark-first, with a daylight ramp. The doctor chooses; the choice is stored on their **profile**, not the device, so it follows them. Ship a theme module with these exact tokens.

```ts
export const dark = {
  bg:'#04131A', card:'#0A2029', raise:'#113039', line:'#1C4049',
  ink:'#EDF3F2', mut:'#9DB3B5', head:'#0A2029', onHead:'#EDF3F2',
  avatar:'#113039', onAccent:'#03150F',
  emerald:'#12A374', emeraldBright:'#2ED39B', emeraldWash:'rgba(18,163,116,.15)',
  brass:'#C8A96A', brassWash:'rgba(200,169,106,.14)',
  clay:'#D2624E', clayWash:'rgba(210,98,78,.16)',
  chip:'#113039', track:'#1C4049', switchOff:'#2A4E58',
};
export const light = {
  bg:'#EDE7DE', card:'#FFFFFF', raise:'#F6F2EB', line:'#DCD3C7',
  ink:'#0B2029', mut:'#5C6F70', head:'#0B2029', onHead:'#F4F1EA',
  avatar:'#0B2029', onAccent:'#FFFFFF',
  emerald:'#0A6E4F', emeraldBright:'#0E8A64', emeraldWash:'rgba(10,110,79,.10)',
  brass:'#9A7C33', brassWash:'rgba(154,124,51,.13)',
  clay:'#B4462F', clayWash:'rgba(180,70,47,.10)',
  chip:'#E4DED4', track:'#DCD3C7', switchOff:'#C6BCAE',
};
```

Meaning is fixed and never borrowed: **emerald = go / on track**, **brass = money and attention**, **clay = urgent and a clock being lost**. One accent per screen.

Type: **IBM Plex Sans** and **IBM Plex Sans Arabic** for the interface (they share metrics, so an Arabic screen sets on the same grid), **IBM Plex Mono** for every case reference, countdown and figure, **Playfair Display** only on the report artefact and the wordmark — never in the interface. Squared corners at 2–4px, hairline borders, no drop shadows, no card inside a card, two-pixel SLA bars. Minimum touch target 44px. Full RTL when the language is Arabic.

Reference prototype (50 screens, each labelled with the route it maps to): https://claude.ai/artifact/F4uCwBNMjGiRdZ3USADkwd
Design system: https://claude.ai/artifact/QkVZuidS9wR3vPrQFuQMus

## v1 scope

In: sign-in, Today, all cases, case offer + accept/decline, case detail, files + viewer, Case Intelligence, ask-for-files, reject-file, messages, report composer + preview + sign + submit, earnings, my services, availability, profile, signature, notifications, appearance, help.

Out of v1 (build behind a flag, ship disabled): video consultations, prescriptions.

Distribution: **TestFlight only** until the patient app clears Apple review under the Shifa Hospital organization account (Apple case `102915364043`). No App Store listing for the doctor app in v1.

---

# P0 · Recon — read only, no code

Read the portal repo and report back. Write nothing.

1. Inventory every doctor-facing route in `src/routes/doctor.js`, plus the doctor-relevant handlers in `appointments.js`, `video.js`, `prescriptions.js`, `messaging.js`, `medical_records.js`, `annotations.js`, `reviews.js`. For each: method, path, what it reads, what it writes, what it renders.
2. Read `src/routes/api/admin.js` end to end and write up the conventions the Command app's API established — auth middleware, error shape, pagination, response envelope, audit logging, idempotency.
3. Find where the acceptance window is computed and where `accept_by_at` / `acceptance_deadline_at` are written and swept.
4. Find the earnings aggregation used by both the doctor earnings page and the finance "owed" figure. Confirm it is genuinely one code path; if it is two, say so loudly.
5. List every table the doctor app will touch, with the columns it needs.
6. Confirm on disk whether `tashkheesa-command` and `Tashkheesa-app` are checked out locally, and where.

**Deliverable:** one markdown report at `docs/DOCTOR_APP_API_AUDIT.md` (uncommitted). Then stop and wait.

---

# P1 · The doctor API — the critical path

Build `/api/v1/doctor/*` in the portal. The doctor portal is server-rendered EJS today; there is no JSON API, and nothing in the app can start without one. Mirror `src/routes/api/admin.js` exactly in auth, error shape and conventions — a reviewer should not be able to tell the two files apart in style.

Auth: the same JWT model as Command — 15-minute access token, 12-hour rotating refresh, `requireDoctor` scoping every route to the calling doctor. Passwordless magic-link exchange and phone OTP (Twilio Verify service `VA680398fe4d8d769b3732d8779f1fc695`) both mint tokens.

**Read endpoints:** dashboard (offers, in-flight cases with SLA remaining, today's appointments, month-to-date earnings), cases list with status filter, case detail, files (both tables merged), case intelligence, patient records shared to the case, messages list and thread, earnings with the paid/pending/reassigned split, services, availability, profile, alerts.

**Write endpoints:** accept, decline (with reason), request files, reject file (with reason), save report draft, submit report, send message, mark alerts read, toggle service, set availability and turnaround, update profile, register push token, set appearance preference.

Rules for this phase:

- Fail closed on ownership. There was a real fail-open bug on the intelligence route where `order.doctor_id && …` passed for every unassigned case and leaked clinical data to any authenticated doctor. Every case route asserts `String(order.doctor_id) === doctorId` and 403s otherwise, with a test proving the unassigned case is refused.
- No new business logic. These endpoints call the same services the EJS routes call. If a rule only exists inside a view, lift it into a service and have both call it.
- Every write is idempotent or guarded, and audited the way the admin writes are.
- Tests: the fault-injection atomicity pattern used on the Command write slices — throw on the audit insert, prove the whole write rolls back, prove a second run is a no-op.

**Definition of done:** all endpoints green in tests, a Postman/curl transcript for each in the PR body, `/healthz` still 200 with all four workers alive, no change in behaviour for any existing EJS route. PR opened, not merged. Then stop.

---

# P2 · App shell

Create `tashkheesa-doctor`: Expo SDK 54 + TypeScript, bundle `com.tashkheesa.doctor`, EAS project, `preview` and `production` profiles pointing at the prod API like the Command app does.

Build: navigation skeleton (Today · Cases · Messages · Earnings · More), the theme module from Section A with dark/light and the profile-stored preference, an i18n layer with full RTL, the auth flow (magic link, phone OTP, secure-store, biometric gate on resume), and an API client with token refresh and typed responses generated from P1.

Every screen is a labelled placeholder at this stage. No case logic.

**Definition of done:** installs from an EAS preview build on Ziad's phone, signs in as a real doctor against production, flips dark/daylight and English/Arabic with the whole UI mirroring correctly. Then stop.

---

# P3 · Slice 1 — Accept

Today, All cases, the case offer, accept, decline with reason. Plus push: register the device token, and deliver "a case is offered to you" and "your acceptance window closes in 30 minutes" through the existing `notifySuperadmins` chain, generalised to doctors.

The offer screen shows, before the doctor accepts: clinical question, patient age/sex, document inventory, tier, the acceptance countdown, and the exact fee broken into service fee and uplift share. The countdown is the real `accept_by_at`, not a client guess. Accepting starts the SLA clock and the screen says so.

**Definition of done:** a real case offered to a real test doctor, accepted from the phone, with the SLA deadline written correctly in the database; a declined case back in the pool; the expiry sweep still working on an ignored offer; the push landing on the lock screen and opening the right case. Then stop.

---

# P4 · Slice 2 — Read

Case detail, the merged file list, the image and PDF viewer with the three annotation tools (arrow, ellipse, measurement) persisting through the existing `annotations` routes, Case Intelligence, shared patient records, ask-for-files (a checklist that writes one bilingual message and moves the case to `awaiting_files`), reject-file with reason, and the message thread with unread counts.

Large files stream and cache; a case opened once must be readable with a bad connection in a hospital basement.

**Definition of done:** a real case with real R2 files read end to end on the device, an annotation surviving app restart, a file request arriving to a test patient in both languages. Then stop.

---

# P5 · Slice 3 — Report

The composer over the three stored fields, with local autosave every few seconds and a draft that survives the app being killed. A per-doctor phrase library. Dictation via on-device speech to text, inserted at the cursor, transcription only. The Arabic side-by-side review step. Preview rendered from the **server's** report template, not a client mock. Attestation, stored signature, submit.

Submitting with no signature on file is blocked with an explanation and a link to add one.

**Definition of done:** a report written entirely on the phone, submitted, delivered to the patient identically to one written in the portal — same PDF bytes-for-purpose — and an earnings row created as pending. This is the slice that decides whether the app is worth having; give it a fresh session and do not rush it. Then stop.

---

# P6 · Slice 4 — Money and practice

Earnings (month total, the paid/pending/reassigned split, line by line including refund clawbacks with their reason, the fee explainer in the doctor's own words), statements, My Services with the cross-specialty union switch, availability and turnaround, profile, signature capture, reviews, notification preferences, appearance, guide, help.

The earnings figure must come from the shared aggregation identified in P0.4. If P0 found two code paths, fixing that is part of this phase.

**Definition of done:** the app's month total matches the portal's and finance's to the piastre for three real doctors. Then stop.

---

# P7 · Hardening and TestFlight

Offline draft safety, error and empty states on every screen, an accessibility pass (44px targets, dynamic type, VoiceOver labels on both languages), crash reporting, and the release config: APNs credentials in EAS, final icons, `production` profile.

Ship to TestFlight for the doctor panel. No App Store listing — the patient app goes first under the Shifa organization account.

**Definition of done:** five consultants using it on real cases for a week, with their feedback written up.

---

# P8 · The `app_rw` role — do not skip

Build the least-privilege Postgres role the Command audit flagged as the top open security item, and move the doctor API onto it. Three clients now connect as the database owner and bypass RLS; that was acceptable with one internal admin app and is not acceptable with an app in fifty consultants' pockets.

Grant only what the doctor API touches, write the policies RLS has been waiting for, prove the app still works, and prove that a compromised doctor token cannot read another doctor's case. Dry-run every grant. Ziad commits.

---

## Ground rules for every phase

- Do not invent a screen the prototype does not have; if something is missing, say so and propose it rather than building it.
- Do not use emoji as icons — stroke SVG on a 24px grid, one style.
- Do not put clinical text in a fixed-height container; text that can grow, scrolls.
- Do not let the app compute a deadline, a fee or an SLA state the server already knows. The server is the clock and the ledger; the app renders them.
- If a phase's definition of done cannot be met, stop and report rather than moving on with it half-proven.
