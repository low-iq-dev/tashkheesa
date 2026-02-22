# FIX INSTAGRAM AUTOPOSTER — Complete the Pipeline

## CONTEXT
The Instagram automation system is partially built but non-functional. The publisher, client, scheduler, and routes exist in `src/instagram/` and there's a superadmin UI at `src/views/superadmin_instagram.ejs`, but critical pieces are missing. The system uses Cloudinary for image hosting and Meta Graph API for posting.

## WHAT EXISTS
- `src/instagram/client.js` — Meta Graph API client (container creation, publishing)
- `src/instagram/publisher.js` — High-level publisher (image, carousel, story, reel)
- `src/instagram/scheduler.js` — Cron-based scheduler (reads from `ig_scheduled_posts` table)
- `src/instagram/config.js` — Config with Meta credentials from env
- `src/instagram/routes.js` — API routes for publishing (never mounted)
- `src/views/superadmin_instagram.ejs` — Superadmin Instagram management UI (325 lines)
- `src/routes/superadmin.js` — Has routes for `/superadmin/instagram` that reference missing scripts

## WHAT'S BROKEN
1. `ig_scheduled_posts` table doesn't exist in DB — never created in migrations
2. Instagram routes never mounted in server.js — `app.use()` call missing
3. Instagram scheduler never started in server.js — no `.start()` call
4. `scripts/instagram-campaign-data.js` doesn't exist — superadmin page depends on it
5. `scripts/instagram-publish-campaign.js` doesn't exist — publish button depends on it
6. `tmp/instagram/` directory doesn't exist — campaign state storage

## REQUIREMENTS

### Approval Workflow
The owner (superadmin) must approve every post before it goes live. Flow:
1. Posts are created with status `pending_approval`
2. Superadmin reviews post on `/superadmin/instagram` page — sees image preview, caption (EN + AR), scheduled time
3. Superadmin can: ✅ Approve, ✏️ Edit caption, 🔄 Regenerate image, ❌ Reject
4. Only `approved` posts get picked up by the scheduler for publishing
5. After publishing, status changes to `published`

### Bilingual Captions
Every post must have both English and Arabic captions. The combined caption format for Instagram:
```
[English caption here]

---

[Arabic caption here]

#tashkheesa #تشخيصة #secondopinion #medical
```

### Campaign Data Structure
Create `scripts/instagram-campaign-data.js` that exports the 11-day launch campaign (Feb 18 - Feb 28, 2026). Each post should have:
- `id` — unique identifier
- `day` — campaign day number (1-11)  
- `date` — scheduled date
- `time` — scheduled time (Cairo timezone)
- `type` — IMAGE, CAROUSEL, STORY, or REEL
- `caption_en` — English caption
- `caption_ar` — Arabic caption
- `hashtags` — array of hashtags
- `image_prompt` — description for AI image generation or Cloudinary image URL
- `theme` — what the post is about

### Campaign Content (11 days: Feb 18 - Feb 28)
Day 1 (Feb 18): Teaser — "Something big is coming to healthcare in Egypt" / "شيء كبير قادم للرعاية الصحية في مصر"
Day 2 (Feb 19): Problem — "Getting a second opinion shouldn't be this hard" / "الحصول على رأي طبي ثاني لازم يكون أسهل من كده"
Day 3 (Feb 20): Solution reveal — "Meet Tashkheesa" / "تعرف على تشخيصة"
Day 4 (Feb 21): How it works — Step-by-step process / "إزاي تشخيصة بتشتغل"
Day 5 (Feb 22): Trust — "Board-certified specialists" / "أطباء استشاريين معتمدين"
Day 6 (Feb 23): Speed — "Reports in 24-72 hours" / "تقارير في ٢٤-٧٢ ساعة"
Day 7 (Feb 24): Testimonial/Social proof — "Why families trust us" / "ليه العائلات بتثق فينا"
Day 8 (Feb 25): Features — "Upload scans, get clarity" / "ارفع الأشعة، واحصل على وضوح"
Day 9 (Feb 26): Countdown — "3 days to launch" / "٣ أيام على الإطلاق"
Day 10 (Feb 27): Countdown — "Tomorrow we launch" / "بكرة بنطلق"
Day 11 (Feb 28): LAUNCH DAY — "We're live! 🚀" / "اتطلقنا! 🚀"

Use Egyptian Arabic dialect (not MSA). Keep captions engaging, professional but warm.

### Cloudinary Integration
Images should be stored on Cloudinary (already configured in env). The `MEDIA_BASE_URL` is `https://tashkheesa.com/media/instagram` but for actual posting, use Cloudinary URLs since Meta needs publicly accessible image URLs.

Cloudinary config:
- Cloud name: `dnqw857j0`
- API Key: from env `CLOUDINARY_API_KEY`
- API Secret: from env `CLOUDINARY_API_SECRET`

For now, use placeholder Cloudinary URLs or Tashkheesa brand images. The superadmin can upload/replace images through the UI.

## IMPLEMENTATION

### Step 1: Create DB table
Add to `src/db.js` migrate() function:
```sql
CREATE TABLE IF NOT EXISTS ig_scheduled_posts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT,
  day_number INTEGER,
  post_type TEXT NOT NULL DEFAULT 'IMAGE',
  caption_en TEXT,
  caption_ar TEXT,
  caption TEXT,
  hashtags TEXT,
  image_urls TEXT,
  scheduled_at TEXT,
  status TEXT DEFAULT 'pending_approval',
  approved_by TEXT,
  approved_at TEXT,
  ig_media_id TEXT,
  published_at TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### Step 2: Create `scripts/instagram-campaign-data.js`
Export the 11-day campaign as a module with all post data including bilingual captions.

### Step 3: Create `scripts/instagram-publish-campaign.js`
Script that:
- Reads campaign data
- Seeds `ig_scheduled_posts` table
- Can publish a specific post by ID (used by superadmin UI)
- Handles --seed flag to populate the table
- Handles --post <id> flag to publish a single approved post

### Step 4: Mount routes in server.js
```javascript
app.use('/api/admin/instagram', requireRole('superadmin'), instagramRoutes);
```

### Step 5: Start scheduler in server.js
```javascript
const igScheduler = new InstagramScheduler(db);
igScheduler.start();
```

### Step 6: Update scheduler to respect approval
Modify `src/instagram/scheduler.js` to only publish posts with status `approved` (not `pending`):
```sql
SELECT * FROM ig_scheduled_posts 
WHERE status = 'approved' AND scheduled_at <= ? 
ORDER BY scheduled_at ASC LIMIT 5
```

### Step 7: Fix superadmin routes
Update `/superadmin/instagram` routes in `src/routes/superadmin.js` to:
- Read posts from `ig_scheduled_posts` table instead of missing script
- Support approve/reject/edit actions
- Show bilingual caption preview

### Step 8: Create tmp directory
```bash
mkdir -p tmp/instagram
```

### Step 9: Seed command
After everything is built, run:
```bash
node scripts/instagram-publish-campaign.js --seed
```
This populates `ig_scheduled_posts` with all 11 posts in `pending_approval` status.

## TEST
1. Visit http://localhost:3000/superadmin/instagram
2. Should see 11 campaign posts with previews
3. Each post shows EN + AR caption
4. Approve button works → changes status to `approved`
5. Reject button works → changes status to `rejected`
6. Only approved posts get published by the scheduler

## FILES TO CREATE
1. `scripts/instagram-campaign-data.js`
2. `scripts/instagram-publish-campaign.js`

## FILES TO MODIFY
1. `src/db.js` — add `ig_scheduled_posts` table to migrate()
2. `src/server.js` — mount instagram routes, start scheduler
3. `src/instagram/scheduler.js` — change status filter from 'pending' to 'approved'
4. `src/routes/superadmin.js` — fix instagram routes to use DB instead of missing scripts
5. `src/views/superadmin_instagram.ejs` — update if needed for bilingual captions and approval workflow

## DO NOT MODIFY
- patient-portal.css
- doctor-portal.css
- Any patient or doctor routes
