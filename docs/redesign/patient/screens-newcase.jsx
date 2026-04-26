// ============================================================
// Tashkheesa Patient Portal — NEW CASE FLOW variants (priority 2)
// Three layout variants:
//   v1  — classic 5-step wizard
//   v2  — 3-step collapsed
//   v3  — single-scroll conversational
// ============================================================

// ----- V1: 5-step wizard, currently on step 2 (documents) -----
function NewCaseV1({ step = 1, sidebarVariant = "dark", trustDensity = "medium" }) {
  const labels = ["Condition", "Documents", "Specialty", "Review", "Payment"];
  return (
    <div className="p-app">
      <PSidebar active="new_case" variant={sidebarVariant} trustDensity={trustDensity} />
      <main className="p-main">
        <PTopbar title="New case" sub="Tell us what's going on — we'll take it from there." />
        <div style={{marginBottom: 28, maxWidth: 720}}>
          <ProgressTrack step={step} total={5} labels={labels} />
        </div>

        {step === 1 && <Step1Condition />}
        {step === 2 && <Step2Documents />}
        {step === 3 && <Step3Specialty />}
        {step === 4 && <Step4Review />}
        {step === 5 && <Step5Payment />}
      </main>
    </div>
  );
}

function Step1Condition() {
  return (
    <div style={{display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18, maxWidth: 1040}}>
      <div className="p-card">
        <div className="p-card__header"><div className="p-card__title">In your own words</div><div className="p-card__sub">One thing at a time · no medical jargon needed</div></div>
        <div className="p-card__body" style={{display: "flex", flexDirection: "column", gap: 18}}>
          <div className="p-field">
            <label className="p-field__label">What's the main concern or diagnosis you'd like a second opinion on?</label>
            <input className="p-field__input" defaultValue="Staging CT suggested possible metastatic disease — want confirmation before starting chemo" />
            <div className="p-field__hint">It's fine to paste exactly what the first doctor said.</div>
          </div>
          <div className="p-field">
            <label className="p-field__label">When did this start? What changed?</label>
            <textarea className="p-field__textarea" rows={4} defaultValue="Unexplained weight loss started late December (about 6 kg in 10 weeks). GP ordered a staging CT on 14 April which showed a suspicious lung finding. I'd like a radiologist's second read before treatment." />
          </div>
          <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14}}>
            <div className="p-field">
              <label className="p-field__label">Your age</label>
              <input className="p-field__input" defaultValue="42" />
            </div>
            <div className="p-field">
              <label className="p-field__label">Preferred language for the report</label>
              <select className="p-field__select" defaultValue="ar"><option value="ar">Arabic</option><option value="en">English</option><option value="both">Both</option></select>
            </div>
          </div>
        </div>
      </div>
      <div className="stack">
        <ReassureCard />
        <div className="p-card" style={{padding: 18}}>
          <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--accent-dark)", fontWeight: 700, marginBottom: 6}}>One moment</div>
          <div style={{fontSize: 13.5, lineHeight: 1.55, color: "var(--ink-2)"}}>You can save and come back anytime. Nothing is submitted until the final step.</div>
        </div>
        <div style={{display: "flex", justifyContent: "flex-end", gap: 10}}>
          <button className="p-btn p-btn--ghost">Save draft</button>
          <button className="p-btn p-btn--primary">Continue<Icon name="chevR" size={14} /></button>
        </div>
      </div>
    </div>
  );
}

function Step2Documents() {
  return (
    <div style={{display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18, maxWidth: 1040}}>
      <div className="stack">
        <div className="p-card">
          <div className="p-card__header"><div className="p-card__title">Upload your documents</div><div className="p-card__sub">Scans, labs, prior reports, referral letters</div></div>
          <div className="p-card__body">
            <div style={{border: "2px dashed var(--rule-strong)", borderRadius: 14, padding: 44, textAlign: "center", background: "#FBF9F4"}}>
              <div style={{width: 48, height: 48, margin: "0 auto 12px", borderRadius: 12, background: "var(--primary-light)", color: "var(--primary-dark)", display: "flex", alignItems: "center", justifyContent: "center"}}><Icon name="upload" size={22} /></div>
              <div style={{fontSize: 15, fontWeight: 600, marginBottom: 4}}>Drop files here or click to browse</div>
              <div style={{fontSize: 12.5, color: "var(--muted)"}}>PDF, DICOM, JPG, PNG · up to 500 MB per file · as many as you need</div>
            </div>
          </div>
        </div>

        <div className="p-card">
          <div className="p-card__header">
            <div className="p-card__title">Uploaded so far</div>
            <div className="p-card__sub">7 files · 276 MB · organized by type</div>
            <div className="spacer" />
            <span className="p-chip p-chip--green"><Icon name="check" size={10} />All accepted</span>
          </div>
          <div className="p-card__body" style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10}}>
            {PDATA.files.map((f, i) => (
              <div key={i} className="file-tile" style={{position: "relative"}}>
                <div className="file-tile__icon"><Icon name="file" size={16} /></div>
                <div style={{flex: 1, minWidth: 0}}>
                  <div className="file-tile__name" style={{whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>{f.name}</div>
                  <div className="file-tile__meta">{f.type} · {f.size} · <span style={{color: "var(--success)"}}>✓ Readable</span></div>
                </div>
                <button className="p-btn p-btn--ghost p-btn--sm"><Icon name="x" size={14} /></button>
              </div>
            ))}
          </div>
        </div>

        {/* The "validation feedback" moment — one file flagged */}
        <div className="p-card" style={{borderColor: "#E6D7B0", background: "#FAF1DD"}}>
          <div className="p-card__body" style={{display: "flex", gap: 14, alignItems: "flex-start"}}>
            <div style={{width: 36, height: 36, borderRadius: 10, background: "#F2E4C7", color: "#8E6C2C", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0}}><Icon name="alert" size={18} /></div>
            <div style={{flex: 1}}>
              <div style={{fontSize: 14, fontWeight: 600, color: "#3E2E0D"}}>One file looks incomplete — <span style={{fontFamily: "var(--font-mono)", fontSize: 12.5}}>prior_imaging_oct2025.pdf</span></div>
              <div style={{fontSize: 13, color: "#6B5A30", marginTop: 4, lineHeight: 1.55}}>
                We couldn't read all pages. Your specialist may ask for a clearer copy — if you have one, replacing it now will save time. If not, submit as-is and the doctor will let you know.
              </div>
              <div style={{display: "flex", gap: 10, marginTop: 10}}>
                <button className="p-btn p-btn--secondary p-btn--sm">Replace file</button>
                <button className="p-btn p-btn--ghost p-btn--sm">Keep as-is</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="stack">
        <ReassureCard />
        <div className="p-card" style={{padding: 18}}>
          <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, marginBottom: 8}}>Privacy</div>
          <div style={{display: "flex", flexDirection: "column", gap: 8, fontSize: 13, color: "var(--ink-2)"}}>
            <div style={{display: "flex", alignItems: "center", gap: 8}}><Icon name="shield" size={14} color="var(--primary)" />Files are encrypted end-to-end</div>
            <div style={{display: "flex", alignItems: "center", gap: 8}}><Icon name="eye" size={14} color="var(--primary)" />Only your assigned doctor sees them</div>
            <div style={{display: "flex", alignItems: "center", gap: 8}}><Icon name="check" size={14} color="var(--primary)" />GDPR-compliant · delete anytime</div>
          </div>
        </div>
        <div style={{display: "flex", justifyContent: "space-between", gap: 10}}>
          <button className="p-btn p-btn--ghost"><Icon name="chevL" size={14} />Back</button>
          <button className="p-btn p-btn--primary">Continue<Icon name="chevR" size={14} /></button>
        </div>
      </div>
    </div>
  );
}

function Step3Specialty() {
  return (
    <div style={{display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18, maxWidth: 1040}}>
      <div className="p-card">
        <div className="p-card__header"><div className="p-card__title">Which area fits best?</div><div className="p-card__sub">If unsure, pick "Not sure" — we'll route you correctly.</div></div>
        <div className="p-card__body" style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10}}>
          {PDATA.specialties.map((s, i) => (
            <div key={i} style={{
              border: s.key === "radiology" ? "2px solid var(--primary)" : "1px solid var(--rule)",
              background: s.key === "radiology" ? "var(--primary-light)" : "#fff",
              borderRadius: 12, padding: 16, cursor: "pointer", position: "relative",
            }}>
              {s.key === "radiology" && <div style={{position: "absolute", top: 10, right: 10, width: 18, height: 18, borderRadius: 999, background: "var(--primary)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center"}}><Icon name="check" size={12} /></div>}
              <div style={{fontSize: 14, fontWeight: 600, color: s.key === "radiology" ? "var(--primary-dark)" : "var(--ink)"}}>{s.name}</div>
              <div style={{fontSize: 12, color: "var(--muted)", marginTop: 4, lineHeight: 1.45}}>{s.sub}</div>
              <div style={{fontSize: 11, color: "var(--muted)", marginTop: 8, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600}}>Typical: {s.files}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="stack">
        <div className="p-card" style={{padding: 20}}>
          <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--accent-dark)", fontWeight: 700, marginBottom: 8}}>How assignment works</div>
          <div style={{fontSize: 13.5, lineHeight: 1.55, color: "var(--ink-2)"}}>
            Once you submit, we match you with a consultant from our Egyptian Medical Syndicate panel based on specialty and current load. You'll see who's assigned within a few hours.
          </div>
        </div>
        <ReassureCard />
        <div style={{display: "flex", justifyContent: "space-between"}}>
          <button className="p-btn p-btn--ghost"><Icon name="chevL" size={14} />Back</button>
          <button className="p-btn p-btn--primary">Continue<Icon name="chevR" size={14} /></button>
        </div>
      </div>
    </div>
  );
}

function Step4Review() {
  return (
    <div style={{display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18, maxWidth: 1040}}>
      <div className="p-card">
        <div className="p-card__header"><div className="p-card__title">Review your case</div><div className="p-card__sub">Check everything looks right before payment.</div></div>
        <div className="p-card__body" style={{display: "flex", flexDirection: "column", gap: 18}}>
          <ReviewRow k="Main concern" v="Staging CT suggested possible metastatic disease — want confirmation before starting chemo" />
          <ReviewRow k="When it started" v="Late December · 6 kg weight loss over 10 weeks · GP ordered staging CT 14 April" />
          <ReviewRow k="Specialty" v="Radiology" />
          <ReviewRow k="Preferred language" v="Arabic" />
          <ReviewRow k="Documents" v="7 files · 276 MB (1 flagged as incomplete — keeping as-is)" />
        </div>
      </div>
      <div className="stack">
        <div className="p-card">
          <div className="p-card__header"><div className="p-card__title">Summary</div></div>
          <div className="p-card__body">
            <div style={{display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13}}><span style={{color: "var(--muted)"}}>Second opinion</span><span>EGP 2,000</span></div>
            <div style={{display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13}}><span style={{color: "var(--muted)"}}>Platform fee</span><span>EGP 0</span></div>
            <div style={{display: "flex", justifyContent: "space-between", padding: "10px 0 0", marginTop: 4, borderTop: "1px solid var(--rule)", fontSize: 14, fontWeight: 600, color: "var(--accent-dark)"}} className="p-num"><span>Total</span><span>EGP 2,000</span></div>
            <div style={{fontSize: 11, color: "var(--muted)", marginTop: 10, lineHeight: 1.5}}>Turnaround 24–72 hours. Full refund if no specialist is available within 48 hours.</div>
          </div>
        </div>
        <div style={{display: "flex", justifyContent: "space-between"}}>
          <button className="p-btn p-btn--ghost"><Icon name="chevL" size={14} />Back</button>
          <button className="p-btn p-btn--primary">Continue to payment<Icon name="chevR" size={14} /></button>
        </div>
      </div>
    </div>
  );
}

function ReviewRow({ k, v }) {
  return (
    <div style={{display: "grid", gridTemplateColumns: "160px 1fr auto", gap: 14, paddingBottom: 14, borderBottom: "1px solid var(--rule)"}}>
      <div style={{fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--muted)", fontWeight: 700, paddingTop: 2}}>{k}</div>
      <div style={{fontSize: 13.5, color: "var(--ink)", lineHeight: 1.5}}>{v}</div>
      <a style={{fontSize: 12, color: "var(--primary)", fontWeight: 600, cursor: "pointer"}}>Edit</a>
    </div>
  );
}

function Step5Payment() {
  return (
    <div style={{display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18, maxWidth: 1040}}>
      <div className="stack">
        <div className="p-card">
          <div className="p-card__header">
            <div className="p-card__title">Payment</div>
            <div className="p-card__sub">Secured by Paymob · Mada, Visa, Mastercard, Apple Pay</div>
          </div>
          <div className="p-card__body" style={{display: "flex", flexDirection: "column", gap: 16}}>
            <div>
              <div className="p-field__label" style={{marginBottom: 8}}>Pay in</div>
              <div style={{display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8}}>
                {PDATA.paymentCurrencies.slice(0,6).map((c, i) => (
                  <div key={i} style={{
                    border: c.primary ? "2px solid var(--primary)" : "1px solid var(--rule)",
                    background: c.primary ? "var(--primary-light)" : "#fff",
                    borderRadius: 10, padding: "10px 12px", cursor: "pointer",
                  }}>
                    <div style={{fontSize: 11, color: "var(--muted)", fontWeight: 600}}>{c.label}</div>
                    <div className="p-num" style={{fontSize: 15, fontWeight: 700, marginTop: 2}}>{c.code} {c.amount}</div>
                    {c.note && <div style={{fontSize: 10.5, color: "var(--primary-dark)", marginTop: 2, fontWeight: 600}}>{c.note}</div>}
                  </div>
                ))}
              </div>
            </div>
            <div className="p-field"><label className="p-field__label">Card number</label><input className="p-field__input" placeholder="1234 5678 9012 3456" /></div>
            <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14}}>
              <div className="p-field"><label className="p-field__label">Expiry</label><input className="p-field__input" placeholder="MM / YY" /></div>
              <div className="p-field"><label className="p-field__label">CVV</label><input className="p-field__input" placeholder="123" /></div>
            </div>
            <div className="p-field"><label className="p-field__label">Name on card</label><input className="p-field__input" defaultValue="Amira Hassan" /></div>
          </div>
        </div>
      </div>
      <div className="stack">
        <div className="p-card">
          <div className="p-card__header"><div className="p-card__title">You're paying</div></div>
          <div className="p-card__body">
            <div className="p-num" style={{fontFamily: "var(--font-display)", fontSize: 36, fontWeight: 500, color: "var(--accent-dark)", letterSpacing: "-0.005em"}}>EGP 2,000</div>
            <div style={{fontSize: 12, color: "var(--muted)", marginTop: 4}}>= USD 41 · AED 150 · approximate</div>
            <div style={{margin: "16px 0", padding: 12, background: "#FBF9F4", borderRadius: 10, fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-2)"}}>
              <div style={{display: "flex", gap: 8, alignItems: "flex-start"}}>
                <Icon name="shield" size={14} color="var(--primary)" />
                <div>Full refund if no specialist is available within 48 hours.</div>
              </div>
            </div>
            <button className="p-btn p-btn--primary p-btn--lg p-btn--block"><Icon name="lock" size={14} />Pay EGP 2,000 securely</button>
            <div style={{fontSize: 11, color: "var(--muted)", marginTop: 10, textAlign: "center"}}>By continuing you accept our <a style={{color: "var(--primary)"}}>terms</a> and <a style={{color: "var(--primary)"}}>privacy policy</a>.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReassureCard() {
  return (
    <div className="p-card" style={{padding: 18, background: "#FBF9F4"}}>
      <div style={{display: "flex", gap: 10, alignItems: "flex-start"}}>
        <div style={{width: 32, height: 32, borderRadius: 8, background: "var(--primary-light)", color: "var(--primary-dark)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0}}><Icon name="heart" size={16} /></div>
        <div>
          <div style={{fontSize: 13.5, fontWeight: 600, lineHeight: 1.4, color: "var(--ink)"}}>You're doing the right thing.</div>
          <div style={{fontSize: 12.5, color: "var(--muted)", marginTop: 4, lineHeight: 1.5}}>A second opinion changes the treatment plan in about 1 in 3 cases. Taking this step matters.</div>
        </div>
      </div>
    </div>
  );
}

// ----- V2: 3-step collapsed -----
function NewCaseV2({ sidebarVariant = "dark", trustDensity = "medium" }) {
  return (
    <div className="p-app">
      <PSidebar active="new_case" variant={sidebarVariant} trustDensity={trustDensity} />
      <main className="p-main">
        <PTopbar title="New case" serif sub="Three quick steps. Save and return anytime." />
        <div style={{marginBottom: 28, maxWidth: 720}}>
          <ProgressTrack step={1} total={3} labels={["Your case", "Documents", "Review & pay"]} />
        </div>
        <div style={{display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18, maxWidth: 1040}}>
          <div className="p-card">
            <div className="p-card__header"><div className="p-card__title">Your case</div><div className="p-card__sub">Condition + specialty in one step</div></div>
            <div className="p-card__body" style={{display: "flex", flexDirection: "column", gap: 18}}>
              <div className="p-field"><label className="p-field__label">What's the main concern or diagnosis?</label><input className="p-field__input" defaultValue="Staging CT — possible metastatic disease" /></div>
              <div className="p-field"><label className="p-field__label">Tell us more, in your own words</label><textarea className="p-field__textarea" rows={4} defaultValue="GP ordered staging CT on 14 April after 10 weeks of unexplained weight loss..." /></div>
              <div className="p-field">
                <label className="p-field__label">Specialty</label>
                <div style={{display: "flex", gap: 8, flexWrap: "wrap"}}>
                  {PDATA.specialties.slice(0,6).map((s,i) => (
                    <div key={i} style={{padding: "8px 14px", borderRadius: 999, border: s.key === "radiology" ? "1px solid var(--primary)" : "1px solid var(--rule)", background: s.key === "radiology" ? "var(--primary-light)" : "#fff", color: s.key === "radiology" ? "var(--primary-dark)" : "var(--ink-2)", fontSize: 12.5, fontWeight: 500, cursor: "pointer"}}>{s.name}</div>
                  ))}
                </div>
                <div className="p-field__hint">Not sure? We'll route you.</div>
              </div>
              <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14}}>
                <div className="p-field"><label className="p-field__label">Your age</label><input className="p-field__input" defaultValue="42" /></div>
                <div className="p-field"><label className="p-field__label">Language for report</label><select className="p-field__select"><option>Arabic</option><option>English</option></select></div>
              </div>
            </div>
          </div>
          <div className="stack">
            <ReassureCard />
            <div style={{display: "flex", justifyContent: "flex-end"}}><button className="p-btn p-btn--primary">Continue<Icon name="chevR" size={14} /></button></div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ----- V3: single-scroll conversational -----
function NewCaseV3({ sidebarVariant = "dark", trustDensity = "medium" }) {
  return (
    <div className="p-app">
      <PSidebar active="new_case" variant={sidebarVariant} trustDensity={trustDensity} />
      <main className="p-main" style={{maxWidth: 720}}>
        <div style={{padding: "16px 0 32px"}}>
          <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--accent-dark)", fontWeight: 700}}>New case</div>
          <h1 style={{fontFamily: "var(--font-display)", fontSize: 38, fontWeight: 500, letterSpacing: "-0.005em", margin: "10px 0 6px", lineHeight: 1.1}}>Tell us what's going on.</h1>
          <p style={{fontSize: 15, color: "var(--ink-2)", lineHeight: 1.55}}>Take it one question at a time. Nothing is submitted until the end.</p>
        </div>

        {[
          { n: "01", q: "What's the main concern you'd like a second opinion on?", placeholder: "e.g. Staging CT suggested possible metastatic disease", val: "Staging CT suggested possible metastatic disease — want confirmation before starting chemo" },
          { n: "02", q: "When did this start? What changed?", textarea: true, val: "Late December — unexplained weight loss of about 6 kg over 10 weeks. GP ordered staging CT on 14 April." },
          { n: "03", q: "Which area fits best?", specialty: true },
        ].map((s, i) => (
          <div key={i} style={{borderLeft: "2px solid var(--primary-light)", paddingLeft: 24, marginBottom: 28, marginLeft: 10, position: "relative"}}>
            <div style={{position: "absolute", left: -14, top: -2, width: 26, height: 26, borderRadius: 999, background: "var(--primary)", color: "#F2E4C7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)"}}>{s.n}</div>
            <div style={{fontSize: 16, fontWeight: 600, lineHeight: 1.4, marginBottom: 10, fontFamily: "var(--font-display)"}}>{s.q}</div>
            {s.specialty ? (
              <div style={{display: "flex", gap: 8, flexWrap: "wrap"}}>
                {PDATA.specialties.map((sp, j) => (
                  <div key={j} style={{padding: "8px 14px", borderRadius: 999, border: sp.key === "radiology" ? "1px solid var(--primary)" : "1px solid var(--rule)", background: sp.key === "radiology" ? "var(--primary-light)" : "#fff", color: sp.key === "radiology" ? "var(--primary-dark)" : "var(--ink-2)", fontSize: 12.5, fontWeight: 500}}>{sp.name}</div>
                ))}
              </div>
            ) : s.textarea ? (
              <textarea className="p-field__textarea" rows={3} defaultValue={s.val} />
            ) : (
              <input className="p-field__input" defaultValue={s.val} />
            )}
          </div>
        ))}

        <div style={{marginTop: 32, padding: 24, background: "#FBF9F4", borderRadius: 14, border: "1px solid var(--rule)"}}>
          <div style={{fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--accent-dark)", fontWeight: 700, marginBottom: 8}}>Next</div>
          <div style={{fontSize: 15, fontWeight: 600, marginBottom: 4}}>Upload your files, then pay.</div>
          <div style={{fontSize: 13, color: "var(--muted)", marginBottom: 16, lineHeight: 1.5}}>Scans, labs, prior reports. We accept PDF, DICOM, JPG.</div>
          <button className="p-btn p-btn--primary p-btn--lg">Continue to upload<Icon name="chevR" size={14} /></button>
        </div>
      </main>
    </div>
  );
}

Object.assign(window, { NewCaseV1, NewCaseV2, NewCaseV3 });
