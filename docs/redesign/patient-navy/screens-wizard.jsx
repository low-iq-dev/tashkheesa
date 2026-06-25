// screens-wizard.jsx — Case submission wizard: who → files (AI analysis) → specialty → urgency → review → payment → done.

const DEPENDENTS = [
  { id: "me", en: "Mariam (you)", ar: "مريم (إنتي)", rel_en: "", rel_ar: "", init: "M" },
  { id: "dad", en: "Samir", ar: "سمير", rel_en: "Father · 64", rel_ar: "بابا · 64", init: "S" },
  { id: "mom", en: "Nadia", ar: "نادية", rel_en: "Mother · 59", rel_ar: "ماما · 59", init: "N" },
];

function WizardScreen() {
  const { t, lang, dir, nav, back, patch, store, showToast } = useApp();
  const STEPS = ["wiz_who", "wiz_files", "wiz_specialty", "wiz_urgency", "wiz_review", "wiz_pay"];
  const [step, setStep] = React.useState(0);
  const [patient, setPatient] = React.useState("me");
  const [files, setFiles] = React.useState([]);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [aiDone, setAiDone] = React.useState(false);
  const [specialty, setSpecialty] = React.useState(null);
  const [focus, setFocus] = React.useState("");
  const [tier, setTier] = React.useState("standard");
  const [payMethod, setPayMethod] = React.useState("card");
  const [paying, setPaying] = React.useState(false);
  const [doneView, setDoneView] = React.useState(false);
  const uid = React.useRef(0);

  const price = tier === "urgent" ? PRICING.urgent : PRICING.standard;

  // simulate an upload with progress
  const addFile = (name, size) => {
    const id = ++uid.current;
    setFiles(f => [...f, { id, name, size, progress: 0 }]);
    const tick = setInterval(() => {
      setFiles(f => f.map(x => x.id === id ? { ...x, progress: Math.min(100, (x.progress || 0) + 14 + Math.random() * 16) } : x));
    }, 130);
    setTimeout(() => { clearInterval(tick); setFiles(f => f.map(x => x.id === id ? { ...x, progress: 100 } : x)); }, 1100);
  };
  const sampleFiles = [
    ["chest_CT_axial.dcm", "12.4 MB"], ["radiology_report.pdf", "240 KB"],
    ["blood_panel_CBC.pdf", "180 KB"], ["referral_note.jpg", "1.1 MB"],
  ];
  const addNext = () => { const n = files.length; if (n < sampleFiles.length) addFile(...sampleFiles[n]); };

  // run AI analysis after files settle
  React.useEffect(() => {
    if (step === 1 && files.length > 0 && files.every(f => f.progress >= 100) && !aiDone && !analyzing) {
      setAnalyzing(true);
      const id = setTimeout(() => { setAnalyzing(false); setAiDone(true); }, 1600);
      return () => clearTimeout(id);
    }
  }, [step, files, aiDone, analyzing]);

  const canNext = () => {
    if (step === 0) return !!patient;
    if (step === 1) return files.length > 0 && files.every(f => f.progress >= 100);
    if (step === 2) return !!specialty;
    return true;
  };

  const goNext = () => {
    if (step < STEPS.length - 1) { setStep(step + 1); document.getElementById("wiz-scroll")?.scrollTo(0, 0); }
  };
  const goBack = () => { if (step > 0) setStep(step - 1); else back(); };

  const submit = () => {
    setPaying(true);
    setTimeout(() => {
      setPaying(false); setDoneView(true);
      const newCase = {
        id: "TK-" + (4830 + Math.floor(Math.random() * 60)), specialty, patient_en: DEPENDENTS.find(d => d.id === patient).en,
        patient_ar: DEPENDENTS.find(d => d.id === patient).ar, status: "submitted", tier,
        filesN: files.length, dueHrs: tier === "urgent" ? 24 : 72, createdEn: "Just now", createdAr: "دلوقتي", doctor: SAMPLE_DOCTOR,
      };
      patch({ cases: [newCase, ...store.cases] });
    }, 1400);
  };

  if (doneView) return <SubmittedView nav={nav} />;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* header with progress */}
      <div style={{ paddingTop: "var(--safe-top)", background: "rgba(8,17,32,0.82)", backdropFilter: "blur(16px)", borderBottom: "1px solid var(--rule-faint)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 16px 12px" }}>
          <button onClick={goBack} style={{ background: "var(--on-navy-faint)", border: "1px solid var(--rule)", cursor: "pointer", width: 36, height: 36, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text)" }}>
            <Ic name={dir === "rtl" ? "chevron-right" : "chevron-left"} size={19} />
          </button>
          <div style={{ flex: 1 }}>
            <WizardProgress steps={STEPS} current={step} />
          </div>
          <span className="num" style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 600 }}>{step + 1}/{STEPS.length}</span>
        </div>
      </div>

      <div id="wiz-scroll" className="app-scroll" style={{ flex: 1, overflowY: "auto", padding: "20px 18px calc(var(--safe-bottom) + 100px)" }}>
        <div key={step}>
          {step === 0 && <StepWho patient={patient} setPatient={setPatient} />}
          {step === 1 && <StepFiles files={files} addNext={addNext} setFiles={setFiles} analyzing={analyzing} aiDone={aiDone} focus={focus} setFocus={setFocus} />}
          {step === 2 && <StepSpecialty specialty={specialty} setSpecialty={setSpecialty} aiDone={aiDone} />}
          {step === 3 && <StepUrgency tier={tier} setTier={setTier} />}
          {step === 4 && <StepReview {...{ patient, files, specialty, tier, focus, price }} onEdit={setStep} />}
          {step === 5 && <StepPay payMethod={payMethod} setPayMethod={setPayMethod} price={price} />}
        </div>
      </div>

      {/* footer CTA */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "14px 18px calc(14px + var(--safe-bottom))", background: "rgba(8,17,32,0.92)", backdropFilter: "blur(16px)", borderTop: "1px solid var(--rule)" }}>
        {step === 5 ? (
          <Btn variant="primary" size="lg" full loading={paying} icon="lock" onClick={submit}>{t("pay_now")} · {money(price, lang)}</Btn>
        ) : (
          <Btn variant="primary" size="lg" full disabled={!canNext()} iconRight={dir === "rtl" ? "arrow-left" : "arrow-right"} onClick={goNext}>{t("continue")}</Btn>
        )}
      </div>
    </div>
  );
}

function StepTitle({ title, sub }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h1 style={{ fontSize: 23, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em", margin: "0 0 7px", textWrap: "balance" }}>{title}</h1>
      {sub && <p style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.55, margin: 0 }}>{sub}</p>}
    </div>
  );
}

function StepWho({ patient, setPatient }) {
  const { t, lang, nav } = useApp();
  return (
    <div>
      <StepTitle title={t("who_title")} />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {DEPENDENTS.map(d => {
          const on = patient === d.id;
          return (
            <button key={d.id} onClick={() => setPatient(d.id)} style={{ display: "flex", alignItems: "center", gap: 13, padding: 14, borderRadius: "var(--r-lg)", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
              background: on ? "var(--teal-tint)" : "var(--surface)", border: `1.5px solid ${on ? "var(--teal)" : "var(--rule)"}`, transition: "all var(--t-base) var(--ease)" }}>
              <div style={{ width: 44, height: 44, borderRadius: "50%", background: on ? "var(--teal)" : "var(--surface-2)", color: on ? "var(--on-teal)" : "var(--text-2)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 17, flexShrink: 0 }}>{d.init}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15.5, fontWeight: 600, color: "var(--text)" }}>{d.id === "me" ? t("who_me") : (lang === "ar" ? d.ar : d.en)}</div>
                {(d.rel_en || d.rel_ar) && <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>{lang === "ar" ? d.rel_ar : d.rel_en}</div>}
              </div>
              <div style={{ width: 22, height: 22, borderRadius: "50%", border: `2px solid ${on ? "var(--teal)" : "var(--rule-strong)"}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {on && <span style={{ width: 11, height: 11, borderRadius: "50%", background: "var(--teal)" }} />}
              </div>
            </button>
          );
        })}
        <button onClick={() => nav("family")} style={{ display: "flex", alignItems: "center", gap: 11, padding: 14, borderRadius: "var(--r-lg)", cursor: "pointer", fontFamily: "inherit", background: "transparent", border: "1.5px dashed var(--rule-strong)", color: "var(--teal)" }}>
          <Ic name="user-plus" size={20} /><span style={{ fontSize: 15, fontWeight: 600 }}>{t("add_dependent")}</span>
        </button>
      </div>
    </div>
  );
}

function StepFiles({ files, addNext, setFiles, analyzing, aiDone, focus, setFocus }) {
  const { t, lang, dir } = useApp();
  return (
    <div>
      <StepTitle title={t("upload_title")} sub={t("upload_sub")} />
      {/* dropzone */}
      <button onClick={addNext} style={{ width: "100%", padding: "26px 16px", borderRadius: "var(--r-lg)", cursor: "pointer", fontFamily: "inherit",
        background: "var(--teal-tint)", border: "1.5px dashed var(--teal)", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <div style={{ width: 46, height: 46, borderRadius: "50%", background: "var(--surface)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Ic name="upload-cloud" size={24} color="var(--teal)" />
        </div>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{t("add_files")}</span>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>PDF · JPG · PNG · DICOM</span>
      </button>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <Btn variant="secondary" size="sm" icon="camera" onClick={addNext}>{lang === "ar" ? "صوّر" : "Camera"}</Btn>
        <Btn variant="secondary" size="sm" icon="folder-open" onClick={addNext}>{t("from_profile")}</Btn>
      </div>

      {files.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 16 }}>
          {files.map(f => <FileTile key={f.id} file={f} onRemove={() => setFiles(x => x.filter(y => y.id !== f.id))} />)}
        </div>
      )}

      {/* AI analysis state */}
      {analyzing && (
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: 14, borderRadius: "var(--r-md)", background: "var(--surface)", border: "1px solid var(--rule)", marginBottom: 16 }}>
          <span className="tk-spin" style={{ width: 18, height: 18, border: "2px solid var(--teal)", borderRightColor: "transparent", borderRadius: "50%" }} />
          <span style={{ fontSize: 13.5, color: "var(--text-2)" }}>{lang === "ar" ? "بنحلّل ملفاتك لاقتراح التخصص…" : "Reading your files to suggest a specialty…"}</span>
        </div>
      )}
      {aiDone && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 13, borderRadius: "var(--r-md)", background: "var(--teal-tint)", border: "1px solid rgba(95,230,224,0.3)", marginBottom: 16 }}>
          <Ic name="sparkles" size={18} color="var(--teal)" />
          <span style={{ fontSize: 13, color: "var(--text)", flex: 1 }}>{lang === "ar" ? "لقينا اقتراح للتخصص — هتلاقيه في الخطوة الجاية." : "We have a specialty suggestion — see the next step."}</span>
        </div>
      )}

      <Field label={t("describe_label")} value={focus} onChange={setFocus} placeholder={t("describe_ph")} multiline rows={3} dir={dir} />

      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
          <Ic name="lock" size={14} color="var(--success)" />{t("encrypted")}
        </div>
      </div>
    </div>
  );
}

function StepSpecialty({ specialty, setSpecialty, aiDone }) {
  const { t, lang } = useApp();
  const [showWhy, setShowWhy] = React.useState(false);
  const suggested = "radiology";
  return (
    <div>
      <StepTitle title={t("pick_specialty")} sub={t("pick_specialty_sub")} />

      {aiDone && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase", color: "var(--teal)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <Ic name="sparkles" size={13} />{t("ai_suggested")}
          </div>
          <div style={{ background: "var(--surface)", border: `1.5px solid ${specialty === suggested ? "var(--teal)" : "rgba(95,230,224,0.4)"}`, borderRadius: "var(--r-lg)", padding: 14, boxShadow: "0 0 0 4px var(--teal-tint)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <SpecialtyIcon id={suggested} size={46} active />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{lang === "ar" ? specMeta(suggested).ar : specMeta(suggested).en}</div>
                <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>{lang === "ar" ? specMeta(suggested).blurb_ar : specMeta(suggested).blurb_en}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Btn variant={specialty === suggested ? "primary" : "secondary"} size="sm" icon={specialty === suggested ? "check" : undefined} onClick={() => setSpecialty(suggested)} style={{ flex: 1 }}>{specialty === suggested ? (lang === "ar" ? "متأكد" : "Selected") : t("use_suggestion")}</Btn>
              <Btn variant="ghost" size="sm" onClick={() => setShowWhy(!showWhy)}>{t("ai_why")}</Btn>
            </div>
            {showWhy && (
              <div style={{ marginTop: 12, padding: 12, background: "var(--surface-2)", borderRadius: "var(--r-md)", fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55, display: "flex", gap: 8 }}>
                <Ic name="file-search" size={16} color="var(--teal)" style={{ flexShrink: 0, marginTop: 1 }} />{t("ai_reason")}
              </div>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 10, display: "flex", alignItems: "center", gap: 5 }}>
            <Ic name="info" size={12} />{lang === "ar" ? "إنت اللي تقرّر دايماً — تقدر تختار غيره من تحت." : "You always decide — pick another below."}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase", color: "var(--muted)", marginBottom: 10 }}>{lang === "ar" ? "كل التخصصات" : "All specialties"}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {SPECIALTIES.map(s => {
          const on = specialty === s.id;
          return (
            <button key={s.id} onClick={() => setSpecialty(s.id)} style={{ display: "flex", flexDirection: "column", gap: 9, padding: 13, borderRadius: "var(--r-md)", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
              background: on ? "var(--teal-tint)" : "var(--surface)", border: `1.5px solid ${on ? "var(--teal)" : "var(--rule)"}`, transition: "all var(--t-base) var(--ease)", position: "relative" }}>
              <SpecialtyIcon id={s.id} size={38} active={on} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{lang === "ar" ? s.ar : s.en}</div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, lineHeight: 1.35 }}>{lang === "ar" ? s.blurb_ar : s.blurb_en}</div>
              </div>
              {s.lead && <span style={{ position: "absolute", top: 11, insetInlineEnd: 11, width: 6, height: 6, borderRadius: "50%", background: "var(--teal)" }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepUrgency({ tier, setTier }) {
  const { t, lang } = useApp();
  const tiers = [
    { id: "standard", icon: "clock", price: PRICING.standard },
    { id: "urgent", icon: "zap", price: PRICING.urgent },
  ];
  return (
    <div>
      <StepTitle title={t("urgency_title")} />
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {tiers.map(tr => {
          const on = tier === tr.id;
          const urgent = tr.id === "urgent";
          return (
            <button key={tr.id} onClick={() => setTier(tr.id)} style={{ textAlign: "left", padding: 16, borderRadius: "var(--r-lg)", cursor: "pointer", fontFamily: "inherit",
              background: on ? "var(--teal-tint)" : "var(--surface)", border: `1.5px solid ${on ? "var(--teal)" : "var(--rule)"}`, transition: "all var(--t-base) var(--ease)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: "var(--r-md)", background: urgent ? "var(--warn-bg)" : "var(--surface-2)", color: urgent ? "var(--warn)" : "var(--teal)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Ic name={tr.icon} size={22} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{t(urgent ? "tier_urgent" : "tier_standard")}</span>
                    {urgent && <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--warn)", background: "var(--warn-bg)", padding: "2px 7px", borderRadius: 999, textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("tier_urgent_tag")}</span>}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 3 }}>{t(urgent ? "tier_urgent_w" : "tier_standard_w")}</div>
                </div>
                <div style={{ textAlign: dir => "end" }}>
                  <div className="num" style={{ fontSize: 17, fontWeight: 700, color: on ? "var(--teal)" : "var(--text)" }}>{money(tr.price, lang)}</div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 16, padding: 13, borderRadius: "var(--r-md)", background: "var(--success-bg)", border: "1px solid rgba(52,211,153,0.25)", display: "flex", gap: 9, alignItems: "flex-start" }}>
        <Ic name="shield-check" size={18} color="var(--success)" style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>{t("refund_promise")}</span>
      </div>
    </div>
  );
}

function StepReview({ patient, files, specialty, tier, focus, price, onEdit }) {
  const { t, lang } = useApp();
  const dep = DEPENDENTS.find(d => d.id === patient);
  const eta = tier === "urgent" ? (lang === "ar" ? "بكرة، حوالي 3 العصر" : "Tomorrow, ~3:00 PM") : (lang === "ar" ? "خلال 3 أيام" : "Within 3 days");
  const rows = [
    { label: t("wiz_who"), val: dep.id === "me" ? t("who_me") : (lang === "ar" ? dep.ar : dep.en), step: 0, icon: "user-round" },
    { label: t("wiz_specialty"), val: lang === "ar" ? specMeta(specialty).ar : specMeta(specialty).en, step: 2, icon: specMeta(specialty).icon },
    { label: t("wiz_files"), val: `${files.length} ${t("files_n")}`, step: 1, icon: "paperclip" },
    { label: t("wiz_urgency"), val: t(tier === "urgent" ? "tier_urgent" : "tier_standard"), step: 3, icon: tier === "urgent" ? "zap" : "clock" },
  ];
  return (
    <div>
      <StepTitle title={t("review_title")} />
      <Card pad={4} style={{ marginBottom: 16 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 12px", borderBottom: i < rows.length - 1 ? "1px solid var(--rule)" : "none" }}>
            <Ic name={r.icon} size={18} color="var(--muted)" />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{r.label}</div>
              <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text)", marginTop: 1 }}>{r.val}</div>
            </div>
            <button onClick={() => onEdit(r.step)} style={{ background: "none", border: "none", color: "var(--teal)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t("edit")}</button>
          </div>
        ))}
      </Card>

      {focus && (
        <Card pad={14} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>{t("describe_label")}</div>
          <div style={{ fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.55 }}>{focus}</div>
        </Card>
      )}

      <Card pad={16} style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "var(--text-2)" }}>
            <Ic name="calendar-clock" size={17} color="var(--teal)" />{t("est_delivery")}
          </div>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{eta}</span>
        </div>
        <div style={{ height: 1, background: "var(--rule)", margin: "13px 0" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, color: "var(--text-2)" }}>{t("pay_total")}</span>
          <span className="num" style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em" }}>{money(price, lang)}</span>
        </div>
      </Card>
      <ShifaStrip compact />
    </div>
  );
}

function StepPay({ payMethod, setPayMethod, price }) {
  const { t, lang } = useApp();
  const methods = [
    { id: "card", icon: "credit-card", label: t("pay_card"), detail: "Visa, Mastercard, Meeza" },
    { id: "wallet", icon: "wallet", label: t("pay_wallet"), detail: "Vodafone Cash, InstaPay" },
    { id: "fawry", icon: "store", label: t("pay_fawry"), detail: lang === "ar" ? "كود دفع في أي فرع" : "Pay code at any outlet" },
  ];
  return (
    <div>
      <StepTitle title={t("pay_title")} />
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
        {methods.map(mth => {
          const on = payMethod === mth.id;
          return (
            <button key={mth.id} onClick={() => setPayMethod(mth.id)} style={{ display: "flex", alignItems: "center", gap: 13, padding: 14, borderRadius: "var(--r-md)", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
              background: on ? "var(--teal-tint)" : "var(--surface)", border: `1.5px solid ${on ? "var(--teal)" : "var(--rule)"}`, transition: "all var(--t-base) var(--ease)" }}>
              <Ic name={mth.icon} size={22} color={on ? "var(--teal)" : "var(--text-2)"} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{mth.label}</div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 1 }}>{mth.detail}</div>
              </div>
              <div style={{ width: 20, height: 20, borderRadius: "50%", border: `2px solid ${on ? "var(--teal)" : "var(--rule-strong)"}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {on && <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--teal)" }} />}
              </div>
            </button>
          );
        })}
      </div>

      {payMethod === "card" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 18 }}>
          <Field label={lang === "ar" ? "رقم الكارت" : "Card number"} value="" onChange={() => {}} placeholder="4291 •••• •••• ••••" icon="credit-card" dir="ltr" />
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}><Field label={lang === "ar" ? "تاريخ الانتهاء" : "Expiry"} value="" onChange={() => {}} placeholder="MM/YY" dir="ltr" /></div>
            <div style={{ flex: 1 }}><Field label="CVV" value="" onChange={() => {}} placeholder="•••" dir="ltr" /></div>
          </div>
        </div>
      )}

      <Card pad={14} style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, color: "var(--text-2)" }}>{t("pay_total")}</span>
          <span className="num" style={{ fontSize: 20, fontWeight: 700, color: "var(--text)" }}>{money(price, lang)}</span>
        </div>
      </Card>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
        <Ic name="shield-check" size={15} color="var(--success)" style={{ flexShrink: 0, marginTop: 1 }} />{t("pay_secure")}
      </div>
    </div>
  );
}

function SubmittedView({ nav }) {
  const { t } = useApp();
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", padding: "var(--safe-top) 28px calc(var(--safe-bottom) + 20px)", background: "var(--navy-800)" }}>
      <div style={{ position: "relative", marginBottom: 28 }}>
        <div style={{ width: 96, height: 96, borderRadius: "50%", background: "var(--teal-tint)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "var(--teal)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Ic name="check" size={34} color="var(--on-teal)" stroke={2.4} />
          </div>
        </div>
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em", margin: "0 0 10px" }}>{t("submitted_title")}</h1>
      <p style={{ fontSize: 14.5, color: "var(--text-2)", lineHeight: 1.6, maxWidth: 300, margin: "0 0 30px" }}>{t("submitted_sub")}</p>
      <div style={{ width: "100%", maxWidth: 320, display: "flex", flexDirection: "column", gap: 10 }}>
        <Btn variant="primary" size="lg" full onClick={() => nav("home", {}, { root: true })}>{t("go_dashboard")}</Btn>
        <ShifaStrip compact />
      </div>
    </div>
  );
}

Object.assign(window, { WizardScreen, DEPENDENTS });
