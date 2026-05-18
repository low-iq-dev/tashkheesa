/* global React */
const { useState, useEffect, useMemo } = React;

// ----- Tiny inline icons (stroke = currentColor) -----
const I = {
  search:  () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>,
  bolt:    () => <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>,
  plus:    () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>,
  refresh: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>,
  download:() => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4v12M6 12l6 6 6-6M4 20h16"/></svg>,
  alert:   () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.5"/></svg>,
  arrowUp: () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>,
  arrowDn: () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg>,
  ext:     () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 4h6v6M10 14L20 4M19 13v6H5V5h6"/></svg>,
  more:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>,
  check:   () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7"/></svg>,
  x:       () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 6l12 12M18 6L6 18"/></svg>,
  play:    () => <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>,
  clock:   () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
};

// ----- Sparkline -----
function Spark({ data = [], w = 70, h = 24, color }) {
  if (!data.length) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data.map((d, i) => `${i * step},${h - ((d - min) / range) * (h - 2) - 1}`);
  const path = `M${pts.join(" L")}`;
  const area = `${path} L${w},${h} L0,${h} Z`;
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={color ? { color } : null}>
      <path className="spark-area" d={area} />
      <path className="spark-path" d={path} />
    </svg>
  );
}

// ----- KPI card -----
function Kpi({ label, value, unit, sub, delta, spark }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {delta && (
            <span className={`delta ${delta.dir}`}>
              {delta.dir === "up" ? <I.arrowUp /> : <I.arrowDn />} {delta.v}
            </span>
          )}
          {sub && <span className="sub">{sub}</span>}
        </div>
      </div>
      {spark && <Spark data={spark} />}
    </div>
  );
}

// ----- Card wrapper -----
function Card({ title, sub, actions, children, tight }) {
  return (
    <div className="card">
      {(title || actions) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          {sub && <span className="sub">{sub}</span>}
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      <div className={`card-body${tight ? " tight" : ""}`}>{children}</div>
    </div>
  );
}

// ----- Empty state -----
function Empty({ title, sub }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {sub}
    </div>
  );
}

// ----- Bar row -----
function BarRow({ label, value, max, color, suffix }) {
  const pct = Math.min(100, (value / (max || 1)) * 100);
  return (
    <div className="bar-row">
      <span className="lab">{label}</span>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%`, background: color || "var(--accent)" }} /></div>
      <span className="v">{value.toLocaleString()}{suffix || ""}</span>
    </div>
  );
}

// ----- Tier strip (multi-color stacked) -----
function TierStrip({ segments }) {
  const total = segments.reduce((a, b) => a + b.v, 0);
  return (
    <div className="tier-strip" title={segments.map(s => `${s.label}: ${s.v}`).join(" · ")}>
      {segments.map((s, i) => (
        <div key={i} style={{ width: `${(s.v / total) * 100}%`, background: s.color }} />
      ))}
    </div>
  );
}

// Export to window
Object.assign(window, { I, Spark, Kpi, Card, Empty, BarRow, TierStrip });
