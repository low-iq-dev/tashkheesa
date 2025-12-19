const base = process.env.SMOKE_BASE_URL || 'http://localhost:3000';

(async () => {
  const paths = ['/healthz', '/__version'];

  try {
    await Promise.all(
      paths.map(async (p) => {
        const r = await fetch(base + p);
        if (!r.ok) throw new Error(`${p} ${r.status}`);
        await r.text();
      })
    );

    console.log('✅ smoke ok');
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('⛔ smoke failed:', msg);
    console.error('➡ Tried:', paths.map((p) => base + p).join(' , '));
    console.error(
      '➡ Fix: start the server in another terminal: `npm run dev` (leave it running), then rerun: `npm run safe`'
    );
    console.error(
      '➡ If server is on a different URL, set SMOKE_BASE_URL (example: `SMOKE_BASE_URL=http://localhost:3000 npm run safe`).'
    );
    process.exit(1);
  }
})();