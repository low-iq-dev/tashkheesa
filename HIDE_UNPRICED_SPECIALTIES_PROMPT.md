# HIDE UNPRICED SPECIALTIES

## Task
Hide the following 11 specialties from patient-facing pages. They have no priced services yet.

Specialties to hide: Dermatology, ENT (Ear, Nose & Throat), Endocrinology, Gastroenterology, General Surgery, Internal Medicine, Ophthalmology, Orthopedics, Pediatrics, Pulmonology, Urology

Also hide any services that belong to these specialties.

## How
Option A (preferred): Add `is_visible` column to specialties table (BOOLEAN DEFAULT true), set to false for these 11. Update patient-facing queries to filter by `is_visible = true`.

Option B: Use the existing service `is_visible` flag — set `is_visible = 0` on all services under these 11 specialties, and filter specialties that have zero visible services.

Either way, make sure:
1. The /services page does NOT show these specialties
2. The patient portal does NOT let patients select these specialties when creating a case
3. The superadmin dashboard STILL shows them (so we can re-enable later)
4. Do NOT delete anything

## Also remove duplicate services
Some specialties have generic duplicates like "Dermatology Service", "Gastroenterology Service", "Orthopedics Service". Delete these generic placeholder services entirely — they're not real services.

## Database
We're on PostgreSQL now. Use the pg.js helpers (queryOne, queryAll, execute).
