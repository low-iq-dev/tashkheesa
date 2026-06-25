// screens-auth.jsx — Onboarding carousel, Auth (phone/email), OTP entry.

function Wordmark({ size = 22, color = "var(--text)" }) {
  const { lang } = useApp();
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
      <ShifaMark size={size + 6} />
      <span style={{ fontFamily: lang === "ar" ? "var(--font-ar)" : "var(--font-sans)", fontSize: size, fontWeight: 700, color, letterSpacing: "-0.02em" }}>
        {lang === "ar" ? "تشخيصة" : "Tashkheesa"}
      </span>
    </div>
  );
}

function OnboardingScreen() {
  const { t, nav, lang } = useApp();
  const [i, setI] = React.useState(0);
  const slides = [
    { illo: <IlloUpload />, t: "ob1_title", b: "ob1_body" },
    { illo: <IlloSigned />, t: "ob2_title", b: "ob2_body" },
    { illo: <IlloClock />, t: "ob3_title", b: "ob3_body" },
    { illo: <IlloAsync />, t: "ob4_title", b: "ob4_body" },
  ];
  const last = i === slides.length - 1;
  const s = slides[i];
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--navy-800)",
      padding: "var(--safe-top) 24px calc(var(--safe-bottom) + 16px)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8 }}>
        <Wordmark size={19} />
        {!last && <button onClick={() => nav("auth")} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t("skip")}</button>}
      </div>

      <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center" }}>
        <div style={{ marginBottom: 36 }}>{s.illo}</div>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em", lineHeight: 1.2, margin: "0 0 14px", textWrap: "balance" }}>{t(s.t)}</h1>
        <p style={{ fontSize: 15.5, color: "var(--text-2)", lineHeight: 1.6, maxWidth: 320, margin: 0 }}>{t(s.b)}</p>
      </div>

      <div style={{ display: "flex", gap: 7, justifyContent: "center", marginBottom: 24 }}>
        {slides.map((_, k) => (
          <button key={k} onClick={() => setI(k)} style={{ height: 7, width: k === i ? 24 : 7, borderRadius: 999, border: "none", cursor: "pointer",
            background: k === i ? "var(--teal)" : "var(--rule-strong)", transition: "all var(--t-base) var(--ease)" }} />
        ))}
      </div>

      {last ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Btn variant="primary" size="lg" full onClick={() => nav("auth")}>{t("get_started")}</Btn>
          <div style={{ textAlign: "center" }}><ShifaStrip compact /></div>
        </div>
      ) : (
        <Btn variant="primary" size="lg" full iconRight={lang === "ar" ? "arrow-left" : "arrow-right"} onClick={() => setI(i + 1)}>{t("next")}</Btn>
      )}
    </div>
  );
}

function AuthScreen() {
  const { t, nav, lang, dir } = useApp();
  const [mode, setMode] = React.useState("phone");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [pass, setPass] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const go = () => { setLoading(true); setTimeout(() => { setLoading(false); nav(mode === "phone" ? "otp" : "home", { phone }); }, 800); };
  const valid = mode === "phone" ? phone.replace(/\D/g, "").length >= 10 : email.includes("@") && pass.length >= 4;

  return (
    <div className="app-scroll" style={{ height: "100%", overflowY: "auto", background: "var(--navy-800)", padding: "calc(var(--safe-top) + 8px) 24px calc(var(--safe-bottom) + 20px)" }}>
      <Wordmark size={20} />
      <div style={{ marginTop: 36 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em", margin: "0 0 8px" }}>{t("auth_welcome")}</h1>
        <p style={{ fontSize: 15, color: "var(--text-2)", margin: 0 }}>{t("auth_sub")}</p>
      </div>

      <div style={{ marginTop: 26 }}>
        <Segmented full value={mode} onChange={setMode} options={[
          { value: "phone", label: t("tab_phone"), icon: "smartphone" },
          { value: "email", label: t("tab_email"), icon: "mail" },
        ]} />
      </div>

      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 16 }}>
        {mode === "phone" ? (
          <Field label={t("phone_label")} value={phone} onChange={setPhone} placeholder="10 1234 5678" icon="phone" inputMode="tel" dir="ltr" suffix="🇪🇬 +20" />
        ) : (
          <>
            <Field label={t("email_label")} value={email} onChange={setEmail} placeholder="you@example.com" icon="mail" type="email" dir="ltr" />
            <Field label={t("pass_label")} value={pass} onChange={setPass} placeholder="••••••••" icon="lock" type="password" dir="ltr" />
          </>
        )}
        <Btn variant="primary" size="lg" full loading={loading} disabled={!valid} onClick={go} iconRight={valid && !loading ? (dir === "rtl" ? "arrow-left" : "arrow-right") : undefined}>
          {t(mode === "phone" ? "send_code" : "sign_in")}
        </Btn>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0" }}>
        <div style={{ flex: 1, height: 1, background: "var(--rule)" }} />
        <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{t("or")}</span>
        <div style={{ flex: 1, height: 1, background: "var(--rule)" }} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Btn variant="secondary" size="lg" full icon="apple" onClick={() => nav("home")}>{t("continue_apple")}</Btn>
        <Btn variant="secondary" size="lg" full icon="chrome" onClick={() => nav("home")}>{t("continue_google")}</Btn>
      </div>

      <p style={{ fontSize: 12, color: "var(--muted)", textAlign: "center", lineHeight: 1.55, margin: "24px auto 18px", maxWidth: 300 }}>{t("terms_note")}</p>
      <ShifaStrip compact />
    </div>
  );
}

function OTPScreen() {
  const { t, nav, params, lang } = useApp();
  const [code, setCode] = React.useState("");
  const [secs, setSecs] = React.useState(28);
  const [verifying, setVerifying] = React.useState(false);
  const [showAutofill, setShowAutofill] = React.useState(false);
  React.useEffect(() => { const id = setInterval(() => setSecs(s => (s > 0 ? s - 1 : 0)), 1000); return () => clearInterval(id); }, []);
  React.useEffect(() => { const id = setTimeout(() => setShowAutofill(true), 1400); return () => clearTimeout(id); }, []);
  const complete = (val) => { setVerifying(true); setTimeout(() => nav("home"), 900); };
  const phone = params?.phone || "+20 10 1234 5678";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--navy-800)", padding: "calc(var(--safe-top) + 6px) 24px calc(var(--safe-bottom) + 20px)" }}>
      <TopBarInline onBack={() => nav("auth")} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div style={{ width: 56, height: 56, borderRadius: "var(--r-lg)", background: "var(--teal-tint)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 22 }}>
          <Ic name="message-square-lock" size={26} color="var(--teal)" />
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em", margin: "0 0 8px" }}>{t("otp_title")}</h1>
        <p style={{ fontSize: 14.5, color: "var(--text-2)", margin: "0 0 30px", lineHeight: 1.5 }}>
          {t("otp_sub")} <span dir="ltr" className="num" style={{ color: "var(--text)", fontWeight: 600 }}>{phone}</span>
        </p>

        <OTPInput value={code} onChange={setCode} onComplete={complete} />

        {showAutofill && code.length === 0 && (
          <button onClick={() => { setCode("482906"); complete("482906"); }} style={{ marginTop: 18, alignSelf: "center", display: "flex", alignItems: "center", gap: 8, background: "var(--surface-2)", border: "1px solid var(--rule-strong)", borderRadius: "var(--r-pill)", padding: "8px 14px", cursor: "pointer", color: "var(--text-2)", fontSize: 13, fontFamily: "inherit" }}>
            <Ic name="key-round" size={15} color="var(--teal)" /><span className="num">{t("otp_autofill")}</span>
          </button>
        )}

        <div style={{ marginTop: 26, textAlign: "center" }}>
          {secs > 0 ? (
            <span className="num" style={{ fontSize: 13.5, color: "var(--muted)" }}>{t("otp_in")} 0:{String(secs).padStart(2, "0")}</span>
          ) : (
            <button onClick={() => setSecs(28)} style={{ background: "none", border: "none", color: "var(--teal)", fontSize: 13.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t("otp_resend")}</button>
          )}
        </div>
      </div>
      <Btn variant="primary" size="lg" full loading={verifying} disabled={code.length < 6} onClick={() => complete(code)}>{t("otp_verify")}</Btn>
    </div>
  );
}

// tiny inline back row (no sticky bg) for full-bleed screens
function TopBarInline({ onBack }) {
  const { dir } = useApp();
  return (
    <button onClick={onBack} style={{ alignSelf: dir === "rtl" ? "flex-end" : "flex-start", background: "var(--on-navy-faint)", border: "1px solid var(--rule)", cursor: "pointer", width: 38, height: 38, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text)" }}>
      <Ic name={dir === "rtl" ? "chevron-right" : "chevron-left"} size={20} />
    </button>
  );
}

Object.assign(window, { Wordmark, OnboardingScreen, AuthScreen, OTPScreen, TopBarInline });
