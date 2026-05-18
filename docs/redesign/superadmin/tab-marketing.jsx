/* global React, Kpi, Card, I */

function MarketingTab({ data }) {
  const m = data.marketing;

  return (
    <div className="tab-pane active" id="pane-marketing">
      <div className="section-h" style={{ marginTop: 4 }}>
        <h2>Marketing & Growth</h2>
        <div className="meta">4 active campaigns · WA verify pending</div>
      </div>

      <div className="kpi-strip">
        {m.kpis.map((k, i) => <Kpi key={i} {...k} />)}
      </div>

      <div className="section-h"><h2>Campaign performance · last 30d</h2>
        <div className="actions">
          <button className="btn primary"><I.plus /> Send campaign</button>
          <button className="btn">Schedule IG post</button>
        </div>
      </div>
      <Card tight>
        <table className="tbl">
          <thead><tr><th>Campaign</th><th>Channel</th><th className="num">Sent</th><th>Open</th><th>Click</th><th className="num">Conv</th><th>Sent on</th></tr></thead>
          <tbody>
            {m.campaigns.map((c, i) => {
              const openPct = Math.round((c.open / c.sent) * 100);
              const clickPct = Math.round((c.click / c.sent) * 100);
              return (
                <tr key={i}>
                  <td>{c.name}</td>
                  <td><span className={`chip ${c.channel === "WhatsApp" ? "green" : "accent"}`}>{c.channel}</span></td>
                  <td className="num">{c.sent}</td>
                  <td><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div className="bar-track" style={{ width: 50 }}><div className="bar-fill" style={{ width: `${openPct}%` }} /></div><span className="tabular" style={{ fontSize: 11.5 }}>{openPct}%</span></div></td>
                  <td><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div className="bar-track" style={{ width: 50 }}><div className="bar-fill" style={{ width: `${clickPct * 4}%`, background: "var(--violet)" }} /></div><span className="tabular" style={{ fontSize: 11.5 }}>{clickPct}%</span></div></td>
                  <td className="num">{c.conv}</td>
                  <td className="mono" style={{ color: "var(--fg-3)", fontSize: 11.5 }}>{c.when}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <Card title="Instagram" sub={`${m.instagram.reach30d.toLocaleString()} reach 30d · ${m.instagram.postsScheduled} scheduled`}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div style={{ padding: 10, background: "var(--bg-1)", borderRadius: 6 }}>
              <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: ".06em" }}>Reach 7d</div>
              <div className="tabular" style={{ fontSize: 18, fontWeight: 600 }}>{m.instagram.reach7d.toLocaleString()}</div>
            </div>
            <div style={{ padding: 10, background: "var(--bg-1)", borderRadius: 6 }}>
              <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: ".06em" }}>Reach 30d</div>
              <div className="tabular" style={{ fontSize: 18, fontWeight: 600 }}>{m.instagram.reach30d.toLocaleString()}</div>
            </div>
          </div>
          <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>Top posts</div>
          {m.instagram.topPosts.map((p, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, paddingBlock: 7, borderBottom: i < 2 ? "1px solid var(--line-soft)" : 0 }}>
              <div style={{ width: 32, height: 32, borderRadius: 4, background: "var(--bg-3)", flexShrink: 0, backgroundImage: "repeating-linear-gradient(45deg, transparent 0 4px, oklch(0.40 0.012 245) 4px 5px)" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.caption}</div>
                <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{p.reach.toLocaleString()} reach · {p.likes} likes · {p.saves} saves</div>
              </div>
            </div>
          ))}
        </Card>

        <Card title="Referral program" sub="this month">
          <table className="tbl">
            <thead><tr><th>Code</th><th className="num">Uses</th><th className="num">Conv</th><th className="num">Revenue</th></tr></thead>
            <tbody>
              {m.referrals.map((r, i) => (
                <tr key={i}>
                  <td className="mono"><strong>{r.code}</strong></td>
                  <td className="num">{r.uses}</td>
                  <td className="num">{r.conv}</td>
                  <td className="num">{r.rev.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, padding: 10, background: "var(--bg-1)", borderRadius: 6, fontSize: 12 }}>
            <button className="btn" style={{ width: "100%", justifyContent: "center" }}><I.plus /> Create referral code</button>
          </div>
        </Card>
      </div>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <Card title="WhatsApp templates" sub={`${m.waTemplates.length} templates`}
          actions={<span className="chip amber">Meta verify pending</span>}>
          <table className="tbl">
            <thead><tr><th>Template</th><th>Status</th><th className="num">Uses</th></tr></thead>
            <tbody>
              {m.waTemplates.map((t, i) => (
                <tr key={i}>
                  <td className="mono">{t.name}</td>
                  <td><span className={`chip ${t.status === "approved" ? "green" : t.status === "in_review" ? "amber" : "red"}`}>{t.status.replace("_", " ")}</span></td>
                  <td className="num">{t.uses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Meta Business Verification" sub="known blocker">
          <div style={{ padding: 14, background: "var(--amber-soft)", borderRadius: 8, border: "1px solid oklch(0.50 0.10 75 / 0.4)" }}>
            <div style={{ color: "var(--amber)", fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>⚠ Verification status: Pending review</div>
            <div style={{ fontSize: 12, color: "var(--fg-1)", lineHeight: 1.5 }}>
              Submitted Apr 22 · 10 days in queue. Without verification, WA throughput is capped at 250 conversations/day.
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              <button className="btn">Re-check status</button>
              <button className="btn">Open Meta Business <I.ext /></button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

window.MarketingTab = MarketingTab;
