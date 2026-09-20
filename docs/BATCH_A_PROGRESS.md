# Batch A progress — patient safety and the clock

OWNER: this session (Claude Code, MacBook, worktree /Users/ziadelwahsh/tashkheesa-launchfix, started 2026-09-20)

Branch: fix/launch-gates-routing-revocation, fast-forwarded to origin/main (0787acbb4) before starting.
Baseline tests (env DATABASE_URL= node tests/run.js): Passed 1891 / Failed 6 / Skipped 52 — the six known pre-existing failures.
After implementation: Passed 1904 / Failed 6 / Skipped 52 — the six failing lines byte-identical to baseline.

- A4 — IMPLEMENTED (1f99bd74c) + IN REVIEW. Access rule + redaction were already merged (c30c0d7ba). Delta: clinical question + fee breakdown onto the entitled pre-accept brief (both policy-visible per the batch brief; fee via earnings_writer.previewCaseEarnings = the ledger's own math, resolving C5); eligibility extended with tier support + per-doctor capacity in the shared rule. Matrix: docs/reviews/batch-a-2026-09-20/A4-A5-verification-matrix.md.
- A5 — IMPLEMENTED (1f99bd74c) + IN REVIEW. Accept handler: no-specialty pool case fails closed (?msg=specialty), tier gate 3d, per-doctor tier-aware capacity (capFor + canonical load count) replacing the global 4; one live users read powers 3b/3c/3d/4, fail-closed throughout.
- A6 — IMPLEMENTED (9fb01fbd8) + IN REVIEW. Item 1 verified CLEAN (no inline durations anywhere — recon report in docs/reviews/batch-a-2026-09-20/). Fixes: assignDoctor stops swallowing the doctor_assignments INSERT (rollback + throw + registered event); superadmin reassign routed through reassignCase (was a bare doctor_id UPDATE writing NEITHER deadline column); seed script stops minting NULL accept_by_at rows. Prod read (Supabase MCP, SELECT only): ZERO stranded rows in every shape — no production DML needed. Guard: tests/core/a6-acceptance-deadline-single-writer.test.js (9 checks).
- A7 — IMPLEMENTED (d9be4cff0) + IN REVIEW. 8 files; legacy-value normalisations untouched.
- A8 — IMPLEMENTED (2119aa30d) + IN REVIEW. Both PDF generators.

Review round: spec review + adversarial review running as independent read-only agents; reports land in docs/reviews/batch-a-2026-09-20/. Fix round follows their findings.

NOT pushed. Nothing merges without Ziad.
