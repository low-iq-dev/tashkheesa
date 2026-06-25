// app.jsx — root shell: context, navigation stack, language/RTL, presentation chrome.

const SCREEN_GROUPS = [
  { label: "Onboarding & auth", items: [
    { id: "onboarding", name: "Onboarding" },
    { id: "auth", name: "Sign in" },
    { id: "otp", name: "OTP entry" },
  ]},
  { label: "Core", items: [
    { id: "home", name: "Home / dashboard" },
    { id: "cases", name: "My cases" },
    { id: "caseDetail", name: "Case detail + SLA" },
    { id: "wizard", name: "New case wizard" },
  ]},
  { label: "The payoff", items: [
    { id: "report", name: "Signed report" },
    { id: "reportPDF", name: "Report — full document" },
    { id: "followup", name: "Follow-up question" },
  ]},
  { label: "Trust & edges", items: [
    { id: "breach", name: "SLA breach + refund" },
    { id: "alerts", name: "Notifications" },
    { id: "account", name: "Account" },
    { id: "medical", name: "Medical profile" },
    { id: "family", name: "Family profiles" },
    { id: "howItWorks", name: "How it works" },
    { id: "partnership", name: "Shifa partnership" },
    { id: "refundPolicy", name: "Refund policy" },
  ]},
];

const DARK_STATUS = (s) => !["report", "reportPDF"].includes(s);

function App() {
  const [lang, setLang] = React.useState("en");
  const [scale, setScale] = React.useState(1);
  React.useEffect(() => {
    const fit = () => setScale(Math.min(1, (window.innerHeight - 96) / 874));
    fit(); window.addEventListener("resize", fit); return () => window.removeEventListener("resize", fit);
  }, []);
  const [hist, setHist] = React.useState([{ screen: "onboarding", params: {} }]);
  const [toast, setToast] = React.useState(null);
  const [store, setStore] = React.useState({
    cases: SAMPLE_CASES, completed: COMPLETED_CASE, breached: BREACHED_CASE,
    notifs: NOTIFS, followupUsed: false, profileFiles: 4,
  });

  const cur = hist[hist.length - 1];
  const dir = lang === "ar" ? "rtl" : "ltr";
  const t = React.useCallback((key) => {
    const e = DICT[key]; if (!e) return key; return e[lang] ?? e.en ?? key;
  }, [lang]);

  const nav = React.useCallback((screen, params = {}, opts = {}) => {
    setHist(h => opts.root ? [{ screen, params }] : [...h, { screen, params }]);
    const el = document.getElementById("tk-screen-scroll"); if (el) el.scrollTop = 0;
  }, []);
  const back = React.useCallback(() => setHist(h => (h.length > 1 ? h.slice(0, -1) : h)), []);
  const showToast = React.useCallback((msg, type = "info") => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 2600);
  }, []);
  const patch = React.useCallback((p) => setStore(s => ({ ...s, ...p })), []);

  const ctx = { lang, setLang, dir, t, nav, back, screen: cur.screen, params: cur.params, store, patch, showToast, canBack: hist.length > 1 };

  const REG = {
    onboarding: "OnboardingScreen", auth: "AuthScreen", otp: "OTPScreen",
    home: "HomeScreen", cases: "CasesScreen", caseDetail: "CaseDetailScreen", wizard: "WizardScreen",
    report: "ReportScreen", reportPDF: "ReportPDFScreen", followup: "FollowupScreen",
    breach: "BreachScreen", alerts: "AlertsScreen", account: "AccountScreen",
    medical: "MedicalScreen", family: "FamilyScreen",
    howItWorks: "HowItWorksScreen", partnership: "PartnershipScreen", refundPolicy: "RefundPolicyScreen",
  };
  const Screen = window[REG[cur.screen]] || (() => <Placeholder name={cur.screen} />);
  const darkStatus = DARK_STATUS(cur.screen);

  return (
    <AppContext.Provider value={ctx}>
      <div style={{ minHeight: "100vh", display: "flex", background: "radial-gradient(1200px 700px at 70% -10%, #0e2236 0%, var(--navy-900) 60%)", color: "var(--text)" }}>
        {/* presentation rail */}
        <aside className="app-scroll" style={{ width: 264, flexShrink: 0, borderRight: "1px solid var(--rule)", height: "100vh", position: "sticky", top: 0, overflowY: "auto", padding: "22px 16px 40px", background: "rgba(8,17,32,0.5)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 6px 18px" }}>
            <ShifaMark size={30} />
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>Tashkheesa</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>Patient app · screen set</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, padding: "0 6px 16px" }}>
            <button onClick={() => setLang("en")} style={railToggle(lang === "en")}>EN · LTR</button>
            <button onClick={() => setLang("ar")} style={railToggle(lang === "ar")}>ع · RTL</button>
          </div>

          {SCREEN_GROUPS.map(g => (
            <div key={g.label} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted-2)", padding: "0 8px 7px" }}>{g.label}</div>
              {g.items.map(it => {
                const on = cur.screen === it.id;
                return (
                  <button key={it.id} onClick={() => nav(it.id, {}, { root: true })} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "9px 10px", borderRadius: 10, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, marginBottom: 1,
                    background: on ? "var(--teal-tint)" : "transparent", color: on ? "var(--teal)" : "var(--text-2)", fontWeight: on ? 600 : 500 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: on ? "var(--teal)" : "var(--rule-strong)" }} />{it.name}
                  </button>
                );
              })}
            </div>
          ))}
          <a href="design-system.html" style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 6px 0", padding: "11px 12px", borderRadius: 10, textDecoration: "none", background: "var(--on-navy-faint)", border: "1px solid var(--rule)", color: "var(--text-2)", fontSize: 13, fontWeight: 600 }}>
            <Ic name="swatch-book" size={16} color="var(--teal)" /> Design system →
          </a>
        </aside>

        {/* stage */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px", minHeight: "100vh" }}>
          <div style={{ position: "relative", width: 402 * scale, height: 874 * scale }}>
            <div style={{ position: "absolute", top: 0, left: 0, transform: `scale(${scale})`, transformOrigin: "top left" }}>
            <IOSDevice dark={darkStatus}>
              <div id="tk-screen-host" dir={dir} style={{ height: "100%", position: "relative", fontFamily: lang === "ar" ? "var(--font-ar)" : "var(--font-sans)", background: darkStatus ? "var(--navy-800)" : "var(--rpt-bg)" }}>
                <Toast toast={toast} />
                <Screen />
              </div>
            </IOSDevice>
            </div>
          </div>
          <div style={{ marginTop: 18, fontSize: 12.5, color: "var(--muted)", display: "flex", gap: 16, alignItems: "center" }}>
            <span>{labelFor(cur.screen)}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{lang === "ar" ? "Arabic · RTL" : "English · LTR"}</span>
          </div>
        </main>
      </div>
    </AppContext.Provider>
  );
}

function railToggle(on) {
  return { flex: 1, padding: "8px 10px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600,
    border: `1px solid ${on ? "var(--teal)" : "var(--rule)"}`, background: on ? "var(--teal-tint)" : "transparent", color: on ? "var(--teal)" : "var(--text-2)" };
}
function labelFor(id) {
  for (const g of SCREEN_GROUPS) { const it = g.items.find(x => x.id === id); if (it) return it.name; }
  return id;
}

function Placeholder({ name }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--muted)", padding: 24, textAlign: "center" }}>
      <Ic name="hammer" size={32} color="var(--teal)" />
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-2)" }}>{name}</div>
      <div style={{ fontSize: 13 }}>Screen coming up next.</div>
    </div>
  );
}

// Tab shell for the 4 main tabs
function TabShell({ active, children, scrollRef }) {
  const { nav } = useApp();
  return (
    <div style={{ height: "100%", position: "relative", display: "flex", flexDirection: "column" }}>
      <div id="tk-screen-scroll" ref={scrollRef} className="app-scroll" style={{ flex: 1, overflowY: "auto" }}>
        {children}
        <div style={{ height: 92 }} />
      </div>
      <TabBar active={active} onTab={(id) => { if (id === "new") nav("wizard"); else nav(id, {}, { root: true }); }} />
    </div>
  );
}

window.TabShell = TabShell;
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
