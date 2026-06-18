// screens-account.jsx — Notifications, Account, Medical profile, Family, How it works, Partnership, Refund policy.

function AlertsScreen() {
  const { t, lang, nav, store, patch } = useApp();
  const accentMap = { success: "var(--success)", teal: "var(--teal)", warn: "var(--warn)", danger: "var(--danger)" };
  const bgMap = { success: "var(--success-bg)", teal: "var(--teal-tint)", warn: "var(--warn-bg)", danger: "var(--danger-bg)" };
  const route = (n) => n.type === "ready" ? nav("report") : n.type === "refund" ? nav("breach") : nav("caseDetail", { id: "TK-4821" });
  return (
    <TabShell active="alerts">
      <div style={{ paddingTop: "var(--safe-top)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 18px 14px" }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em", margin: 0 }}>{t("alerts_title")}</h1>
          <button onClick={() => patch({ notifs: store.notifs.map(n => ({ ...n, unread: false })) })} style={{ background: "none", border: "none", color: "var(--teal)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t("mark_read")}</button>
        </div>
        <div style={{ padding: "0 18px", display: "flex", flexDirection: "column", gap: 10 }}>
          {store.notifs.length ? store.notifs.map(n => (
            <div key={n.id} onClick={() => route(n)} style={{ display: "flex", gap: 13, padding: 14, borderRadius: "var(--r-lg)", cursor: "pointer", position: "relative",
              background: n.unread ? "var(--surface)" : "transparent", border: `1px solid ${n.unread ? "var(--rule-strong)" : "var(--rule-faint)"}` }}>
              <div style={{ width: 42, height: 42, borderRadius: "var(--r-md)", background: bgMap[n.accent], display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Ic name={n.icon} size={20} color={accentMap[n.accent]} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text)", flex: 1 }}>{lang === "ar" ? n.ar : n.en}</span>
                  <span className="num" style={{ fontSize: 11.5, color: "var(--muted)" }}>{lang === "ar" ? n.ageAr : n.ageEn}</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 3 }}>{lang === "ar" ? n.subAr : n.subEn}</div>
              </div>
              {n.unread && <span style={{ position: "absolute", top: 16, insetInlineStart: -3, width: 7, height: 7, borderRadius: "50%", background: "var(--teal)" }} />}
            </div>
          )) : (
            <EmptyState illo="bell-off" title={t("no_alerts")} body={t("no_alerts_sub")} />
          )}
        </div>
      </div>
    </TabShell>
  );
}

function ListItem({ icon, title, sub, onClick, right, accent, danger }) {
  const { dir } = useApp();
  return (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 13, width: "100%", textAlign: "start", padding: "13px 14px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
      <div style={{ width: 36, height: 36, borderRadius: "var(--r-sm)", background: danger ? "var(--danger-bg)" : "var(--teal-tint)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Ic name={icon} size={18} color={danger ? "var(--danger)" : "var(--teal)"} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: danger ? "var(--danger)" : "var(--text)" }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 1 }}>{sub}</div>}
      </div>
      {right || <Ic name={dir === "rtl" ? "chevron-left" : "chevron-right"} size={18} color="var(--muted-2)" />}
    </button>
  );
}

function GroupCard({ children }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", overflow: "hidden", marginBottom: 16 }}>
      {React.Children.toArray(children).map((c, i, arr) => (
        <div key={i} style={{ borderBottom: i < arr.length - 1 ? "1px solid var(--rule)" : "none" }}>{c}</div>
      ))}
    </div>
  );
}

function AccountScreen() {
  const { t, lang, setLang, nav } = useApp();
  return (
    <TabShell active="account">
      <div style={{ paddingTop: "var(--safe-top)" }}>
        <div style={{ padding: "8px 18px 18px" }}>
          {/* profile header */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
            <div style={{ width: 60, height: 60, borderRadius: "50%", background: "linear-gradient(135deg, var(--teal), var(--teal-dim))", color: "var(--on-teal)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 700 }}>M</div>
            <div>
              <div style={{ fontSize: 19, fontWeight: 700, color: "var(--text)" }}>{lang === "ar" ? "مريم عادل" : "Mariam Adel"}</div>
              <div className="num" style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }} dir="ltr">+20 10 1234 5678</div>
            </div>
          </div>

          <GroupCard>
            <ListItem icon="folder-heart" title={t("medical_profile")} sub={t("medical_profile_sub")} onClick={() => nav("medical")} />
            <ListItem icon="users" title={t("family_profiles")} sub={t("family_sub")} onClick={() => nav("family")} />
            <ListItem icon="credit-card" title={t("payment_methods")} onClick={() => {}} />
          </GroupCard>

          <GroupCard>
            <ListItem icon="languages" title={t("language_pref")} right={
              <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 4, background: "var(--surface-2)", borderRadius: 999, padding: 3 }}>
                {["en", "ar"].map(l => (
                  <button key={l} onClick={() => setLang(l)} style={{ padding: "5px 12px", borderRadius: 999, border: "none", cursor: "pointer", fontFamily: l === "ar" ? "var(--font-ar)" : "var(--font-sans)", fontSize: 12.5, fontWeight: 600,
                    background: lang === l ? "var(--teal)" : "transparent", color: lang === l ? "var(--on-teal)" : "var(--text-2)" }}>{l === "en" ? "EN" : "ع"}</button>
                ))}
              </div>
            } onClick={() => {}} />
          </GroupCard>

          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase", color: "var(--muted)", padding: "0 4px 8px" }}>{lang === "ar" ? "الثقة والمساعدة" : "Trust & help"}</div>
          <GroupCard>
            <ListItem icon="route" title={t("how_it_works")} onClick={() => nav("howItWorks")} />
            <ListItem icon="building-2" title={t("our_partnership")} onClick={() => nav("partnership")} />
            <ListItem icon="receipt-text" title={t("refund_policy")} onClick={() => nav("refundPolicy")} />
            <ListItem icon="headset" title={t("help_center")} onClick={() => {}} />
            <ListItem icon="shield" title={t("privacy")} onClick={() => {}} />
          </GroupCard>

          <GroupCard>
            <ListItem icon="log-out" title={t("sign_out")} danger onClick={() => nav("onboarding", {}, { root: true })} right={<span />} />
          </GroupCard>

          <div style={{ textAlign: "center", marginTop: 8 }}><ShifaStrip compact /></div>
          <div className="num" style={{ textAlign: "center", fontSize: 11, color: "var(--muted-2)", marginTop: 14 }}>v1.0 · Tashkheesa</div>
        </div>
      </div>
    </TabShell>
  );
}

function MedicalScreen() {
  const { t, lang, nav } = useApp();
  const chips = lang === "ar" ? ["البنسلين", "حبوب اللقاح"] : ["Penicillin", "Pollen"];
  const chronic = lang === "ar" ? ["ضغط مرتفع"] : ["Hypertension"];
  const savedFiles = [
    { name: "ECG_baseline.pdf", size: "210 KB" }, { name: "CBC_2026.pdf", size: "180 KB" },
    { name: "MRI_brain.dcm", size: "8.2 MB" }, { name: "prescription_apr.jpg", size: "640 KB" },
  ];
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <TopBar title={t("medical_profile")} onBack={() => nav("account", {}, { root: true })} right={<button style={{ background: "none", border: "none", color: "var(--teal)", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t("edit")}</button>} />
      <div className="app-scroll" style={{ flex: 1, overflowY: "auto", padding: "6px 18px calc(var(--safe-bottom) + 20px)" }}>
        <p style={{ fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.55, margin: "4px 0 18px" }}>
          {lang === "ar" ? "بياناتك دي بتترفع تلقائياً مع كل حالة جديدة — عشان متعيدش الرفع كل مرة." : "This profile is attached to every new case automatically — so you never re-upload your history."}
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <Card pad={14}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase", color: "var(--muted)" }}>{t("blood_type")}</div>
            <div className="num" style={{ fontSize: 24, fontWeight: 700, color: "var(--teal)", marginTop: 6 }}>O+</div>
          </Card>
          <Card pad={14}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase", color: "var(--muted)" }}>{lang === "ar" ? "العمر" : "Age"}</div>
            <div className="num" style={{ fontSize: 24, fontWeight: 700, color: "var(--text)", marginTop: 6 }}>32</div>
          </Card>
        </div>

        <Card pad={16} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase", color: "var(--muted)", marginBottom: 10 }}>{t("allergies")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {chips.map(c => <span key={c} style={{ fontSize: 13, fontWeight: 600, color: "var(--warn)", background: "var(--warn-bg)", padding: "6px 12px", borderRadius: 999 }}>{c}</span>)}
          </div>
        </Card>

        <Card pad={16} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase", color: "var(--muted)", marginBottom: 10 }}>{t("chronic")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {chronic.map(c => <span key={c} style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)", background: "var(--surface-2)", padding: "6px 12px", borderRadius: 999 }}>{c}</span>)}
          </div>
        </Card>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 4px 12px" }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase", color: "var(--muted)" }}>{t("saved_files")}</span>
          <span className="num" style={{ fontSize: 12, color: "var(--muted)" }}>{savedFiles.length}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {savedFiles.map((f, i) => <FileTile key={i} file={f} />)}
        </div>
        <div style={{ marginTop: 14 }}>
          <Btn variant="secondary" size="md" full icon="plus" onClick={() => {}}>{t("add_files")}</Btn>
        </div>
      </div>
    </div>
  );
}

function FamilyScreen() {
  const { t, lang, nav, showToast } = useApp();
  const [sheet, setSheet] = React.useState(false);
  const members = [
    { init: "S", en: "Samir Adel", ar: "سمير عادل", rel_en: "Father · 64", rel_ar: "بابا · 64", cases: 2, blood: "A+" },
    { init: "N", en: "Nadia Adel", ar: "نادية عادل", rel_en: "Mother · 59", rel_ar: "ماما · 59", cases: 1, blood: "O-" },
    { init: "Y", en: "Yousef", ar: "يوسف", rel_en: "Son · 7", rel_ar: "ابني · 7", cases: 0, blood: "O+" },
  ];
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <TopBar title={t("family_profiles")} onBack={() => nav("account", {}, { root: true })} />
      <div className="app-scroll" style={{ flex: 1, overflowY: "auto", padding: "6px 18px calc(var(--safe-bottom) + 20px)" }}>
        <p style={{ fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.55, margin: "4px 0 18px" }}>{t("family_sub")}.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* self */}
          <Card pad={14}>
            <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
              <div style={{ width: 46, height: 46, borderRadius: "50%", background: "var(--teal)", color: "var(--on-teal)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 18 }}>M</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{lang === "ar" ? "مريم عادل (إنتي)" : "Mariam Adel (you)"}</div>
                <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }} className="num">O+ · 32</div>
              </div>
            </div>
          </Card>
          {members.map((mb, i) => (
            <Card key={i} pad={14} onClick={() => showToast(lang === "ar" ? "ملف " + mb.ar : mb.en + "'s profile")}>
              <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
                <div style={{ width: 46, height: 46, borderRadius: "50%", background: "var(--surface-2)", color: "var(--text-2)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 18 }}>{mb.init}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{lang === "ar" ? mb.ar : mb.en}</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}><span>{lang === "ar" ? mb.rel_ar : mb.rel_en}</span> · <span className="num">{mb.blood}</span></div>
                </div>
                {mb.cases > 0 && <span className="num" style={{ fontSize: 12, fontWeight: 600, color: "var(--teal)", background: "var(--teal-tint)", padding: "4px 9px", borderRadius: 999 }}>{mb.cases} {lang === "ar" ? "حالات" : "cases"}</span>}
              </div>
            </Card>
          ))}
        </div>
        <div style={{ marginTop: 16 }}>
          <Btn variant="secondary" size="md" full icon="user-plus" onClick={() => setSheet(true)}>{t("add_member")}</Btn>
        </div>
      </div>

      <Sheet open={sheet} onClose={() => setSheet(false)} title={t("add_member")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={lang === "ar" ? "الاسم" : "Full name"} value="" onChange={() => {}} placeholder={lang === "ar" ? "اكتب الاسم" : "Enter name"} icon="user-round" dir={lang === "ar" ? "rtl" : "ltr"} />
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}><Field label={t("relationship")} value="" onChange={() => {}} placeholder={lang === "ar" ? "بابا" : "Father"} dir={lang === "ar" ? "rtl" : "ltr"} /></div>
            <div style={{ flex: 1 }}><Field label={t("blood_type")} value="" onChange={() => {}} placeholder="O+" dir="ltr" /></div>
          </div>
          <Btn variant="primary" size="lg" full onClick={() => { setSheet(false); showToast(lang === "ar" ? "تمت إضافة الفرد" : "Family member added", "success"); }}>{t("add_member")}</Btn>
        </div>
      </Sheet>
    </div>
  );
}

function HowItWorksScreen() {
  const { t, lang, nav } = useApp();
  const steps = [
    { icon: "upload-cloud", t: "hiw1_t", b: "hiw1_b" },
    { icon: "user-search", t: "hiw2_t", b: "hiw2_b" },
    { icon: "file-pen-line", t: "hiw3_t", b: "hiw3_b" },
    { icon: "file-badge", t: "hiw4_t", b: "hiw4_b" },
  ];
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <TopBar title={t("how_it_works")} onBack={() => nav("account", {}, { root: true })} />
      <div className="app-scroll" style={{ flex: 1, overflowY: "auto", padding: "10px 18px calc(var(--safe-bottom) + 20px)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 16 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ width: 48, height: 48, borderRadius: "var(--r-md)", background: "var(--teal-tint)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Ic name={s.icon} size={22} color="var(--teal)" />
                </div>
                {i < steps.length - 1 && <div style={{ width: 2, flex: 1, minHeight: 28, background: "var(--rule-strong)", margin: "6px 0" }} />}
              </div>
              <div style={{ paddingBottom: i < steps.length - 1 ? 24 : 0, paddingTop: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--teal)", marginBottom: 3 }} className="num">0{i + 1}</div>
                <div style={{ fontSize: 16.5, fontWeight: 700, color: "var(--text)", marginBottom: 5 }}>{t(s.t)}</div>
                <div style={{ fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.55 }}>{t(s.b)}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 8 }}><ShifaStrip /></div>
        <div style={{ marginTop: 16 }}>
          <Btn variant="primary" size="lg" full icon="plus" onClick={() => nav("wizard")}>{t("start_new_case")}</Btn>
        </div>
      </div>
    </div>
  );
}

function PartnershipScreen() {
  const { t, lang, nav } = useApp();
  const branches = [
    { key: "branch_tagamoa", addr_en: "5th Settlement, New Cairo", addr_ar: "التجمّع الخامس، القاهرة الجديدة" },
    { key: "branch_sherouk", addr_en: "El Sherouk City", addr_ar: "مدينة الشروق" },
  ];
  const stats = [
    { n: "120+", l_en: "Consultants", l_ar: "استشاري" },
    { n: "9", l_en: "Specialties", l_ar: "تخصصات" },
    { n: "100%", l_en: "Shifa-credentialed", l_ar: "معتمدين من شفاء" },
  ];
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <TopBar title={t("our_partnership")} onBack={() => nav("account", {}, { root: true })} />
      <div className="app-scroll" style={{ flex: 1, overflowY: "auto", padding: "6px 18px calc(var(--safe-bottom) + 20px)" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "8px 0 22px" }}>
          <div style={{ width: 64, height: 64, borderRadius: "var(--r-lg)", background: "var(--teal-tint)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
            <Ic name="building-2" size={30} color="var(--teal)" />
          </div>
          <h1 style={{ fontSize: 21, fontWeight: 700, color: "var(--text)", margin: "0 0 10px", letterSpacing: "-0.02em" }}>{t("shifa")}</h1>
          <p style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.6, maxWidth: 320, margin: 0 }}>{t("partner_body")}</p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 20 }}>
          {stats.map((s, i) => (
            <Card key={i} pad={12} style={{ textAlign: "center" }}>
              <div className="num" style={{ fontSize: 20, fontWeight: 700, color: "var(--teal)" }}>{s.n}</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3, lineHeight: 1.3 }}>{lang === "ar" ? s.l_ar : s.l_en}</div>
            </Card>
          ))}
        </div>

        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase", color: "var(--muted)", marginBottom: 10, padding: "0 4px" }}>{lang === "ar" ? "الفروع" : "Branches"}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
          {branches.map((b, i) => (
            <Card key={i} pad={14}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div style={{ width: 42, height: 42, borderRadius: "var(--r-md)", background: "var(--surface-2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Ic name="map-pin" size={19} color="var(--teal)" />
                </div>
                <div>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text)" }}>{t(b.key)}</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>{lang === "ar" ? b.addr_ar : b.addr_en}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>

        <div style={{ padding: 16, borderRadius: "var(--r-lg)", background: "var(--surface)", border: "1px solid var(--rule)", display: "flex", gap: 12 }}>
          <Ic name="badge-check" size={22} color="var(--teal)" style={{ flexShrink: 0 }} />
          <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.55 }}>
            {lang === "ar" ? "كل تقرير بيمر على مراجعة المجلس الطبي لشفاء قبل ما يتسلّم." : "Every report passes Shifa medical-board review before it reaches you."}
          </div>
        </div>
      </div>
    </div>
  );
}

function RefundPolicyScreen() {
  const { t, lang, nav } = useApp();
  // legal surfaces = formal Arabic
  const sections = [
    { h_en: "Full refund on missed SLA", h_ar: "استرداد كامل عند تجاوز المدة",
      b_en: "If your report is not delivered within the SLA window for your chosen tier (48–72 hours standard, 24 hours urgent), you are automatically refunded the full amount paid — no request required.",
      b_ar: "في حال عدم تسليم التقرير خلال المدة المحددة للباقة المختارة (48–72 ساعة للعادية، 24 ساعة للعاجلة)، يُرَدّ إليك كامل المبلغ المدفوع تلقائياً ودون الحاجة إلى تقديم طلب." },
    { h_en: "When you are charged", h_ar: "توقيت تحصيل الرسوم",
      b_en: "Payment is authorised at submission but only captured once a specialist accepts your case. If no specialist accepts within 12 hours, the authorisation is released in full.",
      b_ar: "يتم حجز المبلغ عند الإرسال، ولا يُحصَّل فعلياً إلا بعد قبول أحد الاستشاريين للحالة. وإذا لم يقبلها أي استشاري خلال 12 ساعة، يُلغى الحجز بالكامل." },
    { h_en: "Refund timing", h_ar: "مدة استرداد المبلغ",
      b_en: "Approved refunds are returned to your original payment method within 5–7 business days. Mobile-wallet refunds are typically faster.",
      b_ar: "تُرَدّ المبالغ المعتمدة إلى وسيلة الدفع الأصلية خلال 5–7 أيام عمل. وعادةً ما تكون عمليات الرد عبر محافظ الموبايل أسرع." },
    { h_en: "What is non-refundable", h_ar: "ما لا يخضع للاسترداد",
      b_en: "Once a signed report is delivered within the SLA, the fee is non-refundable, as the medical service has been rendered. Clarifying follow-ups are free and separate.",
      b_ar: "بمجرد تسليم التقرير الموقّع خلال المدة المحددة، تصبح الرسوم غير قابلة للاسترداد لكون الخدمة الطبية قد قُدِّمت. علماً بأن أسئلة المتابعة التوضيحية مجانية ومستقلة." },
  ];
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <TopBar title={t("refund_policy")} onBack={() => nav("account", {}, { root: true })} />
      <div className="app-scroll" style={{ flex: 1, overflowY: "auto", padding: "6px 18px calc(var(--safe-bottom) + 20px)" }} dir={lang === "ar" ? "rtl" : "ltr"}>
        <div style={{ padding: 16, borderRadius: "var(--r-lg)", background: "var(--success-bg)", border: "1px solid rgba(52,211,153,0.25)", display: "flex", gap: 12, marginBottom: 20, marginTop: 4 }}>
          <Ic name="shield-check" size={22} color="var(--success)" style={{ flexShrink: 0 }} />
          <div style={{ fontSize: 13.5, color: "var(--text)", lineHeight: 1.6, fontWeight: 500 }}>{t("refund_promise")}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {sections.map((s, i) => (
            <div key={i}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
                <span className="num" style={{ fontSize: 12, fontWeight: 700, color: "var(--teal)", width: 22, height: 22, borderRadius: "50%", background: "var(--teal-tint)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                <h2 style={{ fontSize: 15.5, fontWeight: 700, color: "var(--text)", margin: 0 }}>{lang === "ar" ? s.h_ar : s.h_en}</h2>
              </div>
              <p style={{ fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.7, margin: 0, paddingInlineStart: 31 }}>{lang === "ar" ? s.b_ar : s.b_en}</p>
            </div>
          ))}
        </div>
        <div className="num" style={{ fontSize: 11.5, color: "var(--muted-2)", marginTop: 24, textAlign: "center" }}>{lang === "ar" ? "آخر تحديث: 1 يونيو 2026" : "Last updated: 1 June 2026"}</div>
      </div>
    </div>
  );
}

Object.assign(window, { AlertsScreen, AccountScreen, MedicalScreen, FamilyScreen, HowItWorksScreen, PartnershipScreen, RefundPolicyScreen, ListItem, GroupCard });
