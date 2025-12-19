

const base = process.env.SMOKE_BASE_URL || 'http://localhost:3000';

(async () => {
  try {
    const paths = ['/healthz', '/__version'];

    await Promise.all(
      paths.map(async (p) => {
        const r = await fetch(base + p);
        if (!r.ok) throw new Error(`${p} ${r.status}`);
        await r.text();
      })
    );

    console.log('✅ smoke ok');
  } catch (e) {
    console.error('⛔ smoke failed:', e?.message || e);
    process.exit(1);
  }
})();