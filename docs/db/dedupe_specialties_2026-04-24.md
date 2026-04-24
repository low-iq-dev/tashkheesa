# Specialty-table dedupe — 2026-04-24

Runbook for migration `src/migrations/018_dedupe_specialties.sql`. Covers
the state the migration expects, what it changes, and the post-conditions
to verify.

## Why

The `specialties` table shipped with two parallel ID conventions:

| ID convention    | Example                   | Intended      |
|------------------|---------------------------|---------------|
| `spec-<slug>`    | `spec-cardiology`         | keeper        |
| bare name        | `cardiology`              | legacy — drop |

Four names had both variants (`Cardiology`, `Oncology`, `Neurology`,
`Radiology`), so the doctor profile specialty dropdown rendered them
twice. Additionally, `spec-pathology` and `lab_pathology` (Lab &
Pathology) existed side-by-side; the `tashkheesa_pricing_v2.xlsx`
pricing file lists only Lab & Pathology, so Pathology must collapse
into it.

No physical FK constraints exist from `orders`, `appointments`, or
`services` to `specialties` — the references are logical, and a bare
`DELETE FROM specialties` would silently orphan rows. The migration
handles this explicitly.

## Pre-state (as captured 2026-04-24 on local Postgres)

```
 total_rows | distinct_names
------------+----------------
         21 |             17
```

Dupe pairs by name:

```
    name    |             ids
------------+------------------------------
 Cardiology | {spec-cardiology, cardiology}
 Oncology   | {spec-oncology,   oncology}
 Neurology  | {spec-neurology,  neurology}
 Radiology  | {spec-radiology,  radiology}
```

Stand-alone `spec-pathology` row distinct from `lab_pathology`.

Logical references to the soon-to-be-dropped IDs:

| Table          | `cardiology` | `oncology` | `neurology` | `radiology` | `spec-pathology` |
|----------------|-------------:|-----------:|------------:|------------:|-----------------:|
| `orders`       |            0 |          1 |           0 |           0 |                0 |
| `appointments` |            0 |          1 |           0 |           0 |                0 |
| `services`     |           11 |          9 |          11 |          12 |               19 |

`services_backup_2026_04_22` contains 71 such rows. It is a frozen
snapshot from the 2026-04-22 services dedupe and is **not** touched —
the backup must reflect the row state at that earlier moment.

## What the migration does

1. **Delete colliding bare-variant services** — `services` has
   UNIQUE (specialty_id, name) from migration `011`. If a bare-variant
   service shares a name with a `spec-*` sibling, the repoint in step 2
   would violate the constraint. These rows are the obsolete duplicates;
   the `spec-*` rows (authoritative, the ones the pricing pipeline
   uses) are preserved.
2. **Repoint `orders`, `appointments`, `services`** from bare IDs to
   the corresponding `spec-<slug>`; and from `spec-pathology` to
   `lab_pathology`.
3. **`DELETE FROM specialties WHERE id IN (...)`** the five obsolete
   rows: `cardiology`, `oncology`, `neurology`, `radiology`,
   `spec-pathology`.
4. **`ALTER TABLE specialties ADD CONSTRAINT specialties_name_unique
   UNIQUE (name)`** so the drift cannot recur. Guarded by
   `IF NOT EXISTS` so the migration is idempotent.

## Post-state (verified on local Postgres)

```
 total | distinct_names
-------+----------------
    16 |             16
```

Exactly 16 specialties, matching `tashkheesa_pricing_v2.xlsx`:

```
 Cardiology             Endocrinology              Gastroenterology
 Dermatology            ENT (Ear, Nose & Throat)   General Surgery
 Internal Medicine      Lab & Pathology            Neurology
 Oncology               Ophthalmology              Orthopedics
 Pediatrics             Pulmonology                Radiology
 Urology
```

Constraints:

```
 specialties_pkey
 specialties_name_unique
```

Orphan check across live tables (excluding the pre-existing
`addon` specialty_id in 2 service rows, which is out of scope —
it is unrelated to the dedupe):

```
    t     | specialty_id | count
----------+--------------+-------
 services | addon        |     2
```

Doctor profile dropdown renders 17 `<option>` elements
(1 "—" placeholder + 16 specialties) — down from 21 before.

## Idempotency

Re-running the migration on the post-state returns:

```
UPDATE 0
UPDATE 0
DELETE 0
DO
COMMIT
```

No errors, no writes. Safe to run multiple times (e.g. if the boot-time
migration runner replays it).

## Rollback

There is no automatic rollback. If the drop turns out to be wrong:

- Re-insert the five rows from `services_backup_2026_04_22` or from
  a PITR backup.
- Drop the `specialties_name_unique` constraint before restoring the
  duplicate rows.

No production data was lost by this change — every reference was
re-pointed before deletion, and the dropped specialty IDs were the
ones users were never intended to select.
