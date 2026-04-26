// ============================================================
// CASE DETAIL — three variants
//   v1  timeline-led (status is the hero, everything else flows below)
//   v2  tabbed (Overview / Documents / Messages / Report)
//   v3  split pane (status+next left, docs/messages right)
// Plus focused moments: post-payment, pre-assignment limbo.
// ============================================================

function CaseHeader({ compact = false }) {
  const c = PDATA.activeCase;
  return (
    <div style={{display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 18}}>
      <div style={{flex: 1}}>
        <div style={{display: "flex", alignItems: "center", gap: 10, marginBottom: 6}}>
          <span className="p-num" style={{fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)", letterSpacing: "0.02em"}}>{c.id}</span>
          <span style={{width: 3, height: 3, borderRadius: 999, background: "var(--rule-strong)"}}></span>
          <span style={{fontSize: 11, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--muted)", fontWeight: 600}}>{c.category}</span>
        </div>
        <h1 style={{fontFamily: compact ? "var(--font-sans)" : "var(--font-display)", fontSize: compact ? 22 : 28, fontWeight: compact ? 600 : 500, margin: 0, letterSpacing: compact ? "-0.01em" : "-0.005em", lineHeight: 1.2}}>
          {c.title}
        </h1>
        <div style={{display: "flex", alignItems: "center", gap: 14, marginTop: 8, fontSize: 12.5, color: "var(--muted)"}}>
          <span>Submitted {c.submittedAgo}</span>
          <span style={{width: 3, height: 3, borderRadius: 999, background: "var(--rule-strong)"}}></span>
          <span>{c.docsCount} documents</span>
          <span style={{width: 3, height: 3, borderRadius: 999, background: "var(--rule-strong)"}}></span>
          <span>Report in <strong className="p-num" style={{color: "var(--accent-dark)"}}>{c.etaCountdown}</strong></span>
        </div>
      </div>
      <div style={{display: "flex", alignItems: "center", gap: 8}}>
        <span className="case-status"><span className="case-status__dot"></span>{c.statusLabel}</span>
      </div>
    </div>
  );
}

function WhatsHappeningCard({ compact = false }) {
  // This is the "anxiety reducer" — always explains state in warm copy.
  return (
    <div style={{
      background: "linear-gradient(180deg, #FAF1DD 0%, #F8F5EF 100%)",
      border: "1px solid #E8D4A8", borderRadius: 14, padding: 20,
    }}>
      <div style={{display: "flex", alignItems: "center", gap: 8, marginBottom: 10}}>
        <div style={{width: 24, height: 24, borderRadius: 999, background: "var(--accent)", color: "var(--on-accent)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0}}>
          <Icon name="clock" size={12} />
        </div>
        <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--accent-dark)", fontWeight: 700}}>What's happening now</div>
      </div>
      <div style={{fontSize: compact ? 14 : 16, fontWeight: 600, lineHeight: 1.4, color: "var(--ink)", marginBottom: 6}}>
        Dr. Rania is reviewing your scans.
      </div>
      <div style={{fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6}}>
        She opened your case on Tuesday at 11:30 and has already reviewed 4 of 7 files. You don't need to do anything — she'll message you here if she has questions.
      </div>
      <div style={{marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(179,139,62,0.2)", display: "flex", justifyContent: "space-between", alignItems: "center"}}>
        <div>
          <div style={{fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--muted)", fontWeight: 600}}>Expected by</div>
          <div className="p-num" style={{fontSize: 14, fontWeight: 600, marginTop: 2}}>Thursday 21 Apr · by 8pm</div>
        </div>
        <div className="p-num" style={{fontFamily: "var(--font-display)", fontSize: 30, fontWeight: 500, color: "var(--accent-dark)", letterSpacing: "-0.01em"}}>18h 24m</div>
      </div>
    </div>
  );
}

function DoctorAssignedCard() {
  const d = PDATA.doctor;
  return (
    <div className="p-card" style={{padding: 18}}>
      <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 14}}>Assigned to</div>
      <div style={{display: "flex", gap: 14, alignItems: "flex-start"}}>
        <div style={{width: 60, height: 60, borderRadius: 14, background: "linear-gradient(135deg, #E8F3F1, #D4E9E5)", color: "var(--primary-dark)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, flexShrink: 0}}>
          {d.initials}
        </div>
        <div style={{flex: 1}}>
          <div style={{fontSize: 15.5, fontWeight: 600}}>{d.name}</div>
          <div style={{fontSize: 12.5, color: "var(--muted)", marginTop: 2}}>{d.role}</div>
          <div style={{fontSize: 11.5, color: "var(--muted)", marginTop: 6, lineHeight: 1.5}}>{d.credentials} · {d.hospital}</div>
          <div style={{display: "flex", gap: 12, marginTop: 10, fontSize: 11, color: "var(--ink-2)"}}>
            <span style={{display: "flex", alignItems: "center", gap: 4}}><Icon name="globe" size={12} color="var(--accent)" />{d.languages}</span>
            <span style={{display: "flex", alignItems: "center", gap: 4}}><Icon name="clock" size={12} color="var(--accent)" />{d.responseTime}</span>
          </div>
        </div>
      </div>
      <div style={{display: "flex", gap: 8, marginTop: 14}}>
        <button className="p-btn p-btn--secondary p-btn--sm" style={{flex: 1}}>
          <Icon name="message" size={14} />Message
        </button>
        <button className="p-btn p-btn--ghost p-btn--sm" style={{flex: 1}}>
          <Icon name="shield" size={14} />View profile
        </button>
      </div>
    </div>
  );
}

// ============================================================
// V1 — timeline-led case detail
// ============================================================
function CaseDetailV1({ sidebarVariant = "dark", trustDensity = "medium", aiSurfacing = "invisible" }) {
  return (
    <div className="p-app">
      <PSidebar active="dashboard" variant={sidebarVariant} trustDensity={trustDensity} unread={2} />
      <main className="p-main">
        <div style={{fontSize: 12, color: "var(--muted)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6}}>
          <span>Home</span><Icon name="chevR" size={10} /><span>Case</span>
        </div>
        <CaseHeader />

        <div style={{display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 18, marginTop: 12}}>
          <div className="stack" style={{gap: 18}}>
            <WhatsHappeningCard />

            <div className="p-card">
              <div className="p-card__header">
                <div className="p-card__title">Your case, step by step</div>
                <div className="p-card__sub">Updated just now</div>
              </div>
              <div className="p-card__body">
                <div className="tl">
                  {PDATA.timeline.map((t, i) => (
                    <div key={i} className={`tl__step ${t.state}`}>
                      <div className="tl__step-k">{t.k}</div>
                      <div className="tl__step-title">{t.title}</div>
                      <div className="tl__step-sub">{t.sub}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="p-card">
              <div className="p-card__header">
                <div className="p-card__title">Your documents</div>
                <div className="p-card__sub">{PDATA.files.length} files · organized by type</div>
                <div className="spacer" />
                <span className="p-card__link">Add more</span>
              </div>
              <div className="p-card__body" style={{padding: 14}}>
                {["Imaging", "Report", "Labs", "Letter"].map(group => {
                  const items = PDATA.files.filter(f => f.type === group);
                  if (!items.length) return null;
                  return (
                    <div key={group} style={{marginBottom: 14}}>
                      <div style={{fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--muted)", fontWeight: 700, marginBottom: 8, paddingLeft: 4}}>{group} · {items.length}</div>
                      <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8}}>
                        {items.map((f, i) => <FileTile key={i} f={f} />)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="p-card">
              <div className="p-card__header">
                <div className="p-card__title">Messages with Dr. Rania</div>
                <div className="p-card__sub">{PDATA.messages.length} messages</div>
                <div className="spacer" />
                <span className="p-card__link">Open chat →</span>
              </div>
              <div className="p-card__body" style={{padding: 16}}>
                <div style={{display: "flex", flexDirection: "column", gap: 8}}>
                  {PDATA.messages.slice(-3).map((m, i) => (
                    <div key={i} className={`bubble bubble--${m.who}`} style={{alignSelf: m.who === "me" ? "flex-end" : "flex-start"}}>
                      {m.text}
                      <div className="bubble__meta">{m.time}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="stack" style={{gap: 14}}>
            <DoctorAssignedCard />

            <div className="p-card" style={{padding: 18}}>
              <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 10}}>Case details</div>
              <Kv k="Case ID" v={<span style={{fontFamily: "var(--font-mono)", fontSize: 12}}>{PDATA.activeCase.id}</span>} />
              <Kv k="Submitted" v={PDATA.activeCase.submitted} />
              <Kv k="Specialty" v={PDATA.activeCase.specialty} />
              <Kv k="Language" v={PDATA.activeCase.preferredLang} />
              <Kv k="Fee paid" v={<span className="p-num" style={{fontWeight: 600}}>{PDATA.activeCase.fee}</span>} last />
            </div>

            <div className="p-card" style={{padding: 18, background: "#FBF9F4"}}>
              <div style={{fontSize: 13, fontWeight: 600, marginBottom: 6}}>Your files are protected.</div>
              <div style={{fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 10}}>
                Encrypted in transit and at rest. Only Dr. Rania can see them. You can delete them anytime after the case closes.
              </div>
              <div style={{display: "flex", gap: 8, flexWrap: "wrap"}}>
                <span className="p-chip p-chip--teal"><Icon name="shield" size={10} />GDPR</span>
                <span className="p-chip p-chip--teal"><Icon name="lock" size={10} />E2E</span>
                <span className="p-chip p-chip--brass"><Icon name="check" size={10} />Shifa Partner</span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function Kv({ k, v, last }) {
  return (
    <div style={{display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: last ? "none" : "1px solid var(--rule)", fontSize: 12.5}}>
      <span style={{color: "var(--muted)"}}>{k}</span>
      <span style={{color: "var(--ink)", textAlign: "right"}}>{v}</span>
    </div>
  );
}

// ============================================================
// V2 — tabbed
// ============================================================
function CaseDetailV2({ sidebarVariant = "dark", trustDensity = "medium" }) {
  const [tab, setTab] = React.useState("overview");
  const tabs = [
    { k: "overview", label: "Overview" },
    { k: "documents", label: "Documents", count: 7 },
    { k: "messages", label: "Messages", count: 2, dot: true },
    { k: "report", label: "Report", disabled: true },
  ];
  return (
    <div className="p-app">
      <PSidebar active="dashboard" variant={sidebarVariant} trustDensity={trustDensity} unread={2} />
      <main className="p-main">
        <div style={{fontSize: 12, color: "var(--muted)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6}}>
          <span>Home</span><Icon name="chevR" size={10} /><span>Case</span>
        </div>
        <CaseHeader />

        {/* Tabs */}
        <div style={{display: "flex", gap: 2, borderBottom: "1px solid var(--rule)", marginBottom: 18}}>
          {tabs.map(t => (
            <button key={t.k} onClick={() => !t.disabled && setTab(t.k)} disabled={t.disabled}
              style={{
                padding: "12px 18px", border: "none", background: "transparent", cursor: t.disabled ? "not-allowed" : "pointer",
                fontSize: 13.5, fontWeight: 600, color: t.disabled ? "var(--muted-2)" : (tab === t.k ? "var(--primary)" : "var(--ink-2)"),
                borderBottom: tab === t.k ? "2px solid var(--primary)" : "2px solid transparent",
                marginBottom: -1, display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit",
              }}>
              {t.label}
              {t.count && <span style={{background: tab === t.k ? "var(--primary-light)" : "var(--surface-sunk)", color: tab === t.k ? "var(--primary-dark)" : "var(--muted)", padding: "1px 7px", borderRadius: 999, fontSize: 10, fontWeight: 700}}>{t.count}</span>}
              {t.dot && <span style={{width: 6, height: 6, borderRadius: 999, background: "var(--accent)"}}></span>}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <div style={{display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 18}}>
            <div className="stack" style={{gap: 18}}>
              <WhatsHappeningCard />
              <div className="p-card">
                <div className="p-card__header"><div className="p-card__title">Your case, step by step</div></div>
                <div className="p-card__body">
                  <div className="tl">
                    {PDATA.timeline.map((t, i) => (
                      <div key={i} className={`tl__step ${t.state}`}>
                        <div className="tl__step-k">{t.k}</div>
                        <div className="tl__step-title">{t.title}</div>
                        <div className="tl__step-sub">{t.sub}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="stack" style={{gap: 14}}>
              <DoctorAssignedCard />
              <div className="p-card" style={{padding: 18}}>
                <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 10}}>Case details</div>
                <Kv k="Case ID" v={<span style={{fontFamily: "var(--font-mono)", fontSize: 12}}>{PDATA.activeCase.id}</span>} />
                <Kv k="Submitted" v={PDATA.activeCase.submitted} />
                <Kv k="Specialty" v={PDATA.activeCase.specialty} />
                <Kv k="Fee paid" v={<span className="p-num" style={{fontWeight: 600}}>{PDATA.activeCase.fee}</span>} last />
              </div>
            </div>
          </div>
        )}

        {tab === "documents" && (
          <div className="p-card">
            <div className="p-card__header">
              <div className="p-card__title">Documents</div>
              <div className="p-card__sub">{PDATA.files.length} files · {Math.round(PDATA.files.reduce((a,f)=>a+parseFloat(f.size),0))} MB total</div>
              <div className="spacer" />
              <button className="p-btn p-btn--ghost p-btn--sm"><Icon name="upload" size={12} />Add files</button>
            </div>
            <div className="p-card__body" style={{padding: 18}}>
              {["Imaging", "Report", "Labs", "Letter"].map(group => {
                const items = PDATA.files.filter(f => f.type === group);
                if (!items.length) return null;
                return (
                  <div key={group} style={{marginBottom: 18}}>
                    <div style={{fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--muted)", fontWeight: 700, marginBottom: 10, paddingLeft: 4}}>{group} · {items.length}</div>
                    <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10}}>
                      {items.map((f, i) => <FileTile key={i} f={f} />)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab === "messages" && (
          <div className="p-card" style={{display: "grid", gridTemplateColumns: "1fr 280px", minHeight: 520}}>
            <div style={{padding: 20, display: "flex", flexDirection: "column"}}>
              <div style={{borderBottom: "1px solid var(--rule)", paddingBottom: 12, marginBottom: 14, display: "flex", alignItems: "center", gap: 10}}>
                <div style={{width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg, #E8F3F1, #D4E9E5)", color: "var(--primary-dark)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600}}>RE</div>
                <div style={{flex: 1}}>
                  <div style={{fontSize: 13.5, fontWeight: 600}}>Dr. Rania El Radi</div>
                  <div style={{fontSize: 11, color: "var(--muted)"}}>Typically responds within 2 hours</div>
                </div>
                <span className="p-chip p-chip--green"><span style={{width: 6, height: 6, borderRadius: 999, background: "var(--success)"}}></span>Online</span>
              </div>
              <div style={{flex: 1, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", padding: "4px 2px"}}>
                {PDATA.messages.map((m, i) => (
                  <div key={i} className={`bubble bubble--${m.who}`} style={{alignSelf: m.who === "me" ? "flex-end" : "flex-start"}}>
                    {m.text}
                    <div className="bubble__meta">{m.time}</div>
                  </div>
                ))}
              </div>
              <div style={{marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--rule)", display: "flex", gap: 8}}>
                <input className="p-field__input" placeholder="Write a reply…" style={{flex: 1}} />
                <button className="p-btn p-btn--primary"><Icon name="send" size={14} /></button>
              </div>
            </div>
            <div style={{borderLeft: "1px solid var(--rule)", padding: 18, background: "#FBF9F4"}}>
              <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 12}}>About this conversation</div>
              <div style={{fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 14}}>
                Messages are scoped to this case and only visible to you and Dr. Rania. For urgent medical situations, call your local emergency line.
              </div>
              <button className="p-btn p-btn--ghost p-btn--sm" style={{width: "100%"}}><Icon name="shield" size={12} />Privacy & safety</button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ============================================================
// V3 — split pane
// ============================================================
function CaseDetailV3({ sidebarVariant = "dark", trustDensity = "medium" }) {
  return (
    <div className="p-app">
      <PSidebar active="dashboard" variant={sidebarVariant} trustDensity={trustDensity} unread={2} />
      <main className="p-main" style={{maxWidth: 1400}}>
        <CaseHeader compact />
        <div style={{display: "grid", gridTemplateColumns: "380px 1fr", gap: 20}}>
          {/* Left: status + next step + doctor */}
          <div className="stack" style={{gap: 14, position: "sticky", top: 28, alignSelf: "flex-start"}}>
            <WhatsHappeningCard compact />
            <DoctorAssignedCard />
            <div className="p-card" style={{padding: 18}}>
              <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 12}}>Progress</div>
              <div className="tl" style={{paddingLeft: 22}}>
                {PDATA.timeline.map((t, i) => (
                  <div key={i} className={`tl__step ${t.state}`} style={{paddingBottom: 14}}>
                    <div className="tl__step-title" style={{fontSize: 13}}>{t.title}</div>
                    <div className="tl__step-sub" style={{fontSize: 11.5}}>{t.sub}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right: docs + messages stacked */}
          <div className="stack" style={{gap: 18}}>
            <div className="p-card">
              <div className="p-card__header">
                <div className="p-card__title">Your documents</div>
                <div className="p-card__sub">{PDATA.files.length} files</div>
                <div className="spacer" />
                <button className="p-btn p-btn--ghost p-btn--sm"><Icon name="upload" size={12} />Add files</button>
              </div>
              <div className="p-card__body" style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10}}>
                {PDATA.files.map((f, i) => <FileTile key={i} f={f} />)}
              </div>
            </div>

            <div className="p-card">
              <div className="p-card__header">
                <div className="p-card__title">Messages with Dr. Rania</div>
                <div className="p-card__sub">2 new · Typically replies within 2h</div>
              </div>
              <div className="p-card__body" style={{padding: 16}}>
                <div style={{display: "flex", flexDirection: "column", gap: 10, marginBottom: 14}}>
                  {PDATA.messages.map((m, i) => (
                    <div key={i} className={`bubble bubble--${m.who}`} style={{alignSelf: m.who === "me" ? "flex-end" : "flex-start"}}>
                      {m.text}
                      <div className="bubble__meta">{m.time}</div>
                    </div>
                  ))}
                </div>
                <div style={{display: "flex", gap: 8, paddingTop: 14, borderTop: "1px solid var(--rule)"}}>
                  <input className="p-field__input" placeholder="Write a reply…" style={{flex: 1}} />
                  <button className="p-btn p-btn--primary"><Icon name="send" size={14} />Send</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ============================================================
// Post-payment "here's what's happening" moment
// ============================================================
function PostPayment({ sidebarVariant = "dark", trustDensity = "medium" }) {
  return (
    <div className="p-app">
      <PSidebar active="dashboard" variant={sidebarVariant} trustDensity={trustDensity} />
      <main className="p-main" style={{maxWidth: 720, margin: "0 auto", paddingTop: 48}}>
        <div style={{textAlign: "center", marginBottom: 36}}>
          <div style={{width: 72, height: 72, margin: "0 auto 20px", borderRadius: 20, background: "var(--primary-light)", color: "var(--primary-dark)", display: "flex", alignItems: "center", justifyContent: "center"}}>
            <Icon name="check" size={32} />
          </div>
          <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--primary-dark)", fontWeight: 700, marginBottom: 10}}>Payment received</div>
          <h1 style={{fontFamily: "var(--font-display)", fontSize: 36, fontWeight: 500, letterSpacing: "-0.005em", margin: "0 0 12px", lineHeight: 1.15}}>
            Your case is in safe hands.
          </h1>
          <p style={{fontSize: 15, color: "var(--ink-2)", lineHeight: 1.6, maxWidth: 520, margin: "0 auto"}}>
            We've received your files and payment. Here's exactly what happens next — you don't need to do anything.
          </p>
        </div>

        <div className="p-card" style={{padding: 28, marginBottom: 18}}>
          <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 18}}>Next 72 hours</div>
          <div style={{display: "flex", flexDirection: "column", gap: 20}}>
            {[
              { num: "01", title: "Right now — we're organizing your files", sub: "Grouping scans, labs, and reports by date so your specialist can move fast. Takes a few minutes.", active: true },
              { num: "02", title: "Within 2–4 hours — a specialist is assigned", sub: "We match you with a consultant based on specialty and current load. You'll get an email with their name and credentials.", active: false },
              { num: "03", title: "Within 24–72 hours — your written opinion arrives", sub: "A full report in Arabic, with findings, recommendations, and next steps. You'll get an SMS the moment it's ready.", active: false },
            ].map((s, i) => (
              <div key={i} style={{display: "flex", gap: 16, alignItems: "flex-start"}}>
                <div style={{
                  width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                  background: s.active ? "var(--accent-light)" : "var(--primary-light)",
                  color: s.active ? "var(--accent-dark)" : "var(--primary-dark)",
                  fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  border: s.active ? "2px solid var(--accent)" : "none",
                }}>{s.num}</div>
                <div style={{flex: 1, paddingTop: 4}}>
                  <div style={{fontSize: 15, fontWeight: 600, marginBottom: 3, display: "flex", alignItems: "center", gap: 8}}>
                    {s.title}
                    {s.active && <span className="p-chip p-chip--brass">In progress</span>}
                  </div>
                  <div style={{fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55}}>{s.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 18}}>
          <div className="p-card" style={{padding: 18}}>
            <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 8}}>Receipt</div>
            <div className="p-num" style={{fontSize: 22, fontFamily: "var(--font-display)", fontWeight: 500, color: "var(--accent-dark)"}}>EGP 2,000</div>
            <div style={{fontSize: 12, color: "var(--muted)", marginTop: 4}}>Paymob · ···· 4824 · 18 Apr 14:22</div>
            <button className="p-btn p-btn--ghost p-btn--sm" style={{padding: 0, marginTop: 10}}>Download receipt<Icon name="download" size={12} /></button>
          </div>
          <div className="p-card" style={{padding: 18}}>
            <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 8}}>Peace of mind</div>
            <div style={{fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55}}>
              No specialist available within 48 hours? Full refund, no questions asked.
            </div>
          </div>
        </div>

        <div style={{display: "flex", gap: 10, justifyContent: "center", marginTop: 24}}>
          <button className="p-btn p-btn--primary p-btn--lg">Go to my case<Icon name="chevR" size={14} /></button>
          <button className="p-btn p-btn--ghost p-btn--lg">Return to home</button>
        </div>
      </main>
    </div>
  );
}

// ============================================================
// Pre-assignment limbo — 2-4h window when doctor isn't assigned yet
// ============================================================
function LimboState({ sidebarVariant = "dark", trustDensity = "medium" }) {
  return (
    <div className="p-app">
      <PSidebar active="dashboard" variant={sidebarVariant} trustDensity={trustDensity} />
      <main className="p-main">
        <CaseHeader />
        <div style={{display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 18}}>
          <div className="stack" style={{gap: 18}}>
            <div style={{
              background: "linear-gradient(180deg, #E8F3F1 0%, #F8F5EF 100%)",
              border: "1px solid #C5DFDB", borderRadius: 14, padding: 24,
            }}>
              <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--primary-dark)", fontWeight: 700, marginBottom: 12}}>Matching you with a specialist</div>
              <h2 style={{fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 500, letterSpacing: "-0.005em", margin: "0 0 10px", lineHeight: 1.2}}>
                We're pairing you with the right doctor — usually within 2–4 hours.
              </h2>
              <p style={{fontSize: 14, color: "var(--ink-2)", lineHeight: 1.6, marginBottom: 16}}>
                Three of our radiology consultants are currently reviewing queues. You'll get an email and SMS the moment one accepts your case. Typical wait at this hour: <strong>1h 40m</strong>.
              </p>
              <div style={{display: "flex", gap: 8}}>
                {[0,1,2].map(i => (
                  <div key={i} style={{height: 4, flex: 1, borderRadius: 2, background: "var(--primary)", opacity: 0.3 + i * 0.25,
                    animation: `limboPulse 1.5s ${i * 0.2}s infinite`}}></div>
                ))}
              </div>
              <style>{`@keyframes limboPulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }`}</style>
            </div>

            <div className="p-card">
              <div className="p-card__header"><div className="p-card__title">Your case, step by step</div></div>
              <div className="p-card__body">
                <div className="tl">
                  {PDATA.timeline.map((t, i) => (
                    <div key={i} className={`tl__step ${i === 2 ? "active" : (i < 2 ? "done" : "pending")}`}>
                      <div className="tl__step-k">{t.k}</div>
                      <div className="tl__step-title">{i === 2 ? "Finding your specialist…" : t.title}</div>
                      <div className="tl__step-sub">{i === 2 ? "Usually takes 2–4 hours · we'll notify you" : t.sub}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="stack" style={{gap: 14}}>
            <div className="p-card" style={{padding: 18}}>
              <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 10}}>While you wait</div>
              <div style={{fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 12}}>
                There's nothing you need to do. We'll email you the moment your specialist is assigned.
              </div>
              <div style={{display: "flex", flexDirection: "column", gap: 6}}>
                <button className="p-btn p-btn--ghost p-btn--sm" style={{justifyContent: "flex-start"}}><Icon name="file" size={14} />Review my case summary</button>
                <button className="p-btn p-btn--ghost p-btn--sm" style={{justifyContent: "flex-start"}}><Icon name="message" size={14} />Add files or notes</button>
              </div>
            </div>
            <div className="p-card" style={{padding: 18, background: "#FBF9F4"}}>
              <div style={{fontSize: 13, fontWeight: 600, marginBottom: 6}}>Still waiting after 4 hours?</div>
              <div style={{fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 10}}>
                If no specialist has accepted by then, our care coordinator Mr. Maher will reach out personally.
              </div>
              <button className="p-btn p-btn--secondary p-btn--sm" style={{width: "100%"}}>Contact care team</button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

Object.assign(window, { CaseDetailV1, CaseDetailV2, CaseDetailV3, PostPayment, LimboState });
