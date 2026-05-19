// Superadmin cockpit — data layer.
//
// Each public function returns a JSON-serializable shape consumed by the
// matching partial under src/views/partials/superadmin/tab_*.ejs. The
// fetchers parallelize their queries internally with Promise.all so the
// dashboard route hits the DB in a small number of concurrent waves
// rather than 25+ sequential calls.
//
// Caching is in-process Map+TTL, scoped to this module. Owner cockpit is
// owner-only, low fanout, single Render instance — no need for a shared
// store. Cache TTLs are conservative (30-60s) so the cockpit stays
// near-live but doesn't re-run every aggregation per page load.

const { safeAll, safeGet, tableExists } = require('../sql-utils');

// ─── In-process TTL cache ─────────────────────────────────────────────
const _cache = new Map(); // key -> { value, exp }

async function getCached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && hit.exp > now) return hit.value;
  const value = await fn();
  _cache.set(key, { value, exp: now + ttlMs });
  return value;
}

// Allow tests / dev to bust the cache. Not exported officially.
function _bustCache() { _cache.clear(); }

// ─── Range → SQL interval ─────────────────────────────────────────────
// Maps the prototype's range picker (today/7d/30d/mtd) to a SQL date
// filter clause on orders_active.created_at. Returns the WHERE fragment
// (without the leading WHERE) plus params. Used for "this period" KPIs.
function rangeFilter(range) {
  switch (String(range || '7d').toLowerCase()) {
    case 'today':
      return { clause: "o.created_at::date = CURRENT_DATE", params: [] };
    case '30d':
      return { clause: "o.created_at >= NOW() - INTERVAL '30 days'", params: [] };
    case 'mtd':
      return { clause: "o.created_at >= date_trunc('month', NOW())", params: [] };
    case '7d':
    default:
      return { clause: "o.created_at >= NOW() - INTERVAL '7 days'", params: [] };
  }
}

// Human label for the range, for "vs prev 7d" type sub-strings.
function rangeLabel(range) {
  switch (String(range || '7d').toLowerCase()) {
    case 'today': return 'today';
    case '30d':   return 'last 30d';
    case 'mtd':   return 'MTD';
    case '7d':
    default:      return 'last 7d';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────
function fmtEgp(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

function fmtPct(num, den) {
  if (!den || den <= 0) return '0%';
  return Math.round((Number(num) / Number(den)) * 100) + '%';
}

function fmtMinutesAsHm(min) {
  if (min == null || Number.isNaN(min)) return '—';
  const m = Math.round(Number(min));
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${String(rem).padStart(2, '0')}m`;
}

function relTime(d) {
  if (!d) return '—';
  const t = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(t.getTime())) return '—';
  const diffMs = Date.now() - t.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.round(hrs / 24);
  return days + 'd ago';
}

// SLA bucket from hours-remaining float
function slaBucketTier(hoursRemaining) {
  if (hoursRemaining == null) return null;
  if (hoursRemaining < 1) return 'red';
  if (hoursRemaining < 4) return 'amber';
  return 'green';
}

// ─── Pills / Banner / Sidebar (cross-tab chrome) ──────────────────────
async function getStatusPills() {
  return getCached('pills', 30_000, async () => {
    const [
      slaOnTime, errCount24h, workerFailing, dbPing, waCheckRow
    ] = await Promise.all([
      // SLA on-time % over last 7 days (completed cases only)
      safeGet(
        `SELECT
            COUNT(*) FILTER (WHERE completed_at::timestamptz <= deadline_at::timestamptz) AS on_time,
            COUNT(*) AS total
         FROM orders_active
         WHERE completed_at IS NOT NULL
           AND deadline_at IS NOT NULL
           AND completed_at >= NOW() - INTERVAL '7 days'`,
        [], { on_time: 0, total: 0 }
      ),
      // Errors in last 24h (only if error_logs table exists)
      tableExists('error_logs').then(exists => exists
        ? safeGet(`SELECT COUNT(*) AS cnt FROM error_logs WHERE created_at > NOW() - INTERVAL '1 day'`, [], { cnt: 0 })
        : { cnt: 0 }),
      // Workers ok/failing — pg-boss state via job table if present; otherwise null
      tableExists('pgboss.job').then(async exists => {
        if (!exists) return null;
        return safeGet(
          `SELECT
              COUNT(*) FILTER (WHERE state = 'failed' AND completedon > NOW() - INTERVAL '1 hour') AS failing
            FROM pgboss.job`,
          [], { failing: 0 }
        );
      }).catch(() => null),
      // DB latency proxy — just measure how long the next query takes
      (async () => {
        const t0 = Date.now();
        await safeGet('SELECT 1 AS one', [], { one: 1 });
        return { ms: Date.now() - t0 };
      })(),
      // WhatsApp recent fail rate
      tableExists('notifications').then(exists => exists
        ? safeGet(
            `SELECT
                COUNT(*) FILTER (WHERE status = 'failed') AS failed,
                COUNT(*) AS total
              FROM notifications
              WHERE channel = 'whatsapp' AND at > NOW() - INTERVAL '1 hour'`,
            [], { failed: 0, total: 0 }
          )
        : { failed: 0, total: 0 })
    ]);

    const slaPct = slaOnTime.total > 0
      ? Math.round((Number(slaOnTime.on_time) * 100) / Number(slaOnTime.total))
      : null;

    const pills = [];
    pills.push({
      key: 'sla',
      label: 'SLA',
      value: slaPct == null ? '—' : (slaPct + '%'),
      state: slaPct == null ? 'ok' : (slaPct >= 90 ? 'ok' : slaPct >= 75 ? 'warn' : 'bad'),
      href: '/superadmin#operations'
    });
    pills.push({
      key: 'errors',
      label: 'Errors',
      value: String(errCount24h.cnt || 0),
      state: Number(errCount24h.cnt) === 0 ? 'ok' : Number(errCount24h.cnt) > 10 ? 'bad' : 'warn',
      href: '/superadmin#health'
    });
    pills.push({
      key: 'workers',
      label: 'Workers',
      value: workerFailing == null ? '—' : (Number(workerFailing.failing) === 0 ? 'OK' : (workerFailing.failing + ' fail')),
      state: workerFailing == null ? 'ok' : (Number(workerFailing.failing) === 0 ? 'ok' : 'warn'),
      href: '/superadmin#health'
    });
    pills.push({
      key: 'db',
      label: 'DB',
      value: dbPing.ms + 'ms',
      state: dbPing.ms < 50 ? 'ok' : dbPing.ms < 200 ? 'warn' : 'bad'
    });
    if (waCheckRow.total > 0) {
      const wp = Math.round((Number(waCheckRow.failed) * 100) / Number(waCheckRow.total));
      pills.push({
        key: 'whatsapp',
        label: 'WhatsApp',
        value: wp === 0 ? 'OK' : (wp + '% fail'),
        state: wp === 0 ? 'ok' : wp > 25 ? 'bad' : 'warn',
        href: '/superadmin#marketing'
      });
    }
    return pills;
  });
}

async function getAttentionItems() {
  return getCached('attention', 30_000, async () => {
    const [breachedNow, urgentUnassigned, doctorsPending, refundsPending, fileReqsPending] = await Promise.all([
      // SLA breached now (active, past deadline)
      safeGet(
        `SELECT COUNT(*) AS cnt
           FROM orders_active
          WHERE completed_at IS NULL
            AND deadline_at IS NOT NULL
            AND deadline_at::timestamptz < NOW()`,
        [], { cnt: 0 }
      ),
      // Urgent unassigned
      safeGet(
        `SELECT COUNT(*) AS cnt
           FROM orders_active
          WHERE doctor_id IS NULL
            AND completed_at IS NULL
            AND LOWER(COALESCE(urgency_tier, 'standard')) IN ('urgent', 'fast_track')`,
        [], { cnt: 0 }
      ),
      safeGet(
        `SELECT COUNT(*) AS cnt FROM users WHERE role = 'doctor' AND pending_approval = true`,
        [], { cnt: 0 }
      ),
      tableExists('refunds').then(exists => exists
        ? safeGet(`SELECT COUNT(*) AS cnt FROM refunds WHERE status = 'pending'`, [], { cnt: 0 })
        : { cnt: 0 }),
      // Pending file requests on orders — best-effort, table+column may not exist
      safeGet(
        `SELECT COUNT(*) AS cnt FROM order_events
          WHERE label = 'additional_files_requested'
            AND at > NOW() - INTERVAL '7 days'`,
        [], { cnt: 0 }
      ).catch(() => ({ cnt: 0 }))
    ]);

    const items = [];
    if (Number(breachedNow.cnt) > 0) items.push({ key: 'breached', label: 'cases SLA-breached now', value: Number(breachedNow.cnt), href: '/superadmin/orders?filter=breached' });
    if (Number(urgentUnassigned.cnt) > 0) items.push({ key: 'urgent', label: 'urgent cases unassigned', value: Number(urgentUnassigned.cnt), href: '/superadmin/orders?filter=unassigned' });
    if (Number(doctorsPending.cnt) > 0) items.push({ key: 'doctors', label: 'doctors pending approval', value: Number(doctorsPending.cnt), href: '/superadmin/doctors?status=pending' });
    if (Number(refundsPending.cnt) > 0) items.push({ key: 'refunds', label: 'refunds pending review', value: Number(refundsPending.cnt), href: '/superadmin/refunds' });
    if (Number(fileReqsPending.cnt) > 0) items.push({ key: 'filereqs', label: 'file requests open', value: Number(fileReqsPending.cnt), href: '/superadmin/orders?filter=file-requests' });

    // Severity heuristic — breached or many urgent => red, anything else => amber
    const severity = (Number(breachedNow.cnt) > 0 || Number(urgentUnassigned.cnt) > 1) ? 'red' : 'amber';
    return { items, severity };
  });
}

async function getSidebarBadges() {
  return getCached('sidebar_badges', 30_000, async () => {
    const [cases, video, doctors, alerts, instagram, opsAttn, hltAttn, docAttn, finAttn] = await Promise.all([
      // Active cases (not completed)
      safeGet(`SELECT COUNT(*) AS cnt FROM orders_active WHERE completed_at IS NULL`, [], { cnt: 0 }),
      // Upcoming video calls today
      tableExists('appointments').then(exists => exists
        ? safeGet(
            `SELECT COUNT(*) AS cnt FROM appointments
              WHERE scheduled_at::date = CURRENT_DATE
                AND status IN ('scheduled', 'pending', 'confirmed')`,
            [], { cnt: 0 }
          )
        : { cnt: 0 }),
      safeGet(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'doctor' AND pending_approval = true`, [], { cnt: 0 }),
      // Unread superadmin notifications
      tableExists('notifications').then(exists => exists
        ? safeGet(
            `SELECT COUNT(*) AS cnt FROM notifications
              WHERE COALESCE(LOWER(status), '') NOT IN ('seen', 'read')
                AND (template ILIKE '%superadmin%' OR template ILIKE '%admin_alert%')
                AND at > NOW() - INTERVAL '30 days'`,
            [], { cnt: 0 }
          )
        : { cnt: 0 }),
      tableExists('ig_scheduled_posts').then(exists => exists
        ? safeGet(`SELECT COUNT(*) AS cnt FROM ig_scheduled_posts WHERE status = 'pending'`, [], { cnt: 0 })
        : { cnt: 0 }),
      // Per-tab attention counts
      safeGet(
        `SELECT COUNT(*) AS cnt
           FROM orders_active
          WHERE completed_at IS NULL
            AND deadline_at IS NOT NULL
            AND deadline_at::timestamptz < NOW() + INTERVAL '4 hours'`,
        [], { cnt: 0 }
      ),
      tableExists('error_logs').then(exists => exists
        ? safeGet(`SELECT COUNT(*) AS cnt FROM error_logs WHERE created_at > NOW() - INTERVAL '24 hours'`, [], { cnt: 0 })
        : { cnt: 0 }),
      safeGet(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'doctor' AND pending_approval = true`, [], { cnt: 0 }),
      tableExists('refunds').then(exists => exists
        ? safeGet(`SELECT COUNT(*) AS cnt FROM refunds WHERE status = 'pending'`, [], { cnt: 0 })
        : { cnt: 0 })
    ]);
    // finAttn = pending refunds (also the finance-tab attention indicator).
    // Aliased under `refunds` for the sidebar badgeKey set in Phase 4.
    return {
      cases: Number(cases.cnt) || 0,
      video: Number(video.cnt) || 0,
      doctors: Number(doctors.cnt) || 0,
      alerts: Number(alerts.cnt) || 0,
      instagram: Number(instagram.cnt) || 0,
      refunds: Number(finAttn.cnt) || 0,
      tab_ops_attn: Number(opsAttn.cnt) || 0,
      tab_hlt_attn: Number(hltAttn.cnt) || 0,
      tab_doc_attn: Number(docAttn.cnt) || 0,
      tab_fin_attn: Number(finAttn.cnt) || 0
    };
  });
}

// ─── OPERATIONS ───────────────────────────────────────────────────────
async function getOperationsTabData({ range = '7d' } = {}) {
  return getCached('ops:' + range, 30_000, async () => {
    const rf = rangeFilter(range);
    const [
      kpiAgg, slaBuckets, recentCases, doctorPresence, breachedTrend
    ] = await Promise.all([
      // Aggregated KPI counts in one query
      safeGet(
        `SELECT
            COUNT(*) FILTER (WHERE completed_at IS NULL) AS in_flight,
            COUNT(*) FILTER (WHERE completed_at IS NULL AND deadline_at IS NOT NULL AND deadline_at::timestamptz < NOW()) AS breached_now,
            COUNT(*) FILTER (WHERE doctor_id IS NULL AND completed_at IS NULL) AS unassigned,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(urgency_tier,'standard')) IN ('urgent','fast_track') AND completed_at IS NULL) AS urgent_active,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(urgency_tier,'standard')) = 'vip' AND completed_at IS NULL) AS vip_active,
            COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today_total
         FROM orders_active`,
        [], { in_flight: 0, breached_now: 0, unassigned: 0, urgent_active: 0, vip_active: 0, today_total: 0 }
      ),
      // SLA risk buckets (3 buckets by hours-remaining)
      safeAll(
        `SELECT tier, COUNT(*) AS n FROM (
            SELECT
              CASE
                WHEN EXTRACT(EPOCH FROM (deadline_at::timestamptz - NOW())) / 3600 < 1 THEN 'red'
                WHEN EXTRACT(EPOCH FROM (deadline_at::timestamptz - NOW())) / 3600 < 4 THEN 'amber'
                ELSE 'green'
              END AS tier
           FROM orders_active
           WHERE completed_at IS NULL
             AND deadline_at IS NOT NULL
             AND EXTRACT(EPOCH FROM (deadline_at::timestamptz - NOW())) / 3600 >= 0
         ) sub
         GROUP BY tier`,
        [], []
      ),
      // Recent cases for live table
      safeAll(
        `SELECT
            o.id,
            o.reference_id,
            COALESCE(p.name, '—') AS patient_name,
            COALESCE(sp.name, '—') AS specialty_name,
            COALESCE(sv.name, '—') AS service_name,
            COALESCE(o.urgency_tier, 'standard') AS urgency_tier,
            COALESCE(d.name, '—') AS doctor_name,
            o.status,
            o.deadline_at,
            o.completed_at,
            EXTRACT(EPOCH FROM (o.deadline_at::timestamptz - NOW())) / 3600 AS hours_remaining
         FROM orders_active o
         LEFT JOIN users p ON p.id = o.patient_id
         LEFT JOIN users d ON d.id = o.doctor_id
         LEFT JOIN specialties sp ON sp.id = o.specialty_id
         LEFT JOIN services sv ON sv.id = o.service_id
         WHERE o.completed_at IS NULL OR o.completed_at > NOW() - INTERVAL '4 hours'
         ORDER BY (o.deadline_at IS NULL), o.deadline_at ASC, o.created_at DESC
         LIMIT 8`,
        [], []
      ),
      // Doctor presence — active in last 10 min via session table, fallback to is_active
      safeAll(
        `SELECT
            u.id,
            u.name,
            COALESCE(sp.name, '—') AS specialty_name,
            COUNT(o.id) FILTER (WHERE o.completed_at IS NULL AND o.doctor_id = u.id) AS active_cases
         FROM users u
         LEFT JOIN specialties sp ON sp.id = u.specialty_id
         LEFT JOIN orders_active o ON o.doctor_id = u.id
         WHERE u.role = 'doctor'
           AND u.is_active = true
           AND u.pending_approval = false
           AND COALESCE(u.is_paused, false) = false
         GROUP BY u.id, u.name, sp.name
         ORDER BY active_cases DESC, u.name ASC
         LIMIT 6`,
        [], []
      ),
      // Sparkline: cases per day, last 7d (no range filter — chart is fixed)
      safeAll(
        `SELECT
            created_at::date AS d,
            COUNT(*) AS n
         FROM orders_active
         WHERE created_at >= NOW() - INTERVAL '7 days'
         GROUP BY d
         ORDER BY d ASC`,
        [], []
      )
    ]);

    const inFlightSpark = buildSparkSeries(breachedTrend.map(r => ({ d: r.d, v: Number(r.n) })), 7);
    const buckets = {
      red:   { tier: 'red',   label: '< 1 hour',     n: 0, sub: 'reassign now' },
      amber: { tier: 'amber', label: '1 — 4 hours',  n: 0, sub: 'watch closely' },
      green: { tier: 'green', label: '> 4 hours',    n: 0, sub: 'on track' }
    };
    slaBuckets.forEach(r => { if (buckets[r.tier]) buckets[r.tier].n = Number(r.n); });

    return {
      range,
      rangeLabel: rangeLabel(range),
      kpis: [
        { label: 'Cases in flight', value: kpiAgg.in_flight, sub: 'today total ' + kpiAgg.today_total, spark: inFlightSpark },
        { label: 'SLA breached now', value: kpiAgg.breached_now, sub: Number(kpiAgg.breached_now) > 0 ? 'reassign or escalate' : 'none' },
        { label: 'Pending doctor approvals', value: null, sub: 'see Doctors tab' }, // delegated to doctors tab
        { label: 'Urgent active', value: kpiAgg.urgent_active, sub: '1.6× uplift' },
        { label: 'VIP active', value: kpiAgg.vip_active, sub: '1.3× uplift' },
        { label: 'Unassigned', value: kpiAgg.unassigned, sub: Number(kpiAgg.unassigned) > 0 ? 'in queue' : 'none' }
      ],
      slaBuckets: [buckets.red, buckets.amber, buckets.green],
      // Tier distribution for the stacked strip — same source as buckets above
      tierStrip: [
        { label: 'Urgent',   v: Number(kpiAgg.urgent_active), color: 'var(--red)' },
        { label: 'VIP',      v: Number(kpiAgg.vip_active),    color: 'var(--violet)' },
        { label: 'Standard', v: Math.max(0, Number(kpiAgg.in_flight) - Number(kpiAgg.urgent_active) - Number(kpiAgg.vip_active)), color: 'var(--accent)' }
      ],
      cases: recentCases.map(c => {
        const hr = c.hours_remaining;
        return {
          id: c.reference_id || c.id,
          rawId: c.id,
          patient: c.patient_name,
          spec: c.specialty_name,
          service: c.service_name,
          tier: ({ urgent: 'Urgent', fast_track: 'Urgent', vip: 'VIP', standard: 'Standard' }[String(c.urgency_tier || '').toLowerCase()] || 'Standard'),
          deadline: c.completed_at ? 'delivered' : (hr == null ? '—' : (hr < 0 ? 'overdue' : fmtHoursAsHm(hr))),
          status: humanStatus(c.status),
          doc: c.doctor_name,
          risk: c.completed_at ? 'green' : (slaBucketTier(hr) || 'amber')
        };
      }),
      doctors: doctorPresence.map(d => ({
        name: d.name,
        spec: d.specialty_name,
        active: Number(d.active_cases) || 0,
        // Real presence requires last_seen_at; not in DB yet. Leave neutral.
        status: Number(d.active_cases) > 0 ? 'busy' : 'idle',
        presence: Number(d.active_cases) > 0 ? 'online' : 'idle'
      }))
    };
  });
}

function fmtHoursAsHm(h) {
  if (h == null || Number.isNaN(Number(h))) return '—';
  const totalMin = Math.round(Number(h) * 60);
  if (totalMin < 60) return totalMin + 'm';
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return mm === 0 ? hh + 'h' : `${hh}h ${String(mm).padStart(2, '0')}m`;
}

function humanStatus(s) {
  if (!s) return '—';
  return String(s).replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
}

// Pads/normalises a per-day series into a fixed-length sparkline array.
function buildSparkSeries(rows, days) {
  const series = new Array(days).fill(0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  rows.forEach(r => {
    const dt = new Date(r.d);
    dt.setHours(0, 0, 0, 0);
    const diff = Math.round((today - dt) / 86400000);
    const idx = days - 1 - diff;
    if (idx >= 0 && idx < days) series[idx] = Number(r.v) || 0;
  });
  return series;
}

// ─── FINANCE ──────────────────────────────────────────────────────────
async function getFinanceTabData({ range = '7d' } = {}) {
  return getCached('finance:' + range, 60_000, async () => {
    const [
      kpiAgg, urgencyTier, fxZone, payouts, paymobToday, paymobRecent, refundsMtd, revBySpec
    ] = await Promise.all([
      // KPI aggregates
      safeGet(
        `SELECT
            COALESCE(SUM(price) FILTER (WHERE created_at::date = CURRENT_DATE), 0) AS rev_today,
            COALESCE(SUM(price) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) AS rev_mtd,
            COALESCE(SUM(price - COALESCE(doctor_fee, 0)) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) AS gross_profit_mtd,
            COALESCE(AVG(price) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND price > 0), 0) AS avg_order_30d,
            COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW())) AS orders_mtd
         FROM orders_active`,
        [], { rev_today: 0, rev_mtd: 0, gross_profit_mtd: 0, avg_order_30d: 0, orders_mtd: 0 }
      ),
      // Urgency tier breakdown for selected range
      safeAll(
        `SELECT
            COALESCE(o.urgency_tier, 'standard') AS tier,
            COUNT(*) AS cases,
            COALESCE(SUM(o.urgency_uplift_amount), 0) AS uplift
         FROM orders_active o
         WHERE ${rangeFilter(range).clause}
         GROUP BY COALESCE(o.urgency_tier, 'standard')`,
        [], []
      ),
      // FX zone (country) — best-effort
      safeAll(
        `SELECT
            COALESCE(o.country, 'EG') AS country,
            COUNT(*) AS cases,
            COALESCE(SUM(o.price), 0) AS rev
         FROM orders_active o
         WHERE ${rangeFilter(range).clause}
         GROUP BY country
         ORDER BY rev DESC
         LIMIT 6`,
        [], []
      ),
      // Payouts ledger (top 6 by owed)
      tableExists('doctor_earnings').then(exists => exists
        ? safeAll(
            `SELECT
                u.id AS doctor_id,
                COALESCE(u.name, '—') AS doctor_name,
                COALESCE(SUM(de.earned_amount) FILTER (WHERE de.status = 'pending'), 0) AS owed,
                COUNT(*) FILTER (WHERE de.created_at >= NOW() - INTERVAL '14 days') AS cycle_cases,
                MAX(de.created_at) FILTER (WHERE de.status = 'paid') AS last_paid
             FROM users u
             LEFT JOIN doctor_earnings de ON de.doctor_id = u.id
             WHERE u.role = 'doctor'
             GROUP BY u.id, u.name
             ORDER BY owed DESC NULLS LAST
             LIMIT 6`,
            [], []
          )
        : []),
      // Paymob today summary — check for table that tracks paymob txns
      tableExists('appointment_payments').then(exists => exists
        ? safeGet(
            `SELECT
                COUNT(*) AS txns,
                COUNT(*) FILTER (WHERE status = 'paid') AS success,
                COUNT(*) FILTER (WHERE status = 'failed') AS failed,
                COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS settled,
                COALESCE(SUM(amount) FILTER (WHERE status IN ('pending', 'authorized')), 0) AS pending
              FROM appointment_payments
              WHERE created_at::date = CURRENT_DATE`,
            [], { txns: 0, success: 0, failed: 0, settled: 0, pending: 0 }
          )
        : { txns: 0, success: 0, failed: 0, settled: 0, pending: 0 }),
      tableExists('appointment_payments').then(exists => exists
        ? safeAll(
            `SELECT id, amount, status, created_at FROM appointment_payments
              WHERE created_at::date = CURRENT_DATE
              ORDER BY created_at DESC LIMIT 5`,
            [], []
          )
        : []),
      tableExists('refunds').then(exists => exists
        ? safeGet(
            `SELECT
                COUNT(*) AS cnt,
                COALESCE(SUM(amount_egp), 0) AS total
              FROM refunds
              WHERE refunded_at >= date_trunc('month', NOW())
                AND status IN ('paid','approved','auto_approved')`,
            [], { cnt: 0, total: 0 }
          )
        : { cnt: 0, total: 0 }),
      // Revenue by specialty for the selected range
      safeAll(
        `SELECT
            sp.name AS specialty_name,
            COUNT(o.id) AS cases,
            COALESCE(SUM(o.price), 0) AS revenue
         FROM orders_active o
         LEFT JOIN specialties sp ON sp.id = o.specialty_id
         WHERE ${rangeFilter(range).clause}
         GROUP BY sp.name
         HAVING COUNT(o.id) > 0
         ORDER BY revenue DESC
         LIMIT 8`,
        [], []
      )
    ]);

    return {
      range,
      rangeLabel: rangeLabel(range),
      kpis: [
        { label: 'Revenue (today)', value: fmtEgp(kpiAgg.rev_today), unit: 'EGP', sub: 'vs yesterday' },
        { label: 'Revenue (MTD)', value: fmtEgp(kpiAgg.rev_mtd), unit: 'EGP', sub: kpiAgg.orders_mtd + ' orders' },
        { label: 'Gross profit (MTD)', value: fmtEgp(kpiAgg.gross_profit_mtd), unit: 'EGP', sub: 'after doctor fee' },
        { label: 'Avg order value', value: fmtEgp(kpiAgg.avg_order_30d), unit: 'EGP', sub: '30d trailing' },
        { label: 'Refunds (MTD)', value: fmtEgp(refundsMtd.total), unit: 'EGP', sub: refundsMtd.cnt + ' refunds' },
        { label: 'Orders (MTD)', value: kpiAgg.orders_mtd, sub: 'count' }
      ],
      revenueBySpecialty: revBySpec.map(r => ({ name: r.specialty_name || '—', cases: Number(r.cases), revenue: Number(r.revenue) })),
      urgencyTier: urgencyTier.map(u => ({
        name: ({ urgent: 'Urgent', fast_track: 'Urgent', vip: 'VIP', standard: 'Standard' }[String(u.tier).toLowerCase()] || 'Standard'),
        mult: ({ urgent: '1.6×', fast_track: '1.6×', vip: '1.3×', standard: '1.0×' }[String(u.tier).toLowerCase()] || '—'),
        cases: Number(u.cases) || 0,
        uplift: Number(u.uplift) || 0,
        color: ({ urgent: 'var(--amber)', fast_track: 'var(--amber)', vip: 'var(--violet)', standard: 'var(--accent)' }[String(u.tier).toLowerCase()] || 'var(--accent)')
      })),
      fxZone: fxZone.map(z => ({
        name: z.country || '—',
        cases: Number(z.cases) || 0,
        rev: Number(z.rev) || 0
      })),
      payouts: payouts.map(p => ({
        doctor: p.doctor_name,
        cases: Number(p.cycle_cases) || 0,
        owed: Number(p.owed) || 0,
        lastPaid: p.last_paid ? new Date(p.last_paid).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) : '—',
        next: 'next cycle'
      })),
      paymob: {
        today: {
          txns: Number(paymobToday.txns) || 0,
          success: Number(paymobToday.success) || 0,
          failed: Number(paymobToday.failed) || 0,
          settled: fmtEgp(paymobToday.settled) + ' EGP',
          pending: fmtEgp(paymobToday.pending) + ' EGP'
        },
        recent: paymobRecent.map(r => ({
          id: String(r.id).slice(0, 10),
          amount: Number(r.amount) || 0,
          status: r.status,
          time: r.created_at ? new Date(r.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'
        }))
      }
    };
  });
}

// ─── DOCTORS ──────────────────────────────────────────────────────────
async function getDoctorsTabData({ range = '7d' } = {}) {
  return getCached('doctors:' + range, 60_000, async () => {
    const [agg, leaderboard, pipeline, coverage] = await Promise.all([
      safeGet(
        `SELECT
            COUNT(*) FILTER (WHERE role = 'doctor' AND is_active = true AND pending_approval = false) AS active_count,
            COUNT(*) FILTER (WHERE role = 'doctor' AND pending_approval = true) AS pending_count,
            COUNT(*) FILTER (WHERE role = 'doctor' AND pending_approval = false AND is_active = false) AS inactive_count
         FROM users`,
        [], { active_count: 0, pending_count: 0, inactive_count: 0 }
      ),
      // Leaderboard: last 30 days
      safeAll(
        `SELECT
            u.id,
            COALESCE(u.name, '—') AS name,
            COALESCE(sp.name, '—') AS specialty_name,
            COUNT(o.id) AS cases,
            AVG(EXTRACT(EPOCH FROM (o.completed_at - o.accepted_at)) / 60) FILTER (
              WHERE o.completed_at IS NOT NULL AND o.accepted_at IS NOT NULL
            ) AS avg_ttr_min,
            COUNT(*) FILTER (
              WHERE o.completed_at IS NOT NULL
                AND o.deadline_at IS NOT NULL
                AND o.completed_at::timestamptz <= o.deadline_at::timestamptz
            )::float / NULLIF(COUNT(*) FILTER (WHERE o.completed_at IS NOT NULL), 0) AS sla_hit,
            COALESCE(SUM(o.price), 0) AS rev,
            COALESCE(
              (SELECT SUM(earned_amount) FROM doctor_earnings de WHERE de.doctor_id = u.id AND de.status = 'pending'),
              0
            ) AS owed,
            (SELECT AVG(rating)::numeric(3,1) FROM reviews r WHERE r.doctor_id = u.id) AS rating
         FROM users u
         LEFT JOIN specialties sp ON sp.id = u.specialty_id
         LEFT JOIN orders_active o ON o.doctor_id = u.id AND o.created_at >= NOW() - INTERVAL '30 days'
         WHERE u.role = 'doctor' AND u.is_active = true AND u.pending_approval = false
         GROUP BY u.id, u.name, sp.name
         HAVING COUNT(o.id) > 0
         ORDER BY cases DESC
         LIMIT 10`,
        [], []
      ),
      // Pipeline: pending/inactive lists (names only, top 3 each)
      safeAll(
        `SELECT
            CASE
              WHEN pending_approval = true THEN 'pending'
              WHEN is_active = false THEN 'inactive'
              ELSE 'active'
            END AS stage,
            id, name,
            (SELECT name FROM specialties s WHERE s.id = users.specialty_id) AS specialty_name,
            created_at
         FROM users
         WHERE role = 'doctor'
         ORDER BY pending_approval DESC, created_at DESC`,
        [], []
      ),
      // Coverage: active doctor count per specialty
      safeAll(
        `SELECT
            sp.name AS specialty_name,
            COUNT(u.id) FILTER (WHERE u.is_active = true AND u.pending_approval = false) AS active_count
         FROM specialties sp
         LEFT JOIN users u ON u.specialty_id = sp.id AND u.role = 'doctor'
         GROUP BY sp.name
         ORDER BY sp.name ASC`,
        [], []
      )
    ]);

    // Derive aggregate SLA hit + TTR from leaderboard rows for the KPI header
    const ttrAvg = leaderboard.length
      ? Math.round(leaderboard.reduce((s, r) => s + (Number(r.avg_ttr_min) || 0), 0) / Math.max(1, leaderboard.filter(r => r.avg_ttr_min != null).length))
      : null;
    const slaAvg = (() => {
      const vals = leaderboard.map(r => Number(r.sla_hit)).filter(v => !Number.isNaN(v) && v != null);
      if (!vals.length) return null;
      return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100);
    })();
    const ratingAvg = (() => {
      const vals = leaderboard.map(r => Number(r.rating)).filter(v => !Number.isNaN(v) && v != null && v > 0);
      if (!vals.length) return null;
      return (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1);
    })();

    const stageGroups = { pending: [], inactive: [], active: [] };
    pipeline.forEach(p => {
      if (stageGroups[p.stage]) stageGroups[p.stage].push({ id: p.id, name: p.name, specialty: p.specialty_name });
    });

    return {
      range,
      rangeLabel: rangeLabel(range),
      kpis: [
        { label: 'Active doctors', value: Number(agg.active_count) || 0, sub: 'of ' + (Number(agg.active_count) + Number(agg.pending_count) + Number(agg.inactive_count)) + ' total' },
        { label: 'Pending approval', value: Number(agg.pending_count) || 0, sub: Number(agg.pending_count) > 0 ? 'review queue' : 'caught up' },
        { label: 'Avg SLA hit', value: slaAvg == null ? '—' : (slaAvg + '%'), sub: 'last 30d' },
        { label: 'Avg TTR', value: fmtMinutesAsHm(ttrAvg), sub: 'across leaders' },
        { label: 'Avg rating', value: ratingAvg == null ? '—' : ratingAvg, unit: ratingAvg == null ? '' : '/5', sub: 'all-time' }
      ],
      leaderboard: leaderboard.map(r => ({
        name: r.name,
        spec: r.specialty_name,
        cases: Number(r.cases) || 0,
        ttr: fmtMinutesAsHm(r.avg_ttr_min),
        sla: r.sla_hit == null ? null : Math.round(Number(r.sla_hit) * 100),
        rating: r.rating == null ? null : Number(r.rating),
        rev: Number(r.rev) || 0,
        owed: Number(r.owed) || 0
      })),
      pipeline: [
        { stage: 'Pending approval', count: stageGroups.pending.length, items: stageGroups.pending.slice(0, 3).map(d => d.name + (d.specialty ? ` (${d.specialty})` : '')) },
        { stage: 'Inactive', count: stageGroups.inactive.length, items: stageGroups.inactive.slice(0, 3).map(d => d.name + (d.specialty ? ` (${d.specialty})` : '')) },
        { stage: 'Active', count: stageGroups.active.length, items: [] }
      ],
      coverage: coverage.map(c => {
        const n = Number(c.active_count) || 0;
        return {
          spec: c.specialty_name,
          active: n,
          status: n >= 2 ? 'ok' : n === 1 ? 'risk' : 'gap'
        };
      })
    };
  });
}

// ─── PATIENTS ─────────────────────────────────────────────────────────
async function getPatientsTabData({ range = '7d' } = {}) {
  return getCached('patients:' + range, 60_000, async () => {
    const [agg, reviews, geo] = await Promise.all([
      safeGet(
        `SELECT
            COUNT(*) FILTER (WHERE role = 'patient' AND created_at::date = CURRENT_DATE) AS new_today,
            COUNT(*) FILTER (WHERE role = 'patient' AND created_at >= NOW() - INTERVAL '7 days') AS new_7d,
            COUNT(*) FILTER (WHERE role = 'patient' AND created_at >= NOW() - INTERVAL '30 days') AS new_30d,
            COUNT(*) FILTER (WHERE role = 'patient') AS total
         FROM users`,
        [], { new_today: 0, new_7d: 0, new_30d: 0, total: 0 }
      ),
      // Recent reviews
      tableExists('reviews').then(exists => exists
        ? safeAll(
            `SELECT
                r.id,
                r.rating,
                r.review_text AS text,
                r.created_at,
                COALESCE(p.name, '—') AS patient_name,
                COALESCE(sp.name, '—') AS specialty_name
              FROM reviews r
              LEFT JOIN users p ON p.id = r.patient_id
              LEFT JOIN users d ON d.id = r.doctor_id
              LEFT JOIN specialties sp ON sp.id = d.specialty_id
              WHERE r.review_text IS NOT NULL AND r.review_text <> ''
              ORDER BY r.created_at DESC
              LIMIT 4`,
            [], []
          )
        : []),
      // Geo by country
      safeAll(
        `SELECT
            COALESCE(NULLIF(country, ''), 'EG') AS country,
            COUNT(*) AS cnt
         FROM users
         WHERE role = 'patient'
         GROUP BY country
         ORDER BY cnt DESC
         LIMIT 6`,
        [], []
      )
    ]);

    // Repeat-case rate: patients with >=2 orders / total patients with >=1 order
    const repeatRow = await safeGet(
      `SELECT
          COUNT(DISTINCT patient_id) FILTER (WHERE patient_id IN (
            SELECT patient_id FROM orders_active GROUP BY patient_id HAVING COUNT(*) >= 2
          )) AS repeat_patients,
          COUNT(DISTINCT patient_id) AS total_patients
       FROM orders_active
       WHERE patient_id IS NOT NULL`,
      [], { repeat_patients: 0, total_patients: 0 }
    );
    const repeatPct = Number(repeatRow.total_patients) > 0
      ? Math.round((Number(repeatRow.repeat_patients) * 100) / Number(repeatRow.total_patients))
      : null;

    const geoTotal = geo.reduce((s, r) => s + Number(r.cnt), 0);
    return {
      range,
      rangeLabel: rangeLabel(range),
      kpis: [
        { label: 'New (today)', value: Number(agg.new_today) || 0, sub: 'patients' },
        { label: 'New (7d)', value: Number(agg.new_7d) || 0, sub: agg.total + ' total' },
        { label: 'Repeat rate', value: repeatPct == null ? '—' : (repeatPct + '%'), sub: '≥2 cases' },
        { label: 'New (30d)', value: Number(agg.new_30d) || 0, sub: 'patients' },
        { label: 'Total patients', value: Number(agg.total) || 0, sub: 'all-time' }
      ],
      // Acquisition source — no tracking column exists yet; render c_empty in the tab partial.
      sources: null,
      // Cohort retention — no weekly snapshot table; c_empty in tab partial.
      cohorts: null,
      geo: geo.map(g => ({
        region: g.country || '—',
        count: Number(g.cnt) || 0,
        pct: geoTotal > 0 ? Math.round((Number(g.cnt) * 100) / geoTotal) : 0
      })),
      reviews: reviews.map(r => ({
        who: maskName(r.patient_name),
        spec: r.specialty_name,
        rating: Math.max(0, Math.min(5, Number(r.rating) || 0)),
        when: relTime(r.created_at),
        text: String(r.text || '').slice(0, 220)
      }))
    };
  });
}

function maskName(name) {
  if (!name) return '—';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0] + '.';
  return parts[0][0] + '. ' + parts[parts.length - 1][0] + '.';
}

// ─── MARKETING ────────────────────────────────────────────────────────
async function getMarketingTabData({ range = '7d' } = {}) {
  return getCached('marketing:' + range, 60_000, async () => {
    const [campaigns, referrals, igPosts, conversions7d] = await Promise.all([
      // Open/click tracking is not stored on campaign_recipients yet;
      // we can only report sent count + failure count from the row's
      // status column. Open/click columns deliberately omitted — the
      // tab partial renders these as 0.
      tableExists('email_campaigns').then(exists => exists
        ? safeAll(
            `SELECT
                ec.id, ec.name, ec.scheduled_at, ec.status,
                (SELECT COUNT(*) FROM campaign_recipients cr WHERE cr.campaign_id = ec.id AND cr.status = 'sent') AS sent,
                (SELECT COUNT(*) FROM campaign_recipients cr WHERE cr.campaign_id = ec.id AND cr.status = 'failed') AS failed
              FROM email_campaigns ec
              ORDER BY scheduled_at DESC NULLS LAST
              LIMIT 6`,
            [], []
          )
        : []),
      // "Conv" here = redemptions that attached to an order
      // (rr.order_id IS NOT NULL). The schema doesn't track a separate
      // conversion timestamp; an order_id linkage is the conversion.
      tableExists('referral_codes').then(exists => exists
        ? safeAll(
            `SELECT
                rc.code,
                COUNT(rr.id) AS uses,
                COUNT(rr.id) FILTER (WHERE rr.order_id IS NOT NULL) AS conv,
                COALESCE(SUM(o.price), 0) AS rev
              FROM referral_codes rc
              LEFT JOIN referral_redemptions rr ON rr.referral_code_id = rc.id
              LEFT JOIN orders_active o ON o.referral_code = rc.code
              GROUP BY rc.code
              HAVING COUNT(rr.id) > 0
              ORDER BY uses DESC
              LIMIT 6`,
            [], []
          )
        : []),
      tableExists('ig_scheduled_posts').then(exists => exists
        ? safeGet(
            `SELECT
                COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                COUNT(*) FILTER (WHERE status = 'published') AS published
              FROM ig_scheduled_posts`,
            [], { pending: 0, published: 0 }
          )
        : { pending: 0, published: 0 }),
      // Conversions in 7d: orders with referral code OR known campaign source
      safeGet(
        `SELECT COUNT(*) AS cnt FROM orders_active
          WHERE referral_code IS NOT NULL
            AND created_at >= NOW() - INTERVAL '7 days'`,
        [], { cnt: 0 }
      )
    ]);

    // Active referrers = referral codes with >=1 use this month
    const activeReferrers = referrals.filter(r => Number(r.uses) > 0).length;

    return {
      range,
      rangeLabel: rangeLabel(range),
      kpis: [
        { label: 'Conversions (7d)', value: Number(conversions7d.cnt) || 0, sub: 'from referrals' },
        { label: 'Active referrers', value: activeReferrers, sub: 'with ≥1 use' },
        { label: 'IG scheduled', value: Number(igPosts.pending) || 0, sub: Number(igPosts.published) + ' published' },
        // Reach / open rate / IG followers need external data — c_empty in the tab.
        { label: 'Email opens', value: null, sub: 'see campaigns table' },
        { label: 'WhatsApp verify', value: null, sub: 'no DB signal' }
      ],
      campaigns: campaigns.map(c => ({
        name: c.name || '—',
        channel: 'Email',
        sent: Number(c.sent) || 0,
        // Open/click/conv tracking isn't wired into campaign_recipients;
        // see superadmin_dashboard.js comment. Show 0 with a tab-level
        // note rather than fake data.
        open: 0,
        click: 0,
        conv: 0,
        failed: Number(c.failed) || 0,
        when: c.scheduled_at ? new Date(c.scheduled_at).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) : '—'
      })),
      instagram: {
        // No reach data in DB; the tab partial renders c_empty for this card.
        reach7d: null,
        reach30d: null,
        postsScheduled: Number(igPosts.pending) || 0,
        topPosts: null
      },
      referrals: referrals.map(r => ({
        code: r.code,
        uses: Number(r.uses) || 0,
        conv: Number(r.conv) || 0,
        rev: Number(r.rev) || 0
      })),
      waTemplates: null // not in DB
    };
  });
}

// ─── HEALTH ───────────────────────────────────────────────────────────
async function getHealthTabData({ range = '7d' } = {}) {
  return getCached('health', 30_000, async () => {
    const [
      errors, errorsCount, crons, dbPool, lastDeploy
    ] = await Promise.all([
      tableExists('error_logs').then(exists => exists
        ? safeAll(
            `SELECT id, message, created_at, COALESCE(category, '—') AS category, context
              FROM error_logs
              WHERE created_at >= NOW() - INTERVAL '24 hours'
              ORDER BY created_at DESC
              LIMIT 8`,
            [], []
          )
        : []),
      tableExists('error_logs').then(exists => exists
        ? safeGet(
            `SELECT
                COUNT(*) AS cnt,
                COUNT(DISTINCT message) AS unique_cnt
              FROM error_logs
              WHERE created_at >= NOW() - INTERVAL '24 hours'`,
            [], { cnt: 0, unique_cnt: 0 }
          )
        : { cnt: 0, unique_cnt: 0 }),
      // pg-boss schedules
      tableExists('pgboss.schedule').then(exists => exists
        ? safeAll(`SELECT name, cron, timezone FROM pgboss.schedule ORDER BY name ASC`, [], [])
            .catch(() => [])
        : []).catch(() => []),
      // DB pool state — not exposed via SQL; report null
      Promise.resolve(null),
      Promise.resolve(null)
    ]);

    // Worker queue depth via pg-boss job table
    let queueDepth = null;
    try {
      if (await tableExists('pgboss.job')) {
        const row = await safeGet(
          `SELECT COUNT(*) AS cnt FROM pgboss.job WHERE state IN ('created', 'retry', 'active')`,
          [], { cnt: 0 }
        ).catch(() => ({ cnt: 0 }));
        queueDepth = Number(row.cnt) || 0;
      }
    } catch (_) { queueDepth = null; }

    return {
      kpis: [
        { label: 'Errors (24h)', value: Number(errorsCount.cnt) || 0, sub: errorsCount.unique_cnt + ' unique' },
        { label: 'Worker queue', value: queueDepth == null ? '—' : queueDepth, sub: 'pg-boss depth' },
        { label: 'API uptime (24h)', value: null, sub: 'no DB signal' },
        { label: 'DB pool', value: null, sub: 'no SQL access' },
        { label: 'Last deploy', value: null, sub: 'Render API not wired' }
      ],
      // Services list — no in-DB uptime data. Tab renders c_empty.
      services: null,
      errors: errors.map(e => ({
        id: 'ERR-' + String(e.id).slice(0, 8),
        message: e.message || '—',
        count: 1, // not deduped at query level
        last: relTime(e.created_at),
        trace: e.context && typeof e.context === 'object' && e.context.context ? String(e.context.context) : (e.category || '—'),
        severity: 'med'
      })),
      crons: crons.map(c => ({
        name: c.name,
        sched: c.cron,
        last: '—',
        next: '—',
        status: 'ok'
      })),
      workers: null, // pg-boss per-worker state would need queue-by-queue queries; deferred
      waCrashFeed: null,
      deploys: null
    };
  });
}

module.exports = {
  getStatusPills,
  getAttentionItems,
  getSidebarBadges,
  getOperationsTabData,
  getFinanceTabData,
  getDoctorsTabData,
  getPatientsTabData,
  getMarketingTabData,
  getHealthTabData,
  // Exposed for tests / dev only.
  _bustCache,
  _internal: { rangeFilter, rangeLabel, fmtEgp, fmtMinutesAsHm }
};
