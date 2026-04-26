// ============================================================
// Tashkheesa Patient Portal — DASHBOARD variants (priority 1)
// ============================================================

// Three states of the dashboard user can flip through via Tweaks:
//   empty  — first-time, no case yet
//   active — case in review
//   done   — report delivered

function DashboardActive({ trustDensity = "medium", sidebarVariant = "dark", aiSurfacing = "invisible" }) {
  const c = PDATA.activeCase;
  return (
    <div className="p-app">
      <PSidebar active="dashboard" variant={sidebarVariant} trustDensity={trustDensity} />
      <main className="p-main">
        <PTopbar title={`Good afternoon, ${PDATA.patient.name.split(" ")[0]}.`} serif
                 sub="Here's where your case stands today.">
          <div className="p-chip p-chip--teal"><Icon name="shield" size={11} />Encrypted</div>
        </PTopbar>

        {/* Hero — case-in-review state */}
        <div className="dash-hero">
          <div>
            <div className="dash-hero__eyebrow">Your active case</div>
            <h2 className="dash-hero__title">Your specialist is reviewing your files now.</h2>
            <p className="dash-hero__sub">
              Dr. Rania El Radi started her review yesterday morning. You'll get an email and SMS the moment her written opinion is ready — no need to keep checking.
            </p>
            <div style={{display: "flex", gap: 10, marginTop: 18}}>
              <button className="p-btn p-btn--primary">Open case</button>
              <button className="p-btn p-btn--ghost">Message Dr. El Radi</button>
            </div>
          </div>
          <div style={{textAlign: "right"}}>
            <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700}}>Expected by</div>
            <div className="p-num" style={{fontFamily: "var(--font-display)", fontSize: 36, fontWeight: 500, letterSpacing: "-0.005em", color: "var(--ink)", marginTop: 4}}>Thu, 21 Apr</div>
            <div style={{fontSize: 12, color: "var(--accent-dark)", fontWeight: 600, marginTop: 2}} className="p-num">about {c.etaCountdown} away</div>
            <div style={{marginTop: 16}}><div className="case-status"><span className="case-status__dot" />{c.statusLabel}</div></div>
          </div>
        </div>

        {/* What's happening right now card */}
        <div className="next-step" style={{marginBottom: 18}}>
          <div className="next-step__glyph"><Icon name="eye" size={22} /></div>
          <div>
            <div className="next-step__k">What's happening right now</div>
            <div className="next-step__title">Dr. El Radi is comparing your current scan with October's imaging.</div>
            <div className="next-step__sub">Step 4 of 5 · Nothing is needed from you. If she has a question, it'll arrive here as a message.</div>
          </div>
          <button className="p-btn p-btn--secondary">View details</button>
        </div>

        <div style={{display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18}}>
          {/* LEFT: timeline + docs */}
          <div className="stack">
            <div className="p-card">
              <div className="p-card__header">
                <div className="p-card__title">Your case timeline</div>
                <div className="p-card__sub">{c.id}</div>
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
                <div className="p-card__sub">7 files · {aiSurfacing === "invisible" ? "organized by type" : "organized automatically"}</div>
                <div className="spacer" />
                <a className="p-card__link">View all →</a>
              </div>
              <div className="p-card__body" style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10}}>
                {PDATA.files.slice(0,4).map((f, i) => <FileTile key={i} f={f} compact />)}
              </div>
            </div>
          </div>

          {/* RIGHT: doctor + trust + next steps */}
          <div className="stack">
            <div className="p-card">
              <div className="p-card__header"><div className="p-card__title">Your specialist</div></div>
              <div className="p-card__body">
                <DoctorCard />
                <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 14}}>
                  <button className="p-btn p-btn--secondary p-btn--sm"><Icon name="message" size={13} />Message</button>
                  <button className="p-btn p-btn--ghost p-btn--sm"><Icon name="eye" size={13} />Profile</button>
                </div>
              </div>
            </div>

            <div className="p-card" style={{background: "linear-gradient(180deg, #FAF1DD 0%, #F2E4C7 100%)", border: "1px solid #E6D7B0"}}>
              <div className="p-card__body">
                <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#8E6C2C", fontWeight: 700, marginBottom: 6}}>Our promise</div>
                <div style={{fontSize: 14, fontWeight: 600, color: "#3E2E0D", lineHeight: 1.45, marginBottom: 8}}>Written opinion in 24–72 hours, or your money back.</div>
                <div style={{fontSize: 12, color: "#6B5A30", lineHeight: 1.5}}>Every case is reviewed by a consultant-level Egyptian specialist licensed by the Egyptian Medical Syndicate.</div>
              </div>
            </div>

            <div className="p-card">
              <div className="p-card__header"><div className="p-card__title">Need help?</div></div>
              <div className="p-card__body" style={{display: "flex", flexDirection: "column", gap: 10}}>
                <a style={{fontSize: 13, color: "var(--primary)", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 8}}><Icon name="helpCircle" size={14} />How does a second opinion work?</a>
                <a style={{fontSize: 13, color: "var(--primary)", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 8}}><Icon name="phone" size={14} />Speak to patient care · +20 2 2735 4120</a>
                <a style={{fontSize: 13, color: "var(--primary)", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 8}}><Icon name="mail" size={14} />care@tashkheesa.com</a>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ============================================================
// DASHBOARD — EMPTY (first-time, no case)
// ============================================================
function DashboardEmpty({ trustDensity = "medium", sidebarVariant = "dark" }) {
  return (
    <div className="p-app">
      <PSidebar active="dashboard" variant={sidebarVariant} trustDensity={trustDensity} />
      <main className="p-main">
        <PTopbar title={`Welcome, ${PDATA.patient.name.split(" ")[0]}.`} serif
                 sub="Let's get your case in front of the right specialist." />

        <div style={{
          background: "linear-gradient(180deg, #FFFFFF 0%, #FBF9F4 100%)",
          border: "1px solid var(--rule)", borderRadius: 16, padding: "44px 40px 36px",
          display: "grid", gridTemplateColumns: "1fr 320px", gap: 40, alignItems: "center",
          marginBottom: 18,
        }}>
          <div>
            <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--accent-dark)", fontWeight: 700, marginBottom: 12}}>Start here</div>
            <h2 style={{fontFamily: "var(--font-display)", fontSize: 36, fontWeight: 500, letterSpacing: "-0.005em", lineHeight: 1.1, margin: 0, color: "var(--ink)"}}>
              A senior specialist, reviewing your files with the care they deserve.
            </h2>
            <p style={{fontSize: 15, color: "var(--ink-2)", marginTop: 14, lineHeight: 1.55, maxWidth: 540}}>
              Upload your scans, labs and any prior reports. A consultant from our Egyptian Medical Syndicate panel will return a written opinion in 24–72 hours — in English or Arabic, whichever you prefer.
            </p>
            <div style={{display: "flex", gap: 12, marginTop: 22}}>
              <button className="p-btn p-btn--primary p-btn--lg">Start my case</button>
              <button className="p-btn p-btn--ghost p-btn--lg">How it works</button>
            </div>
          </div>
          <div style={{
            background: "linear-gradient(135deg, #0B6B5F 0%, #074B43 100%)",
            borderRadius: 14, padding: 24, color: "#F8F5EF", position: "relative", overflow: "hidden",
          }}>
            <div style={{position: "absolute", top: 12, right: 16, fontFamily: "var(--font-display)", fontSize: 64, color: "#B38B3E", opacity: 0.45, fontWeight: 500}}>ت</div>
            <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#E6D7B0", fontWeight: 700}}>What you'll receive</div>
            <div className="p-num" style={{fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 500, marginTop: 8, lineHeight: 1.15}}>A written consultant-level opinion.</div>
            <div style={{fontSize: 12.5, color: "rgba(248,245,239,0.75)", marginTop: 8, lineHeight: 1.55}}>Clear recommendations, next steps and whether further testing is needed. Sent to your portal and email.</div>
          </div>
        </div>

        <div style={{display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14}}>
          {[
            { k: "1 · Upload", title: "Tell us what's going on.", sub: "Symptoms, what the first doctor said, and your files (scans, labs, reports).", icon: "upload" },
            { k: "2 · Review", title: "A specialist reviews everything.", sub: "We assign the right consultant and they go through your case personally.", icon: "eye" },
            { k: "3 · Opinion", title: "You get a written opinion.", sub: "Usually 24–72 hours. Includes recommendations and clear next steps.", icon: "file" },
          ].map((s, i) => (
            <div key={i} className="p-card" style={{padding: 20}}>
              <div style={{width: 36, height: 36, borderRadius: 10, background: "var(--primary-light)", color: "var(--primary-dark)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 12}}><Icon name={s.icon} size={18} /></div>
              <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--accent-dark)", fontWeight: 700, marginBottom: 4}}>{s.k}</div>
              <div style={{fontSize: 15, fontWeight: 600, lineHeight: 1.3, marginBottom: 6}}>{s.title}</div>
              <div style={{fontSize: 13, color: "var(--muted)", lineHeight: 1.5}}>{s.sub}</div>
            </div>
          ))}
        </div>

        <div className="p-card" style={{marginTop: 14, padding: "18px 22px", display: "flex", gap: 18, alignItems: "center", background: "#FBF9F4"}}>
          <div style={{display: "flex", gap: 18, flex: 1}}>
            <div><div style={{fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700}}>Turnaround</div><div style={{fontSize: 16, fontWeight: 600, marginTop: 2, fontVariantNumeric: "tabular-nums"}}>24–72 hours</div></div>
            <div><div style={{fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700}}>Starting at</div><div style={{fontSize: 16, fontWeight: 600, marginTop: 2, color: "var(--accent-dark)", fontVariantNumeric: "tabular-nums"}}>EGP 1,200</div></div>
            <div><div style={{fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700}}>Languages</div><div style={{fontSize: 16, fontWeight: 600, marginTop: 2}}>Arabic · English</div></div>
            <div><div style={{fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700}}>Partner hospital</div><div style={{fontSize: 16, fontWeight: 600, marginTop: 2}}>Shifa, El Tagamoa</div></div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ============================================================
// DASHBOARD — REPORT READY
// ============================================================
function DashboardReady({ trustDensity = "medium", sidebarVariant = "dark" }) {
  return (
    <div className="p-app">
      <PSidebar active="dashboard" variant={sidebarVariant} trustDensity={trustDensity} />
      <main className="p-main">
        <PTopbar title={`Your opinion is ready, ${PDATA.patient.name.split(" ")[0]}.`} serif
                 sub="Dr. El Radi delivered your report this morning." />

        <div style={{
          background: "linear-gradient(135deg, #0B6B5F 0%, #074B43 100%)",
          borderRadius: 16, padding: 28, color: "#F8F5EF", marginBottom: 18,
          display: "grid", gridTemplateColumns: "1fr auto", gap: 28, alignItems: "center", position: "relative", overflow: "hidden",
        }}>
          <div style={{position: "absolute", top: -30, right: -30, fontFamily: "var(--font-display)", fontSize: 240, color: "#B38B3E", opacity: 0.15, fontWeight: 500, lineHeight: 1}}>✓</div>
          <div>
            <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#E6D7B0", fontWeight: 700, marginBottom: 10}}>Report delivered · 29 min ago</div>
            <div style={{fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 500, letterSpacing: "-0.005em", lineHeight: 1.15, maxWidth: 560}}>
              Dr. El Radi has written your opinion. Take your time reading it — and message her if anything's unclear.
            </div>
          </div>
          <div style={{display: "flex", flexDirection: "column", gap: 8}}>
            <button className="p-btn p-btn--brass p-btn--lg">Read the report</button>
            <button className="p-btn" style={{background: "rgba(255,255,255,0.1)", color: "#F8F5EF", border: "1px solid rgba(255,255,255,0.2)"}}><Icon name="download" size={14} />Download PDF</button>
          </div>
        </div>

        <div style={{display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18}}>
          <div className="p-card">
            <div className="p-card__header">
              <div className="p-card__title">Quick summary</div>
              <div className="p-card__sub">First page of Dr. El Radi's report — full version inside</div>
            </div>
            <div className="p-card__body">
              <div style={{padding: 20, background: "#FBF9F4", borderRadius: 12, fontFamily: "var(--font-display)", fontSize: 16, lineHeight: 1.6, color: "var(--ink)"}}>
                "The staging CT findings are likely consistent with the initial report, but I recommend an additional PET-CT to clarify two indeterminate nodules before committing to a treatment plan. A full written discussion of alternatives follows below."
                <div style={{marginTop: 12, fontSize: 11, fontFamily: "var(--font-sans)", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600}}>— Dr. Rania El Radi, Consultant Radiologist</div>
              </div>
              <div style={{display: "flex", gap: 10, marginTop: 16}}>
                <button className="p-btn p-btn--primary">Open full report</button>
                <button className="p-btn p-btn--secondary"><Icon name="message" size={13} />Ask Dr. El Radi a question</button>
              </div>
            </div>
          </div>

          <div className="stack">
            <div className="p-card">
              <div className="p-card__header"><div className="p-card__title">Your specialist</div></div>
              <div className="p-card__body"><DoctorCard /></div>
            </div>
            <div className="p-card">
              <div className="p-card__body" style={{textAlign: "center"}}>
                <div style={{fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5, marginBottom: 10}}>How was your experience with Dr. El Radi?</div>
                <div style={{display: "flex", justifyContent: "center", gap: 4, color: "#B38B3E", fontSize: 22, marginBottom: 10}}>★★★★★</div>
                <button className="p-btn p-btn--ghost p-btn--sm">Leave a review</button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

Object.assign(window, { DashboardActive, DashboardEmpty, DashboardReady });
