# BUILD AI IMAGE GENERATION INTO INSTAGRAM TAB

## OVERVIEW
Add AI image generation (DALL-E 3) + approval workflow to the superadmin Instagram page. The owner should be able to generate, preview, approve/reject with feedback, and regenerate images — all without leaving the dashboard.

## ENVIRONMENT
- `OPENAI_API_KEY` — already in .env
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — already in .env
- Database: PostgreSQL (use `queryOne`, `queryAll`, `execute` from `src/pg.js`)

## FLOW
1. Each post in `ig_scheduled_posts` has an `image_prompt` field (text describing the image)
2. Owner clicks "Generate Image" on a post card
3. System calls DALL-E 3 API with the prompt → gets image URL
4. Image is uploaded to Cloudinary automatically (DALL-E URLs expire)
5. Cloudinary URL saved to the post's `image_urls` field in DB
6. Image preview appears on the card
7. Owner can:
   - ✅ **Approve** — marks post as `approved`, ready for scheduler to publish
   - ❌ **Reject + Comment** — owner types feedback (e.g. "too dark, make it brighter, add more blue")
   - 🔄 **Regenerate** — takes original prompt + owner's feedback, generates a new image
8. Regeneration appends the owner's feedback to the prompt: `"[original prompt]. Feedback: [owner comment]"`
9. New image replaces the old one on Cloudinary

## TECHNICAL IMPLEMENTATION

### 1. Install dependencies
```bash
npm install openai cloudinary
```

### 2. Create `src/instagram/image_generator.js`
```javascript
// Uses OpenAI DALL-E 3 to generate images
// Uses Cloudinary to host them permanently
// 
// generateImage(prompt) → { url, cloudinaryUrl, publicId }
// regenerateImage(prompt, feedback) → same
// uploadToCloudinary(imageUrl, postId) → { cloudinaryUrl, publicId }
```

Key implementation details:
- DALL-E 3 API: model "dall-e-3", size "1024x1024", quality "standard"
- Cloudinary upload: folder "tashkheesa/instagram", use post ID as public_id
- Return both the temp DALL-E URL and the permanent Cloudinary URL

### 3. Add API routes in `src/instagram/routes.js`

**POST /api/admin/instagram/generate/:postId**
- Reads `image_prompt` from the post
- Calls DALL-E 3
- Uploads result to Cloudinary  
- Updates `image_urls` in DB with Cloudinary URL
- Returns { success: true, imageUrl: cloudinaryUrl }

**POST /api/admin/instagram/regenerate/:postId**
- Reads `image_prompt` + `feedback` from request body
- Combines: `${original_prompt}. Revision instructions: ${feedback}`
- Calls DALL-E 3 with combined prompt
- Uploads to Cloudinary (overwrites previous)
- Updates DB
- Returns { success: true, imageUrl: cloudinaryUrl }

**POST /api/admin/instagram/approve/:postId**
- Already exists — just verify it works

**POST /api/admin/instagram/reject/:postId**  
- Update to accept `feedback` in request body
- Save feedback to a new `rejection_feedback` column (or use `error_message` column)
- Set status back to `pending_approval`

### 4. Add `rejection_feedback` column to `ig_scheduled_posts`
```sql
ALTER TABLE ig_scheduled_posts ADD COLUMN IF NOT EXISTS rejection_feedback TEXT;
ALTER TABLE ig_scheduled_posts ADD COLUMN IF NOT EXISTS generation_count INTEGER DEFAULT 0;
```

### 5. Update `src/views/superadmin_instagram.ejs`

Redesign each post card to include:

**Image area:**
- If no image: Show "Generate Image" button with a sparkle icon
- If image exists: Show the actual image (use Cloudinary URL with w_400 transform for thumbnail)
- While generating: Show a loading spinner with "Generating..." text

**Below image:**
- Post caption preview (first line of English caption)
- Arabic caption preview (first line)
- Scheduled date/time
- Status badge (Pending Approval / Approved / Rejected / Published)

**Action buttons:**
- "Generate Image" (only if no image yet) — calls generate endpoint
- "Approve" — approves the post (only if image exists)
- "Reject" — opens a textarea for feedback, then calls reject endpoint
- "Regenerate" — opens a textarea for revision instructions, then calls regenerate endpoint

**Reject/Regenerate textarea:**
- Appears inline when clicking Reject or Regenerate
- Placeholder: "What should be different? (e.g. 'make background darker, add more medical elements')"
- Submit button to confirm
- Cancel button to close

**JavaScript (inline in the EJS):**
```javascript
async function generateImage(postId, btn) {
  btn.disabled = true;
  btn.textContent = 'Generating...';
  const card = btn.closest('.ig-card');
  
  const res = await fetch(`/api/admin/instagram/generate/${postId}`, { method: 'POST' });
  const data = await res.json();
  
  if (data.success) {
    // Replace placeholder with actual image
    const imgArea = card.querySelector('.ig-card-img');
    imgArea.innerHTML = `<img src="${data.imageUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;">`;
    btn.textContent = 'Generated ✓';
  } else {
    btn.textContent = 'Failed — Retry';
    btn.disabled = false;
    alert('Generation failed: ' + data.error);
  }
}

async function rejectWithFeedback(postId, card) {
  // Show inline textarea
  const actionsDiv = card.querySelector('.ig-card-actions');
  actionsDiv.innerHTML = `
    <textarea id="feedback-${postId}" placeholder="What should be different?" style="width:100%;min-height:60px;margin-bottom:8px;border-radius:6px;border:1px solid #cbd5e1;padding:8px;font-size:0.85rem;"></textarea>
    <button class="card-btn card-btn-reject" onclick="submitReject('${postId}', this.closest('.ig-card'))">Submit Rejection</button>
    <button class="card-btn" onclick="location.reload()" style="background:#e2e8f0;color:#1a202c;">Cancel</button>
  `;
}

async function submitReject(postId, card) {
  const feedback = document.getElementById(`feedback-${postId}`).value;
  await fetch(`/api/admin/instagram/reject/${postId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback })
  });
  location.reload();
}

async function regenerateWithFeedback(postId, card) {
  // Show inline textarea for revision
  const actionsDiv = card.querySelector('.ig-card-actions');
  actionsDiv.innerHTML = `
    <textarea id="regen-${postId}" placeholder="Revision instructions (e.g. 'more blue, less dark')" style="width:100%;min-height:60px;margin-bottom:8px;border-radius:6px;border:1px solid #cbd5e1;padding:8px;font-size:0.85rem;"></textarea>
    <button class="card-btn card-btn-approve" onclick="submitRegenerate('${postId}', this.closest('.ig-card'))">Regenerate</button>
    <button class="card-btn" onclick="location.reload()" style="background:#e2e8f0;color:#1a202c;">Cancel</button>
  `;
}

async function submitRegenerate(postId, card) {
  const feedback = document.getElementById(`regen-${postId}`).value;
  const btn = card.querySelector('.card-btn-approve');
  btn.disabled = true;
  btn.textContent = 'Regenerating...';
  
  const res = await fetch(`/api/admin/instagram/regenerate/${postId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback })
  });
  const data = await res.json();
  
  if (data.success) {
    location.reload();
  } else {
    alert('Regeneration failed: ' + data.error);
    btn.textContent = 'Retry';
    btn.disabled = false;
  }
}
```

### 6. Show only upcoming posts (not all 11)
Add a filter: only show posts where `scheduled_at` is within the next 3 days, PLUS any posts with status `pending_approval` or `rejected` regardless of date. This way the owner sees what's coming up soon + anything needing attention.

Update the query in `src/routes/superadmin.js`:
```sql
SELECT * FROM ig_scheduled_posts 
WHERE scheduled_at >= NOW() - INTERVAL '1 day'
   OR status IN ('pending_approval', 'rejected')
ORDER BY day_number ASC, scheduled_at ASC
```

Also add a toggle button "Show All Posts" that loads everything if needed.

## IMAGE PROMPT GUIDELINES
When calling DALL-E 3, prepend this to every prompt:
```
"Professional healthcare brand image for Instagram. Brand colors: deep navy (#1A365D), medical blue (#2B6CB0), teal accent (#38B2AC). Clean, modern, premium feel. No text or words in the image. Square format. "
```

## TEST
1. Restart server: `npm run dev`
2. Go to localhost:3000/superadmin/instagram
3. Click "Generate Image" on the first post
4. Should see loading state, then image appears
5. Try "Reject" with feedback → image disappears, feedback saved
6. Try "Regenerate" with revision → new image appears
7. Try "Approve" → status changes to approved

## FILES TO CREATE
- `src/instagram/image_generator.js`

## FILES TO MODIFY
- `src/instagram/routes.js` — add generate/regenerate endpoints
- `src/routes/superadmin.js` — update query filter
- `src/views/superadmin_instagram.ejs` — full card redesign with generate/approve/reject/regenerate
- `src/db.js` — add rejection_feedback and generation_count columns
- `package.json` — add openai and cloudinary dependencies

## DO NOT
- Modify patient or doctor portals
- Touch CSS files
- Change any other routes
- Push to production
