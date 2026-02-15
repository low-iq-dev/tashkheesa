require('dotenv').config();

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

async function testPost() {
  console.log('\n🧪 Tashkheesa Instagram Test Post\n');

  const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
  const IG_ACCOUNT_ID = process.env.IG_BUSINESS_ACCOUNT_ID;

  if (!ACCESS_TOKEN || !IG_ACCOUNT_ID) {
    console.error('❌ Missing IG_ACCESS_TOKEN or IG_BUSINESS_ACCOUNT_ID in .env');
    process.exit(1);
  }
  console.log('✅ Environment variables found\n');

  // Step 1: Upload test image to Cloudinary
  console.log('📤 Uploading test image to Cloudinary...');
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  let imageUrl;
  try {
    const result = await cloudinary.uploader.upload(
      'https://placehold.co/1080x1080/0A1628/2EC4B6.jpg?text=Tashkheesa%0ATest+Post',
      { folder: 'tashkheesa/instagram', public_id: 'test-post-' + Date.now() }
    );
    imageUrl = result.secure_url;
    console.log('✅ Uploaded:', imageUrl, '\n');
  } catch (err) {
    console.error('❌ Cloudinary failed:', err.message);
    process.exit(1);
  }

  // Step 2: Create Instagram container
  console.log('📦 Creating Instagram container...');
  const containerRes = await fetch(`${GRAPH_API_BASE}/${IG_ACCOUNT_ID}/media`, {
    method: 'POST',
    body: new URLSearchParams({
      image_url: imageUrl,
      caption: '🧪 Test post from Tashkheesa automation.\n\nIf you see this, it works! ✅\n\n%23Tashkheesa %23TestPost',
      access_token: ACCESS_TOKEN,
    }),
  });
  const container = await containerRes.json();

  if (container.error) {
    console.error('❌ Container failed:', container.error.message);
    process.exit(1);
  }
  console.log('✅ Container:', container.id, '\n');

  // Step 3: Wait for processing
  console.log('⏳ Waiting for processing...');
  let status = 'IN_PROGRESS';
  for (let i = 0; i < 30 && status === 'IN_PROGRESS'; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(`${GRAPH_API_BASE}/${container.id}?fields=status_code&access_token=${ACCESS_TOKEN}`);
    const data = await res.json();
    status = data.status_code;
    process.stdout.write('.');
  }
  console.log('\n✅ Container ready\n');

  // Step 4: Publish
  console.log('🚀 Publishing to Instagram...');
  const pubRes = await fetch(`${GRAPH_API_BASE}/${IG_ACCOUNT_ID}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: container.id, access_token: ACCESS_TOKEN }),
  });
  const pub = await pubRes.json();

  if (pub.error) {
    console.error('❌ Publish failed:', pub.error.message);
    process.exit(1);
  }

  console.log('\n🎉 SUCCESS! Posted to Instagram!');
  console.log('   Media ID:', pub.id);
  console.log('   Check: https://instagram.com/tashkheesaa\n');
}

testPost();
