/* global React, Kpi, Card, I */

function HealthTab({ data }) {
  const h = data.health;

  return (
    <div className="tab-pane active" id="pane-health">
      <div className="section-h" style={{ marginTop: 4 }}>
        <h2>System Health · last 24h</h2>
        <div className="meta mono">main · 7c4ae2f · render us-east · supabase</div>
      </div>

      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        {h.kpis.map((k, i) => <Kpi key={i} {...k} />)}
      </div>

      <div className="grid-2-1">
        <div>
          <div className="section-h"><h2>Services</h2>
            <div className="actions">
              <button className="btn"><I.refresh /> Recheck</button>
            </div>
          </div>
          <Card tight>
            {h.services.map((s, i) => (
              <div key={i} className="svc-row">
                <span className={`dot-led ${s.status === "warn" ? "amber" : s.status === "bad" ? "red" : ""}`} />
                <div>
                  <div className="svc-name">{s.name}</div>
                  <div className="svc-meta">{s.meta}</div>
                </div>
                <div className="svc-uptime">
                  {s.uptimeSeq.map((c, j) => <span key={j} className={c === "g" ? "" : c === "a" ? "amber" : "red"} />)}
                </div>
                <div className="tabular" style={{ fontSize: 11.5, color: "var(--fg-2)", minWidth: 50, textAlign: "end" }}>{s.uptime}</div>
              </div>
            ))}
          </Card>

          <div className="section-h"><h2>Recent errors · 24h</h2>
            <div className="actions">
              <button className="btn">Open /ops/errors <I.ext /></button>
            </div>
          </div>
          <Card tight>
            {h.errors.map((e) => (
              <div key={e.id} className="err-row">
                <span className="err-count">{e.count}×</span>
                <div>
                  <div className="err-msg">{e.message}</div>
                  <div className="err-trace">{e.trace} · last {e.last}</div>
                </div>
                <span className={`chip ${e.severity === "high" ? "red" : "amber"}`}>{e.severity}</span>
                <button className="btn">Trace <I.ext /></button>
              </div>
            ))}
          </Card>

          <div className="section-h"><h2>Cron jobs</h2><div className="meta">5 scheduled</div></div>
          <Card tight>
            <table className="tbl">
              <thead><tr><th>Job</th><th>Schedule</th><th>Last run</th><th>Next run</th><th>Status</th></tr></thead>
              <tbody>
                {h.crons.map((c, i) => (
                  <tr key={i}>
                    <td>{c.name}</td>
                    <td className="mono" style={{ color: "var(--fg-3)" }}>{c.sched}</td>
                    <td className="mono">{c.last}</td>
                    <td className="mono">{c.next}</td>
                    <td><span className={`chip ${c.status === "ok" ? "green" : "red"}`}>{c.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>

        <div>
          <Card title="Workers" sub="pg-boss" actions={<button className="btn">Restart all</button>}>
            {h.workers.map((w, i) => (
              <div key={i} style={{ paddingBlock: 9, borderBottom: i < h.workers.length - 1 ? "1px solid var(--line-soft)" : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span className={`dot-led ${w.status === "failing" ? "red" : ""}`} />
                  <span className="mono" style={{ fontWeight: 600, fontSize: 12 }}>{w.name}</span>
                  <span style={{ marginInlineStart: "auto" }}>
                    {w.status === "failing"
                      ? <button className="btn danger">Restart</button>
                      : <span className="chip green">ok</span>}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--fg-3)", fontFamily: "var(--font-mono)" }}>
                  last: {w.lastRun} · next: {w.nextRun}
                  {w.attempts > 0 && <span style={{ color: "var(--red)" }}> · {w.attempts} attempts</span>}
                </div>
                {w.error && <div style={{ marginTop: 6, padding: 6, background: "var(--red-soft)", border: "1px solid oklch(0.50 0.12 25 / 0.4)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--red)" }}>{w.error}</div>}
              </div>
            ))}
            <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
              <button className="btn" style={{ flex: 1, justifyContent: "center" }}>Clear queue</button>
              <button className="btn primary" style={{ flex: 1, justifyContent: "center" }}>Trigger SLA sweep</button>
            </div>
          </Card>

          <div style={{ marginTop: 12 }}>
            <Card title="WhatsApp crash alerts" sub="last 5">
              {h.waCrashFeed.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 10, paddingBlock: 6, fontSize: 12, borderBottom: i < h.waCrashFeed.length - 1 ? "1px solid var(--line-soft)" : 0 }}>
                  <span className="mono" style={{ color: "var(--fg-3)", fontSize: 11, minWidth: 36 }}>{a.time}</span>
                  <span style={{ color: "var(--fg-1)" }}>{a.msg}</span>
                </div>
              ))}
            </Card>
          </div>

          <div style={{ marginTop: 12 }}>
            <Card title="Recent deploys" sub="Render · main">
              {h.deploys.map((d, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, paddingBlock: 7, borderBottom: i < h.deploys.length - 1 ? "1px solid var(--line-soft)" : 0, fontSize: 12 }}>
                  <span className={`dot-led ${d.status === "fail" ? "red" : ""}`} />
                  <span className="mono" style={{ color: "var(--fg-2)", minWidth: 64 }}>{d.sha}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.msg}</span>
                  <span style={{ color: "var(--fg-3)", fontSize: 11 }}>{d.when}</span>
                </div>
              ))}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

window.HealthTab = HealthTab;
