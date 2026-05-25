/**
 * Route-level loading skeleton — Next.js renders this instantly while
 * page.tsx is still resolving its Server Component data. Without it, the
 * user stares at the previous route's UI (or the page header) for 1–3 s
 * while the 6 parallel Zabbix fetchers run on a cold cache.
 *
 * The skeleton mirrors the workspace layout (header + tabs strip + content
 * card) so the transition into the real page doesn't visually jolt.
 *
 * Pure CSS, no client JS — keeps the loading bundle minimal.
 */

export default function RetellectPilotLoading() {
  // Inline pulse animation. Tailwind's animate-pulse would also work, but
  // an inline @keyframes stays self-contained and resilient to any global
  // Tailwind config changes.
  return (
    <div>
      <style>{`
        @keyframes shimmer {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 1; }
        }
        @keyframes topbar-slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .skel { background: #e5e7eb; border-radius: 4px; animation: shimmer 1.5s ease-in-out infinite; }
      `}</style>
      {/* Slim indeterminate progress bar at the very top of the viewport —
          unambiguous "page is loading" signal even when the rest of the
          skeleton sits below the fold. Static gradient slides across the
          full width on a 1.4 s loop. */}
      <div style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 3,
        overflow: "hidden",
        zIndex: 9999,
        background: "#e5e7eb",
      }}>
        <div style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(90deg, transparent, #2563eb, transparent)",
          animation: "topbar-slide 1.4s ease-in-out infinite",
        }} />
      </div>

      {/* Header band — mirrors the real header in retellect/[pilotId]/page.tsx */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "16px 24px" }}>
        <div style={{ maxWidth: 1152, margin: "0 auto" }}>
          <div className="skel" style={{ width: 240, height: 12, marginBottom: 10 }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="skel" style={{ width: 280, height: 24 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <div className="skel" style={{ width: 110, height: 26 }} />
              <div className="skel" style={{ width: 60, height: 26 }} />
            </div>
          </div>
        </div>
      </div>

      {/* Tab strip */}
      <div style={{ background: "#fafafa", borderBottom: "1px solid #e5e7eb", padding: "0 24px" }}>
        <div style={{ maxWidth: 1152, margin: "0 auto", display: "flex", gap: 24, padding: "12px 0" }}>
          {[80, 110, 100, 90, 130, 130, 100, 130].map((w, i) => (
            <div key={i} className="skel" style={{ width: w, height: 14 }} />
          ))}
        </div>
      </div>

      {/* Content card */}
      <div style={{ padding: "24px", maxWidth: 1152, margin: "0 auto" }}>
        <div className="skel" style={{ width: 200, height: 18, marginBottom: 12 }} />
        <div className="skel" style={{ width: "100%", height: 12, marginBottom: 24 }} />

        {/* Big tile row — mimics the heatmap or overview cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 20 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skel" style={{ height: 90 }} />
          ))}
        </div>

        {/* Table-ish */}
        <div className="skel" style={{ width: "100%", height: 240 }} />

        {/* Footer hint so the user knows it's loading, not just decorative */}
        <p style={{ marginTop: 20, fontSize: 12, color: "#94a3b8", textAlign: "center" }}>
          Loading pilot data from Zabbix…
        </p>
      </div>
    </div>
  );
}
