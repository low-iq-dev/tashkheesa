#!/usr/bin/env node
/**
 * Tashkheesa Instagram Campaign Manager
 *
 * Usage:
 *   node scripts/instagram-publish-campaign.js --seed       # Seed all posts into DB
 *   node scripts/instagram-publish-campaign.js --post <id>  # Publish a single approved post
 *   node scripts/instagram-publish-campaign.js --list       # List all posts and their status
 */

try { require('@dotenvx/dotenvx').config(); } catch (_) { require('dotenv').config(); }
const { randomUUID } = require('crypto');
const { pool, queryOne, queryAll, execute } = require('../src/pg');
const campaignData = require('./instagram-campaign-data');

const CAMPAIGN_ID = 'launch-feb-2026';

function buildCaption(post) {
  const tags = [...(post.hashtags || []), ...campaignData.brand.hashtags];
  const uniqueTags = [...new Set(tags)];
  return `${post.caption_en}\n\n---\n\n${post.caption_ar}\n\n${uniqueTags.join(' ')}`;
}

async function seedPosts() {
  console.log(`Seeding ${campaignData.posts.length} campaign posts...`);

  let created = 0;
  let skipped = 0;

  for (const post of campaignData.posts) {
    const id = `ig-campaign-${CAMPAIGN_ID}-${post.id}`;

    const existing = await queryOne('SELECT id FROM ig_scheduled_posts WHERE id = $1', [id]);
    if (existing) {
      skipped++;
      continue;
    }

    const scheduledAt = new Date(`${post.date}T${post.time}:00+02:00`).toISOString(); // Cairo timezone
    const caption = buildCaption(post);
    const now = new Date().toISOString();

    await execute(
      `INSERT INTO ig_scheduled_posts
        (id, campaign_id, day_number, post_type, caption_en, caption_ar, caption, hashtags, image_urls, image_prompt, scheduled_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending_approval', $12, $13)`,
      [
        id,
        CAMPAIGN_ID,
        post.day,
        post.type,
        post.caption_en,
        post.caption_ar,
        caption,
        JSON.stringify(post.hashtags || []),
        JSON.stringify([]), // Empty image URLs — superadmin uploads images
        post.image_prompt || null,
        scheduledAt,
        now,
        now,
      ]
    );
    created++;
  }

  console.log(`Done: ${created} created, ${skipped} already exist.`);
}

async function publishPost(postId) {
  const post = await queryOne(
    'SELECT * FROM ig_scheduled_posts WHERE id = $1 OR (campaign_id = $1 AND day_number = $2)',
    [postId, Number(postId) || 0]
  );

  if (!post) {
    console.error(`Post not found: ${postId}`);
    process.exit(1);
  }

  if (post.status !== 'approved') {
    console.error(`Post ${post.id} status is "${post.status}" — must be "approved" to publish.`);
    process.exit(1);
  }

  console.log(`Publishing post ${post.id} (Day ${post.day_number}): ${post.post_type}`);

  try {
    const { InstagramPublisher } = require('../src/instagram/publisher');
    const publisher = new InstagramPublisher();
    const imageUrls = JSON.parse(post.image_urls || '[]');

    let result;
    switch (post.post_type) {
      case 'IMAGE':
        result = await publisher.publishImage({ imageUrl: imageUrls[0], caption: post.caption });
        break;
      case 'CAROUSEL':
        result = await publisher.publishCarousel({ imageUrls, caption: post.caption });
        break;
      case 'STORY':
        result = await publisher.publishStory({ mediaUrl: imageUrls[0], mediaType: 'IMAGE' });
        break;
      case 'REEL':
        result = await publisher.publishReel({ videoUrl: imageUrls[0], caption: post.caption });
        break;
      default:
        throw new Error(`Unknown post type: ${post.post_type}`);
    }

    const now = new Date().toISOString();
    await execute(
      `UPDATE ig_scheduled_posts SET status = 'published', ig_media_id = $1, published_at = $2, updated_at = $3 WHERE id = $4`,
      [result.id, now, now, post.id]
    );

    console.log(`Published! IG Media ID: ${result.id}`);
  } catch (err) {
    const now = new Date().toISOString();
    await execute(
      `UPDATE ig_scheduled_posts SET status = 'failed', error_message = $1, updated_at = $2 WHERE id = $3`,
      [err.message, now, post.id]
    );
    console.error(`Publish failed: ${err.message}`);
    process.exit(1);
  }
}

async function listPosts() {
  const posts = await queryAll(
    'SELECT id, day_number, post_type, status, scheduled_at, published_at FROM ig_scheduled_posts WHERE campaign_id = $1 ORDER BY day_number ASC',
    [CAMPAIGN_ID]
  );

  if (posts.length === 0) {
    console.log('No campaign posts found. Run --seed first.');
    return;
  }

  console.log(`\n${'Day'.padEnd(5)} ${'Type'.padEnd(10)} ${'Status'.padEnd(18)} ${'Scheduled'.padEnd(22)} ID`);
  console.log('-'.repeat(80));
  for (const p of posts) {
    console.log(
      `${String(p.day_number).padEnd(5)} ${p.post_type.padEnd(10)} ${p.status.padEnd(18)} ${(p.scheduled_at || '').slice(0, 19).padEnd(22)} ${p.id}`
    );
  }
  console.log(`\nTotal: ${posts.length} posts`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--seed')) {
    await seedPosts();
  } else if (args.includes('--post')) {
    const idx = args.indexOf('--post');
    const postId = args[idx + 1];
    if (!postId) {
      console.error('Usage: --post <id>');
      process.exit(1);
    }
    await publishPost(postId);
  } else if (args.includes('--list')) {
    await listPosts();
  } else {
    console.log('Usage:');
    console.log('  --seed         Seed all campaign posts into DB');
    console.log('  --post <id>    Publish a single approved post');
    console.log('  --list         List all campaign posts');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
