/* global React, Kpi, Card, Spark, I, BarRow */

function FinanceTab({ data }) {
  const f = data.finance;
  return (
    <div className="tab-pane active" id="pane-finance">
      <div className="section-h" style={{ marginTop: 4 }}>
        <h2>Finance · MTD May 2026</h2>
        <div className="meta">All amounts in EGP · Paymob settled + pending shown separately</div>
      </div>

      <div className="kpi-strip">
        {f.kpis.map((k, i) => <Kpi key={i} {...k} />)}
      </div>

      <div className="grid-3" style={{ marginTop: 12 }}>
        <Card title="Revenue by service tier" sub="MTD">
          {f.serviceTier.map((s, i) => {
            const max = Math.max(...f.serviceTier.map(x => x.rev));
            return (
              <div key={i} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                  <span><strong>{s.name}</strong> <span style={{ color: "var(--fg-3)" }}>· floor {s.floor}</span></span>
                  <span className="tabular" style={{ color: "var(--fg-2)" }}>{s.cases} cases · <strong style={{ color: "var(--fg)" }}>{s.rev.toLocaleString()}</strong></span>
                </div>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${(s.rev / max) * 100}%` }} /></div>
              </div>
            );
          })}
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 6 }}>Floors from pricing v2 · uplift not included here.</div>
        </Card>

        <Card title="By urgency tier" sub="Uplift contribution">
          {f.urgencyTier.map((u, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: i < 2 ? "1px solid var(--line-soft)" : "0" }}>
              <div>
                <div style={{ fontWeight: 500 }}>{u.name} <span className="chip" style={{ marginInlineStart: 6, color: u.color }}>{u.mult}</span></div>
                <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{u.cases} cases</div>
              </div>
              <div style={{ textAlign: "end" }}>
                <div className="tabular" style={{ fontWeight: 600 }}>+{u.uplift.toLocaleString()}</div>
                <div style={{ fontSize: 11, color: "var(--fg-3)" }}>EGP uplift</div>
              </div>
            </div>
          ))}
        </Card>

        <Card title="By FX zone" sub="MTD">
          {f.fxZone.map((z, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: i < 2 ? "1px solid var(--line-soft)" : "0" }}>
              <div>
                <div style={{ fontWeight: 500 }}>{z.name} <span className="chip" style={{ marginInlineStart: 6, color: z.color }}>{z.mult}</span></div>
                <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{z.cases} cases</div>
              </div>
              <div className="tabular" style={{ fontWeight: 600, alignSelf: "center" }}>{z.rev.toLocaleString()}</div>
            </div>
          ))}
        </Card>
      </div>

      <div className="grid-2-1">
        <div>
          <div className="section-h">
            <h2>Doctor payout ledger</h2>
            <div className="actions">
              <button className="btn"><I.download /> CSV</button>
              <button className="btn primary">Pay all (12,000 EGP)</button>
            </div>
          </div>
          <Card tight>
            <table className="tbl">
              <thead><tr><th>Doctor</th><th>Cases (cycle)</th><th className="num">Owed</th><th>Last paid</th><th>Next payout</th><th></th></tr></thead>
              <tbody>
                {f.payouts.map((p, i) => (
                  <tr key={i}>
                    <td>{p.doctor}</td>
                    <td className="tabular">{p.cases}</td>
                    <td className="num">{p.owed.toLocaleString()}</td>
                    <td>{p.lastPaid}</td>
                    <td>{p.next}</td>
                    <td style={{ textAlign: "end" }}>{p.owed > 0 ? <button className="btn">Pay</button> : <span style={{ color: "var(--fg-3)", fontSize: 11 }}>—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>

        <div>
          <div className="section-h"><h2>Paymob today</h2><div className="meta">live</div></div>
          <Card>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: ".06em" }}>Settled</div>
                <div className="tabular" style={{ fontSize: 18, fontWeight: 600 }}>{f.paymob.today.settled}</div>
              </div>
              <div>
                <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: ".06em" }}>Pending</div>
                <div className="tabular" style={{ fontSize: 18, fontWeight: 600 }}>{f.paymob.today.pending}</div>
              </div>
              <div><div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>Success</div><div className="tabular" style={{ fontSize: 14, color: "var(--green)", fontWeight: 600 }}>{f.paymob.today.success} txns</div></div>
              <div><div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>Failed</div><div className="tabular" style={{ fontSize: 14, color: "var(--red)", fontWeight: 600 }}>{f.paymob.today.failed} txn</div></div>
            </div>
            <div style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 8 }}>
              <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Recent</div>
              {f.paymob.recent.map((r, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 12, borderBottom: i < 4 ? "1px solid var(--line-soft)" : 0 }}>
                  <span className="mono" style={{ color: "var(--fg-2)" }}>{r.id}</span>
                  <span className="tabular">{r.amount}</span>
                  <span className={`chip ${r.status === "settled" ? "green" : r.status === "failed" ? "red" : "amber"}`}>{r.status}</span>
                  <span className="mono" style={{ color: "var(--fg-3)", fontSize: 11 }}>{r.time}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

window.FinanceTab = FinanceTab;
