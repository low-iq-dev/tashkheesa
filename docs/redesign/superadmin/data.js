/* global window */
// Tashkheesa mock data — realistic small-clinic numbers (~5-15 cases/day)
// Currency: EGP. Numbers reflect a pre-traction stage.

window.TK_DATA = {
  user: { name: "Ziad", role: "Owner" },

  // Header pills
  pills: [
    { key: "email",    label: "Email",     state: "ok",   value: "OK" },
    { key: "whatsapp", label: "WhatsApp",  state: "warn", value: "Meta verify pending" },
    { key: "sla",      label: "SLA",       state: "warn", value: "82%" },
    { key: "errors",   label: "Errors",    state: "bad",  value: "5" },
    { key: "workers",  label: "Workers",   state: "warn", value: "3/4" },
    { key: "db",       label: "DB",        state: "ok",   value: "12ms" },
  ],

  // Cross-tab attention items
  attention: {
    severity: "red",
    items: [
      { key: "sla_breached", label: "SLA breached now", value: 2, tab: "operations" },
      { key: "urgent_unassigned", label: "Urgent unassigned", value: 1, tab: "operations" },
      { key: "doctors_pending", label: "Doctors pending approval", value: 3, tab: "doctors" },
      { key: "worker_failing", label: "Worker failing", value: "runCaseSlaSweep", tab: "health" },
      { key: "payments_failed", label: "Paymob failed", value: 1, tab: "finance" },
    ],
  },

  // -------- OPERATIONS --------
  ops: {
    kpis: [
      { label: "Cases in flight", value: 11, sub: "of 14 today", spark: [3,4,3,5,7,9,11], delta: { v: "+3", dir: "up" } },
      { label: "SLA breached now", value: 2, sub: "needs reassign", spark: [0,0,1,1,2,2,2], delta: { v: "+2", dir: "down" } },
      { label: "Pending Dr approvals", value: 3, sub: "queue 4d old", spark: [1,2,2,3,3,3,3] },
      { label: "Urgent (1-4h)", value: 4, sub: "1.6× uplift", spark: [2,2,3,3,4,4,4] },
      { label: "VIP (12-18h)", value: 2, sub: "1.3× uplift", spark: [1,1,2,2,2,2,2] },
      { label: "Unassigned", value: 1, sub: "in queue 38m", spark: [0,1,2,1,1,1,1], delta: { v: "+1", dir: "down" } },
    ],
    slaBuckets: [
      { tier: "red", label: "< 1 hour", n: 2, sub: "Reassign now" },
      { tier: "amber", label: "1 — 4 hours", n: 3, sub: "Watch closely" },
      { tier: "green", label: "> 4 hours", n: 6, sub: "On track" },
    ],
    cases: [
      { id: "TK-1842", patient: "M. Hassan",  spec: "Cardiology",  service: "ECG review",   tier: "Urgent", deadline: "32m", status: "In review", doc: "Dr. Salem", risk: "red" },
      { id: "TK-1841", patient: "F. Adel",    spec: "Radiology",   service: "CT chest",     tier: "Urgent", deadline: "1h 12m", status: "Assigned", doc: "Dr. Nour", risk: "red" },
      { id: "TK-1840", patient: "A. Khaled",  spec: "Oncology",    service: "Path 2nd op",  tier: "VIP",    deadline: "3h 48m", status: "Assigned", doc: "Dr. Farid", risk: "amber" },
      { id: "TK-1839", patient: "N. Tarek",   spec: "Neurology",   service: "MRI brain",    tier: "Standard", deadline: "11h 02m", status: "Awaiting Dr", doc: "—", risk: "amber" },
      { id: "TK-1838", patient: "S. Magdy",   spec: "Dermatology", service: "Skin panel",   tier: "Standard", deadline: "16h 40m", status: "Submitted", doc: "—", risk: "green" },
      { id: "TK-1837", patient: "R. Omar",    spec: "Endocrine",   service: "Lab review",   tier: "Standard", deadline: "21h 15m", status: "Assigned", doc: "Dr. Hala", risk: "green" },
      { id: "TK-1836", patient: "Y. Fawzy",   spec: "Cardiology",  service: "Echo review",  tier: "VIP",    deadline: "delivered", status: "Completed", doc: "Dr. Salem", risk: "green" },
    ],
    doctors: [
      { name: "Dr. Salem A.",   spec: "Cardiology",  status: "online",  active: 3, todayDone: 2, ttr: "42m", presence: "online" },
      { name: "Dr. Nour B.",    spec: "Radiology",   status: "busy",    active: 4, todayDone: 3, ttr: "1h 02m", presence: "online" },
      { name: "Dr. Farid R.",   spec: "Oncology",    status: "online",  active: 2, todayDone: 1, ttr: "2h 18m", presence: "online" },
      { name: "Dr. Hala M.",    spec: "Endocrine",   status: "idle",    active: 1, todayDone: 0, ttr: "—", presence: "idle" },
      { name: "Dr. Yasmin K.",  spec: "Dermatology", status: "offline", active: 0, todayDone: 0, ttr: "—", presence: "off" },
    ],
  },

  // -------- FINANCE --------
  finance: {
    kpis: [
      { label: "Revenue (today)", value: "8,420", unit: "EGP", spark: [1.2,2,3.1,4,5.5,7,8.4], delta: { v: "+18%", dir: "up" }, sub: "vs yesterday" },
      { label: "Revenue (MTD)",   value: "184,300", unit: "EGP", spark: [10,30,55,80,110,150,184], delta: { v: "+12%", dir: "up" }, sub: "vs last month" },
      { label: "Gross profit",    value: "112,420", unit: "EGP", spark: [5,18,33,50,72,92,112], delta: { v: "61%", dir: "up" }, sub: "margin MTD" },
      { label: "Net (after fees)", value: "94,180", unit: "EGP", spark: [4,15,28,42,62,80,94], sub: "Paymob + payouts" },
      { label: "Refunds (MTD)",   value: "1,200", unit: "EGP", spark: [0,0,0.4,0.4,0.8,0.8,1.2], delta: { v: "0.6%", dir: "up" }, sub: "of revenue" },
      { label: "Avg order value", value: "612", unit: "EGP", spark: [520,540,560,580,590,605,612], delta: { v: "+4%", dir: "up" }, sub: "30d trailing" },
    ],
    serviceTier: [
      { name: "Simple",   floor: 350,  cases: 18, rev: 6300,  pct: 22 },
      { name: "Moderate", floor: 600,  cases: 22, rev: 13200, pct: 46 },
      { name: "Complex",  floor: 1100, cases: 8,  rev: 8800,  pct: 32 },
    ],
    urgencyTier: [
      { name: "Standard", mult: "1.0×", cases: 32, uplift: 0,    color: "var(--accent)" },
      { name: "VIP",      mult: "1.3×", cases: 11, uplift: 4250, color: "var(--violet)" },
      { name: "Urgent",   mult: "1.6×", cases: 5,  uplift: 3060, color: "var(--amber)" },
    ],
    fxZone: [
      { name: "Egypt",   mult: "1.0×", cases: 38, rev: 16400, color: "var(--accent)" },
      { name: "Gulf",    mult: "1.4×", cases: 7,  rev: 8120,  color: "var(--green)" },
      { name: "Western", mult: "2.0×", cases: 3,  rev: 5780,  color: "var(--violet)" },
    ],
    payouts: [
      { doctor: "Dr. Salem A.",  owed: 4200, lastPaid: "Apr 24", next: "May 8",  cases: 7 },
      { doctor: "Dr. Nour B.",   owed: 5180, lastPaid: "Apr 24", next: "May 8",  cases: 9 },
      { doctor: "Dr. Farid R.",  owed: 2640, lastPaid: "Apr 24", next: "May 8",  cases: 4 },
      { doctor: "Dr. Hala M.",   owed: 980,  lastPaid: "Apr 10", next: "May 8",  cases: 2 },
      { doctor: "Dr. Yasmin K.", owed: 0,    lastPaid: "Apr 24", next: "—",      cases: 0 },
    ],
    paymob: {
      today: { txns: 14, success: 13, failed: 1, settled: "47,200 EGP", pending: "8,420 EGP" },
      recent: [
        { id: "PM-9032", amount: 720, status: "settled", time: "11:42" },
        { id: "PM-9031", amount: 1100, status: "settled", time: "11:14" },
        { id: "PM-9030", amount: 480, status: "failed",  time: "10:48", reason: "card declined" },
        { id: "PM-9029", amount: 612, status: "settled", time: "10:22" },
        { id: "PM-9028", amount: 980, status: "pending", time: "09:55" },
      ],
    },
  },

  // -------- DOCTORS --------
  doctors: {
    kpis: [
      { label: "Active doctors", value: 12, sub: "of 18 onboarded" },
      { label: "Pending approval", value: 3, sub: "oldest 4d", delta: { v: "review", dir: "down" } },
      { label: "Avg SLA hit rate", value: "87%", sub: "30d trailing", delta: { v: "+3pt", dir: "up" } },
      { label: "Avg turnaround", value: "1h 48m", sub: "across tiers" },
      { label: "Avg patient rating", value: "4.7", unit: "/5", sub: "121 ratings" },
    ],
    leaderboard: [
      { name: "Dr. Nour B.",    spec: "Radiology",   cases: 64, ttr: "58m",   sla: 94, rating: 4.8, rev: 24800, owed: 5180 },
      { name: "Dr. Salem A.",   spec: "Cardiology",  cases: 51, ttr: "1h 02m", sla: 91, rating: 4.9, rev: 21400, owed: 4200 },
      { name: "Dr. Farid R.",   spec: "Oncology",    cases: 28, ttr: "2h 12m", sla: 86, rating: 4.6, rev: 14200, owed: 2640 },
      { name: "Dr. Hala M.",    spec: "Endocrine",   cases: 14, ttr: "1h 38m", sla: 79, rating: 4.5, rev: 5400,  owed: 980 },
      { name: "Dr. Yasmin K.",  spec: "Dermatology", cases: 9,  ttr: "2h 04m", sla: 88, rating: 4.7, rev: 3200,  owed: 0 },
      { name: "Dr. Tamer S.",   spec: "Neurology",   cases: 7,  ttr: "3h 11m", sla: 71, rating: 4.4, rev: 4100,  owed: 1120 },
    ],
    pipeline: [
      { stage: "Pending approval", count: 3, items: ["Dr. Khaled (Pulm)", "Dr. Reem (Peds)", "Dr. Ahmed (GI)"] },
      { stage: "Signed, inactive", count: 4, items: ["Dr. Mona (Derm)", "Dr. Hany (Ortho)", "Dr. Sara (Psych)", "Dr. Walid (ENT)"] },
      { stage: "Fully active", count: 12, items: [] },
    ],
    coverage: [
      { spec: "Cardiology",   active: 3, status: "ok" },
      { spec: "Radiology",    active: 4, status: "ok" },
      { spec: "Oncology",     active: 2, status: "ok" },
      { spec: "Neurology",    active: 1, status: "risk" },
      { spec: "Dermatology",  active: 2, status: "ok" },
      { spec: "Endocrine",    active: 2, status: "ok" },
      { spec: "Pediatrics",   active: 0, status: "gap" },
      { spec: "Pulmonology",  active: 1, status: "risk" },
      { spec: "Orthopedics",  active: 0, status: "gap" },
      { spec: "ENT",          active: 1, status: "risk" },
      { spec: "Psychiatry",   active: 0, status: "gap" },
      { spec: "Gastro",       active: 0, status: "gap" },
    ],
  },

  // -------- PATIENTS --------
  patients: {
    kpis: [
      { label: "New (today)", value: 4, sub: "vs 3 yesterday", delta: { v: "+33%", dir: "up" } },
      { label: "New (7d)",    value: 26, sub: "147 lifetime", delta: { v: "+12%", dir: "up" } },
      { label: "Repeat case rate", value: "18%", sub: "patients w/ ≥2", delta: { v: "+2pt", dir: "up" } },
      { label: "Retention 30d", value: "42%", sub: "of cohort 30d", delta: { v: "-1pt", dir: "down" } },
      { label: "Patient NPS",   value: "+58", sub: "from 121 ratings" },
    ],
    sources: [
      { name: "Instagram",  count: 14, pct: 54, color: "var(--violet)" },
      { name: "Referral",   count: 6,  pct: 23, color: "var(--green)" },
      { name: "Organic",    count: 4,  pct: 15, color: "var(--accent)" },
      { name: "WhatsApp",   count: 2,  pct: 8,  color: "var(--amber)" },
    ],
    geo: [
      { region: "Cairo",       count: 64, pct: 44 },
      { region: "Giza",        count: 28, pct: 19 },
      { region: "Alexandria",  count: 19, pct: 13 },
      { region: "Saudi Arabia", count: 14, pct: 10 },
      { region: "UAE",         count: 11, pct: 7 },
      { region: "Other MENA",  count: 11, pct: 7 },
    ],
    cohorts: [
      // weeks of week-N retention
      { wk: "W14", size: 8,  vals: [100, 75, 50, 38, 25] },
      { wk: "W15", size: 11, vals: [100, 64, 45, 36, 27] },
      { wk: "W16", size: 9,  vals: [100, 78, 56, 44] },
      { wk: "W17", size: 14, vals: [100, 71, 50] },
      { wk: "W18", size: 10, vals: [100, 60] },
      { wk: "W19", size: 12, vals: [100] },
    ],
    reviews: [
      { who: "M. H.", spec: "Cardiology",  rating: 5, when: "2h ago", text: "Dr Salem gave a clear second opinion within an hour. Saved me from unnecessary surgery." },
      { who: "F. A.", spec: "Radiology",   rating: 5, when: "5h ago", text: "Fast CT review. Will recommend to family." },
      { who: "A. K.", spec: "Oncology",    rating: 4, when: "1d ago", text: "Helpful but reply could be faster." },
      { who: "N. T.", spec: "Neurology",   rating: 5, when: "1d ago", text: "Excellent. Translated medical terms patiently." },
    ],
  },

  // -------- MARKETING --------
  marketing: {
    kpis: [
      { label: "Reach (7d)",       value: "12.4k", sub: "IG + WA", delta: { v: "+8%", dir: "up" } },
      { label: "IG followers",     value: "3,182",  sub: "+47 this week", delta: { v: "+1.5%", dir: "up" } },
      { label: "Open rate",        value: "38%",   sub: "last 5 sends", delta: { v: "+4pt", dir: "up" } },
      { label: "Conversions (7d)", value: 9,       sub: "from campaigns", delta: { v: "+2", dir: "up" } },
      { label: "Active referrers", value: 14,      sub: "6 this month" },
      { label: "WA verify",        value: "Pending", sub: "Meta business", delta: { v: "blocker", dir: "down" } },
    ],
    campaigns: [
      { name: "May Cardiac Promo",     channel: "WhatsApp", sent: 412, open: 174, click: 38, conv: 4, when: "May 1" },
      { name: "Ramadan Reminder",      channel: "Email",    sent: 980, open: 287, click: 52, conv: 3, when: "Apr 28" },
      { name: "Free 1st Consult",      channel: "WhatsApp", sent: 220, open: 116, click: 41, conv: 2, when: "Apr 24" },
      { name: "Specialist Feature",    channel: "Email",    sent: 980, open: 312, click: 28, conv: 0, when: "Apr 18" },
    ],
    instagram: {
      reach7d: 7240, reach30d: 28100, postsScheduled: 4,
      topPosts: [
        { caption: "When to seek a 2nd opinion (carousel)", reach: 2410, likes: 184, saves: 62 },
        { caption: "Dr. Salem on echocardiograms (reel)", reach: 1820, likes: 142, saves: 41 },
        { caption: "Patient story — F. Adel", reach: 1280, likes: 96, saves: 22 },
      ],
    },
    referrals: [
      { code: "ZIAD20",     uses: 22, conv: 9, rev: 5400 },
      { code: "DRSALEM",    uses: 14, conv: 6, rev: 3640 },
      { code: "SHIFA10",    uses: 8,  conv: 3, rev: 1820 },
      { code: "FAMILY",     uses: 5,  conv: 2, rev: 1200 },
    ],
    waTemplates: [
      { name: "case_assigned",  status: "approved", uses: 142 },
      { name: "case_completed", status: "approved", uses: 121 },
      { name: "sla_warning",    status: "approved", uses: 18 },
      { name: "promo_may",      status: "in_review", uses: 0 },
      { name: "refund_notice",  status: "rejected", uses: 0 },
    ],
  },

  // -------- HEALTH --------
  health: {
    kpis: [
      { label: "API uptime (24h)", value: "99.2%",  sub: "2 incidents", delta: { v: "-0.6", dir: "down" } },
      { label: "DB pool",           value: "12 / 20", sub: "pgbouncer ok" },
      { label: "Worker queue",      value: 7,        sub: "pg-boss depth", delta: { v: "+3", dir: "down" } },
      { label: "Errors (24h)",      value: 5,        sub: "3 unique" },
      { label: "Last deploy",       value: "2h ago", sub: "main · 7c4ae2f" },
    ],
    services: [
      { name: "API (Express)",     uptime: "99.94%", status: "ok",   meta: "p95 184ms", uptimeSeq: ["g","g","g","g","g","g","a","g","g","g","g","g","g","g","g","g","g","g","g","g","g","g","g","g"] },
      { name: "Postgres (Supabase)", uptime: "100%", status: "ok", meta: "12ms · pool 12/20", uptimeSeq: Array(24).fill("g") },
      { name: "pgbouncer",         uptime: "99.7%",  status: "warn", meta: "1 SSL retry @09:14", uptimeSeq: ["g","g","g","g","g","g","g","g","g","a","g","g","g","g","g","g","g","g","g","g","g","g","g","g"] },
      { name: "pg-boss workers",   uptime: "98.1%",  status: "warn", meta: "runCaseSlaSweep failing", uptimeSeq: ["g","g","g","r","r","g","g","g","a","g","g","g","g","g","g","g","g","g","a","g","g","g","g","g"] },
      { name: "Render service",    uptime: "100%",   status: "ok",   meta: "us-east, 512MB", uptimeSeq: Array(24).fill("g") },
      { name: "Paymob webhook",    uptime: "100%",   status: "ok",   meta: "last hit 4m ago", uptimeSeq: Array(24).fill("g") },
      { name: "AI case intel",     uptime: "97.4%",  status: "ok",   meta: "OpenAI · 12 calls/h", uptimeSeq: ["g","g","g","g","a","g","g","g","g","g","g","g","g","g","g","g","g","g","g","g","g","g","g","g"] },
      { name: "OpenClaw stats",    uptime: "99.9%",  status: "ok",   meta: "endpoint 200 OK", uptimeSeq: Array(24).fill("g") },
    ],
    workers: [
      { name: "runCaseSlaSweep",      status: "failing", lastRun: "11:02 (failed)", nextRun: "11:15", attempts: 3, error: "TimeoutError: Pool exhausted" },
      { name: "paymentWebhookHandler", status: "ok",     lastRun: "11:42", nextRun: "on event", attempts: 0 },
      { name: "aiCaseIntelligence",    status: "ok",     lastRun: "11:30", nextRun: "11:45", attempts: 0 },
      { name: "openClawStats",         status: "ok",     lastRun: "11:00", nextRun: "12:00", attempts: 0 },
    ],
    errors: [
      { id: "ERR-01", message: "TimeoutError: Pool exhausted (pgbouncer)", count: 3, last: "11:02", trace: "src/workers/sla-sweep.js:47", severity: "high" },
      { id: "ERR-02", message: "WhatsApp template 'promo_may' rejected", count: 1, last: "10:18", trace: "src/services/whatsapp.js:128", severity: "med" },
      { id: "ERR-03", message: "Paymob webhook signature mismatch", count: 1, last: "09:55", trace: "src/routes/webhooks/paymob.js:62", severity: "med" },
    ],
    crons: [
      { name: "Daily revenue rollup",   sched: "0 1 * * *",   last: "01:00 ✓",  next: "tomorrow 01:00", status: "ok" },
      { name: "SLA sweep",              sched: "*/15 * * * *", last: "11:02 ✗", next: "11:15", status: "failing" },
      { name: "Doctor payout calc",     sched: "0 0 * * 5",   last: "Apr 26 ✓", next: "May 3", status: "ok" },
      { name: "IG post scheduler",      sched: "0 9 * * *",   last: "09:00 ✓", next: "tomorrow 09:00", status: "ok" },
      { name: "Patient retention email", sched: "0 18 * * 1", last: "Apr 28 ✓", next: "May 5", status: "ok" },
    ],
    waCrashFeed: [
      { time: "11:02", msg: "🔥 SLA sweep worker failing (3rd attempt)" },
      { time: "10:18", msg: "⚠️ WA template 'promo_may' rejected by Meta" },
      { time: "09:55", msg: "⚠️ Paymob webhook sig mismatch (TK-1832)" },
      { time: "09:14", msg: "ℹ️ pgbouncer SSL retry succeeded" },
      { time: "08:00", msg: "✅ Daily revenue rollup ok (8,420 EGP)" },
    ],
    deploys: [
      { sha: "7c4ae2f", branch: "main", when: "2h ago",  status: "ok",  msg: "fix(sla): handle null deadline" },
      { sha: "2b1d9c4", branch: "main", when: "1d ago",  status: "ok",  msg: "feat(payouts): MTD ledger view" },
      { sha: "9aef03b", branch: "main", when: "2d ago",  status: "fail", msg: "wip(workers): retry policy" },
      { sha: "4c12d8e", branch: "main", when: "2d ago",  status: "ok",  msg: "feat(workers): retry policy" },
      { sha: "8d3f1e0", branch: "main", when: "3d ago",  status: "ok",  msg: "chore: bump deps" },
    ],
  },
};
