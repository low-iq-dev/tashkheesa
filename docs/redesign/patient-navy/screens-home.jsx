// screens-home.jsx — Home dashboard, Cases list, Case detail (+ SLA), SLA breach/refund.

function CaseRow({ c, onClick }) {
  const { t, lang } = useApp();
  const m = specMeta(c.specialty);
  const ringPct = c.status === "breached" ? 1 : Math.max(0.05, Math.min(1, (c.dueHrs || 0) / (c.tier === "urgent" ? 24 : 72)));
  const ringColor = c.status === "breached" ? "var(--danger)" : (c.dueHrs < 6 ? "var(--warn)" : "var(--teal)");
  return (
    <Card onClick={onClick} pad={14} style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 13, alignItems: "center" }}>
        <SpecialtyIcon id={c.specialty} size={46} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 15.5, fontWeight: 700, color: "var(--text)" }}>{lang === "ar" ? m.ar : m.en}</span>
            <span className="num" style={{ fontSize: 11.5, color: "var(--muted)" }}>{c.id}</span>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
            <Ic name="user-round" size={12} />{lang === "ar" ? c.patient_ar : c.patient_en}
            <span style={{ opacity: 0.4 }}>·</span><span className="num">{c.filesN} {t("files_n")}</span>
          </div>
          <div style={{ marginTop: 9 }}><StatusBadge status={c.status} /></div>
        </div>
        {c.status !== "ready" && c.status !== "breached" && (
          <SLARing pct={ringPct} color={ringColor} size={52}>
            <div style={{ textAlign: "center" }}>
              <div className="num" style={{ fontSize: 15, fontWeight: 700, color: ringColor, lineHeight: 1 }}>{Math.floor(c.dueHrs)}</div>
              <div style={{ fontSize: 8.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{lang === "ar" ? "ساعة" : "hrs"}</div>
            </div>
          </SLARing>
        )}
        {c.status === "ready" && <Ic name="file-check-2" size={26} color="var(--success)" />}
        {c.status === "breached" && <Ic name="alert-triangle" size={24} color="var(--danger)" />}
      </div>
    </Card>
  );
}

function HomeScreen() {
  const { t, lang, nav, store } = useApp();
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => { const id = setTimeout(() => setLoading(false), 650); return () => clearTimeout(id); }, []);

  return (
    <TabShell active="home">
      <div style={{ paddingTop: "var(--safe-top)" }}>
        {/* header */}
        <div style={{ padding: "10px 18px 4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 13, color: "var(--muted)" }}>{t("home_q")}</div>
            <h1 style={{ fontSize: 23, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em", margin: "3px 0 0" }}>{t("greeting")}</h1>
          </div>
          <button onClick={() => nav("account", {}, { root: true })} style={{ width: 42, height: 42, borderRadius: "50%", border: "1px solid var(--rule)", background: "var(--surface)", color: "var(--teal)", fontWeight: 700, fontSize: 16, cursor: "pointer" }}>M</button>
        </div>

        {/* primary CTA */}
        <div style={{ padding: "16px 18px 0" }}>
          <div onClick={() => nav("wizard")} style={{ cursor: "pointer", borderRadius: "var(--r-lg)", padding: 18, position: "relative", overflow: "hidden",
            background: "linear-gradient(135deg, #0e3b50 0%, #11604f 120%)", border: "1px solid var(--rule-strong)" }}>
            <div style={{ position: "absolute", insetInlineEnd: -20, top: -20, opacity: 0.18 }}><Ic name="stethoscope" size={120} color="var(--teal)" /></div>
            <div style={{ position: "relative" }}>
              <h2 style={{ fontSize: 19, fontWeight: 700, color: "var(--text)", margin: "0 0 5px", letterSpacing: "-0.02em" }}>{t("start_new_case")}</h2>
              <p style={{ fontSize: 13.5, color: "var(--text-2)", margin: "0 0 14px", maxWidth: 230, lineHeight: 1.5 }}>{t("start_new_sub")}</p>
              <Btn variant="primary" size="md" icon="plus" onClick={() => nav("wizard")}>{t("start_new_case")}</Btn>
            </div>
          </div>
        </div>

        {/* active cases */}
        <div style={{ padding: "24px 18px 0" }}>
          <SectionHeader title={t("active_cases")} action={() => nav("cases", {}, { root: true })} />
          {loading ? (
            <>{[0, 1].map(i => <SkeletonCase key={i} />)}</>
          ) : store.cases.length ? (
            store.cases.map(c => <CaseRow key={c.id} c={c} onClick={() => nav("caseDetail", { id: c.id })} />)
          ) : (
            <EmptyState illo="folder-heart" title={t("no_active")} body={t("no_active_sub")} action={<Btn variant="primary" icon="plus" onClick={() => nav("wizard")}>{t("start_new_case")}</Btn>} />
          )}
        </div>

        {/* reports */}
        {!loading && (
          <div style={{ padding: "12px 18px 0" }}>
            <SectionHeader title={t("recent_reports")} />
            <Card onClick={() => nav("report", { id: store.completed.id })} pad={14}>
              <div style={{ display: "flex", gap: 13, alignItems: "center" }}>
                <div style={{ width: 46, height: 46, borderRadius: "var(--r-md)", background: "var(--rpt-green)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Ic name="file-badge" size={22} color="var(--rpt-gold-2)" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{lang === "ar" ? specMeta(store.completed.specialty).ar : specMeta(store.completed.specialty).en}</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>{lang === "ar" ? store.completed.doctor.name_ar : store.completed.doctor.name_en} · <span className="num">{store.completed.id}</span></div>
                </div>
                <StatusBadge status="ready" />
              </div>
            </Card>
          </div>
        )}

        <div style={{ padding: "20px 18px 8px" }}><ShifaStrip /></div>
      </div>
    </TabShell>
  );
}

function SectionHeader({ title, action }) {
  const { t } = useApp();
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
      <h2 style={{ fontSize: 17, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.01em" }}>{title}</h2>
      {action && <button onClick={action} style={{ background: "none", border: "none", color: "var(--teal)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t("see_all")}</button>}
    </div>
  );
}

function SkeletonCase() {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", padding: 14, marginBottom: 12, display: "flex", gap: 13, alignItems: "center" }}>
      <Skeleton h={46} w={46} r={14} />
      <div style={{ flex: 1 }}>
        <Skeleton h={14} w="55%" /><div style={{ height: 8 }} /><Skeleton h={11} w="40%" /><div style={{ height: 10 }} /><Skeleton h={20} w={90} r={999} />
      </div>
      <Skeleton h={52} w={52} r={999} />
    </div>
  );
}

function CasesScreen() {
  const { t, nav, store } = useApp();
  const [filter, setFilter] = React.useState("all");
  const all = [...store.cases, store.completed, store.breached];
  const shown = filter === "all" ? all : filter === "active" ? store.cases : filter === "done" ? [store.completed] : [store.breached];
  return (
    <TabShell active="cases">
      <div style={{ paddingTop: "var(--safe-top)" }}>
        <div style={{ padding: "8px 18px 14px" }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em", margin: "4px 0 16px" }}>{t("tab_cases")}</h1>
          <Segmented full value={filter} onChange={setFilter} options={[
            { value: "all", label: t("see_all") }, { value: "active", label: t("st_in_review") },
            { value: "done", label: t("st_ready") }, { value: "breach", label: t("st_breached") },
          ]} />
        </div>
        <div style={{ padding: "0 18px" }}>
          {shown.map(c => (
            <CaseRow key={c.id} c={c} onClick={() => nav(c.status === "ready" ? "report" : c.status === "breached" ? "breach" : "caseDetail", { id: c.id })} />
          ))}
        </div>
      </div>
    </TabShell>
  );
}

function CaseDetailScreen() {
  const { t, lang, nav, params, store } = useApp();
  const c = [...store.cases, store.completed, store.breached].find(x => x.id === params?.id) || store.cases[0];
  const m = specMeta(c.specialty);
  const d = c.doctor || SAMPLE_DOCTOR;
  const wMax = c.tier === "urgent" ? 24 : 72;
  const elapsed = wMax - (c.dueHrs || 0);
  const steps = [
    { state: "done", title: t("st_submitted"), meta: lang === "ar" ? c.createdAr : c.createdEn },
    { state: c.status === "assigned" ? "active" : "done", title: t("st_assigned"), meta: lang === "ar" ? d.name_ar : d.name_en },
    { state: c.status === "in_review" ? "active" : (c.status === "ready" ? "done" : "pending"), title: t("st_in_review"), body: c.status === "in_review" ? (lang === "ar" ? "الاستشاري بيراجع ملفك دلوقتي." : "Your specialist is reviewing your file now.") : null },
    { state: c.status === "ready" ? "done" : "pending", title: t("st_ready") },
  ];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <TopBar title={<span className="num">{c.id}</span>} onBack={() => nav("cases", {}, { root: true })} right={<button style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-2)" }}><Ic name="more-horizontal" size={20} /></button>} />
      <div id="tk-screen-scroll" className="app-scroll" style={{ flex: 1, overflowY: "auto", padding: "4px 18px calc(var(--safe-bottom) + 90px)" }}>
        {/* hero */}
        <Card pad={18} style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 16 }}>
            <SpecialtyIcon id={c.specialty} size={50} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>{lang === "ar" ? m.ar : m.en}</div>
              <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>{lang === "ar" ? c.patient_ar : c.patient_en}</div>
            </div>
            <TierChip tier={c.tier} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, padding: 14, background: "var(--surface-2)", borderRadius: "var(--r-md)" }}>
            <SLARing pct={Math.max(0.05, (c.dueHrs || 0) / wMax)} color={c.dueHrs < 6 ? "var(--warn)" : "var(--teal)"} size={64}>
              <Ic name="clock" size={22} color={c.dueHrs < 6 ? "var(--warn)" : "var(--teal)"} />
            </SLARing>
            <div style={{ flex: 1 }}>
              <SLACountdown hours={c.dueHrs || 18} size="lg" />
            </div>
          </div>
          <div style={{ marginTop: 12 }}><StatusBadge status={c.status} /></div>
        </Card>

        {/* assigned doctor */}
        <Card pad={16} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase", color: "var(--muted)", marginBottom: 12 }}>{t("assigned_to")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--teal-tint)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Ic name="stethoscope" size={22} color="var(--teal)" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>
                {lang === "ar" ? d.name_ar : d.name_en}<Ic name="badge-check" size={15} color="var(--teal)" />
              </div>
              <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>{lang === "ar" ? d.title_ar : d.title_en} · {lang === "ar" ? d.cred_ar : d.cred_en}</div>
            </div>
          </div>
        </Card>

        {/* timeline */}
        <Card pad={18} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase", color: "var(--muted)", marginBottom: 16 }}>{t("timeline")}</div>
          <Timeline steps={steps} />
        </Card>

        <ShifaStrip compact />
      </div>

      {c.status === "ready" && (
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "14px 18px calc(14px + var(--safe-bottom))", background: "rgba(8,17,32,0.9)", backdropFilter: "blur(16px)", borderTop: "1px solid var(--rule)" }}>
          <Btn variant="primary" size="lg" full icon="file-badge" onClick={() => nav("report", { id: c.id })}>{t("view_report")}</Btn>
        </div>
      )}
    </div>
  );
}

function BreachScreen() {
  const { t, lang, nav, store } = useApp();
  const c = store.breached;
  const m = specMeta(c.specialty);
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <TopBar title={<span className="num">{c.id}</span>} onBack={() => nav("cases", {}, { root: true })} />
      <div className="app-scroll" style={{ flex: 1, overflowY: "auto", padding: "4px 18px calc(var(--safe-bottom) + 20px)" }}>
        {/* honest breach banner */}
        <div style={{ background: "var(--danger-bg)", border: "1px solid rgba(248,113,113,0.3)", borderRadius: "var(--r-lg)", padding: 18, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <Ic name="alert-triangle" size={22} color="var(--danger)" />
            <h1 style={{ fontSize: 19, fontWeight: 700, color: "var(--text)", margin: 0 }}>{t("breach_title")}</h1>
          </div>
          <p style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.6, margin: 0 }}>{t("breach_body")}</p>
        </div>

        {/* refund card */}
        <Card pad={18} style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase", color: "var(--muted)" }}>{t("refund_status")}</div>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px", borderRadius: "var(--r-pill)", background: "var(--success-bg)", color: "var(--success)", fontSize: 12.5, fontWeight: 600 }}>
              <Ic name="check-circle-2" size={14} />{t("refund_done")}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span className="num" style={{ fontSize: 34, fontWeight: 700, color: "var(--success)", letterSpacing: "-0.02em" }}>{money(PRICING.standard, lang)}</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>{t("refund_eta")}</div>
          <div style={{ height: 1, background: "var(--rule)", margin: "14px 0" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-2)" }}>
            <Ic name="credit-card" size={16} color="var(--muted)" /> •••• 4291 · Visa
          </div>
        </Card>

        {/* prioritised case */}
        <Card pad={16} style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 13, alignItems: "center" }}>
            <SpecialtyIcon id={c.specialty} size={44} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{lang === "ar" ? m.ar : m.en}</div>
              <div style={{ fontSize: 12.5, color: "var(--teal)", marginTop: 3, display: "flex", alignItems: "center", gap: 5 }}>
                <Ic name="zap" size={13} />{lang === "ar" ? "بأولوية — من غير رسوم" : "Prioritised — no charge"}
              </div>
            </div>
          </div>
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Btn variant="primary" size="lg" full onClick={() => nav("home", {}, { root: true })}>{t("keep_waiting")}</Btn>
          <Btn variant="ghost" size="md" full icon="headset" onClick={() => nav("howItWorks")}>{t("contact_support")}</Btn>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { HomeScreen, CasesScreen, CaseDetailScreen, BreachScreen, CaseRow, SectionHeader, SkeletonCase });
