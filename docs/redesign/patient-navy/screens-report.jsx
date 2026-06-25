// screens-report.jsx — The signed specialist report (green/gold world), PDF document view, follow-up.

const REPORT = {
  id: "TK-4610",
  patient_en: "Mariam Adel", patient_ar: "مريم عادل",
  date_en: "11 June 2026", date_ar: "11 يونيو 2026",
  specialty: "radiology",
  doctor: SAMPLE_DOCTOR,
  summary_en: "The submitted chest CT shows a 9 mm solid nodule in the right upper lobe with smooth, well-defined margins. The appearance is most consistent with a benign lesion. Immediate surgery is not indicated on current imaging.",
  summary_ar: "الأشعة المقطعية على الصدر بتوضّح وجود عقدة صلبة قياسها 9 مم في الفص العلوي الأيمن، حوافها منتظمة وواضحة. الشكل ده غالباً حميد. مفيش داعي لعملية فورية بناءً على الصور الحالية.",
  findings_en: [
    "Solitary 9 mm solid nodule, right upper lobe, smooth margins.",
    "No mediastinal or hilar lymphadenopathy.",
    "No pleural effusion. Remaining lung fields are clear.",
  ],
  findings_ar: [
    "عقدة واحدة صلبة 9 مم في الفص العلوي الأيمن، حوافها منتظمة.",
    "مفيش تضخّم في الغدد الليمفاوية بالمنصف أو السُّرّة الرئوية.",
    "مفيش ارتشاح بلوري، وباقي أنسجة الرئة سليمة.",
  ],
  reco_en: "Recommend a low-dose follow-up CT in 3 months to confirm stability, per Fleischner Society guidance. Biopsy is not warranted at this stage. If you have a history of smoking or prior cancer, please share it so we can refine the interval.",
  reco_ar: "بننصح بأشعة مقطعية بجرعة منخفضة للمتابعة بعد 3 شهور للتأكد من الثبات، حسب إرشادات جمعية فلايشنر. مفيش داعي لأخذ عيّنة في المرحلة دي. لو فيه تاريخ تدخين أو أورام سابقة، يا ريت تبلّغنا عشان نظبط الميعاد.",
};

function ReportHeader({ pdf }) {
  const { t, lang } = useApp();
  return (
    <div style={{ textAlign: "center", padding: pdf ? "8px 0 18px" : "4px 0 18px" }}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}><ReportSeal size={pdf ? 58 : 64} /></div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--rpt-gold)" }}>{t("report_kicker")}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 10 }}>
        <ShifaMark size={22} on="report" />
        <span style={{ fontSize: 17, fontWeight: 700, color: "var(--rpt-green)", letterSpacing: "-0.01em", fontFamily: lang === "ar" ? "var(--font-ar)" : "var(--font-sans)" }}>{lang === "ar" ? "تشخيصة" : "Tashkheesa"}</span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--rpt-muted)", marginTop: 4 }}>{t("backed_by")}</div>
    </div>
  );
}

function RptMeta({ label, value, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpt-muted)" }}>{label}</div>
      <div className={mono ? "num" : ""} style={{ fontSize: 13.5, fontWeight: 600, color: "var(--rpt-ink)", marginTop: 3 }}>{value}</div>
    </div>
  );
}

function RptSection({ title, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
        <span style={{ width: 16, height: 2, background: "var(--rpt-gold)" }} />
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpt-green)" }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function ReportBody({ rlang }) {
  const { t } = useApp();
  const ar = rlang === "ar";
  return (
    <div dir={ar ? "rtl" : "ltr"} style={{ fontFamily: ar ? "var(--font-ar)" : "var(--font-sans)", textAlign: ar ? "right" : "left" }}>
      <RptSection title={t("report_summary")}>
        <p style={{ fontSize: 14.5, color: "var(--rpt-ink)", lineHeight: 1.7, margin: 0 }}>{ar ? REPORT.summary_ar : REPORT.summary_en}</p>
      </RptSection>
      <RptSection title={t("report_findings")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {(ar ? REPORT.findings_ar : REPORT.findings_en).map((f, i) => (
            <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpt-gold)", marginTop: 8, flexShrink: 0 }} />
              <span style={{ fontSize: 14, color: "var(--rpt-ink-2)", lineHeight: 1.6 }}>{f}</span>
            </div>
          ))}
        </div>
      </RptSection>
      <RptSection title={t("report_reco")}>
        <p style={{ fontSize: 14.5, color: "var(--rpt-ink)", lineHeight: 1.7, margin: 0 }}>{ar ? REPORT.reco_ar : REPORT.reco_en}</p>
      </RptSection>
    </div>
  );
}

function Signature({ pdf }) {
  const { t, lang } = useApp();
  const d = REPORT.doctor;
  return (
    <div style={{ marginTop: 8, paddingTop: 18, borderTop: "1px solid var(--rpt-rule-gold)" }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 14 }}>
        <div>
          <svg width="120" height="38" viewBox="0 0 120 38" fill="none" style={{ marginBottom: 4 }}>
            <path d="M4 26c10-14 16 6 22-4s8-12 13 2 9 6 14-6 10 8 16 2 12-10 18-4 12 6 16 2" stroke="var(--rpt-green)" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--rpt-ink)", display: "flex", alignItems: "center", gap: 6 }}>
            {lang === "ar" ? d.name_ar : d.name_en}<Ic name="badge-check" size={15} color="var(--rpt-gold)" />
          </div>
          <div style={{ fontSize: 12.5, color: "var(--rpt-ink-2)", marginTop: 2 }}>{lang === "ar" ? d.title_ar : d.title_en}</div>
          <div style={{ fontSize: 12, color: "var(--rpt-muted)", marginTop: 1 }}>{lang === "ar" ? d.cred_ar : d.cred_en}</div>
          <div className="num" style={{ fontSize: 11, color: "var(--rpt-muted)", marginTop: 5 }}>{t("reg_no")} {d.reg}</div>
        </div>
        <div style={{ textAlign: "center", flexShrink: 0 }}>
          <div style={{ width: 60, height: 60, borderRadius: "50%", border: "1.5px solid var(--rpt-gold)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpt-green)", transform: "rotate(-8deg)" }}>
            <div style={{ textAlign: "center", lineHeight: 1.1 }}>
              <Ic name="shield-check" size={18} color="var(--rpt-gold)" />
              <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.08em", color: "var(--rpt-green)", marginTop: 1 }}>VERIFIED</div>
            </div>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 14, fontSize: 11.5, color: "var(--rpt-muted)" }}>
        <Ic name="lock" size={13} color="var(--rpt-green)" />{t("report_signed")} · <span className="num">{REPORT.date_en}</span>
      </div>
    </div>
  );
}

function ReportScreen() {
  const { t, lang, nav, store } = useApp();
  const [rlang, setRlang] = React.useState(lang);
  React.useEffect(() => setRlang(lang), [lang]);
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--rpt-bg)" }}>
      {/* top bar (report-world) */}
      <div style={{ position: "sticky", top: 0, zIndex: 30, paddingTop: "var(--safe-top)", background: "rgba(246,241,228,0.9)", backdropFilter: "blur(14px)", borderBottom: "1px solid var(--rpt-rule)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px 12px", minHeight: 50 }}>
          <button onClick={() => nav("home", {}, { root: true })} style={{ background: "var(--rpt-bg-2)", border: "1px solid var(--rpt-rule)", cursor: "pointer", width: 38, height: 38, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpt-green)" }}>
            <Ic name={lang === "ar" ? "chevron-right" : "chevron-left"} size={20} />
          </button>
          <div style={{ flex: 1, fontSize: 15, fontWeight: 700, color: "var(--rpt-green)", textAlign: "center" }}><span className="num">{REPORT.id}</span></div>
          <button onClick={() => nav("reportPDF")} style={{ background: "var(--rpt-bg-2)", border: "1px solid var(--rpt-rule)", cursor: "pointer", width: 38, height: 38, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpt-green)" }}>
            <Ic name="expand" size={18} />
          </button>
        </div>
      </div>

      <div className="app-scroll" style={{ flex: 1, overflowY: "auto", padding: "8px 20px calc(var(--safe-bottom) + 120px)" }}>
        <ReportHeader />

        {/* meta block */}
        <div style={{ background: "var(--rpt-surface)", border: "1px solid var(--rpt-rule)", borderRadius: "var(--r-md)", padding: 16, marginBottom: 20, boxShadow: "var(--shadow-rpt)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <RptMeta label={t("report_for")} value={lang === "ar" ? REPORT.patient_ar : REPORT.patient_en} />
            <RptMeta label={t("report_date")} value={lang === "ar" ? REPORT.date_ar : REPORT.date_en} mono />
            <RptMeta label={t("wiz_specialty")} value={lang === "ar" ? specMeta(REPORT.specialty).ar : specMeta(REPORT.specialty).en} />
            <RptMeta label={t("case_id")} value={REPORT.id} mono />
          </div>
        </div>

        {/* language toggle for the opinion */}
        <div style={{ display: "flex", gap: 6, padding: 4, background: "var(--rpt-bg-2)", borderRadius: "var(--r-md)", marginBottom: 20 }}>
          {["en", "ar"].map(l => {
            const on = rlang === l;
            return (
              <button key={l} onClick={() => setRlang(l)} style={{ flex: 1, padding: "9px 12px", borderRadius: "calc(var(--r-md) - 4px)", border: "none", cursor: "pointer", fontFamily: l === "ar" ? "var(--font-ar)" : "var(--font-sans)", fontSize: 13.5, fontWeight: 600,
                background: on ? "var(--rpt-green)" : "transparent", color: on ? "#f3efe2" : "var(--rpt-ink-2)" }}>
                {l === "en" ? "English" : "العربية"}
              </button>
            );
          })}
        </div>

        <div style={{ background: "var(--rpt-surface)", border: "1px solid var(--rpt-rule)", borderRadius: "var(--r-md)", padding: 20, boxShadow: "var(--shadow-rpt)" }}>
          <ReportBody rlang={rlang} />
          <Signature />
        </div>

        <div style={{ textAlign: "center", fontSize: 11, color: "var(--rpt-muted)", marginTop: 16, lineHeight: 1.5 }}>
          {lang === "ar" ? "النسخة الكاملة (PDF) فيها الرأي بالعربي والإنجليزي." : "The full PDF contains the opinion in both Arabic and English."}
        </div>
      </div>

      {/* action bar */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "14px 18px calc(14px + var(--safe-bottom))", background: "rgba(246,241,228,0.95)", backdropFilter: "blur(16px)", borderTop: "1px solid var(--rpt-rule)" }}>
        <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
          <Btn variant="report" size="md" full icon="download" onClick={() => nav("reportPDF")}>{t("download_pdf")}</Btn>
          <ShareBtn />
        </div>
        <button onClick={() => nav("followup")} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "11px", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, fontWeight: 600, color: "var(--rpt-green)" }}>
          <Ic name="message-circle-question" size={17} />{t("ask_followup")}
        </button>
      </div>
    </div>
  );
}

// Share button needs showToast from context — small wrapper
function ShareBtn() {
  const { t, showToast, lang } = useApp();
  return <Btn variant="reportGold" size="md" icon="share-2" onClick={() => showToast(lang === "ar" ? "تم نسخ رابط آمن للتقرير" : "Secure report link copied")}>{t("share_report")}</Btn>;
}

function ReportPDFScreen() {
  const { t, lang, nav, showToast } = useApp();
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--rpt-bg-2)" }}>
      <div style={{ position: "sticky", top: 0, zIndex: 30, paddingTop: "var(--safe-top)", background: "rgba(239,231,211,0.92)", backdropFilter: "blur(14px)", borderBottom: "1px solid var(--rpt-rule)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px 12px", minHeight: 50 }}>
          <button onClick={() => nav("report")} style={{ background: "var(--rpt-surface)", border: "1px solid var(--rpt-rule)", cursor: "pointer", width: 38, height: 38, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpt-green)" }}>
            <Ic name="x" size={19} />
          </button>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: "var(--rpt-green)", textAlign: "center" }}>{lang === "ar" ? "المستند الكامل" : "Full document"}</div>
          <button onClick={() => showToast(lang === "ar" ? "بيتحمّل PDF…" : "Downloading PDF…", "success")} style={{ background: "var(--rpt-surface)", border: "1px solid var(--rpt-rule)", cursor: "pointer", width: 38, height: 38, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpt-green)" }}>
            <Ic name="download" size={18} />
          </button>
        </div>
      </div>

      <div className="app-scroll" style={{ flex: 1, overflowY: "auto", padding: "18px 16px calc(var(--safe-bottom) + 20px)" }}>
        {/* the "paper" */}
        <div style={{ background: "var(--rpt-surface)", borderRadius: 6, boxShadow: "0 16px 40px rgba(31,49,42,0.22)", padding: "26px 24px", border: "1px solid var(--rpt-rule)", position: "relative", overflow: "hidden" }}>
          {/* gold top rule */}
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 4, background: "linear-gradient(90deg, var(--rpt-gold), var(--rpt-gold-2), var(--rpt-gold))" }} />
          <ReportHeader pdf />
          <div style={{ height: 1, background: "var(--rpt-rule-gold)", margin: "4px 0 18px" }} />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 22 }}>
            <RptMeta label={t("report_for")} value={REPORT.patient_en} />
            <RptMeta label={t("report_date")} value={REPORT.date_en} mono />
            <RptMeta label="Specialty" value={specMeta(REPORT.specialty).en} />
            <RptMeta label={t("case_id")} value={REPORT.id} mono />
          </div>

          {/* English */}
          <ReportBody rlang="en" />
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "8px 0 22px" }}>
            <div style={{ flex: 1, height: 1, background: "var(--rpt-rule)" }} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: "var(--rpt-gold)" }}>•</span>
            <div style={{ flex: 1, height: 1, background: "var(--rpt-rule)" }} />
          </div>
          {/* Arabic */}
          <ReportBody rlang="ar" />

          <Signature pdf />

          {/* footer */}
          <div style={{ marginTop: 22, paddingTop: 14, borderTop: "1px solid var(--rpt-rule)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <ShifaMark size={18} on="report" />
              <span style={{ fontSize: 10.5, color: "var(--rpt-muted)" }}>{t("backed_by")}</span>
            </div>
            <span className="num" style={{ fontSize: 10, color: "var(--rpt-muted)" }}>{REPORT.id} · p.1/1</span>
          </div>
        </div>
        <div style={{ textAlign: "center", fontSize: 11, color: "var(--rpt-muted)", marginTop: 14 }}>
          {lang === "ar" ? "موقّع إلكترونياً ومشفّر — قابل للتحقق عبر رقم القيد." : "Electronically signed & encrypted — verifiable via registry number."}
        </div>
      </div>
    </div>
  );
}

function FollowupScreen() {
  const { t, lang, nav, store, patch } = useApp();
  const [q, setQ] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const d = REPORT.doctor;
  const left = store.followupUsed ? 0 : 1;

  if (sent) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", padding: "var(--safe-top) 28px calc(var(--safe-bottom) + 20px)", background: "var(--navy-800)" }}>
        <div style={{ width: 88, height: 88, borderRadius: "50%", background: "var(--teal-tint)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 24 }}>
          <Ic name="send" size={32} color="var(--teal)" />
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: "0 0 10px" }}>{t("followup_sent")}</h1>
        <p style={{ fontSize: 14.5, color: "var(--text-2)", lineHeight: 1.6, maxWidth: 290, margin: "0 0 28px" }}>
          {lang === "ar" ? "د. حسام هيرد على سؤالك خلال 24 ساعة. هنبعتلك إشعار." : "Dr. Hossam will reply within 24 hours. We'll notify you."}
        </p>
        <Btn variant="primary" size="lg" full onClick={() => nav("home", {}, { root: true })} style={{ maxWidth: 320 }}>{t("done")}</Btn>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <TopBar title={t("followup_title")} onBack={() => nav("report")} />
      <div className="app-scroll" style={{ flex: 1, overflowY: "auto", padding: "8px 18px calc(var(--safe-bottom) + 110px)" }}>
        <Card pad={16} style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 46, height: 46, borderRadius: "50%", background: "var(--teal-tint)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Ic name="stethoscope" size={22} color="var(--teal)" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{lang === "ar" ? d.name_ar : d.name_en}</div>
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{lang === "ar" ? d.title_ar : d.title_en}</div>
            </div>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--teal)", background: "var(--teal-tint)", padding: "5px 10px", borderRadius: 999 }} className="num">{left} {t("followup_left")}</span>
          </div>
        </Card>

        <p style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.6, margin: "0 0 18px" }}>{t("followup_sub")}</p>

        <Field label={t("followup_title")} value={q} onChange={setQ} placeholder={t("followup_ph")} multiline rows={5} dir={lang === "ar" ? "rtl" : "ltr"} />

        <div style={{ marginTop: 14, padding: 13, borderRadius: "var(--r-md)", background: "var(--info-bg)", border: "1px solid rgba(96,165,250,0.25)", display: "flex", gap: 9 }}>
          <Ic name="info" size={17} color="var(--info)" style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}>
            {lang === "ar" ? "ده للتوضيح بس — مش استشارة جديدة. لو محتاج رأي على ملفات جديدة، ابدأ حالة جديدة." : "This is for clarification only — not a new consultation. For new files, start a new case."}
          </span>
        </div>
      </div>

      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "14px 18px calc(14px + var(--safe-bottom))", background: "rgba(8,17,32,0.92)", backdropFilter: "blur(16px)", borderTop: "1px solid var(--rule)" }}>
        <Btn variant="primary" size="lg" full disabled={q.trim().length < 5} icon="send" onClick={() => { patch({ followupUsed: true }); setSent(true); }}>{t("send_question")}</Btn>
      </div>
    </div>
  );
}

Object.assign(window, { ReportScreen, ReportPDFScreen, FollowupScreen, REPORT });
