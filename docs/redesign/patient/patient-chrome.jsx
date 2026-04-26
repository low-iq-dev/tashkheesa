// ============================================================
// Tashkheesa Patient Portal — shared chrome + small components
// ============================================================

// Icon system — minimal inline 1.5px stroke
function Icon({ name, size = 16, color }) {
  const S = size;
  const props = { width: S, height: S, viewBox: "0 0 24 24", fill: "none",
                  stroke: color || "currentColor", strokeWidth: 1.5,
                  strokeLinecap: "round", strokeLinejoin: "round" };
  const paths = {
    home: "M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-7h-6v7H4a1 1 0 01-1-1z",
    case: "M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M3 6h18v14a1 1 0 01-1 1H4a1 1 0 01-1-1zM3 11h18",
    plus: "M12 5v14M5 12h14",
    message: "M8 12h8M8 8h5M21 12a8 8 0 01-8 8H5l3-3A8 8 0 1121 12z",
    file: "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 13h6M9 17h4",
    profile: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 22v-1a6 6 0 016-6h4a6 6 0 016 6v1",
    bell: "M15 17H9a6 6 0 016-6V8a3 3 0 00-6 0v3a6 6 0 01-3 5.2M10 21h4",
    settings: "M12 8a4 4 0 110 8 4 4 0 010-8zM3 12h2M19 12h2M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4",
    logout: "M16 17l5-5-5-5M21 12H9M13 3H5v18h8",
    lock: "M6 10V7a6 6 0 0112 0v3M5 10h14v10H5z",
    shield: "M12 2l8 3v7c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V5z",
    check: "M5 12l5 5 10-10",
    chevR: "M9 6l6 6-6 6",
    chevL: "M15 6l-9 6 9 6",
    chevD: "M6 9l6 6 6-6",
    clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
    upload: "M12 15V3m0 0l-5 5m5-5l5 5M5 15v4a2 2 0 002 2h10a2 2 0 002-2v-4",
    calendar: "M4 6h16v14H4zM8 2v4M16 2v4M4 10h16",
    helpCircle: "M12 21a9 9 0 100-18 9 9 0 000 18zM9 9a3 3 0 115.5 1.8c-1 1-2.5 1.5-2.5 3.2M12 17h.01",
    star: "M12 3l2.6 5.3 5.9.9-4.3 4.2 1 5.9L12 16.5 6.8 19.3l1-5.9L3.5 9.2l5.9-.9z",
    search: "M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4-4",
    mail: "M3 6h18v12H3zM3 6l9 7 9-7",
    phone: "M22 16.9v3a2 2 0 01-2.2 2 19 19 0 01-8.3-3 19 19 0 01-6-6A19 19 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.3 1.8.6 2.6a2 2 0 01-.4 2.1L8 9.5a16 16 0 006 6l1.1-1.1a2 2 0 012.1-.4c.8.3 1.7.5 2.6.6a2 2 0 011.7 2z",
    mapPin: "M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0zM12 10a3 3 0 110-6 3 3 0 010 6z",
    globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18",
    download: "M12 3v12m0 0l-5-5m5 5l5-5M5 21h14",
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
    alert: "M12 2L2 21h20zM12 10v5M12 18h.01",
    x: "M18 6L6 18M6 6l12 12",
    send: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
    paperclip: "M21 12l-8.5 8.5a6 6 0 01-8.5-8.5L12 4a4 4 0 015.7 5.7L9 18a2 2 0 11-2.8-2.8L13 8.5",
    sparkle: "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8",
    activity: "M22 12h-4l-3 9L9 3l-3 9H2",
    heart: "M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 00-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 000-7.8z",
  };
  return <svg {...props}><path d={paths[name] || paths.home} /></svg>;
}

// Patient sidebar
function PSidebar({ active = "dashboard", variant = "dark", onNav = () => {}, unread = 0, trustDensity = "medium" }) {
  const items = [
    { k: "dashboard", label: "Home", icon: "home" },
    { k: "new_case", label: "New case", icon: "plus" },
    { k: "cases", label: "My cases", icon: "case", count: "1" },
    { k: "messages", label: "Messages", icon: "message", count: unread ? String(unread) : null },
    { k: "documents", label: "Documents", icon: "file" },
  ];
  const accountItems = [
    { k: "profile", label: "Profile", icon: "profile" },
    { k: "notifications", label: "Notifications", icon: "bell" },
    { k: "signout", label: "Sign out", icon: "logout" },
  ];
  return (
    <aside className={`p-sidebar ${variant === "light" ? "p-sidebar--light" : ""}`}>
      <div className="p-sidebar__brand">
        <div className="p-sidebar__tile">ت</div>
        <div>
          <div className="p-sidebar__wordmark">Tashkheesa</div>
          <div className="p-sidebar__tag">Second opinions</div>
        </div>
      </div>

      <div className="p-nav-sec">Your care</div>
      {items.map(i => (
        <div key={i.k} className={`p-nav ${active === i.k ? "active" : ""}`} onClick={() => onNav(i.k)}>
          <Icon name={i.icon} />
          <span>{i.label}</span>
          {i.count ? <span className="p-nav__count">{i.count}</span> : null}
        </div>
      ))}

      <div className="p-nav-sec">Account</div>
      {accountItems.map(i => (
        <div key={i.k} className={`p-nav ${active === i.k ? "active" : ""}`} onClick={() => onNav(i.k)}>
          <Icon name={i.icon} />
          <span>{i.label}</span>
        </div>
      ))}

      {trustDensity !== "light" && (
        <div className="p-sidebar__trust">
          <div className="p-sidebar__trust-row"><Icon name="shield" size={13} /><span>End-to-end encrypted</span></div>
          <div className="p-sidebar__trust-row"><Icon name="check" size={13} /><span>Licensed Egyptian doctors</span></div>
          {trustDensity === "heavy" && (
            <div className="p-sidebar__trust-row"><Icon name="heart" size={13} /><span>Shifa Hospital partner</span></div>
          )}
        </div>
      )}

      <div className="p-sidebar__me">
        <div className="p-sidebar__avatar">{PDATA.patient.initials}</div>
        <div>
          <div className="p-sidebar__me-name">{PDATA.patient.name}</div>
          <div className="p-sidebar__me-sub">{PDATA.patient.email}</div>
        </div>
      </div>
    </aside>
  );
}

function PTopbar({ title, sub, serif, children }) {
  return (
    <div className="p-topbar">
      <div style={{flex: 1}}>
        <div className={serif ? "p-topbar__title p-topbar__title-serif" : "p-topbar__title"}>{title}</div>
        {sub ? <div className="p-topbar__sub">{sub}</div> : null}
      </div>
      <div className="p-topbar__actions">{children}</div>
    </div>
  );
}

function Avatar({ size = 40, initials, tone = "teal" }) {
  const bg = tone === "brass" ? "var(--accent-light)" : "var(--primary-light)";
  const fg = tone === "brass" ? "var(--accent-dark)" : "var(--primary-dark)";
  return (
    <div style={{
      width: size, height: size, borderRadius: size >= 44 ? 14 : 10,
      background: bg, color: fg, display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: 700, fontSize: size >= 44 ? 16 : 13, flexShrink: 0,
      fontFamily: size >= 44 ? "var(--font-display)" : "var(--font-sans)",
    }}>{initials}</div>
  );
}

// Doctor card — used on dashboard, case detail, post-payment
function DoctorCard({ compact = false }) {
  const d = PDATA.doctor;
  return (
    <div className="doc-card">
      <div className="doc-card__photo">{d.initials}</div>
      <div style={{minWidth: 0}}>
        <div className="doc-card__name">{d.name}</div>
        <div className="doc-card__role">{d.role} · {d.credentials}</div>
        {!compact && (
          <div className="doc-card__meta">
            <span><Icon name="mapPin" size={12} />{d.hospital}</span>
            <span><Icon name="globe" size={12} />{d.languages}</span>
            <span><Icon name="star" size={12} color="#B38B3E" />{d.rating} · {d.reviews} reviews</span>
          </div>
        )}
      </div>
    </div>
  );
}

// File tile with icon by type
function FileTile({ f, compact = false }) {
  const iconByType = { scan: "activity", report: "file", labs: "activity", letter: "mail" };
  return (
    <div className="file-tile">
      <div className="file-tile__icon"><Icon name={iconByType[f.icon] || "file"} size={16} /></div>
      <div style={{flex: 1, minWidth: 0}}>
        <div className="file-tile__name" style={{whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>{f.name}</div>
        <div className="file-tile__meta">{f.type} · {f.size}</div>
      </div>
      {!compact && (
        <button className="p-btn p-btn--ghost p-btn--sm"><Icon name="download" size={14} /></button>
      )}
    </div>
  );
}

// Progress track for multi-step flows
function ProgressTrack({ step, total, labels }) {
  return (
    <div>
      <div className="p-track">
        {Array.from({length: total}).map((_, i) => {
          const cls = i < step ? "is-done" : i === step ? "is-active" : "";
          return <div key={i} className={`p-track__step ${cls}`} />;
        })}
      </div>
      {labels && (
        <div style={{display: "grid", gridAutoFlow: "column", gridAutoColumns: "1fr", gap: 8, marginTop: 8, fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600}}>
          {labels.map((l, i) => (
            <div key={i} style={{color: i === step ? "var(--primary-dark)" : i < step ? "var(--ink)" : "var(--muted)"}}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { Icon, PSidebar, PTopbar, Avatar, DoctorCard, FileTile, ProgressTrack });
