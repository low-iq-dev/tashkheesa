/* global React, ReactDOM, OpsTab, FinanceTab, DoctorsTab, PatientsTab, MarketingTab, HealthTab, I, useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakColor, TweakSelect */
const { useState, useEffect, useMemo } = React;

const TABS = [
  { id: "operations", label: "Operations", attn: 3 },
  { id: "finance",    label: "Finance",    attn: 1 },
  { id: "doctors",    label: "Doctors",    attn: 3 },
  { id: "patients",   label: "Patients",   attn: 0 },
  { id: "marketing",  label: "Marketing",  attn: 0 },
  { id: "health",     label: "Health",     attn: 5 },
];

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "warm",
  "density": "default",
  "accent": "#B38B3E",
  "pillVerbosity": "smart"
}/*EDITMODE-END*/;

function hexToOklchVars(hex) {
  // approximate hex → hue for accent (we keep s/l fixed for harmony)
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h: Math.round(h) };
}

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [tab, setTab] = useState(() => {
    const hash = location.hash.replace("#", "");
    return TABS.find(t => t.id === hash) ? hash : "operations";
  });
  const [attentionDismissed, setAttentionDismissed] = useState(false);
  const data = window.TK_DATA;

  useEffect(() => {
    const h = () => {
      const hash = location.hash.replace("#", "");
      if (TABS.find(t => t.id === hash)) setTab(hash);
    };
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);

  // Apply theme + density to <html>
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", tweaks.theme);
    document.documentElement.setAttribute("data-density", tweaks.density);
    const { h } = hexToOklchVars(tweaks.accent);
    document.documentElement.style.setProperty("--accent-h", h);
  }, [tweaks.theme, tweaks.density, tweaks.accent]);

  const goTab = (id) => {
    location.hash = id;
    setTab(id);
  };

  const visiblePills = useMemo(() => {
    if (tweaks.pillVerbosity === "all") return data.pills;
    if (tweaks.pillVerbosity === "quiet") return data.pills.filter(p => p.state !== "ok");
    // smart: collapse all-ok runs into one summary
    const nonOk = data.pills.filter(p => p.state !== "ok");
    if (nonOk.length === 0) return [{ key: "all", label: "All systems", state: "ok", value: "OK" }];
    const okCount = data.pills.length - nonOk.length;
    return [...nonOk, { key: "ok-rest", label: `${okCount} other`, state: "ok", value: "ok" }];
  }, [data.pills, tweaks.pillVerbosity]);

  const attnSeverity = data.attention.severity;

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <header className="topbar">
          <div className="greeting">
            <span className="greet-1">Owner cockpit</span>
            <span className="greet-2">Hey, {data.user.name}</span>
          </div>
          <div className="pills">
            {visiblePills.map(p => (
              <button
                key={p.key}
                className="pill"
                data-state={p.state}
                title={`${p.label}: ${p.value}`}
                onClick={() => {
                  if (p.key === "errors" || p.key === "workers" || p.key === "db") goTab("health");
                  else if (p.key === "whatsapp") goTab("marketing");
                  else if (p.key === "sla") goTab("operations");
                }}
              >
                <span className="led" />
                <span className="k">{p.label}</span>
                <span className="v">{p.value}</span>
              </button>
            ))}
          </div>
          <div className="spacer" />
          <div className="topbar-tools">
            <div className="search"><I.search /><input placeholder="Search cases, doctors, patients…" /><kbd>⌘K</kbd></div>
            <button className="btn"><I.bolt /> Run SLA Check</button>
          </div>
        </header>

        <nav className="tabs" role="tablist">
          {TABS.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`tab${tab === t.id ? " active" : ""}`}
              onClick={() => goTab(t.id)}
            >
              {t.label}
              {t.attn > 0 && <span className={`count${t.id === "health" || t.id === "operations" ? " alert" : ""}`}>{t.attn}</span>}
            </button>
          ))}
          <div className="tabs-right">
            <div className="range-picker">
              <button>Today</button><button className="active">7d</button><button>30d</button><button>MTD</button>
            </div>
            <button className="btn"><I.download /> CSV</button>
          </div>
        </nav>

        {!attentionDismissed && (
          <div className={`attn-banner sev-${attnSeverity}`} role="alert">
            <div className="sev-bar" />
            <div className="attn-banner-body">
              <div className="attn-title"><I.alert /> Needs you now</div>
              <div className="attn-items">
                {data.attention.items.map(it => (
                  <button key={it.key} className="attn-item" onClick={() => goTab(it.tab)} style={{ background: "transparent", border: 0, cursor: "pointer", padding: 0 }}>
                    <strong>{it.value}</strong>
                    <span className="label">{it.label}</span>
                  </button>
                ))}
              </div>
              <div className="attn-banner-actions">
                <button className="btn primary" onClick={() => goTab("operations")}>Triage</button>
                <button className="btn" onClick={() => setAttentionDismissed(true)} title="Hide for this session"><I.x /></button>
              </div>
            </div>
          </div>
        )}

        {tab === "operations" && <OpsTab data={data} />}
        {tab === "finance" && <FinanceTab data={data} />}
        {tab === "doctors" && <DoctorsTab data={data} />}
        {tab === "patients" && <PatientsTab data={data} />}
        {tab === "marketing" && <MarketingTab data={data} />}
        {tab === "health" && <HealthTab data={data} />}

        <footer className="footer">
          <span className="mono">tashkheesa.com/superadmin · v2.0 redesign</span>
          <span className="mono">node 20 · ejs · supabase · render us-east</span>
          <span className="mono" style={{ marginInlineStart: "auto" }}>RTL-ready · {tweaks.density} · {tweaks.theme}</span>
        </footer>
      </main>

      <TweaksPanel title="Tweaks">
        <TweakSection title="Theme">
          <TweakRadio
            value={tweaks.theme}
            onChange={(v) => setTweak("theme", v)}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "warm", label: "Warm Clinical" },
            ]}
          />
        </TweakSection>
        <TweakSection title="Density">
          <TweakRadio
            value={tweaks.density}
            onChange={(v) => setTweak("density", v)}
            options={[
              { value: "compact", label: "Compact" },
              { value: "default", label: "Default" },
              { value: "cozy", label: "Cozy" },
            ]}
          />
        </TweakSection>
        <TweakSection title="Pills verbosity">
          <TweakRadio
            value={tweaks.pillVerbosity}
            onChange={(v) => setTweak("pillVerbosity", v)}
            options={[
              { value: "all", label: "All" },
              { value: "smart", label: "Smart" },
              { value: "quiet", label: "Quiet" },
            ]}
          />
        </TweakSection>
        <TweakSection title="Accent color">
          <TweakColor
            value={tweaks.accent}
            onChange={(v) => setTweak("accent", v)}
            presets={["#4F6BED", "#3D5BDB", "#1F6FEB", "#0EA5E9", "#0FA37F", "#7C3AED"]}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

function Sidebar() {
  const groups = [
    { label: "Overview", items: [{ id: "dash", label: "Dashboard", active: true }] },
    { label: "Cases", items: [
      { id: "cases", label: "Cases", badge: "11" },
      { id: "video", label: "Video Calls" },
    ] },
    { label: "People", items: [
      { id: "doctors", label: "Doctors", badge: "3", alert: true },
      { id: "patients", label: "Patients" },
    ] },
    { label: "Business", items: [
      { id: "services", label: "Services" },
      { id: "pricing", label: "Pricing" },
      { id: "analytics", label: "Analytics" },
      { id: "reviews", label: "Reviews" },
    ] },
    { label: "Operations", items: [
      { id: "chat", label: "Chat Moderation" },
      { id: "campaigns", label: "Campaigns" },
      { id: "referrals", label: "Referrals" },
      { id: "instagram", label: "Instagram" },
      { id: "alerts", label: "Alerts", badge: "5", alert: true },
    ] },
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">ت</div>
        <div>
          <div className="brand-name">Tashkheesa</div>
          <div className="brand-sub">Owner</div>
        </div>
      </div>
      {groups.map(g => (
        <div key={g.label} className="nav-group">
          <div className="nav-label">{g.label}</div>
          {g.items.map(it => (
            <div key={it.id} className={`nav-item${it.active ? " active" : ""}`}>
              <span className="dot" />
              <span>{it.label}</span>
              {it.badge && <span className={`badge${it.alert ? " alert" : ""}`}>{it.badge}</span>}
            </div>
          ))}
        </div>
      ))}
    </aside>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
