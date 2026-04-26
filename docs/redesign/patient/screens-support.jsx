// ============================================================
// Supporting screens: landing, auth, report, messaging-focused,
// upload-focused (with validation), lower-fi (profile, history,
// notifications bell, empty/loading/error states)
// ============================================================

// ---------- LANDING ----------
function Landing({ sidebarVariant = "dark" }) {
  return (
    <div className="p-landing">
      <div className="p-landing__nav">
        <div style={{display: "flex", alignItems: "center", gap: 10}}>
          <div className="p-sidebar__tile" style={{width: 32, height: 32, fontSize: 19, borderRadius: 8}}>ت</div>
          <div style={{fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em"}}>Tashkheesa</div>
        </div>
        <div style={{marginLeft: 32, display: "flex", gap: 22}}>
          <span className="p-landing__nav-link">How it works</span>
          <span className="p-landing__nav-link">Our doctors</span>
          <span className="p-landing__nav-link">Pricing</span>
          <span className="p-landing__nav-link">For hospitals</span>
        </div>
        <div className="spacer" />
        <span className="p-landing__nav-link">العربية</span>
        <button className="p-btn p-btn--ghost p-btn--sm">Sign in</button>
        <button className="p-btn p-btn--primary p-btn--sm">Start a case</button>
      </div>

      <div className="p-hero">
        <div>
          <div className="p-hero__eyebrow"><Icon name="shield" size={12} />Shifa Hospital El Tagamoa · partnered</div>
          <h1 className="p-hero__title">A second opinion, <em>from a consultant you can name.</em></h1>
          <p className="p-hero__sub">Upload your scans and labs. A licensed Egyptian specialist reads them and writes you a clear opinion in 24–72 hours — in Arabic or English.</p>
          <div className="p-hero__actions">
            <button className="p-btn p-btn--primary p-btn--lg">Start your case<Icon name="chevR" size={14} /></button>
            <button className="p-btn p-btn--ghost p-btn--lg">How it works</button>
          </div>
          <div className="p-hero__trust-row">
            <div><div className="p-hero__trust-k">From</div><div className="p-hero__trust-v p-hero__trust-v--brass p-num">EGP 1,200</div></div>
            <div><div className="p-hero__trust-k">Turnaround</div><div className="p-hero__trust-v p-num">24–72h</div></div>
            <div><div className="p-hero__trust-k">Specialists</div><div className="p-hero__trust-v p-num">18</div></div>
            <div><div className="p-hero__trust-k">Completed</div><div className="p-hero__trust-v p-num">2,400+</div></div>
          </div>
        </div>
        <div className="p-hero__visual">
          <div className="p-hero__visual-glyph">ت</div>
          <div>
            <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#F2E4C7", fontWeight: 700, opacity: 0.9}}>Live case</div>
            <div style={{fontSize: 11, color: "rgba(248,245,239,0.7)", marginTop: 6, fontFamily: "var(--font-mono)"}}>TSH-2025-001284</div>
          </div>
          <div className="p-hero__stack">
            <div className="p-hero__stack-k">Your specialist</div>
            <div className="p-hero__stack-v">Dr. Rania El Radi</div>
            <div className="p-hero__stack-sub">Consultant Radiologist · Shifa Hospital · MD, FRCR · 18 years</div>
            <div style={{display: "flex", gap: 10, marginTop: 12, fontSize: 11, color: "rgba(248,245,239,0.8)"}}>
              <span>Arabic · English</span>
              <span>·</span>
              <span>Responds in 2h</span>
            </div>
          </div>
          <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8}}>
            <div style={{background: "rgba(248,245,239,0.08)", border: "1px solid rgba(248,245,239,0.12)", borderRadius: 10, padding: 12}}>
              <div style={{fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#E6D7B0", fontWeight: 700}}>Report due</div>
              <div className="p-num" style={{fontSize: 18, fontFamily: "var(--font-display)", color: "#F2E4C7", fontWeight: 500, marginTop: 4}}>18h 24m</div>
            </div>
            <div style={{background: "rgba(248,245,239,0.08)", border: "1px solid rgba(248,245,239,0.12)", borderRadius: 10, padding: 12}}>
              <div style={{fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#E6D7B0", fontWeight: 700}}>Files</div>
              <div className="p-num" style={{fontSize: 18, fontFamily: "var(--font-display)", color: "#F2E4C7", fontWeight: 500, marginTop: 4}}>7 · 276 MB</div>
            </div>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div style={{maxWidth: 1180, margin: "0 auto", padding: "40px 56px 80px"}}>
        <div style={{fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--accent-dark)", fontWeight: 700, marginBottom: 12}}>How it works</div>
        <h2 style={{fontFamily: "var(--font-display)", fontSize: 40, fontWeight: 500, letterSpacing: "-0.005em", margin: "0 0 40px", lineHeight: 1.15, maxWidth: 640}}>
          Four steps. One clear written opinion.
        </h2>
        <div style={{display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 18}}>
          {[
            { n: "01", t: "Tell us what's going on", s: "A few sentences about your concern. Paste the prior diagnosis if you have it." },
            { n: "02", t: "Upload your files", s: "Scans, labs, prior reports. PDF, DICOM, JPG. We organize them for your doctor." },
            { n: "03", t: "A specialist is assigned", s: "Within 2–4 hours, typically. You'll see who they are and their credentials." },
            { n: "04", t: "Your written opinion arrives", s: "A clear report in Arabic or English within 24–72 hours. Yours to keep." },
          ].map((s, i) => (
            <div key={i} style={{padding: "20px 22px 24px", background: "#FFF", border: "1px solid var(--rule)", borderRadius: 14, position: "relative"}}>
              <div style={{fontFamily: "var(--font-display)", fontSize: 30, fontWeight: 500, color: "var(--accent)", marginBottom: 14}}>{s.n}</div>
              <div style={{fontSize: 15.5, fontWeight: 600, lineHeight: 1.3, marginBottom: 8}}>{s.t}</div>
              <div style={{fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55}}>{s.s}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Trust strip */}
      <div style={{background: "#FFFEFB", borderTop: "1px solid var(--rule)", borderBottom: "1px solid var(--rule)", padding: "40px 56px"}}>
        <div style={{maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 24}}>
          {[
            { k: "Partner hospital", v: "Shifa El Tagamoa", s: "Clinical partner since 2024" },
            { k: "Licensed with", v: "Egyptian Medical Syndicate", s: "Every specialist verified" },
            { k: "Data", v: "Encrypted · GDPR", s: "End-to-end, delete anytime" },
            { k: "Payment", v: "Paymob secure", s: "EGP, USD, AED, SAR, EUR, GBP" },
          ].map((t, i) => (
            <div key={i}>
              <div style={{fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--muted)", fontWeight: 700, marginBottom: 6}}>{t.k}</div>
              <div style={{fontSize: 15, fontWeight: 600, marginBottom: 3}}>{t.v}</div>
              <div style={{fontSize: 12, color: "var(--muted)"}}>{t.s}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Pricing */}
      <div style={{maxWidth: 1180, margin: "0 auto", padding: "60px 56px 80px"}}>
        <div style={{fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--accent-dark)", fontWeight: 700, marginBottom: 12}}>Pricing</div>
        <h2 style={{fontFamily: "var(--font-display)", fontSize: 40, fontWeight: 500, letterSpacing: "-0.005em", margin: "0 0 10px", lineHeight: 1.15}}>
          One fee. No insurance forms. Full refund if we can't help.
        </h2>
        <p style={{fontSize: 15, color: "var(--ink-2)", maxWidth: 640, lineHeight: 1.6, marginBottom: 36}}>Paid upfront, held safely. If no specialist accepts within 48 hours, the fee is returned in full.</p>
        <div style={{display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14}}>
          {[
            { t: "Standard", p: "EGP 1,200", s: "Single specialty · 72h turnaround · Written opinion in AR or EN" },
            { t: "Priority", p: "EGP 2,000", s: "Single specialty · 24–48h · Two rounds of follow-up questions", recommended: true },
            { t: "Complex", p: "EGP 3,000", s: "Multi-specialty review · 72h · Up to three consultant signatures" },
          ].map((p, i) => (
            <div key={i} style={{padding: "24px 22px 28px", background: p.recommended ? "#FFF" : "#FFFEFB", border: p.recommended ? "2px solid var(--primary)" : "1px solid var(--rule)", borderRadius: 16, position: "relative"}}>
              {p.recommended && <div style={{position: "absolute", top: -10, left: 22, background: "var(--primary)", color: "#F2E4C7", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, padding: "4px 10px", borderRadius: 999}}>Most patients</div>}
              <div style={{fontSize: 14, fontWeight: 600, color: "var(--ink-2)", marginBottom: 10}}>{p.t}</div>
              <div className="p-num" style={{fontFamily: "var(--font-display)", fontSize: 44, fontWeight: 500, color: "var(--accent-dark)", letterSpacing: "-0.01em", lineHeight: 1}}>{p.p}</div>
              <div style={{fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginTop: 14, marginBottom: 20}}>{p.s}</div>
              <button className={"p-btn " + (p.recommended ? "p-btn--primary" : "p-btn--secondary") + " p-btn--block"}>Start a case</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- AUTH ----------
function Auth({ mode = "login" }) {
  return (
    <div style={{minHeight: "100vh", background: "var(--bg)", display: "grid", gridTemplateColumns: "1fr 1fr"}}>
      <div style={{padding: "48px 56px", display: "flex", flexDirection: "column", justifyContent: "center", maxWidth: 520, margin: "0 auto", width: "100%"}}>
        <div style={{display: "flex", alignItems: "center", gap: 10, marginBottom: 48}}>
          <div className="p-sidebar__tile" style={{width: 34, height: 34, fontSize: 20, borderRadius: 9}}>ت</div>
          <div style={{fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em"}}>Tashkheesa</div>
        </div>
        <h1 style={{fontFamily: "var(--font-display)", fontSize: 40, fontWeight: 500, letterSpacing: "-0.005em", margin: "0 0 10px", lineHeight: 1.1}}>
          {mode === "login" ? "Welcome back." : "Create your account."}
        </h1>
        <p style={{fontSize: 15, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 32}}>
          {mode === "login" ? "Pick up where you left off." : "Start your first second opinion. Takes about 8 minutes."}
        </p>
        <div className="stack" style={{gap: 14, marginBottom: 20}}>
          {mode === "signup" && <div className="p-field"><label className="p-field__label">Your name</label><input className="p-field__input" placeholder="Amira Hassan" /></div>}
          <div className="p-field"><label className="p-field__label">Email or phone</label><input className="p-field__input" placeholder="you@example.com" /></div>
          <div className="p-field"><label className="p-field__label">Password</label><input className="p-field__input" type="password" placeholder="••••••••" /></div>
          {mode === "login" && <div style={{fontSize: 12, color: "var(--primary)", marginTop: -6, fontWeight: 600, cursor: "pointer"}}>Forgot password?</div>}
        </div>
        <button className="p-btn p-btn--primary p-btn--lg p-btn--block">{mode === "login" ? "Sign in" : "Create account"}</button>
        <div style={{display: "flex", alignItems: "center", gap: 12, margin: "20px 0", color: "var(--muted)", fontSize: 12}}>
          <div style={{flex: 1, height: 1, background: "var(--rule)"}}></div>
          or
          <div style={{flex: 1, height: 1, background: "var(--rule)"}}></div>
        </div>
        <button className="p-btn p-btn--secondary p-btn--block" style={{marginBottom: 10}}><Icon name="globe" size={14} />Continue with Google</button>
        <button className="p-btn p-btn--secondary p-btn--block">Continue with Apple</button>
        <div style={{fontSize: 13, color: "var(--muted)", marginTop: 32, textAlign: "center"}}>
          {mode === "login" ? "New to Tashkheesa? " : "Already have an account? "}
          <span style={{color: "var(--primary)", fontWeight: 600, cursor: "pointer"}}>{mode === "login" ? "Create account" : "Sign in"}</span>
        </div>
      </div>
      <div style={{background: "linear-gradient(135deg, #0B6B5F 0%, #074B43 100%)", padding: 56, display: "flex", flexDirection: "column", justifyContent: "space-between", color: "#F8F5EF", position: "relative", overflow: "hidden"}}>
        <div style={{position: "absolute", top: 40, right: 56, fontFamily: "var(--font-display)", fontSize: 180, color: "#B38B3E", opacity: 0.95, lineHeight: 0.8, fontWeight: 500}}>ت</div>
        <div></div>
        <div style={{position: "relative", zIndex: 1}}>
          <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#E6D7B0", fontWeight: 700, marginBottom: 16}}>From a patient</div>
          <div style={{fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 500, lineHeight: 1.3, marginBottom: 20, letterSpacing: "-0.005em", maxWidth: 460}}>
            "I had the CT results for three days and couldn't sleep. Dr. Nour's report arrived in 38 hours and actually told me what to do next. That's worth everything."
          </div>
          <div style={{fontSize: 13, color: "rgba(248,245,239,0.7)"}}>— Mona, 48, Alexandria</div>
          <div style={{marginTop: 40, paddingTop: 24, borderTop: "1px solid rgba(248,245,239,0.15)", display: "flex", gap: 18, fontSize: 11, color: "rgba(248,245,239,0.6)"}}>
            <span><Icon name="shield" size={12} color="#B38B3E" /> Encrypted E2E</span>
            <span><Icon name="check" size={12} color="#B38B3E" /> GDPR-compliant</span>
            <span><Icon name="lock" size={12} color="#B38B3E" /> Files stay yours</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- UPLOAD FOCUS (validation feedback) ----------
function UploadFocus({ sidebarVariant = "dark", trustDensity = "medium" }) {
  return (
    <div className="p-app">
      <PSidebar active="new_case" variant={sidebarVariant} trustDensity={trustDensity} />
      <main className="p-main">
        <PTopbar title="Upload your documents" sub="Scans, labs, prior reports — as many as you have." />
        <div style={{display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18, maxWidth: 1040}}>
          <div className="stack" style={{gap: 16}}>
            {/* Dropzone with 3 live states shown side by side for demonstration */}
            <div className="p-card" style={{padding: 0}}>
              <div className="p-card__header"><div className="p-card__title">Your files</div><div className="p-card__sub">We organize them so your doctor can move fast</div></div>
              <div className="p-card__body" style={{padding: 14, display: "flex", flexDirection: "column", gap: 10}}>
                {/* Uploading */}
                <div style={{display: "grid", gridTemplateColumns: "36px 1fr auto", gap: 12, alignItems: "center", padding: 12, border: "1px solid var(--rule)", borderRadius: 10, background: "#fff"}}>
                  <div style={{width: 36, height: 36, borderRadius: 9, background: "var(--primary-light)", color: "var(--primary-dark)", display: "flex", alignItems: "center", justifyContent: "center"}}><Icon name="activity" size={16} /></div>
                  <div>
                    <div style={{fontSize: 13, fontWeight: 500}}>CT chest — contrast, axial.dcm</div>
                    <div style={{fontSize: 11, color: "var(--muted)", marginTop: 4}}>Uploading… 124 MB of 184 MB</div>
                    <div style={{marginTop: 8, height: 4, borderRadius: 2, background: "var(--surface-sunk)", overflow: "hidden"}}><div style={{width: "67%", height: "100%", background: "var(--primary)"}}></div></div>
                  </div>
                  <button className="p-btn p-btn--ghost p-btn--sm"><Icon name="x" size={14} /></button>
                </div>

                {/* Accepted */}
                <div style={{display: "grid", gridTemplateColumns: "36px 1fr auto", gap: 12, alignItems: "center", padding: 12, border: "1px solid var(--rule)", borderRadius: 10, background: "#fff"}}>
                  <div style={{width: 36, height: 36, borderRadius: 9, background: "var(--primary-light)", color: "var(--primary-dark)", display: "flex", alignItems: "center", justifyContent: "center"}}><Icon name="file" size={16} /></div>
                  <div>
                    <div style={{fontSize: 13, fontWeight: 500}}>Radiology report — Dar Al Fouad.pdf</div>
                    <div style={{fontSize: 11, color: "var(--muted)", marginTop: 2}}>Report · 412 KB · <span style={{color: "var(--success)"}}>✓ Readable</span></div>
                  </div>
                  <button className="p-btn p-btn--ghost p-btn--sm"><Icon name="x" size={14} /></button>
                </div>

                {/* Checking (AI validation — quietly worded) */}
                <div style={{display: "grid", gridTemplateColumns: "36px 1fr auto", gap: 12, alignItems: "center", padding: 12, border: "1px solid var(--rule)", borderRadius: 10, background: "#FBF9F4"}}>
                  <div style={{width: 36, height: 36, borderRadius: 9, background: "var(--accent-light)", color: "var(--accent-dark)", display: "flex", alignItems: "center", justifyContent: "center"}}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="8" strokeDasharray="12 8"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>
                  </div>
                  <div>
                    <div style={{fontSize: 13, fontWeight: 500}}>Prior imaging — Oct 2025.pdf</div>
                    <div style={{fontSize: 11, color: "var(--accent-dark)", marginTop: 2}}>Checking file is complete and readable…</div>
                  </div>
                </div>

                {/* Rejected — gentle */}
                <div style={{display: "grid", gridTemplateColumns: "36px 1fr auto", gap: 12, alignItems: "flex-start", padding: 14, border: "1px solid #E8D4A8", borderRadius: 10, background: "#FAF1DD"}}>
                  <div style={{width: 36, height: 36, borderRadius: 9, background: "#F2E4C7", color: "#8E6C2C", display: "flex", alignItems: "center", justifyContent: "center"}}><Icon name="alert" size={16} /></div>
                  <div>
                    <div style={{fontSize: 13, fontWeight: 600, color: "#3E2E0D"}}>This file is missing some pages.</div>
                    <div style={{fontSize: 12, color: "#6B5A30", marginTop: 4, lineHeight: 1.55}}>We couldn't read pages 4–7 of <span style={{fontFamily: "var(--font-mono)", fontSize: 11.5}}>lab_panel_march.pdf</span>. Your specialist may ask for a clearer copy. If you don't have one, submit as-is — the doctor will let you know.</div>
                    <div style={{display: "flex", gap: 8, marginTop: 10}}>
                      <button className="p-btn p-btn--secondary p-btn--sm">Replace file</button>
                      <button className="p-btn p-btn--ghost p-btn--sm">Keep as-is</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div style={{border: "2px dashed var(--rule-strong)", borderRadius: 14, padding: 36, textAlign: "center", background: "#FBF9F4"}}>
              <Icon name="upload" size={22} color="var(--primary-dark)" />
              <div style={{fontSize: 14, fontWeight: 600, marginTop: 8}}>Drop more files or click to browse</div>
              <div style={{fontSize: 12, color: "var(--muted)", marginTop: 4}}>PDF, DICOM, JPG, PNG · up to 500 MB each</div>
            </div>
          </div>
          <div className="stack" style={{gap: 14}}>
            <div className="p-card" style={{padding: 18}}>
              <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 10}}>What helps most</div>
              <ul style={{margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10}}>
                {["The original scan files (DICOM if you have them)", "Any prior imaging for comparison", "Lab panels — CBC, liver, tumor markers", "The previous doctor's written report"].map((t, i) => (
                  <li key={i} style={{fontSize: 13, color: "var(--ink-2)", display: "flex", gap: 8, alignItems: "flex-start"}}><Icon name="check" size={14} color="var(--primary)" /><span>{t}</span></li>
                ))}
              </ul>
            </div>
            <div className="p-card" style={{padding: 18, background: "#FBF9F4"}}>
              <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 10}}>Privacy</div>
              <div style={{fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55}}>Files are encrypted end-to-end. Only your assigned specialist can see them. You can delete them anytime, even after your case closes.</div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ---------- MESSAGING FOCUS ----------
function MessagingFocus({ sidebarVariant = "dark", trustDensity = "medium" }) {
  return (
    <div className="p-app">
      <PSidebar active="dashboard" variant={sidebarVariant} trustDensity={trustDensity} unread={2} />
      <main className="p-main" style={{maxWidth: 1100}}>
        <div style={{fontSize: 12, color: "var(--muted)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6}}>
          <span>Home</span><Icon name="chevR" size={10} /><span>Case TSH-2025-001284</span><Icon name="chevR" size={10} /><span>Messages</span>
        </div>
        <div className="p-card" style={{display: "grid", gridTemplateColumns: "1fr 300px", minHeight: 620}}>
          <div style={{padding: 20, display: "flex", flexDirection: "column"}}>
            <div style={{borderBottom: "1px solid var(--rule)", paddingBottom: 14, marginBottom: 16, display: "flex", alignItems: "center", gap: 12}}>
              <div style={{width: 44, height: 44, borderRadius: 12, background: "linear-gradient(135deg, #E8F3F1, #D4E9E5)", color: "var(--primary-dark)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 600}}>RE</div>
              <div style={{flex: 1}}>
                <div style={{fontSize: 14.5, fontWeight: 600}}>Dr. Rania El Radi</div>
                <div style={{fontSize: 12, color: "var(--muted)"}}>Consultant Radiologist · Replies in ~2h</div>
              </div>
              <span className="p-chip p-chip--green"><span style={{width: 6, height: 6, borderRadius: 999, background: "var(--success)"}}></span>Online</span>
            </div>

            <div style={{fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600, textAlign: "center", padding: "10px 0"}}>Tuesday 19 April</div>

            <div style={{flex: 1, display: "flex", flexDirection: "column", gap: 10}}>
              {PDATA.messages.map((m, i) => (
                <div key={i} style={{display: "flex", flexDirection: "column", alignItems: m.who === "me" ? "flex-end" : "flex-start"}}>
                  <div className={`bubble bubble--${m.who}`}>
                    {m.text}
                  </div>
                  <div style={{fontSize: 10.5, color: "var(--muted)", marginTop: 4, padding: "0 4px"}}>{m.time}</div>
                </div>
              ))}
            </div>

            <div style={{marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--rule)", display: "flex", gap: 8, alignItems: "flex-end"}}>
              <button className="p-btn p-btn--ghost p-btn--sm" style={{padding: 10, borderRadius: 10}}><Icon name="upload" size={16} /></button>
              <div style={{flex: 1}}>
                <textarea className="p-field__textarea" rows={2} placeholder="Write a reply… Dr. Rania usually replies within 2 hours." style={{resize: "none"}}></textarea>
              </div>
              <button className="p-btn p-btn--primary"><Icon name="send" size={14} />Send</button>
            </div>
          </div>

          <div style={{borderLeft: "1px solid var(--rule)", padding: 20, background: "#FBF9F4"}}>
            <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 12}}>This case</div>
            <div style={{fontSize: 13, fontWeight: 600, lineHeight: 1.4, marginBottom: 4}}>Staging CT — suspected metastatic disease</div>
            <div style={{fontSize: 11.5, color: "var(--muted)", marginBottom: 16}}>Radiology · 7 files · submitted 18 Apr</div>
            <button className="p-btn p-btn--ghost p-btn--sm" style={{width: "100%", justifyContent: "flex-start", padding: 0, marginBottom: 14}}>Open case →</button>

            <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, margin: "20px 0 10px", paddingTop: 14, borderTop: "1px solid var(--rule)"}}>Safety</div>
            <div style={{fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 10}}>Messages are not monitored in real time. For emergencies, call <strong>123</strong> (Egypt) or your local emergency line.</div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ---------- REPORT VIEW ----------
function ReportView({ sidebarVariant = "dark", trustDensity = "medium" }) {
  return (
    <div className="p-app">
      <PSidebar active="dashboard" variant={sidebarVariant} trustDensity={trustDensity} />
      <main className="p-main" style={{maxWidth: 960, margin: "0 auto"}}>
        <div style={{fontSize: 12, color: "var(--muted)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6}}>
          <span>Home</span><Icon name="chevR" size={10} /><span>Case TSH-2025-001284</span><Icon name="chevR" size={10} /><span>Report</span>
        </div>

        <div style={{background: "linear-gradient(180deg, #E8F3F1 0%, transparent 100%)", border: "1px solid #C5DFDB", borderRadius: 14, padding: "24px 28px", marginBottom: 18, display: "grid", gridTemplateColumns: "1fr auto", gap: 20, alignItems: "center"}}>
          <div>
            <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--primary-dark)", fontWeight: 700, marginBottom: 8}}>Your report is ready</div>
            <div style={{fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 500, letterSpacing: "-0.005em", margin: "0 0 8px", lineHeight: 1.2}}>
              Dr. Rania El Radi has completed your second opinion.
            </div>
            <div style={{fontSize: 13, color: "var(--ink-2)"}}>Delivered Thu 21 Apr · 18:42 · 2 pages · Arabic</div>
          </div>
          <div style={{display: "flex", gap: 8}}>
            <button className="p-btn p-btn--primary"><Icon name="download" size={14} />Download PDF</button>
          </div>
        </div>

        <div className="p-card" style={{padding: "36px 40px", marginBottom: 18}}>
          <div style={{textAlign: "center", paddingBottom: 24, marginBottom: 24, borderBottom: "1px solid var(--rule)"}}>
            <div className="p-sidebar__tile" style={{width: 40, height: 40, fontSize: 22, margin: "0 auto 10px"}}>ت</div>
            <div style={{fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 500, letterSpacing: "-0.005em"}}>Medical Second Opinion</div>
            <div style={{fontSize: 11.5, color: "var(--muted)", marginTop: 4, fontFamily: "var(--font-mono)"}}>TSH-2025-001284 · Issued 21 April 2026</div>
          </div>

          <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, paddingBottom: 24, marginBottom: 24, borderBottom: "1px solid var(--rule)", fontSize: 12.5}}>
            <div><div style={{fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--muted)", fontWeight: 700}}>Patient</div><div style={{marginTop: 4}}>Amira Hassan, 42 · Cairo</div></div>
            <div><div style={{fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--muted)", fontWeight: 700}}>Consulting specialist</div><div style={{marginTop: 4}}>Dr. Rania El Radi, MD, FRCR · Consultant Radiologist, Shifa El Tagamoa</div></div>
          </div>

          {[
            { h: "Clinical question", b: "Second-read of a staging CT chest (14 April 2026) performed at Dar Al Fouad Hospital, with a finding suspicious for metastatic disease. Patient seeks confirmation prior to initiating systemic therapy." },
            { h: "Files reviewed", b: "CT chest with contrast (axial + coronal), prior CT from October 2025, CBC and liver panel, tumor markers (CEA, CA 19-9), outside radiology report." },
            { h: "Findings", b: "Single 11 mm nodule in the right upper lobe with mild spiculation, unchanged in size from the October 2025 study. No hilar or mediastinal lymphadenopathy. Liver and adrenals are clear. CEA and CA 19-9 within normal range." },
            { h: "Impression", b: "The lesion is stable over six months and lacks features typical of active metastatic disease. Findings are more consistent with a benign sub-pleural nodule than with metastasis." },
            { h: "Recommendation", b: "Short-interval follow-up CT in 3 months is reasonable. Biopsy is not indicated at this time. I would not recommend starting chemotherapy on this imaging alone. Suggest discussion with the treating oncologist in light of these findings." },
          ].map((s, i) => (
            <div key={i} style={{marginBottom: 20}}>
              <div style={{fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--primary-dark)", fontWeight: 700, marginBottom: 8}}>{s.h}</div>
              <div style={{fontSize: 14, lineHeight: 1.7, color: "var(--ink)"}}>{s.b}</div>
            </div>
          ))}

          <div style={{marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--rule)", display: "flex", justifyContent: "space-between", alignItems: "flex-end"}}>
            <div>
              <div style={{fontFamily: "var(--font-display)", fontSize: 22, fontStyle: "italic", color: "var(--primary-dark)"}}>Rania El Radi</div>
              <div style={{fontSize: 11.5, color: "var(--muted)", marginTop: 4}}>Consultant Radiologist · Egyptian Medical Syndicate #214823</div>
            </div>
            <div style={{fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--accent-dark)", fontWeight: 700}}>Signed electronically</div>
          </div>
        </div>

        <div style={{padding: 18, background: "#FBF9F4", border: "1px solid var(--rule)", borderRadius: 14, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.6}}>
          <strong style={{color: "var(--ink)"}}>A written opinion is not treatment.</strong> Share this report with your treating doctor — they know your full medical picture and can act on these findings. Tashkheesa specialists do not prescribe or initiate care.
        </div>
      </main>
    </div>
  );
}

// ---------- LOWER-FI: profile, history, notifications, states ----------
function ProfileSettings({ sidebarVariant = "dark", trustDensity = "medium" }) {
  return (
    <div className="p-app">
      <PSidebar active="profile" variant={sidebarVariant} trustDensity={trustDensity} />
      <main className="p-main" style={{maxWidth: 820}}>
        <PTopbar title="Your profile" sub="Keep your details up to date for faster care." />
        <div className="stack" style={{gap: 14}}>
          <div className="p-card">
            <div className="p-card__header"><div className="p-card__title">Personal</div></div>
            <div className="p-card__body" style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14}}>
              <div className="p-field"><label className="p-field__label">Full name</label><input className="p-field__input" defaultValue="Amira Hassan" /></div>
              <div className="p-field"><label className="p-field__label">Date of birth</label><input className="p-field__input" defaultValue="12 / 03 / 1983" /></div>
              <div className="p-field"><label className="p-field__label">Email</label><input className="p-field__input" defaultValue="amira.hassan@example.com" /></div>
              <div className="p-field"><label className="p-field__label">Phone</label><input className="p-field__input" defaultValue="+20 100 482 1974" /></div>
              <div className="p-field"><label className="p-field__label">Preferred language</label><select className="p-field__select"><option>Arabic</option><option>English</option></select></div>
              <div className="p-field"><label className="p-field__label">Location</label><input className="p-field__input" defaultValue="Cairo, Egypt" /></div>
            </div>
          </div>
          {[
            { t: "Security", s: "Password · two-step sign-in · active devices" },
            { t: "Notifications", s: "Email, SMS, WhatsApp · which updates you want" },
            { t: "Billing", s: "Saved payment methods · past receipts" },
            { t: "Privacy & data", s: "Download a copy · delete account · GDPR controls" },
          ].map((s, i) => (
            <div key={i} className="p-card" style={{padding: 18, display: "grid", gridTemplateColumns: "1fr auto", gap: 14, alignItems: "center"}}>
              <div>
                <div style={{fontSize: 15, fontWeight: 600}}>{s.t}</div>
                <div style={{fontSize: 12.5, color: "var(--muted)", marginTop: 4}}>{s.s}</div>
              </div>
              <Icon name="chevR" size={14} color="var(--muted)" />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

function CaseHistory({ sidebarVariant = "dark", trustDensity = "medium" }) {
  return (
    <div className="p-app">
      <PSidebar active="cases" variant={sidebarVariant} trustDensity={trustDensity} />
      <main className="p-main">
        <PTopbar title="Your cases" sub="All second opinions, past and present." />
        <div className="p-card">
          <div style={{padding: "10px 18px", borderBottom: "1px solid var(--rule)", display: "grid", gridTemplateColumns: "140px 1fr 180px 120px 80px", gap: 14, fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--muted)", fontWeight: 700}}>
            <span>Case</span><span>About</span><span>Specialist</span><span>Fee</span><span>Status</span>
          </div>
          {PDATA.caseHistory.map((c, i) => (
            <div key={i} style={{padding: "16px 18px", borderBottom: i < PDATA.caseHistory.length-1 ? "1px solid var(--rule)" : "none", display: "grid", gridTemplateColumns: "140px 1fr 180px 120px 80px", gap: 14, alignItems: "center", cursor: "pointer"}}>
              <div>
                <div style={{fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--muted)"}}>{c.id}</div>
                <div style={{fontSize: 11.5, color: "var(--muted)", marginTop: 3}}>{c.date}</div>
              </div>
              <div style={{fontSize: 13.5, fontWeight: 500}}>{c.title}</div>
              <div style={{fontSize: 12.5, color: "var(--ink-2)"}}>{c.doctor}</div>
              <div className="p-num" style={{fontSize: 13, fontWeight: 600, color: "var(--accent-dark)"}}>{c.fee}</div>
              <span className={"p-chip " + (c.status === "Completed" ? "p-chip--green" : "p-chip--teal")}>{c.status}</span>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

function NotificationsDropdown() {
  return (
    <div style={{position: "relative", padding: 40, background: "var(--bg)", minHeight: 500}}>
      <div style={{position: "absolute", top: 32, right: 40, width: 360, background: "#fff", border: "1px solid var(--rule)", borderRadius: 14, boxShadow: "0 12px 40px rgba(15,30,45,0.12)"}}>
        <div style={{padding: "14px 16px", borderBottom: "1px solid var(--rule)", display: "flex", alignItems: "center"}}>
          <div style={{fontSize: 14, fontWeight: 600, flex: 1}}>Updates</div>
          <span style={{fontSize: 11, color: "var(--primary)", fontWeight: 600, cursor: "pointer"}}>Mark all read</span>
        </div>
        {[
          { k: "new", t: "Dr. Rania replied to your message", s: "\"Perfect, that's enough to work with…\"", time: "4m ago", icon: "message" },
          { k: "new", t: "Your specialist has been assigned", s: "Dr. Rania El Radi · Consultant Radiologist · Shifa El Tagamoa", time: "2h ago", icon: "check" },
          { k: "", t: "Case TSH-2025-001284 submitted", s: "7 files uploaded · payment received", time: "Mon 18 Apr", icon: "file" },
          { k: "", t: "Welcome to Tashkheesa", s: "Quick tour: how second opinions work here", time: "Mon 18 Apr", icon: "heart" },
        ].map((n, i) => (
          <div key={i} style={{padding: "14px 16px", borderBottom: i < 3 ? "1px solid var(--rule)" : "none", display: "grid", gridTemplateColumns: "32px 1fr", gap: 12, cursor: "pointer", background: n.k === "new" ? "#FBF9F4" : "#fff"}}>
            <div style={{width: 32, height: 32, borderRadius: 8, background: n.k === "new" ? "var(--accent-light)" : "var(--primary-light)", color: n.k === "new" ? "var(--accent-dark)" : "var(--primary-dark)", display: "flex", alignItems: "center", justifyContent: "center"}}>
              <Icon name={n.icon} size={14} />
            </div>
            <div>
              <div style={{fontSize: 13, fontWeight: n.k === "new" ? 600 : 500, lineHeight: 1.4}}>{n.t}</div>
              <div style={{fontSize: 12, color: "var(--muted)", marginTop: 3, lineHeight: 1.45}}>{n.s}</div>
              <div style={{fontSize: 10.5, color: "var(--muted)", marginTop: 6, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 600}}>{n.time}</div>
            </div>
          </div>
        ))}
        <div style={{padding: "10px 16px", borderTop: "1px solid var(--rule)", textAlign: "center"}}>
          <span style={{fontSize: 12, color: "var(--muted)"}}>You also get these by email and WhatsApp</span>
        </div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="p-app">
      <PSidebar active="dashboard" variant="dark" />
      <main className="p-main">
        <div style={{height: 28, width: 240, background: "var(--surface-sunk)", borderRadius: 6, marginBottom: 22, animation: "sk 1.5s infinite"}}></div>
        <div className="p-card" style={{padding: 24, marginBottom: 18}}>
          <div style={{height: 14, width: 120, background: "var(--surface-sunk)", borderRadius: 4, marginBottom: 14}}></div>
          <div style={{height: 22, width: "70%", background: "var(--surface-sunk)", borderRadius: 6, marginBottom: 10}}></div>
          <div style={{height: 14, width: "50%", background: "var(--surface-sunk)", borderRadius: 4}}></div>
        </div>
        <div style={{display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14}}>
          {[0,1,2].map(i => <div key={i} className="p-card" style={{height: 140}}></div>)}
        </div>
        <style>{`@keyframes sk { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
      </main>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="p-app">
      <PSidebar active="dashboard" variant="dark" />
      <main className="p-main" style={{maxWidth: 560, margin: "64px auto 0"}}>
        <div style={{textAlign: "center"}}>
          <div style={{width: 64, height: 64, margin: "0 auto 20px", borderRadius: 18, background: "#FBECDF", color: "#C2410C", display: "flex", alignItems: "center", justifyContent: "center"}}>
            <Icon name="alert" size={28} />
          </div>
          <h1 style={{fontFamily: "var(--font-display)", fontSize: 30, fontWeight: 500, margin: "0 0 10px"}}>Something on our side broke.</h1>
          <p style={{fontSize: 14, color: "var(--ink-2)", lineHeight: 1.6, marginBottom: 24}}>We couldn't load your case just now. Your files and progress are safe — this is only a display issue.</p>
          <div style={{display: "flex", gap: 10, justifyContent: "center"}}>
            <button className="p-btn p-btn--primary">Try again</button>
            <button className="p-btn p-btn--ghost">Contact support</button>
          </div>
          <div style={{fontSize: 11.5, color: "var(--muted)", marginTop: 24, fontFamily: "var(--font-mono)"}}>Error ref: TSH-E-08241</div>
        </div>
      </main>
    </div>
  );
}

Object.assign(window, { Landing, Auth, UploadFocus, MessagingFocus, ReportView, ProfileSettings, CaseHistory, NotificationsDropdown, LoadingState, ErrorState });
