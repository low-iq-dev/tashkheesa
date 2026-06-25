// components.jsx — Tashkheesa patient-app component library (navy world).
// Loaded after i18n.jsx. Defines AppContext + all shared UI primitives.

const AppContext = React.createContext(null);
const useApp = () => React.useContext(AppContext);

// ---- icon (Lucide via CDN, re-created after every commit for React safety) ----
function Ic({ name, size = 20, stroke = 1.6, color, style, className }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const el = ref.current;
    if (el && window.lucide) {
      el.innerHTML = "";
      const i = document.createElement("i");
      i.setAttribute("data-lucide", name);
      el.appendChild(i);
      try {
        window.lucide.createIcons({ attrs: { width: size, height: size, "stroke-width": stroke } });
      } catch (e) {}
    }
  });
  return <span ref={ref} className={className} style={{ display: "inline-flex", width: size, height: size, color: color || "currentColor", flexShrink: 0, ...style }} />;
}

// ---- helpers ----
function money(amount, lang) {
  const n = amount.toLocaleString("en-US");
  return lang === "ar" ? `${n} ج.م` : `EGP ${n}`;
}
function specMeta(id) { return SPECIALTIES.find(s => s.id === id) || SPECIALTIES[0]; }

// ---- Button ----
function Btn({ children, variant = "primary", size = "md", full, loading, disabled, icon, iconRight, onClick, style }) {
  const [press, setPress] = React.useState(false);
  const base = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 9,
    fontFamily: "inherit", fontWeight: 600, cursor: disabled || loading ? "default" : "pointer",
    border: "1px solid transparent", borderRadius: "var(--r-md)", whiteSpace: "nowrap",
    transition: "transform var(--t-fast) var(--ease), background var(--t-base) var(--ease), opacity var(--t-base)",
    transform: press && !disabled ? "scale(0.975)" : "scale(1)",
    width: full ? "100%" : "auto", opacity: disabled ? 0.45 : 1,
    fontSize: size === "lg" ? 16 : size === "sm" ? 13.5 : 15,
    padding: size === "lg" ? "16px 22px" : size === "sm" ? "8px 14px" : "13px 20px",
    letterSpacing: "-0.01em",
  };
  const variants = {
    primary:   { background: "var(--teal)", color: "var(--on-teal)", boxShadow: disabled ? "none" : "var(--shadow-teal)" },
    secondary: { background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--rule-strong)" },
    ghost:     { background: "transparent", color: "var(--teal)" },
    danger:    { background: "var(--danger)", color: "#2a0808" },
    report:    { background: "var(--rpt-green)", color: "#f3efe2", boxShadow: "0 6px 18px rgba(31,77,58,0.28)" },
    reportGold:{ background: "transparent", color: "var(--rpt-green)", border: "1.5px solid var(--rpt-gold)" },
  };
  return (
    <button onClick={disabled || loading ? undefined : onClick}
      onPointerDown={() => setPress(true)} onPointerUp={() => setPress(false)} onPointerLeave={() => setPress(false)}
      style={{ ...base, ...variants[variant], ...style }}>
      {loading
        ? <span className="tk-spin" style={{ width: 17, height: 17, border: "2px solid currentColor", borderRightColor: "transparent", borderRadius: "50%", display: "inline-block" }} />
        : <>{icon && <Ic name={icon} size={size === "lg" ? 20 : 18} />}{children}{iconRight && <Ic name={iconRight} size={size === "lg" ? 20 : 18} />}</>}
    </button>
  );
}

// ---- Input field ----
function Field({ label, value, onChange, placeholder, type = "text", icon, error, hint, dir, multiline, rows = 3, suffix, autoFocus, inputMode }) {
  const [focus, setFocus] = React.useState(false);
  const border = error ? "var(--danger)" : focus ? "var(--teal)" : "var(--rule-strong)";
  const shadow = focus && !error ? "0 0 0 3px var(--teal-tint)" : error ? "0 0 0 3px var(--danger-bg)" : "none";
  return (
    <label style={{ display: "block" }}>
      {label && <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)", marginBottom: 7 }}>{label}</div>}
      <div style={{ position: "relative", display: "flex", alignItems: multiline ? "flex-start" : "center",
        background: "var(--surface-2)", border: `1.5px solid ${border}`, borderRadius: "var(--r-md)",
        boxShadow: shadow, transition: "all var(--t-base) var(--ease)", padding: multiline ? "12px 14px" : "0 14px" }}>
        {icon && <Ic name={icon} size={18} color="var(--muted)" style={{ marginTop: multiline ? 2 : 0 }} />}
        {multiline ? (
          <textarea value={value} onChange={e => onChange?.(e.target.value)} placeholder={placeholder} rows={rows}
            dir={dir} autoFocus={autoFocus} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
            style={{ flex: 1, background: "none", border: "none", outline: "none", resize: "none", color: "var(--text)",
              fontFamily: "inherit", fontSize: 15, lineHeight: 1.5, padding: icon ? "0 0 0 10px" : 0 }} />
        ) : (
          <input value={value} onChange={e => onChange?.(e.target.value)} placeholder={placeholder} type={type}
            dir={dir} autoFocus={autoFocus} inputMode={inputMode} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--text)",
              fontFamily: "inherit", fontSize: 15, height: 50, padding: icon ? "0 10px" : 0 }} />
        )}
        {suffix && <span style={{ color: "var(--muted)", fontSize: 14, fontWeight: 600 }}>{suffix}</span>}
      </div>
      {error && <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 6, display: "flex", gap: 5, alignItems: "center" }}><Ic name="alert-circle" size={13} />{error}</div>}
      {hint && !error && <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 6 }}>{hint}</div>}
    </label>
  );
}

// ---- OTP entry ----
function OTPInput({ length = 6, value, onChange, onComplete }) {
  const refs = React.useRef([]);
  const setDigit = (i, d) => {
    d = d.replace(/\D/g, "").slice(-1);
    const arr = value.split("");
    arr[i] = d; const next = arr.join("").slice(0, length);
    onChange(next);
    if (d && i < length - 1) refs.current[i + 1]?.focus();
    if (next.replace(/\s/g, "").length === length) onComplete?.(next);
  };
  const onKey = (i, e) => { if (e.key === "Backspace" && !value[i] && i > 0) refs.current[i - 1]?.focus(); };
  return (
    <div style={{ display: "flex", gap: 9, justifyContent: "center", direction: "ltr" }}>
      {Array.from({ length }).map((_, i) => {
        const filled = !!value[i];
        return (
          <input key={i} ref={el => refs.current[i] = el} value={value[i] || ""} inputMode="numeric" maxLength={1}
            onChange={e => setDigit(i, e.target.value)} onKeyDown={e => onKey(i, e)}
            style={{ width: 46, height: 56, textAlign: "center", fontSize: 24, fontWeight: 700,
              fontVariantNumeric: "tabular-nums", color: "var(--text)", caretColor: "var(--teal)",
              background: filled ? "var(--teal-tint)" : "var(--surface-2)",
              border: `1.5px solid ${filled ? "var(--teal)" : "var(--rule-strong)"}`, borderRadius: "var(--r-md)",
              outline: "none", transition: "all var(--t-base) var(--ease)" }} />
        );
      })}
    </div>
  );
}

// ---- Segmented toggle ----
function Segmented({ options, value, onChange, full }) {
  return (
    <div style={{ display: "flex", background: "var(--surface-2)", borderRadius: "var(--r-md)", padding: 4, gap: 4,
      border: "1px solid var(--rule)", width: full ? "100%" : "auto" }}>
      {options.map(o => {
        const active = o.value === value;
        return (
          <button key={o.value} onClick={() => onChange(o.value)}
            style={{ flex: full ? 1 : "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
              padding: "10px 16px", borderRadius: "calc(var(--r-md) - 4px)", border: "none", cursor: "pointer",
              fontFamily: "inherit", fontSize: 14, fontWeight: 600,
              background: active ? "var(--teal)" : "transparent", color: active ? "var(--on-teal)" : "var(--text-2)",
              boxShadow: active ? "var(--shadow-1)" : "none", transition: "all var(--t-base) var(--ease)" }}>
            {o.icon && <Ic name={o.icon} size={16} />}{o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- Card ----
function Card({ children, onClick, style, pad = 16, glow }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ background: "var(--surface)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)",
        padding: pad, boxShadow: hover && onClick ? "var(--shadow-3)" : "var(--shadow-1)",
        transform: hover && onClick ? "translateY(-2px)" : "none", cursor: onClick ? "pointer" : "default",
        transition: "all var(--t-base) var(--ease)", ...style }}>
      {children}
    </div>
  );
}

// ---- Status badge ----
const STATUS_MAP = {
  submitted: { color: "var(--info)", bg: "var(--info-bg)", dot: "var(--info)", key: "st_submitted" },
  assigned:  { color: "var(--teal)", bg: "var(--teal-tint)", dot: "var(--teal)", key: "st_assigned" },
  in_review: { color: "var(--warn)", bg: "var(--warn-bg)", dot: "var(--sla-amber)", key: "st_in_review" },
  ready:     { color: "var(--success)", bg: "var(--success-bg)", dot: "var(--success)", key: "st_ready" },
  breached:  { color: "var(--danger)", bg: "var(--danger-bg)", dot: "var(--danger)", key: "st_breached" },
  followup:  { color: "var(--teal)", bg: "var(--teal-tint)", dot: "var(--teal)", key: "st_followup" },
};
function StatusBadge({ status }) {
  const { t } = useApp();
  const m = STATUS_MAP[status] || STATUS_MAP.submitted;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px 5px 9px",
      borderRadius: "var(--r-pill)", background: m.bg, color: m.color, fontSize: 12.5, fontWeight: 600 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: m.dot }} />{t(m.key)}
    </span>
  );
}

// ---- SLA chip (tier) ----
function TierChip({ tier, small }) {
  const { t } = useApp();
  const urgent = tier === "urgent";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: small ? "3px 8px" : "5px 11px",
      borderRadius: "var(--r-pill)", fontSize: small ? 11.5 : 12.5, fontWeight: 600,
      background: urgent ? "var(--warn-bg)" : "var(--on-navy-faint)", color: urgent ? "var(--warn)" : "var(--text-2)",
      border: urgent ? "1px solid rgba(251,191,36,0.3)" : "1px solid var(--rule)" }}>
      {urgent && <Ic name="zap" size={small ? 11 : 13} />}{t(urgent ? "tier_urgent" : "tier_standard")}
    </span>
  );
}

// ---- SLA countdown (live ticking) ----
function SLACountdown({ hours, overdue, size = "md", onColor }) {
  const { t, lang } = useApp();
  const [secs, setSecs] = React.useState(Math.round((overdue ? -hours : hours) * 3600));
  React.useEffect(() => {
    const id = setInterval(() => setSecs(s => s - 1), 1000);
    return () => clearInterval(id);
  }, []);
  const isOver = secs < 0;
  const abs = Math.abs(secs);
  const h = Math.floor(abs / 3600), m = Math.floor((abs % 3600) / 60), s = abs % 60;
  const total = hours;
  const urgencyColor = isOver ? "var(--danger)" : (overdue ? "var(--danger)" : (h < 6 ? "var(--warn)" : "var(--teal)"));
  const col = onColor || urgencyColor;
  const big = size === "lg";
  const pad = (n) => String(n).padStart(2, "0");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "var(--track-label)", textTransform: "uppercase",
        color: "var(--muted)" }}>{t(isOver ? "due_passed" : "due_in")}</span>
      <div className="num" style={{ display: "flex", alignItems: "baseline", gap: 2, color: col, direction: "ltr",
        fontSize: big ? 38 : 22, fontWeight: 700, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>
        <span>{pad(h)}</span><span style={{ opacity: 0.5, fontSize: "0.7em" }}>h</span>
        <span style={{ marginLeft: 4 }}>{pad(m)}</span><span style={{ opacity: 0.5, fontSize: "0.7em" }}>m</span>
        <span style={{ marginLeft: 4, opacity: 0.7 }}>{pad(s)}</span><span style={{ opacity: 0.5, fontSize: "0.7em" }}>s</span>
      </div>
    </div>
  );
}

// ---- SLA progress ring ----
function SLARing({ pct, color = "var(--teal)", size = 52, children }) {
  const r = (size - 6) / 2, c = 2 * Math.PI * r;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--rule-strong)" strokeWidth="4" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} style={{ transition: "stroke-dashoffset 0.6s var(--ease)" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>{children}</div>
    </div>
  );
}

// ---- File tile (upload states) ----
function FileTile({ file, onRemove }) {
  const { t } = useApp();
  const ext = (file.name.split(".").pop() || "").toUpperCase();
  const iconFor = { PDF: "file-text", DCM: "scan-line", JPG: "image", PNG: "image", JPEG: "image" }[ext] || "file";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, background: "var(--surface-2)",
      border: "1px solid var(--rule)", borderRadius: "var(--r-md)" }}>
      <div style={{ width: 40, height: 40, borderRadius: "var(--r-sm)", background: "var(--teal-tint)",
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Ic name={iconFor} size={20} color="var(--teal)" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{file.name}</div>
        {file.progress != null && file.progress < 100 ? (
          <div style={{ marginTop: 7 }}>
            <div style={{ height: 4, background: "var(--rule-strong)", borderRadius: 999, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${file.progress}%`, background: "var(--teal)", borderRadius: 999, transition: "width 0.2s linear" }} />
            </div>
            <span className="num" style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 4, display: "inline-block" }}>{t("uploading")} · {Math.round(file.progress)}%</span>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--success)", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
            <Ic name="check" size={13} />{file.size || t("uploaded")} · {ext}
          </div>
        )}
      </div>
      {onRemove && (file.progress == null || file.progress >= 100) && (
        <button onClick={onRemove} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 4, display: "flex" }}>
          <Ic name="x" size={18} />
        </button>
      )}
    </div>
  );
}

// ---- vertical timeline / stepper ----
function Timeline({ steps }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const c = s.state === "done" ? "var(--success)" : s.state === "active" ? "var(--teal)" : "var(--muted-2)";
        return (
          <div key={i} style={{ display: "flex", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
                background: s.state === "done" ? "var(--success-bg)" : s.state === "active" ? "var(--teal-tint)" : "var(--surface-2)",
                border: `1.5px solid ${c}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {s.state === "done" ? <Ic name="check" size={14} color={c} />
                  : s.state === "active" ? <span style={{ width: 8, height: 8, borderRadius: "50%", background: c }} className="tk-pulse" />
                  : <span style={{ width: 6, height: 6, borderRadius: "50%", background: c }} />}
              </div>
              {!last && <div style={{ width: 2, flex: 1, minHeight: 26, background: s.state === "done" ? "var(--success)" : "var(--rule-strong)", margin: "4px 0" }} />}
            </div>
            <div style={{ paddingBottom: last ? 0 : 20, flex: 1 }}>
              <div style={{ fontSize: 14.5, fontWeight: 600, color: s.state === "pending" ? "var(--muted)" : "var(--text)" }}>{s.title}</div>
              {s.meta && <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>{s.meta}</div>}
              {s.body && <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 5, lineHeight: 1.5 }}>{s.body}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- wizard progress (top steps) ----
function WizardProgress({ steps, current }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {steps.map((s, i) => (
        <div key={i} style={{ flex: 1, height: 4, borderRadius: 999,
          background: i <= current ? "var(--teal)" : "var(--rule-strong)",
          transition: "background var(--t-slow) var(--ease)" }} />
      ))}
    </div>
  );
}

// ---- bottom sheet / modal ----
function Sheet({ open, onClose, children, title }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 100, display: "flex", flexDirection: "column",
      justifyContent: "flex-end", background: "rgba(4,9,18,0.6)", backdropFilter: "blur(2px)",
      animation: "tkFade var(--t-base) var(--ease)" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "var(--surface)", borderTopLeftRadius: "var(--r-2xl)",
        borderTopRightRadius: "var(--r-2xl)", borderTop: "1px solid var(--rule-strong)", padding: "10px 20px calc(20px + var(--safe-bottom))",
        boxShadow: "var(--shadow-3)", animation: "tkSlideUp var(--t-slow) var(--ease-out)", maxHeight: "82%", overflowY: "auto" }} className="app-scroll">
        <div style={{ width: 38, height: 4, borderRadius: 999, background: "var(--rule-strong)", margin: "0 auto 16px" }} />
        {title && <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 14 }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

// ---- toast ----
function Toast({ toast }) {
  if (!toast) return null;
  const accent = { success: "var(--success)", error: "var(--danger)", info: "var(--teal)" }[toast.type || "info"];
  const icon = { success: "check-circle-2", error: "alert-triangle", info: "info" }[toast.type || "info"];
  return (
    <div style={{ position: "absolute", top: "calc(var(--safe-top) + 6px)", left: 16, right: 16, zIndex: 200,
      display: "flex", alignItems: "center", gap: 11, padding: "13px 15px", background: "var(--surface)",
      border: "1px solid var(--rule-strong)", borderLeft: `3px solid ${accent}`, borderRadius: "var(--r-md)",
      boxShadow: "var(--shadow-3)", animation: "tkToast var(--t-slow) var(--ease-out)" }}>
      <Ic name={icon} size={19} color={accent} />
      <span style={{ fontSize: 14, color: "var(--text)", fontWeight: 500, flex: 1 }}>{toast.msg}</span>
    </div>
  );
}

// ---- empty state ----
function EmptyState({ illo, title, body, action }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "44px 28px" }}>
      <div style={{ width: 92, height: 92, borderRadius: "50%", background: "var(--surface)", border: "1px solid var(--rule)",
        display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20 }}>
        <Ic name={illo || "inbox"} size={38} stroke={1.3} color="var(--teal)" />
      </div>
      <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text)", marginBottom: 7 }}>{title}</div>
      {body && <div style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.55, maxWidth: 260, marginBottom: action ? 20 : 0 }}>{body}</div>}
      {action}
    </div>
  );
}

// ---- skeleton ----
function Skeleton({ h = 16, w = "100%", r = 8, style }) {
  return <div className="tk-shimmer" style={{ height: h, width: w, borderRadius: r, ...style }} />;
}

// ---- bottom tab bar ----
function TabBar({ active, onTab }) {
  const { t } = useApp();
  const tabs = [
    { id: "home", icon: "home", label: "tab_home" },
    { id: "cases", icon: "folder-heart", label: "tab_cases" },
    { id: "new", icon: "plus", label: "tab_new", center: true },
    { id: "alerts", icon: "bell", label: "tab_alerts" },
    { id: "account", icon: "user-round", label: "tab_account" },
  ];
  return (
    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 40,
      background: "rgba(8,17,32,0.86)", backdropFilter: "blur(18px) saturate(160%)",
      borderTop: "1px solid var(--rule)", padding: "9px 8px calc(8px + var(--safe-bottom))",
      display: "flex", justifyContent: "space-around", alignItems: "flex-end" }}>
      {tabs.map(tb => {
        if (tb.center) {
          return (
            <button key={tb.id} onClick={() => onTab(tb.id)} style={{ background: "none", border: "none", cursor: "pointer",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4, transform: "translateY(-2px)" }}>
              <span style={{ width: 50, height: 38, borderRadius: 14, background: "var(--teal)", color: "var(--on-teal)",
                display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "var(--shadow-teal)" }}>
                <Ic name="plus" size={24} stroke={2.2} />
              </span>
            </button>
          );
        }
        const on = active === tb.id;
        return (
          <button key={tb.id} onClick={() => onTab(tb.id)} style={{ background: "none", border: "none", cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flex: 1, padding: "2px 0",
            color: on ? "var(--teal)" : "var(--muted)" }}>
            <Ic name={tb.icon} size={23} stroke={on ? 2 : 1.6} />
            <span style={{ fontSize: 10.5, fontWeight: on ? 700 : 500 }}>{t(tb.label)}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---- screen header (back + title) ----
function TopBar({ title, onBack, right, transparent, dark = true }) {
  const { dir } = useApp();
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 30, paddingTop: "var(--safe-top)",
      background: transparent ? "transparent" : "rgba(8,17,32,0.82)", backdropFilter: transparent ? "none" : "blur(16px)",
      borderBottom: transparent ? "none" : "1px solid var(--rule-faint)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px 12px", minHeight: 50 }}>
        {onBack ? (
          <button onClick={onBack} style={{ background: "var(--on-navy-faint)", border: "1px solid var(--rule)", cursor: "pointer",
            width: 38, height: 38, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text)" }}>
            <Ic name={dir === "rtl" ? "chevron-right" : "chevron-left"} size={20} />
          </button>
        ) : <div style={{ width: 4 }} />}
        <div style={{ flex: 1, fontSize: 17, fontWeight: 700, color: "var(--text)", textAlign: "center" }}>{title}</div>
        <div style={{ minWidth: 38, display: "flex", justifyContent: "flex-end" }}>{right}</div>
      </div>
    </div>
  );
}

// ---- specialty avatar ----
function SpecialtyIcon({ id, size = 44, active }) {
  const m = specMeta(id);
  return (
    <div style={{ width: size, height: size, borderRadius: "var(--r-md)", flexShrink: 0,
      background: active ? "var(--teal)" : "var(--teal-tint)", color: active ? "var(--on-teal)" : "var(--teal)",
      display: "flex", alignItems: "center", justifyContent: "center", transition: "all var(--t-base) var(--ease)" }}>
      <Ic name={m.icon} size={size * 0.5} stroke={1.6} />
    </div>
  );
}

// ---- trust strip ----
function ShifaStrip({ compact }) {
  const { t } = useApp();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: compact ? "10px 12px" : "13px 14px",
      background: "var(--on-navy-faint)", border: "1px solid var(--rule)", borderRadius: "var(--r-md)" }}>
      <Ic name="shield-check" size={compact ? 18 : 20} color="var(--teal)" />
      <span style={{ fontSize: compact ? 12 : 12.5, color: "var(--text-2)", lineHeight: 1.45 }}>{t(compact ? "backed_by" : "trust_strip")}</span>
    </div>
  );
}

Object.assign(window, {
  AppContext, useApp, money, specMeta,
  Ic, Btn, Field, OTPInput, Segmented, Card, StatusBadge, TierChip, SLACountdown, SLARing,
  FileTile, Timeline, WizardProgress, Sheet, Toast, EmptyState, Skeleton, TabBar, TopBar,
  SpecialtyIcon, ShifaStrip, STATUS_MAP,
});
