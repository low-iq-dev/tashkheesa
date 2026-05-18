/* global React, Kpi, Card, I */

function PatientsTab({ data }) {
  const p = data.patients;
  const maxGeo = Math.max(...p.geo.map(g => g.count));

  return (
    <div className="tab-pane active" id="pane-patients">
      <div className="section-h" style={{ marginTop: 4 }}>
        <h2>Patients & Growth</h2>
        <div className="meta">147 lifetime · 26 new this week</div>
      </div>

      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        {p.kpis.map((k, i) => <Kpi key={i} {...k} />)}
      </div>

      <div className="grid-2-1">
        <Card title="Cohort retention" sub="weekly · % returning for ≥1 case">
          <table className="tbl" style={{ fontSize: 11.5 }}>
            <thead><tr><th>Cohort</th><th>Size</th><th>W0</th><th>W1</th><th>W2</th><th>W3</th><th>W4</th></tr></thead>
            <tbody>
              {p.cohorts.map((c, i) => (
                <tr key={i}>
                  <td className="mono">{c.wk}</td>
                  <td className="tabular">{c.size}</td>
                  {[0, 1, 2, 3, 4].map(j => {
                    const v = c.vals[j];
                    if (v == null) return <td key={j} style={{ color: "var(--fg-3)" }}>—</td>;
                    const a = (v / 100) * 0.6 + 0.05;
                    return <td key={j} style={{ background: `oklch(0.42 0.13 var(--accent-h) / ${a})`, color: "var(--fg)", fontVariantNumeric: "tabular-nums", textAlign: "center" }}>{v}%</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Acquisition source" sub="last 7d">
          {p.sources.map((s, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                <span>{s.name}</span><span className="tabular" style={{ fontWeight: 600 }}>{s.count} <span style={{ color: "var(--fg-3)" }}>· {s.pct}%</span></span>
              </div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${s.pct}%`, background: s.color }} /></div>
            </div>
          ))}
        </Card>
      </div>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <Card title="Geographic distribution" sub="all-time">
          {p.geo.map((g, i) => (
            <div key={i} style={{ marginBottom: 7 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                <span>{g.region}</span>
                <span className="tabular" style={{ color: "var(--fg-2)" }}>{g.count} <span style={{ color: "var(--fg-3)" }}>· {g.pct}%</span></span>
              </div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${(g.count / maxGeo) * 100}%` }} /></div>
            </div>
          ))}
        </Card>

        <Card title="Recent reviews" sub="★ 4.7 avg" actions={<button className="btn">All reviews <I.ext /></button>}>
          {p.reviews.map((r, i) => (
            <div key={i} style={{ paddingBlock: 9, borderBottom: i < p.reviews.length - 1 ? "1px solid var(--line-soft)" : 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <div className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>{r.who.split(" ")[0][0]}</div>
                <strong style={{ fontSize: 12 }}>{r.who}</strong>
                <span className="spec-tag">{r.spec}</span>
                <span style={{ marginInlineStart: "auto", color: "var(--amber)", fontSize: 12 }}>{"★".repeat(r.rating)}</span>
                <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{r.when}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--fg-1)", lineHeight: 1.5 }}>{r.text}</div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

window.PatientsTab = PatientsTab;
