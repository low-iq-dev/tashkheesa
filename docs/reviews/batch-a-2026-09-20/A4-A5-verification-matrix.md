# A4/A5 verification matrix — 2026-09-20

Every cell below is a hermetically driven test against the REAL route handlers
(plucked off router.stack, fake pg, DATABASE_URL blank), not an assertion about
source text. Evidence columns name the guard file and the check that proves the
cell; both guards run green on the final tree:

- `tests/core/doctor-pre-accept-exposure.test.js` — 56/56
- `tests/core/doctor-account-gates-accept-and-create.test.js` — 32/32

## Surface 1 — VIEW: GET /portal/doctor/case/:caseId (the pre-accept brief)

| case | doctor | result | evidence (exposure guard) |
|---|---|---|---|
| paid, pool, in-specialty, standard | active, all tiers, under cap | **OFFER** — clinical question + specialty + service + tier/window + age/sex + report language + file count/kinds; history, medications, patient name, filenames/urls, AI checks, annotations ALL absent from the payload | (3) entitled doctor; (3) offer still usable |
| unpaid (payment_status pending) | same | **403 refusal**, nothing loaded | (3) UNPAID refused |
| paid, pool, ANOTHER specialty | same | **403** | (3) another specialty |
| paid, pool, NO specialty | same | **403** (blank ≠ wildcard) | (3) no-specialty pool case |
| paid, pool, in-specialty | paused / pending_approval / deactivated / rejected | **403** each | (3) account rule refused ×4 |
| paid, pool, VIP tier | supports standard only | **403** | (3) tier/cap check |
| paid, pool, in-specialty | at their max_active_cases | **403** | (3) tier/cap check |
| paid, pool, in-specialty | one under their cap | **OFFER** | (3) tier/cap check |
| VIP, ASSIGNED to this doctor | supports standard only | **OFFER** (a human routed it; fix round X3/S1) | (3) assigned-offer exemption |
| ASSIGNED to this doctor (fills their last slot) | at their cap | **OFFER** (the case is excluded from its own load count) | (3) assigned-offer exemption |
| assigned to ANOTHER doctor | any | **403** assigned_to_other | (3) assigned to another |
| assigned to THIS doctor, not accepted | eligible | **OFFER** (question yes, patient no) | (3) assigned-not-accepted |
| accepted by THIS doctor (IN_REVIEW) | even paused | **FULL** — everything, unchanged | (3) accepted; (3) paused-keeps-case |
| any | users read THROWS | **403** (fail closed) | (3) account read throws |

The same acceptance-not-assignment rule is separately pinned on the ten other
surfaces (intelligence view ×2, patient-records, prescribe GET+POST, download-
report, analytics, annotations ×4, video board + detail, dashboard queues) —
checks (4)–(11) of the exposure guard, all green and untouched by this delta
except where the question policy changed.

## Surface 2 — ACCEPT: POST /portal/doctor/case/:caseId/accept

| case | doctor | result | evidence (account-gates guard) |
|---|---|---|---|
| unpaid | any | bounce to case page, no work | pre-existing paid gate (guard drives it implicitly: every scenario order is paid; the gate itself is unchanged code) |
| pool, in-specialty, standard, paid | active, under cap | **accept**: order → live read → capacity → assignDoctor → withTransaction | (4b) ACTIVE goes all the way |
| pool, NO specialty | active | **?msg=case_unroutable** + bilingual copy (fix round A5/S1) | (4b) NO specialty → every doctor refused |
| pool, NO specialty | paused | **?msg=case_unroutable** (case-side refusal; still refused) | same check |
| pool, in-specialty | doctor specialty BLANK | **?msg=specialty** | (4b) blank doctor specialty |
| pool, in-specialty | paused | **?msg=paused** + bilingual copy | (4b) paused |
| pool | pending_approval | **?msg=pending_approval** | (4b) pending |
| pool | deactivated | **?msg=account_inactive** | (4b) deactivated |
| pool | rejected (reason, is_active NULL) | **?msg=account_inactive** | (4b) rejected |
| pool | users row MISSING | **?msg=account_inactive** (fail closed) | (4b) missing row |
| pool | users read THROWS | **?msg=account_check_failed**, logged | (4b) read throws |
| pool, urgent tier | supports standard only | **?msg=tier_not_supported** + bilingual copy | (4b) tier gate |
| pool, vip tier | sla_tiers_supported NULL | **?msg=tier_not_supported** (NULL = standard-only) | (4b) NULL tiers |
| pool, standard | sla_tiers_supported NULL | **accepted** | same check |
| pool | at their own max_active_cases (2/2) | **capacity path** (?msg=capacity via overflow) | (4b) per-doctor cap |
| pool | under their cap (1/2) | **accepted** | same check |
| pool, urgent | 5 active, urgent cap 8, standard cap 2 | **accepted** (urgent measures the urgent cap) | same check |
| pool | max_active_cases NULL | **accepted** (no cap configured — assign_case semantics) | same check |
| assigned to THIS doctor, paused | — | **accepted** (pool gates skipped: a human routed it) | (4b) already-assigned |
| assigned to ANOTHER doctor | any | bounce (Guardrail 2, unchanged) | pre-existing, unchanged code |

## Notes

- The paid gate on both surfaces is `payment_status IN ('paid','captured')`,
  case-folded — view via doctor_case_access.isPaidForReview, accept via the
  handler's own gate; both pre-existing, unchanged, and pinned by the exposure
  guard's UNPAID rows.
- Fix round 2026-09-20: viewing and accepting now draw the SAME line. Pool
  offers pass specialty + tier + capacity on both surfaces; ASSIGNED offers
  are exempt from all three on both surfaces (cad13b5's human-routing ruling),
  and the load count excludes the case being decided, so a case can never be
  routed to a doctor who cannot open or accept it. The one REMAINING
  asymmetry is pre-existing and recorded for Ziad: the VIEW applies the
  ACCOUNT rule (paused/pending/inactive/rejected) to assigned-not-accepted
  cases while the ACCEPT's Guardrail 3c is pool-only — a paused doctor cannot
  read an assigned offer but could still POST accept it blind. Every refusal
  bounce now renders its named copy on the denial screen (fix round X6).
