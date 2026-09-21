# A7/S1 follow-up — oncology intake maps to VIP, not a 24h fourth tier

2026-09-21. Ziad's ruling on the FIX-ROUND "Reported" item A7/S1: **there is no
24-hour tier and never was.** `slaConfigForTestType` (src/routes/api/
cases_intake.js:32) gave every oncology website intake `sla_type
'priority_24h'` / `sla_hours 24` — a live fourth tier outside Standard 48h /
VIP 18h / Urgent 4h. The comment's intent was "tighter than standard"; the
real tier that means that is VIP. Decision: map oncology to VIP (18h), using
the canonical tier value the rest of the codebase uses, not a new string.

## The change

One mapping: `{ sla_type: 'priority_24h', sla_hours: 24 }` →
`{ sla_type: 'vip', sla_hours: 18 }`. Nothing else. The non-oncology branch
keeps `standard_72h` / 48 untouched.

Where the values land (unchanged plumbing, verified in source):
- `orders.sla_hours` ← 18 (INSERT at cases_intake.js, $7)
- `cases.sla_type` ← 'vip', `cases.sla_deadline` ← now + 18h (INSERT, $3/$4)

Guard (TDD, red first): `tests/core/cases-intake-oncology-vip.test.js` drives
the REAL POST /intake handler off router.stack with a recording fake pg
client. Red run failed on "orders.sla_hours is 24, wanted 18"; green after
the mapping change. It pins: oncology → 18 / 'vip' / deadline 18h out /
'priority_24h' written nowhere; ct_mri → 48 / 'standard_72h' retained.

## Spec conformance

- "Map oncology to VIP (18h)" — done, both columns, deadline derived.
- "Canonical tier value, not a new string" — 'vip' is the value
  normalizeTier / acceptance_window / the display maps all speak.
- Schema safety: prod read (Supabase MCP, information_schema + pg_constraint,
  2026-09-21) — `cases.sla_type` is plain `text`, **no CHECK constraint, no
  enum type**; `orders.sla_hours` is bare `integer`. 'vip'/18 write cleanly,
  no migration needed for the fix itself.
- Repo-wide: `priority_24h` now appears in **zero** live code paths (its only
  other mentions are the unrelated `addon_priority_24hr` add-on id in the
  pricing CSV / migration 041's comment).

## Adversarial pass (self-review — no independent agent was run on this
4-line follow-up; flagged in the batch report so Ziad can demand one)

- **Downstream tier readers**: these intake orders never wrote
  `orders.urgency_tier` (stays NULL) — readers use the sanctioned
  urgency_tier-first / sla_hours-fallback, and 18 is VIP's exact number, so
  the X14 receipt rule (exact 4/18/48 match) and emailService's `<=18` VIP
  band now both read these rows as VIP instead of an unnameable 24h shape.
  Strictly more consistent than before.
- **Deliberately NOT writing `orders.urgency_tier='vip'` at intake**: a
  website lead is unpaid and unpriced; tier is a paid-product attribute set
  by the pricing path when ops convert the lead. Writing the tier here would
  claim a VIP product nobody has bought. Same posture as the old code (which
  also left it NULL). If Batch B disagrees, it owns the change.
- **"You will be contacted within 24 hours."** (the intake response message,
  cases_intake.js) — a contact/reply-time promise, not a tier or SLA claim;
  the A7 commit's deliberately-left-alone list already ruled on contact
  reply-time promises. Left alone, consistently. Note for Ziad: for an 18h
  oncology SLA, "contacted within 24 hours" is now slower than the report
  deadline itself — copy Ziad may want to tighten, but it is a copy decision,
  not part of this ruling.
- **Historical rows**: existing `cases.sla_type='priority_24h'` /
  `sla_hours=24` rows are untouched (no readers key on the string; the 24 is
  honored as a number by the legacy-honoring paths, pinned elsewhere by
  "legacy 2-tier wizard priority order → 24 honored").
- **Lints**: the urgency-tier lint does not cover cases_intake.js (it writes
  sla config, it does not derive a display tier); the copy-pins lint is
  unaffected. Verified by the full-suite run.

## Batch B — recorded, deliberately not done now (Ziad, 2026-09-21)

The stored enum values `priority_24h` and `standard_72h` both name retired
durations, and `standard_72h` actually returns 48 hours. Renaming touches
historical rows, so it needs a migration and belongs with the ledger work.
Until then: new oncology rows say 'vip'; old rows keep their historical
strings; the non-oncology branch keeps writing 'standard_72h'.

## Result

Suite: 1908 → 1911 passed, the same 6 pre-existing failures byte-identical,
52 skipped (no-DB run; counts confirmed in the batch report). No prod DML —
the fix changes what NEW intakes write.
