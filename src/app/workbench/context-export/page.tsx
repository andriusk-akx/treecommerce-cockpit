import { prisma } from "@/lib/db";
import CopyButton from "./CopyButton";

export const dynamic = "force-dynamic";

export default async function ContextExportPage() {
  let pilots: any[] = [];
  let clients: any[] = [];
  try {
    [pilots, clients] = await Promise.all([
      prisma.pilot.findMany({
        include: {
          client: true,
          dataSources: true,
          devices: true,
          stores: true,
          _count: { select: { devices: true, incidents: true, stores: true, dataSources: true, noteEntries: true } },
        },
      }),
      prisma.client.findMany({
        include: { _count: { select: { pilots: true, stores: true } } },
      }),
    ]);
  } catch {}

  const fullContext = generateContextMarkdown(clients, pilots);
  const pilotContexts = pilots.map((p) => ({
    id: p.id,
    name: p.name,
    shortCode: p.shortCode,
    productType: p.productType,
    context: generatePilotContextMarkdown(p),
  }));

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Konteksto eksportas</h2>
        <p className="text-xs text-gray-400 mt-0.5">Struktūruotas projekto kontekstas Claude CoWork sesijoms</p>
      </div>

      {/* Full context */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-600">Pilnas projekto kontekstas</h3>
            <p className="text-[10px] text-gray-400 mt-0.5">Visų klientų, pilotų ir sistemos informacija</p>
          </div>
          <CopyButton text={fullContext} label="Kopijuoti viską" />
        </div>
        <pre className="bg-gray-50 rounded-lg p-4 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed max-h-[400px] overflow-y-auto">
          {fullContext}
        </pre>
      </div>

      {/* Per-pilot context */}
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-600">Piloto kontekstas</h3>
        <p className="text-[10px] text-gray-400 mt-0.5">Individualus kontekstas kiekvienam pilotui</p>
      </div>

      <div className="space-y-4">
        {pilotContexts.map((pc) => (
          <div key={pc.id} className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-semibold text-gray-700">{pc.name}</h4>
                <span className={`px-2 py-0.5 text-[9px] font-bold uppercase rounded-full ${
                  pc.productType === "TREECOMMERCE"
                    ? "bg-emerald-100 text-emerald-700"
                    : pc.productType === "RETELLECT"
                      ? "bg-purple-100 text-purple-700"
                      : "bg-gray-100 text-gray-600"
                }`}>
                  {pc.productType}
                </span>
                <span className="text-[10px] text-gray-400 font-mono">{pc.shortCode}</span>
              </div>
              <CopyButton text={pc.context} />
            </div>
            <pre className="bg-gray-50 rounded-lg p-4 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed max-h-[250px] overflow-y-auto">
              {pc.context}
            </pre>
          </div>
        ))}
      </div>

      {pilotContexts.length === 0 && (
        <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
          <p className="text-gray-400">Nėra pilotų duomenų bazėje.</p>
        </div>
      )}
    </div>
  );
}

function generateContextMarkdown(clients: any[], pilots: any[]): string {
  const lines: string[] = [];
  lines.push("# AKpilot — Projekto kontekstas");
  lines.push(`Generuota: ${new Date().toISOString()}`);
  lines.push("");

  lines.push("## Klientai");
  for (const c of clients) {
    lines.push(`- **${c.name}** (${c.code}) — ${c.status} | ${c._count.pilots} pilotų, ${c._count.stores} parduotuvių`);
  }
  lines.push("");

  lines.push("## Pilotai");
  for (const p of pilots) {
    lines.push(`### ${p.name} (${p.shortCode})`);
    lines.push(`- Klientas: ${p.client.name}`);
    lines.push(`- Tipas: ${p.productType} | Statusas: ${p.status}`);
    lines.push(`- Įrenginiai: ${p._count.devices} | Incidentai: ${p._count.incidents} | Šaltiniai: ${p._count.dataSources} | Pastabos: ${p._count.noteEntries}`);
    if (p.goalSummary) lines.push(`- Tikslas: ${p.goalSummary}`);
    if (p.dataSources?.length > 0) {
      lines.push(`- Duomenų šaltiniai: ${p.dataSources.map((ds: any) => `${ds.name} (${ds.type})`).join(", ")}`);
    }
    lines.push("");
  }

  lines.push("## Techninis stekas");
  lines.push("- Next.js 16 (App Router) + React 19 + TypeScript");
  lines.push("- Tailwind CSS 4 + Prisma 7 + PostgreSQL 16");
  lines.push("- Zabbix JSON-RPC integracija (monitoring.strongpoint.com)");
  lines.push("- Universal Data Source Manager (live → cache → unavailable)");
  lines.push("- 12eat POS REST API (TEST/PROD switchable)");
  lines.push("");

  lines.push("## Architektūra");
  lines.push("- Domain: Client → Pilot → DataSource / Store / Device / View");
  lines.push("- Pilot productType: TREECOMMERCE | RETELLECT | OTHER");
  lines.push("- Maršrutai: /clients, /pilots/[id]/*, /workbench/*, /settings/*");
  lines.push("- Shared: overview, technical, incidents, uptime, patterns, analytics, notes, data-sources");
  lines.push("- TreeCommerce: sales, promotions");
  lines.push("- Retellect: devices, cpu-analysis, capacity-risk");
  lines.push("- Seni maršrutai (/sales, /uptime, etc.) vis dar veikia su redirect banner");

  return lines.join("\n");
}

function generatePilotContextMarkdown(pilot: any): string {
  const lines: string[] = [];
  lines.push(`# Pilotas: ${pilot.name} (${pilot.shortCode})`);
  lines.push(`Generuota: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`- Klientas: ${pilot.client.name} (${pilot.client.code})`);
  lines.push(`- Produkto tipas: ${pilot.productType}`);
  lines.push(`- Statusas: ${pilot.status} | Matomumas: ${pilot.visibility}`);
  if (pilot.goalSummary) lines.push(`- Tikslas: ${pilot.goalSummary}`);
  if (pilot.internalOwner) lines.push(`- Atsakingas: ${pilot.internalOwner}`);
  lines.push(`- Sukurtas: ${pilot.createdAt?.toISOString?.() || "N/A"}`);
  lines.push("");

  if (pilot.devices?.length > 0) {
    lines.push("## Įrenginiai");
    for (const d of pilot.devices) {
      lines.push(`- ${d.name} — ${d.deviceType} | CPU: ${d.cpuModel || "N/A"} | RAM: ${d.ramGb || "N/A"} GB | Retellect: ${d.retellectEnabled ? "Taip" : "Ne"}`);
    }
    lines.push("");
  }

  if (pilot.stores?.length > 0) {
    lines.push("## Parduotuvės");
    for (const s of pilot.stores) {
      lines.push(`- ${s.name} (${s.code}) — ${s.city || ""} ${s.country || ""}`);
    }
    lines.push("");
  }

  if (pilot.dataSources?.length > 0) {
    lines.push("## Duomenų šaltiniai");
    for (const ds of pilot.dataSources) {
      lines.push(`- ${ds.name} — ${ds.type} | Sync: ${ds.syncMode} | URL: ${ds.baseUrl || "N/A"}`);
    }
    lines.push("");
  }

  lines.push("## Prieinami moduliai");
  const shared = ["overview", "technical", "incidents", "uptime", "patterns", "analytics", "notes", "data-sources"];
  const tc = ["sales", "promotions"];
  const ret = ["devices", "cpu-analysis", "capacity-risk"];

  lines.push(`Shared: ${shared.join(", ")}`);
  if (pilot.productType === "TREECOMMERCE") lines.push(`TreeCommerce: ${tc.join(", ")}`);
  if (pilot.productType === "RETELLECT") lines.push(`Retellect: ${ret.join(", ")}`);

  return lines.join("\n");
}
