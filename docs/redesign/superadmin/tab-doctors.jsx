/* global React, Kpi, Card, I, BarRow */

function DoctorsTab({ data }) {
  const d = data.doctors;
  const statusColor = { ok: "var(--green)", risk: "var(--amber)", gap: "var(--red)" };

  return (
    <div className="tab-pane active" id="pane-doctors">
      <div className="section-h" style={{ marginTop: 4 }}>
        <h2>Doctors & Performance</h2>
        <div className="meta">{d.kpis[0].value} active · {d.kpis[1].value} pending</div>
      </div>

      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        {d.kpis.map((k, i) => <Kpi key={i} {...k} />)}
      </div>

      <div className="section-h"><h2>Leaderboard · last 30d</h2>
        <div className="actions"><button className="btn"><I.download /> CSV</button></div>
      </div>
      <Card tight>
        <table className="tbl">
          <thead><tr>
            <th>Doctor</th><th>Specialty</th><th className="num">Cases</th><th>Avg TTR</th>
            <th>SLA hit</th><th>Rating</th><th className="num">Revenue</th><th className="num">Owed</th>
          </tr></thead>
          <tbody>
            {d.leaderboard.map((r, i) => (
              <tr key={i}>
                <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}><div className="avatar">{r.name.split(" ")[1][0]}</div>{r.name}</div></td>
                <td><span className="spec-tag">{r.spec}</span></td>
                <td className="num">{r.cases}</td>
                <td className="tabular">{r.ttr}</td>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div className="bar-track" style={{ width: 60 }}><div className="bar-fill" style={{ width: `${r.sla}%`, background: r.sla >= 90 ? "var(--green)" : r.sla >= 80 ? "var(--amber)" : "var(--red)" }} /></div>
                    <span className="tabular" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{r.sla}%</span>
                  </div>
                </td>
                <td className="tabular">★ {r.rating}</td>
                <td className="num">{r.rev.toLocaleString()}</td>
                <td className="num">{r.owed > 0 ? r.owed.toLocaleString() : <span style={{ color: "var(--fg-3)" }}>—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <Card title="Onboarding pipeline" sub="3 stages">
          <div style={{ display: "flex", gap: 8 }}>
            {d.pipeline.map((p, i) => (
              <div key={i} style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 8, padding: 10, background: "var(--bg-1)" }}>
                <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: ".06em" }}>{p.stage}</div>
                <div style={{ fontSize: 22, fontWeight: 600, marginBlock: 4 }}>{p.count}</div>
                <div style={{ fontSize: 11, color: "var(--fg-2)", lineHeight: 1.6 }}>
                  {p.items.length ? p.items.slice(0, 3).map((it, j) => <div key={j}>· {it}</div>) : <span style={{ color: "var(--fg-3)" }}>—</span>}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Specialty coverage" sub="<2 active = risk">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
            {d.coverage.map((c, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-1)" }}>
                <span style={{ fontSize: 12 }}>{c.spec}</span>
                <span className="tabular" style={{ fontSize: 12, fontWeight: 600, color: statusColor[c.status] }}>{c.active}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 14, fontSize: 11, color: "var(--fg-2)" }}>
            <span><span className="dot-led" />ok ≥2</span>
            <span><span className="dot-led amber" />risk =1</span>
            <span><span className="dot-led red" />gap =0</span>
          </div>
        </Card>
      </div>
    </div>
  );
}

window.DoctorsTab = DoctorsTab;
