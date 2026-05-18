/* global React, Kpi, Card, Empty, I, BarRow, TierStrip */

function OpsTab({ data, attentionVisible }) {
  const ops = data.ops;
  const tierColors = { Urgent: "var(--red)", VIP: "var(--violet)", Standard: "var(--accent)" };
  const riskChip = { red: "red", amber: "amber", green: "green" };

  return (
    <div className="tab-pane active" id="pane-operations">
      <div className="section-h" style={{ marginTop: 4 }}>
        <h2>Live Ops · {new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</h2>
        <div className="meta">Auto-refresh every 30s · last update just now</div>
      </div>

      <div className="kpi-strip">
        {ops.kpis.map((k, i) => <Kpi key={i} {...k} />)}
      </div>

      <div className="section-h">
        <h2>SLA risk board</h2>
        <div className="actions">
          <button className="btn"><I.refresh /> Run sweep</button>
          <button className="btn">Reassign batch</button>
        </div>
      </div>
      <div className="grid-2-1">
        <Card>
          <div className="sla-buckets">
            {ops.slaBuckets.map((b, i) => (
              <div key={i} className={`sla-bucket ${b.tier}`}>
                <div className="h">
                  <span className={`dot-led ${b.tier === "red" ? "red" : b.tier === "amber" ? "amber" : ""}`} />
                  {b.label}
                </div>
                <div className="n">{b.n}</div>
                <div className="d">{b.sub}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>
              Distribution by urgency tier · today
            </div>
            <TierStrip segments={[
              { label: "Urgent", v: 4, color: "var(--red)" },
              { label: "VIP", v: 2, color: "var(--violet)" },
              { label: "Standard", v: 5, color: "var(--accent)" },
            ]} />
            <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 11.5, color: "var(--fg-2)" }}>
              <span><span className="dot-led red" />Urgent · 4 · 1.6×</span>
              <span><span className="dot-led" style={{ background: "var(--violet)" }} />VIP · 2 · 1.3×</span>
              <span><span className="dot-led" style={{ background: "var(--accent)" }} />Standard · 5 · 1.0×</span>
            </div>
          </div>
        </Card>

        <Card title="Quick actions" sub="Operations">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button className="btn primary" style={{ justifyContent: "flex-start" }}><I.bolt /> Run SLA Check</button>
            <button className="btn" style={{ justifyContent: "flex-start" }}><I.refresh /> Reassign case</button>
            <button className="btn" style={{ justifyContent: "flex-start" }}>↑ Force urgency uplift</button>
            <button className="btn" style={{ justifyContent: "flex-start" }}>💬 Message doctor</button>
            <button className="btn" style={{ justifyContent: "flex-start" }}><I.plus /> Create order</button>
          </div>
          <div style={{ marginTop: 12, padding: 10, background: "var(--bg-1)", borderRadius: 6, fontSize: 11.5, color: "var(--fg-2)" }}>
            <div style={{ color: "var(--fg-1)", fontWeight: 600, marginBottom: 4 }}>Last sweep</div>
            11:02 · 14 cases scanned · <span style={{ color: "var(--red)" }}>2 breached</span> · 3 escalated
          </div>
        </Card>
      </div>

      <div className="grid-2-1">
        <div>
          <div className="section-h">
            <h2>Recent cases · live</h2>
            <div className="actions">
              <button className="btn">All cases <I.ext /></button>
            </div>
          </div>
          <Card tight>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Patient</th>
                  <th>Service</th>
                  <th>Tier</th>
                  <th>Doctor</th>
                  <th>Deadline</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {ops.cases.map(c => (
                  <tr key={c.id}>
                    <td className="id">{c.id}</td>
                    <td>{c.patient}<div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{c.spec}</div></td>
                    <td>{c.service}</td>
                    <td><span className="chip dot" style={{ color: tierColors[c.tier], background: "transparent", borderColor: "var(--line)" }}>{c.tier}</span></td>
                    <td>{c.doc === "—" ? <span style={{ color: "var(--fg-3)" }}>unassigned</span> : c.doc}</td>
                    <td><span className={`chip ${riskChip[c.risk]}`}>{c.deadline}</span></td>
                    <td>{c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>

        <div>
          <div className="section-h"><h2>Doctor status</h2><div className="meta">5 of 12</div></div>
          <Card tight>
            <div className="list">
              {ops.doctors.map((d, i) => (
                <div key={i} className="list-row" style={{ gridTemplateColumns: "26px 1fr auto" }}>
                  <div className="avatar">
                    {d.name.split(" ")[1][0]}
                    <span className={`presence ${d.presence}`} />
                  </div>
                  <div>
                    <div style={{ fontWeight: 500 }}>{d.name}</div>
                    <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{d.spec} · {d.status} · ttr {d.ttr}</div>
                  </div>
                  <div style={{ textAlign: "end", fontVariantNumeric: "tabular-nums" }}>
                    <div style={{ fontWeight: 600 }}>{d.active}</div>
                    <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>active</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

window.OpsTab = OpsTab;
