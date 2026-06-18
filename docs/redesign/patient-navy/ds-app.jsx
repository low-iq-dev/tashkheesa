// ds-app.jsx — Tashkheesa patient-app design system reference page.

function DSProvider({ children }) {
  const [lang, setLang] = React.useState("en");
  const [toast, setToast] = React.useState(null);
  const t = (k) => { const e = DICT[k]; return e ? (e[lang] ?? e.en) : k; };
  const ctx = {
    lang, setLang, dir: lang === "ar" ? "rtl" : "ltr", t,
    nav: () => {}, back: () => {}, screen: "", params: {},
    store: { notifs: NOTIFS, cases: SAMPLE_CASES, completed: COMPLETED_CASE },
    patch: () => {}, showToast: (m, type) => { setToast({ msg: m, type }); setTimeout(() => setToast(null), 2000); },
  };
  return <AppContext.Provider value={ctx}>{React.cloneElement(children, { toast })}</AppContext.Provider>;
}

function Section({ id, kicker, title, desc, children }) {
  return (
    <section id={id} style={{ marginBottom: 64, scrollMarginTop: 24 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--teal)", marginBottom: 8 }}>{kicker}</div>
        <h2 style={{ fontSize: 30, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em", margin: 0 }}>{title}</h2>
        {desc && <p style={{ fontSize: 15, color: "var(--text-2)", lineHeight: 1.6, maxWidth: 720, margin: "10px 0 0" }}>{desc}</p>}
      </div>
      {children}
    </section>
  );
}

function Sub({ title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 14px", paddingBottom: 10, borderBottom: "1px solid var(--rule)" }}>{title}</h3>
      {children}
    </div>
  );
}

function Panel({ children, style }) {
  return <div style={{ background: "var(--surface)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", padding: 24, ...style }}>{children}</div>;
}

function Swatch({ name, token, hex, text }) {
  return (
    <div style={{ borderRadius: "var(--r-md)", overflow: "hidden", border: "1px solid var(--rule)" }}>
      <div style={{ height: 72, background: hex, display: "flex", alignItems: "flex-end", padding: 8 }}>
        {text && <span style={{ fontSize: 12, color: text, fontWeight: 600 }}>Aa</span>}
      </div>
      <div style={{ padding: "10px 12px", background: "var(--surface)" }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{name}</div>
        <div className="num" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{token}</div>
        <div className="num" style={{ fontSize: 11, color: "var(--muted-2)", marginTop: 1, textTransform: "uppercase" }}>{hex}</div>
      </div>
    </div>
  );
}

const swatchGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 14 };

function ColorsSection() {
  return (
    <Section id="colors" kicker="Foundations" title="Color system" desc="Two worlds. The navy app world carries the whole product — calm, clinical, trustworthy. The reserved green-and-gold world appears only on the signed specialist report, so receiving an opinion feels like an official document. Teal #5fe6e0 is the single accent; it never decorates, it always means action or focus.">
      <Sub title="App — navy surfaces">
        <div style={swatchGrid}>
          <Swatch name="Void" token="--navy-900" hex="#081120" text="#eaf2f9" />
          <Swatch name="Background" token="--navy-800" hex="#0c1c30" text="#eaf2f9" />
          <Swatch name="Raised" token="--navy-700" hex="#0f2238" text="#eaf2f9" />
          <Swatch name="Surface" token="--surface" hex="#112844" text="#eaf2f9" />
          <Swatch name="Surface 2" token="--surface-2" hex="#16304f" text="#eaf2f9" />
          <Swatch name="Surface 3" token="--surface-3" hex="#1c3a5e" text="#eaf2f9" />
        </div>
      </Sub>
      <Sub title="Teal accent">
        <div style={swatchGrid}>
          <Swatch name="Teal" token="--teal" hex="#5fe6e0" text="#042027" />
          <Swatch name="Teal bright" token="--teal-bright" hex="#7af0ea" text="#042027" />
          <Swatch name="Teal dim" token="--teal-dim" hex="#3aa8a3" text="#042027" />
          <Swatch name="On teal" token="--on-teal" hex="#042027" text="#5fe6e0" />
        </div>
      </Sub>
      <Sub title="Text on navy">
        <div style={swatchGrid}>
          <Swatch name="Primary" token="--text" hex="#eaf2f9" text="#0c1c30" />
          <Swatch name="Secondary" token="--text-2" hex="#aebfd2" text="#0c1c30" />
          <Swatch name="Muted" token="--muted" hex="#7388a0" text="#0c1c30" />
          <Swatch name="Disabled" token="--muted-2" hex="#51647c" text="#eaf2f9" />
        </div>
      </Sub>
      <Sub title="Semantic — success / refund · warning / SLA · error · info">
        <div style={swatchGrid}>
          <Swatch name="Success / refund" token="--success" hex="#34d399" text="#042027" />
          <Swatch name="Warning / SLA" token="--warn" hex="#fbbf24" text="#1a1305" />
          <Swatch name="Error / breach" token="--danger" hex="#f87171" text="#2a0808" />
          <Swatch name="Info" token="--info" hex="#60a5fa" text="#042027" />
        </div>
      </Sub>
      <Sub title="SLA urgency dots">
        <div style={swatchGrid}>
          <Swatch name="On track" token="--sla-green" hex="#34d399" text="#042027" />
          <Swatch name="Approaching" token="--sla-amber" hex="#fbbf24" text="#1a1305" />
          <Swatch name="Breached" token="--sla-red" hex="#f87171" text="#2a0808" />
        </div>
      </Sub>
      <Sub title="Reserved report world — green + gold on parchment">
        <div style={{ ...swatchGrid, padding: 16, background: "var(--rpt-bg)", borderRadius: "var(--r-md)" }}>
          <Swatch name="Parchment" token="--rpt-bg" hex="#f6f1e4" text="#1f4d3a" />
          <Swatch name="Paper" token="--rpt-surface" hex="#fffdf8" text="#1f4d3a" />
          <Swatch name="Authority green" token="--rpt-green" hex="#1f4d3a" text="#e7d3a1" />
          <Swatch name="Green deep" token="--rpt-green-deep" hex="#143527" text="#e7d3a1" />
          <Swatch name="Gold" token="--rpt-gold" hex="#b08531" text="#fffdf8" />
          <Swatch name="Gold light" token="--rpt-gold-2" hex="#caa44f" text="#1f4d3a" />
          <Swatch name="Report ink" token="--rpt-ink" hex="#1c2620" text="#f6f1e4" />
          <Swatch name="Gold soft" token="--rpt-gold-soft" hex="#e7d3a1" text="#1f4d3a" />
        </div>
      </Sub>
    </Section>
  );
}

function TypeSection() {
  const { lang } = useApp();
  const scale = [
    { name: "Display", token: "--t-display · 32", size: 32, w: 700, en: "Trust, written down.", ar: "ثقة، مكتوبة." },
    { name: "Heading 1", token: "--t-h1 · 26", size: 26, w: 700, en: "Your second opinion", ar: "رأيك الطبي الثاني" },
    { name: "Heading 2", token: "--t-h2 · 21", size: 21, w: 700, en: "Active cases", ar: "الحالات الجارية" },
    { name: "Card title", token: "--t-h3 · 17", size: 17, w: 600, en: "Reviewing specialist", ar: "الاستشاري المراجع" },
    { name: "Body", token: "--t-body · 15", size: 15, w: 400, en: "Upload your scans, labs and prior reports.", ar: "ارفع أشعتك وتحاليلك وتقاريرك السابقة." },
    { name: "Meta", token: "--t-meta · 13", size: 13, w: 400, en: "Report due in 18h 24m", ar: "التقرير خلال 18س 24د" },
    { name: "Micro label", token: "--t-label · 11", size: 11, w: 700, en: "FAST-TRACK", ar: "عاجل", upper: true },
  ];
  return (
    <Section id="type" kicker="Foundations" title="Typography" desc="Sora carries Latin UI and headings; IBM Plex Sans Arabic carries every Arabic surface. Numerals are always tabular (lining figures) so countdowns, prices and case IDs never shimmy — and stay Western (0–9) in both languages for clinical clarity.">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        <Panel>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Latin · Sora</div>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 40, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em" }}>Tashkheesa</div>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 15, color: "var(--text-2)", marginTop: 8 }}>300 · 400 · 500 · 600 · 700 · 800</div>
        </Panel>
        <Panel>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Arabic · IBM Plex Sans Arabic</div>
          <div style={{ fontFamily: "var(--font-ar)", fontSize: 40, fontWeight: 700, color: "var(--text)" }} dir="rtl">تشخيصة</div>
          <div style={{ fontFamily: "var(--font-ar)", fontSize: 15, color: "var(--text-2)", marginTop: 8 }} dir="rtl">300 · 400 · 500 · 600 · 700</div>
        </Panel>
      </div>
      <Panel style={{ padding: 0, overflow: "hidden" }}>
        {scale.map((s, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "150px 1fr 1fr", gap: 20, alignItems: "center", padding: "18px 24px", borderBottom: i < scale.length - 1 ? "1px solid var(--rule)" : "none" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{s.name}</div>
              <div className="num" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{s.token}</div>
            </div>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: s.size, fontWeight: s.w, color: "var(--text)", letterSpacing: s.upper ? "0.12em" : "-0.01em", textTransform: s.upper ? "uppercase" : "none" }}>{s.en}</div>
            <div dir="rtl" style={{ fontFamily: "var(--font-ar)", fontSize: s.size, fontWeight: s.w, color: "var(--text)", textAlign: "right" }}>{s.ar}</div>
          </div>
        ))}
      </Panel>
    </Section>
  );
}

function SpacingSection() {
  const space = [["--s-1", 4], ["--s-2", 8], ["--s-3", 12], ["--s-4", 16], ["--s-5", 20], ["--s-6", 24], ["--s-8", 32], ["--s-10", 48]];
  const radii = [["--r-xs", 6], ["--r-sm", 10], ["--r-md", 14], ["--r-lg", 18], ["--r-xl", 24], ["--r-pill", 999]];
  const elev = [["--shadow-1", "var(--shadow-1)"], ["--shadow-2", "var(--shadow-2)"], ["--shadow-3", "var(--shadow-3)"], ["--shadow-teal", "var(--shadow-teal)"]];
  return (
    <Section id="spacing" kicker="Foundations" title="Spacing · radius · elevation" desc="A 4-px base scale. Radii stay soft but serious (cards 18px, sheets 24px). Depth on a dark UI comes from a teal glow on primary actions and tight, near-black shadows — never heavy drop shadows.">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <Panel>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 16 }}>Spacing</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {space.map(([tok, px]) => (
              <div key={tok} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ height: 14, width: px, background: "var(--teal)", borderRadius: 3 }} />
                <span className="num" style={{ fontSize: 12, color: "var(--text-2)" }}>{tok}</span>
                <span className="num" style={{ fontSize: 12, color: "var(--muted)", marginLeft: "auto" }}>{px}px</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 16 }}>Radius</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
            {radii.map(([tok, px]) => (
              <div key={tok} style={{ textAlign: "center" }}>
                <div style={{ height: 54, background: "var(--surface-2)", border: "1.5px solid var(--teal)", borderRadius: px }} />
                <div className="num" style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>{tok}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 18 }}>Elevation</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 20 }}>
          {elev.map(([tok, sh]) => (
            <div key={tok} style={{ textAlign: "center" }}>
              <div style={{ height: 70, background: "var(--surface)", borderRadius: "var(--r-md)", boxShadow: sh, border: "1px solid var(--rule)" }} />
              <div className="num" style={{ fontSize: 11, color: "var(--muted)", marginTop: 10 }}>{tok}</div>
            </div>
          ))}
        </div>
      </Panel>
    </Section>
  );
}

function IconSection() {
  const icons = ["home", "folder-heart", "bell", "user-round", "stethoscope", "upload-cloud", "file-badge", "file-text", "shield-check", "badge-check", "clock", "clock-alert", "zap", "sparkles", "credit-card", "wallet", "banknote", "lock", "message-circle-question", "calendar-clock", "user-plus", "building-2", "map-pin", "info"];
  return (
    <Section id="icons" kicker="Foundations" title="Iconography" desc="Lucide outline icons, 1.5–1.6px stroke, currentColor — clinical and even-weight. Specialty avatars pair each discipline with a single glyph in a teal tile. No emoji, ever.">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Panel>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 18 }}>UI icons</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 16 }}>
            {icons.map(n => <div key={n} style={{ display: "flex", justifyContent: "center", color: "var(--text-2)" }}><Ic name={n} size={22} /></div>)}
          </div>
        </Panel>
        <Panel>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 18 }}>Specialties</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 14 }}>
            {SPECIALTIES.map(s => (
              <div key={s.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <SpecialtyIcon id={s.id} size={40} />
                <span style={{ fontSize: 10.5, color: "var(--muted)", textAlign: "center", lineHeight: 1.2 }}>{s.en}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </Section>
  );
}

function ComponentsSection() {
  const { t, lang } = useApp();
  const [otp, setOtp] = React.useState("4829");
  const [seg, setSeg] = React.useState("phone");
  const [field, setField] = React.useState("");
  return (
    <Section id="components" kicker="Library" title="Components" desc="Every primitive shown in its real states. Toggle the language in the top bar to see each one flip to Arabic / RTL.">
      <Sub title="Buttons — variants & states">
        <Panel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 16 }}>
            <Btn variant="primary" icon="plus">{t("start_new_case")}</Btn>
            <Btn variant="secondary" icon="folder-open">{t("from_profile")}</Btn>
            <Btn variant="ghost" iconRight="arrow-right">{t("see_all")}</Btn>
            <Btn variant="danger" icon="alert-triangle">{t("st_breached")}</Btn>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 16 }}>
            <Btn variant="primary" loading>Loading</Btn>
            <Btn variant="primary" disabled>Disabled</Btn>
            <Btn variant="primary" size="sm">Small</Btn>
            <Btn variant="primary" size="lg">Large</Btn>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", padding: 16, background: "var(--rpt-bg)", borderRadius: "var(--r-md)" }}>
            <Btn variant="report" icon="download">{t("download_pdf")}</Btn>
            <Btn variant="reportGold" icon="share-2">{t("share_report")}</Btn>
            <span style={{ fontSize: 12, color: "var(--rpt-muted)" }}>report-world buttons</span>
          </div>
        </Panel>
      </Sub>

      <Sub title="Inputs · OTP · segmented toggle">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Panel>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Field label={t("phone_label")} value={field} onChange={setField} placeholder="10 1234 5678" icon="phone" suffix="+20" dir="ltr" />
              <Field label={t("email_label")} value="" onChange={() => {}} placeholder="Focused state — tap in" icon="mail" dir="ltr" />
              <Field label={t("pass_label")} value="wrong" onChange={() => {}} icon="lock" error={lang === "ar" ? "كلمة سر غير صحيحة" : "Incorrect password"} dir="ltr" />
            </div>
          </Panel>
          <Panel>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>{t("otp_title")}</div>
            <OTPInput value={otp} onChange={setOtp} />
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>Segmented toggle</div>
              <Segmented full value={seg} onChange={setSeg} options={[{ value: "phone", label: t("tab_phone"), icon: "smartphone" }, { value: "email", label: t("tab_email"), icon: "mail" }]} />
            </div>
          </Panel>
        </div>
      </Sub>

      <Sub title="Status badges · tier chips">
        <Panel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 16 }}>
            {["submitted", "assigned", "in_review", "ready", "breached", "followup"].map(s => <StatusBadge key={s} status={s} />)}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <TierChip tier="standard" /><TierChip tier="urgent" />
          </div>
        </Panel>
      </Sub>

      <Sub title="File tiles — uploading & uploaded">
        <Panel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <FileTile file={{ name: "chest_CT_axial.dcm", progress: 64 }} />
            <FileTile file={{ name: "radiology_report.pdf", size: "240 KB" }} onRemove={() => {}} />
          </div>
        </Panel>
      </Sub>

      <Sub title="SLA countdown · ring · case timeline">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Panel>
            <div style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 22 }}>
              <SLARing pct={0.62} size={70}><Ic name="clock" size={24} color="var(--teal)" /></SLARing>
              <SLACountdown hours={18.4} size="lg" />
            </div>
            <SLACountdown hours={3.2} />
          </Panel>
          <Panel>
            <Timeline steps={[
              { state: "done", title: t("st_submitted"), meta: t("optional") ? "Today 09:12" : "" },
              { state: "done", title: t("st_assigned"), meta: "Dr. Hossam" },
              { state: "active", title: t("st_in_review") },
              { state: "pending", title: t("st_ready") },
            ]} />
          </Panel>
        </div>
      </Sub>

      <Sub title="Cards · status row · empty & loading state">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Panel style={{ background: "var(--navy-800)" }}>
            <CaseRow c={SAMPLE_CASES[0]} onClick={() => {}} />
            <SkeletonCase />
          </Panel>
          <Panel style={{ background: "var(--navy-800)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <EmptyState illo="folder-heart" title={t("no_active")} body={t("no_active_sub")} action={<Btn variant="primary" icon="plus">{t("start_new_case")}</Btn>} />
          </Panel>
        </div>
      </Sub>

      <Sub title="Wizard progress · toast · trust strip">
        <Panel>
          <div style={{ maxWidth: 360, marginBottom: 20 }}>
            <WizardProgress steps={[0, 1, 2, 3, 4, 5]} current={2} />
          </div>
          <div style={{ position: "relative", height: 60, marginBottom: 16, background: "var(--navy-800)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 10, left: 16, right: 16, display: "flex", alignItems: "center", gap: 11, padding: "13px 15px", background: "var(--surface)", border: "1px solid var(--rule-strong)", borderLeft: "3px solid var(--success)", borderRadius: "var(--r-md)", boxShadow: "var(--shadow-3)" }}>
              <Ic name="check-circle-2" size={19} color="var(--success)" />
              <span style={{ fontSize: 14, color: "var(--text)", fontWeight: 500 }}>{lang === "ar" ? "تم نسخ رابط آمن للتقرير" : "Secure report link copied"}</span>
            </div>
          </div>
          <ShifaStrip />
        </Panel>
      </Sub>
    </Section>
  );
}

function DSPage({ toast }) {
  const { lang, setLang, dir } = useApp();
  const nav = [["colors", "Color"], ["type", "Type"], ["spacing", "Spacing"], ["icons", "Icons"], ["components", "Components"]];
  return (
    <div style={{ minHeight: "100vh" }}>
      <Toast toast={toast} />
      {/* top bar */}
      <header style={{ position: "sticky", top: 0, zIndex: 50, background: "rgba(8,17,32,0.9)", backdropFilter: "blur(16px)", borderBottom: "1px solid var(--rule)" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "14px 32px", display: "flex", alignItems: "center", gap: 16 }}>
          <ShifaMark size={30} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>Tashkheesa — Design System</div>
            <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Patient app · navy world + reserved report world</div>
          </div>
          <nav style={{ display: "flex", gap: 4 }}>
            {nav.map(([id, label]) => <a key={id} href={"#" + id} style={{ fontSize: 13, color: "var(--text-2)", textDecoration: "none", padding: "7px 11px", borderRadius: 8 }}>{label}</a>)}
          </nav>
          <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", borderRadius: 999, padding: 3 }}>
            {["en", "ar"].map(l => <button key={l} onClick={() => setLang(l)} style={{ padding: "6px 13px", borderRadius: 999, border: "none", cursor: "pointer", fontFamily: l === "ar" ? "var(--font-ar)" : "var(--font-sans)", fontSize: 12.5, fontWeight: 600, background: lang === l ? "var(--teal)" : "transparent", color: lang === l ? "var(--on-teal)" : "var(--text-2)" }}>{l === "en" ? "EN" : "ع"}</button>)}
          </div>
          <a href="index.html" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, color: "var(--teal)", textDecoration: "none", background: "var(--teal-tint)", padding: "8px 13px", borderRadius: 9 }}>
            <Ic name="smartphone" size={15} /> Prototype
          </a>
        </div>
      </header>

      <main dir={dir} style={{ maxWidth: 1080, margin: "0 auto", padding: "48px 32px 96px", fontFamily: lang === "ar" ? "var(--font-ar)" : "var(--font-sans)" }}>
        {/* hero */}
        <div style={{ marginBottom: 64 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--teal)", marginBottom: 12 }}>Calm clinical · night</div>
          <h1 style={{ fontSize: 44, fontWeight: 700, letterSpacing: "-0.03em", margin: "0 0 16px", lineHeight: 1.05, maxWidth: 700 }}>{lang === "ar" ? "ثقة طبية، مكتوبة وموقّعة." : "Medical-grade trust, written and signed."}</h1>
          <p style={{ fontSize: 16, color: "var(--text-2)", lineHeight: 1.6, maxWidth: 640, margin: 0 }}>{lang === "ar" ? "نظام تصميم لتطبيق تشخيصة للمرضى — عالم كحلي هادئ للتطبيق، وعالم أخضر وذهبي محجوز للتقرير الموقّع. مبني أصلاً بالعربي والإنجليزي." : "The design system for the Tashkheesa patient app — a calm navy world for the product, and a reserved green-and-gold world for the signed report. Built natively bilingual, RTL-first where it counts."}</p>
        </div>
        <ColorsSection />
        <TypeSection />
        <SpacingSection />
        <IconSection />
        <ComponentsSection />
        <footer style={{ borderTop: "1px solid var(--rule)", paddingTop: 24, marginTop: 24, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <ShifaStrip compact />
          <span className="num" style={{ fontSize: 12, color: "var(--muted-2)" }}>Tashkheesa · v1.0</span>
        </footer>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<DSProvider><DSPage /></DSProvider>);
