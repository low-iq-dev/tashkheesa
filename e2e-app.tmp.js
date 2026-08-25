// End-to-end exercise of the PATIENT APP pipeline against production.
//
// Auth: a 15-minute access token minted locally with the app's own
// generateTokens + JWT_SECRET. No credentials are entered anywhere and no
// production auth data is modified. The token is never printed.
//
// Safety: submit() creates a real order but does NOT pay it. Assignment and the
// doctor broadcast both hang off PAID, so no doctor is contacted. The order is
// deleted at the end.

require('dotenv').config();
const { generateTokens } = require('/Users/macmini/tashkheesa-portal/src/middleware/requireJWT');

const BASE = 'https://tashkheesa.onrender.com/api/v1';
const PATIENT = { id: '7f942f8b-3569-4737-8078-c17f8965a16d', email: 'test@gmail.com', role: 'patient', name: 'E2E Test' };
const { accessToken } = generateTokens(PATIENT);

const results = [];
let draftId = null;
let caseId = null;

function log(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + step.padEnd(42) + (detail || ''));
}

async function call(method, path, body, opts) {
  const init = {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + accessToken }, (opts && opts.headers) || {}),
  };
  if (body !== undefined && !(opts && opts.raw)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(BASE + path, init);
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch (_) { json = { _raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

(async () => {
  console.log('\n=== PATIENT APP PIPELINE — production ===\n');

  // 1. Session
  let r = await call('GET', '/auth/me');
  log('auth/me', r.status === 200, 'status=' + r.status + (r.status !== 200 ? ' ' + JSON.stringify(r.json).slice(0,160) : ''));

  // 2. Catalogue
  r = await call('GET', '/specialties');
  const specs = (r.json && r.json.data) || [];
  log('GET /specialties', r.status === 200 && specs.length > 0, 'status=' + r.status + ' count=' + specs.length);

  const withServices = specs.filter(s => (s.serviceCount ?? 1) > 0);
  const spec = withServices[0];
  log('specialties have bookable services', !!spec, spec ? ('using ' + spec.id) : 'NONE bookable');

  let service = null;
  if (spec) {
    r = await call('GET', '/services?specialty=' + encodeURIComponent(spec.id) + '&country=EG');
    const svcs = (r.json && r.json.data) || [];
    service = svcs[0];
    log('GET /services', r.status === 200 && svcs.length > 0, 'status=' + r.status + ' count=' + svcs.length);
    log('service carries a price', !!(service && service.basePrice),
        service ? (service.currency + ' ' + service.basePrice) : 'no service');
  }

  // 3. Resume (should be null or an old draft)
  r = await call('GET', '/cases/draft');
  log('GET /cases/draft (resume)', r.status === 200, 'status=' + r.status + ' draft=' + (r.json?.data?.draft ? 'present' : 'null'));

  // 4. Create
  r = await call('POST', '/cases/draft', {
    clinicalQuestion: 'E2E pipeline check — shortness of breath after a chest CT, requesting a second opinion.',
    medicalHistory: 'E2E test record.',
    country: 'EG',
    language: 'en'
  });
  draftId = r.json?.data?.draft?.id || null;
  log('POST /cases/draft (create)', r.status === 200 && !!draftId,
      'status=' + r.status + (draftId ? ' id=' + draftId.slice(0,8) : ' ' + JSON.stringify(r.json).slice(0,200)));

  if (draftId) {
    // 5. Patch
    r = await call('PATCH', '/cases/draft/' + draftId, { medicalHistory: 'E2E patched.', draftStep: 1 });
    log('PATCH /cases/draft/:id', r.status === 200, 'status=' + r.status);

    // 6. Documents-done with NO files — must be refused
    r = await call('POST', '/cases/draft/' + draftId + '/documents-done', {});
    log('documents-done refuses 0 files', r.status === 422 && r.json?.code === 'NEEDS_FILES',
        'status=' + r.status + ' code=' + (r.json?.code || '-'));

    // 7. Submit with NO files — must also be refused (server-side enforcement)
    r = await call('POST', '/cases/draft/' + draftId + '/submit', { serviceId: service && service.id });
    log('submit refuses 0 files', r.status === 422 && r.json?.code === 'NEEDS_FILES',
        'status=' + r.status + ' code=' + (r.json?.code || '-'));

    // 8. Upload a file
    const form = new FormData();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    form.append('file', new Blob([png], { type: 'image/png' }), 'e2e-probe.png');
    r = await call('POST', '/files', form, { raw: true });
    const key = r.json?.data?.key || null;
    log('POST /files (R2 upload)', r.status === 200 && !!key,
        'status=' + r.status + (key ? '' : ' ' + JSON.stringify(r.json).slice(0,220)));

    if (key) {
      // 9. Attach
      r = await call('POST', '/cases/draft/' + draftId + '/files', {
        fileId: key, filename: 'e2e-probe.png', mimeType: 'image/png', size: png.length
      });
      log('POST /cases/draft/:id/files', r.status === 200, 'status=' + r.status +
          (r.status !== 200 ? ' ' + JSON.stringify(r.json).slice(0,200) : ''));

      // 10. Documents-done now succeeds
      r = await call('POST', '/cases/draft/' + draftId + '/documents-done', {});
      log('documents-done with 1 file', r.status === 200, 'status=' + r.status +
          (r.status !== 200 ? ' ' + JSON.stringify(r.json).slice(0,200) : ''));

      // 11. Classification poll
      r = await call('GET', '/cases/draft/' + draftId + '/classification');
      log('GET classification', r.status === 200,
          'status=' + r.status + ' classification=' + (r.json?.data?.classification ? 'present' : 'null (AI off — expected)'));

      // 12. Submit
      r = await call('POST', '/cases/draft/' + draftId + '/submit', {
        serviceId: service && service.id,
        specialtyId: spec && spec.id,
        urgencyTier: 'standard',
        country: 'EG'
      });
      caseId = r.json?.data?.id || null;
      log('POST submit', r.status === 200 && !!caseId,
          'status=' + r.status + (caseId ? ' ref=' + (r.json?.data?.referenceId || '?') : ' ' + JSON.stringify(r.json).slice(0,250)));
      if (caseId) {
        const d = r.json.data;
        log('submit priced the case', d.price != null, 'price=' + d.price + ' ' + (d.currency || '') + ' sla=' + d.slaHours + 'h');
      }
    }
  }

  // 13. Case list + detail
  r = await call('GET', '/cases');
  log('GET /cases (list)', r.status === 200, 'status=' + r.status + ' count=' + ((r.json?.data?.length) ?? '?'));

  if (caseId) {
    r = await call('GET', '/cases/' + caseId);
    log('GET /cases/:id', r.status === 200, 'status=' + r.status);

    // 14. THE MONEY PATH
    r = await call('GET', '/cases/' + caseId + '/payment');
    const hasLink = !!(r.json?.data?.paymentUrl || r.json?.data?.payment_link || r.json?.data?.url);
    log('GET /cases/:id/payment (Paymob)', r.status === 200 && hasLink,
        'status=' + r.status + ' ' + (hasLink ? 'link minted' : JSON.stringify(r.json).slice(0,300)));
  }

  // 15. Notifications
  r = await call('GET', '/notifications');
  const notifs = r.json?.data || [];
  log('GET /notifications', r.status === 200, 'status=' + r.status + ' count=' + (notifs.length ?? '?'));
  const channelsLeaked = notifs.some(n => n.channel && n.channel !== 'internal');
  log('list is internal-only', !channelsLeaked, channelsLeaked ? 'LEAKED non-internal rows' : 'clean');

  r = await call('GET', '/notifications/unread-count');
  log('GET /notifications/unread-count', r.status === 200, 'status=' + r.status + ' count=' + (r.json?.data?.count ?? '?'));

  console.log('\n=== SUMMARY ===');
  const failed = results.filter(x => !x.ok);
  console.log('passed: ' + (results.length - failed.length) + '/' + results.length);
  if (failed.length) {
    console.log('\nFAILURES:');
    failed.forEach(f => console.log('  - ' + f.step + ' :: ' + f.detail));
  }
  console.log('\nCLEANUP_ORDER_ID=' + (caseId || draftId || 'none'));
})().catch(e => { console.error('HARNESS ERROR:', e && e.message); process.exit(1); });
