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
      category: "System",
      color: "#0ea5e9",
      items: [
        { primary: "perf_counter[\\Process(vmware-vmx)]", aliases: ["vm.cpu"] },
        { primary: "perf_counter[\\Process(besclient)]" },
      ],
      notes: "VMware host process for the SCO VM (vmware-vmx) plus IBM BigFix endpoint management client (besclient). Does not include kernel work — kernel CPU is in 'Other' until system.cpu.util[,system] is deployed.",
    },
    {
      category: "Other",
      color: "#94a3b8",
      items: [
        { primary: "(everything in system.cpu.util not above)" },
      ],
      notes: "Computed as host CPU minus the four categories. Captures: Windows kernel work (interrupts, scheduler, I/O wait), OS services (svchost, lsass, audit), antivirus, scheduled tasks, and any process Zabbix doesn't track by name on this host (e.g. NHSTW32, cs300sd, UDMServer have items but rarely fire; anything outside that list is invisible).",
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
        no Retellect helper / service item exists in the template — if
        Retellect deploys auxiliary processes, they are invisible;
        no <code>system.cpu.util[,user/system/iowait]</code> kernel split
        deployed fleet-wide (only one experimental host has it); no LLD
        <code className="ml-1">proc.cpu.util[*]</code> auto-discovery, so any
        process not in the list above lands in &ldquo;Other&rdquo;.
      </div>
    </div>
  );
}
