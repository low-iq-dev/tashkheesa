// illustrations.jsx — brand line-art illustrations (teal on navy) + the report seal.
// Simple, clinical, abstract — matches the design-system line-art language.

function IlloUpload({ size = 200 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" fill="none">
      <circle cx="100" cy="100" r="92" stroke="var(--rule-strong)" strokeWidth="1.2" strokeDasharray="3 5"/>
      <rect x="58" y="48" width="84" height="104" rx="10" fill="var(--surface)" stroke="var(--teal)" strokeWidth="2.2"/>
      <path d="M74 76h52M74 92h52M74 108h36" stroke="var(--teal-dim)" strokeWidth="2.4" strokeLinecap="round"/>
      <circle cx="100" cy="100" r="30" fill="var(--navy-800)" stroke="var(--teal)" strokeWidth="2.4"/>
      <path d="M100 114V90m0 0l-9 9m9-9l9 9" stroke="var(--teal)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="150" cy="58" r="13" fill="var(--teal)"/>
      <path d="M145 58l4 4 7-8" stroke="var(--on-teal)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function IlloSigned({ size = 200 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" fill="none">
      <circle cx="100" cy="100" r="92" stroke="var(--rule-strong)" strokeWidth="1.2" strokeDasharray="3 5"/>
      <rect x="52" y="44" width="96" height="112" rx="10" fill="var(--surface)" stroke="var(--teal)" strokeWidth="2.2"/>
      <path d="M68 68h40M68 84h64M68 100h64M68 116h40" stroke="var(--teal-dim)" strokeWidth="2.2" strokeLinecap="round"/>
      <path d="M70 138c8-6 14-6 22 0s14 6 22 0" stroke="var(--teal)" strokeWidth="2.4" strokeLinecap="round"/>
      <circle cx="138" cy="138" r="22" fill="var(--rpt-green)" stroke="var(--rpt-gold)" strokeWidth="2.2"/>
      <path d="M130 138l5 5 11-12" stroke="var(--rpt-gold-2)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function IlloClock({ size = 200 }) {
  const r = 58, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" fill="none">
      <circle cx="100" cy="100" r="92" stroke="var(--rule-strong)" strokeWidth="1.2" strokeDasharray="3 5"/>
      <circle cx="100" cy="100" r={r} fill="var(--surface)" stroke="var(--rule-strong)" strokeWidth="6"/>
      <circle cx="100" cy="100" r={r} fill="none" stroke="var(--teal)" strokeWidth="6" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * 0.32} transform="rotate(-90 100 100)"/>
      <path d="M100 100V64M100 100l24 14" stroke="var(--text)" strokeWidth="3.4" strokeLinecap="round"/>
      <circle cx="100" cy="100" r="5" fill="var(--teal)"/>
    </svg>
  );
}

function IlloAsync({ size = 200 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" fill="none">
      <circle cx="100" cy="100" r="92" stroke="var(--rule-strong)" strokeWidth="1.2" strokeDasharray="3 5"/>
      <rect x="44" y="56" width="68" height="80" rx="9" fill="var(--surface)" stroke="var(--teal)" strokeWidth="2.2"/>
      <path d="M58 78h40M58 92h40M58 106h26" stroke="var(--teal-dim)" strokeWidth="2.2" strokeLinecap="round"/>
      <path d="M120 96c0-13 11-24 26-24s26 11 26 24-11 24-26 24c-4 0-8-1-11-2l-15 5 4-13c-2-4-4-9-4-14z"
        fill="var(--navy-700)" stroke="var(--muted)" strokeWidth="2" strokeDasharray="4 4"/>
      <path d="M146 86v9m0 5v.5" stroke="var(--muted)" strokeWidth="2.6" strokeLinecap="round"/>
      <path d="M150 150l8 8m0-8l-8 8" stroke="var(--danger)" strokeWidth="2.4" strokeLinecap="round"/>
    </svg>
  );
}

// The wax-seal style mark for the signed report (gold on green)
function ReportSeal({ size = 64 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <circle cx="40" cy="40" r="36" fill="var(--rpt-green)" />
      <circle cx="40" cy="40" r="31" fill="none" stroke="var(--rpt-gold)" strokeWidth="1.2" strokeDasharray="2 3"/>
      <circle cx="40" cy="40" r="26" fill="none" stroke="var(--rpt-gold)" strokeWidth="1.6"/>
      <path d="M30 41l7 7 14-16" stroke="var(--rpt-gold-2)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M40 14l3 5 5-2-1 6 6 1-4 4 4 4-6 1 1 6-5-2-3 5-3-5-5 2 1-6-6-1 4-4-4-4 6-1-1-6 5 2z"
        fill="none" stroke="var(--rpt-gold)" strokeWidth="0.8" opacity="0.5"/>
    </svg>
  );
}

function ShifaMark({ size = 28, on = "navy" }) {
  const c = on === "navy" ? "var(--teal)" : "var(--rpt-green)";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect x="2" y="2" width="28" height="28" rx="8" fill={c}/>
      <path d="M11 17l4 4 7-9" stroke={on === "navy" ? "var(--on-teal)" : "#f3efe2"} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="20.5" cy="11.5" r="1.6" fill={on === "navy" ? "var(--on-teal)" : "#f3efe2"}/>
    </svg>
  );
}

Object.assign(window, { IlloUpload, IlloSigned, IlloClock, IlloAsync, ReportSeal, ShifaMark });
