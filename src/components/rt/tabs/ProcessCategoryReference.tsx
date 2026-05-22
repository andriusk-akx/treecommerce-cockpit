"use client";

/**
 * Reference table that documents how Zabbix process items map onto the four
 * dashboard categories (Retellect / SCO App / DB / System) plus the implicit
 * "Other" bucket. Lives at the bottom of the CPU Timeline page so a user
 * never has to wonder "what counts as DB?".
 *
 * If you change the categorisation logic in
 *   `src/app/api/rt/process-history/route.ts` (the `categorise()` function)
 * — UPDATE THIS TABLE TOO. They must stay in sync; otherwise the dashboard
 * silently lies about what it's counting.
 */
export function ProcessCategoryReference() {
  // One row per category. `items` lists the Zabbix item key patterns we
  // recognise; `notes` explains caveats.
  const rows: Array<{
    category: string;
    color: string;
    items: { primary: string; aliases?: string[] }[];
    notes: string;
  }> = [
    {
      category: "Retellect",
      color: "#ef4444",
      items: [
        { primary: "perf_counter[\\Process(python)]", aliases: ["python.cpu"] },
        { primary: "perf_counter[\\Process(python#1)]", aliases: ["python1.cpu"] },
        { primary: "perf_counter[\\Process(python#2)]", aliases: ["python2.cpu"] },
        { primary: "perf_counter[\\Process(python#3)]", aliases: ["python3.cpu"] },
      ],
      notes: "Sum of all python instances on the host. Per-process telemetry only — if Retellect runs auxiliary helpers / services under a different name (not 'python'), they are not captured here and will appear as 'Other'.",
    },
    {
      category: "SCO App",
      color: "#f59e0b",
      items: [
        { primary: "perf_counter[\\Process(sp.sss)]", aliases: ["spss.cpu"] },
      ],
      notes: "StrongPoint POS application (sp.sss process).",
    },
    {
      category: "DB (SQL)",
      color: "#a78bfa",
      items: [
        { primary: "perf_counter[\\Process(sqlservr)]", aliases: ["sql.cpu"] },
      ],
      notes: "Microsoft SQL Server (sqlservr process). Local DB instance for the SCO host.",
    },
    {
      category: "System (VM host)",
      color: "#0ea5e9",
      items: [
        { primary: "perf_counter[\\Process(vmware-vmx)]", aliases: ["vm.cpu"] },
      ],
      notes: "VMware host process for the SCO VM (vmware-vmx). Before 2026-05-12 this bucket also lumped in BESClient — BESClient now has its own row so the BigFix cost is readable directly.",
    },
    {
      category: "BESClient",
      color: "#10b981",
      items: [
        { primary: "perf_counter[\\Process(besclient)]", aliases: ["besclient.cpu"] },
      ],
      notes: "IBM BigFix endpoint management client. Pulled out of \"System\" 2026-05-12 after SP admin detailed the Other bucket on testlab_SPUB-P-SCO150 — BigFix is a SP-stack standard so it appears on every Rimi SCO and was the largest hidden contributor to Other.",
    },
    {
      category: "Elastic",
      color: "#a3e635",
      items: [
        { primary: "perf_counter[\\Process(elastic-agent)]", aliases: ["elastic.cpu", "elasticsearch.cpu", "elastic-agent.cpu"] },
      ],
      notes: "Elastic agent / Elasticsearch worker (used by SP for log shipping and telemetry collection). Added 2026-05-12 when SP admin enabled per-process monitoring on testlab — fed via perf_counter or *.cpu depending on what the StrongPoint template publishes on a given host.",
    },
    {
      category: "OS Core",
      color: "#f97316",
      items: [
        { primary: "system.cpu.util[,system]" },
      ],
      notes: "Windows kernel-mode CPU at host scope — interrupts, scheduler, I/O completion, driver work. Sourced directly from system.cpu.util[,system], not from a process. Empty on hosts that don't publish the kernel-CPU item (most Rimi prod hosts as of 2026-05-12); enabled on testlab_SPUB-P-SCO150 as the pilot host.",
    },
    {
      category: "Other",
      color: "#94a3b8",
      items: [
        { primary: "(everything in system.cpu.util not above)" },
      ],
      notes: "Computed as host CPU minus the named categories above. On hosts with the full 2026-05-12 telemetry (kernel CPU + BESClient + Elastic) this should be small — anything left in Other is genuinely unattributed (antivirus, scheduled tasks, processes outside the template's named list). On hosts without the new items, Other still includes kernel work + BigFix + Elastic, same as before.",
    },
  ];

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-white text-xs overflow-hidden">
      <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
        <span className="font-semibold text-slate-700">Process category reference</span>
        <span className="text-[10px] text-slate-500">
          Maps Zabbix items → dashboard categories. Hybrid source: prefer
          {" "}<code className="px-1 py-0.5 bg-slate-100 rounded">perf_counter[\Process(...)]</code> (instantaneous, % per core, normalised by host core count); fall back to
          {" "}<code className="px-1 py-0.5 bg-slate-100 rounded">*.cpu</code> (1-min sliding average, % of host) when perf_counter is missing.
        </span>
      </div>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-slate-500 bg-slate-50/60">
            <th className="px-4 py-2 font-medium" style={{ width: 110 }}>Category</th>
            <th className="px-4 py-2 font-medium" style={{ width: 380 }}>Zabbix items captured</th>
            <th className="px-4 py-2 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.category} className="border-t border-slate-100 align-top">
              <td className="px-4 py-2">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                    style={{ background: r.color }}
                    aria-hidden
                  />
                  <span className="font-semibold text-slate-700">{r.category}</span>
                </div>
              </td>
              <td className="px-4 py-2">
                <div className="flex flex-col gap-1">
                  {r.items.map((it, i) => (
                    <div key={i}>
                      <code className="px-1 py-0.5 bg-slate-100 rounded text-[11px] text-slate-700">{it.primary}</code>
                      {it.aliases && it.aliases.length > 0 && (
                        <span className="text-slate-400 text-[10px] ml-2">
                          fallback: {it.aliases.map((a, ai) => (
                            <code key={ai} className="px-1 py-0.5 bg-slate-50 rounded text-slate-500 ml-1">{a}</code>
                          ))}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </td>
              <td className="px-4 py-2 text-slate-600 leading-relaxed">{r.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-4 py-2 bg-amber-50/60 border-t border-amber-200 text-[10px] text-amber-900">
        <strong>Known coverage gaps</strong> (pending StrongPoint admin):
        the Retellect helper runs under the Python service, so it&apos;s
        already counted inside the Retellect bucket via{" "}
        <code>python*.cpu</code> — only non-python auxiliary processes (if
        any) would be invisible; BESClient / Elastic / OS Core items are
        deployed on
        <code className="ml-1">testlab_SPUB-P-SCO150</code> only as of
        2026-05-12, fleet rollout still pending so production Rimi SCOs
        keep those cycles inside &ldquo;Other&rdquo;; no LLD{" "}
        <code>proc.cpu.util[*]</code> auto-discovery, so any process not in
        the list above lands in &ldquo;Other&rdquo;.
      </div>
    </div>
  );
}
