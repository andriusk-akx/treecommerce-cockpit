import { getZabbixClient } from "./client";
import { getClientForHost } from "./analytics";
import { getHostAvailability } from "./availability";
import { cached } from "./cache";

export interface Insight {
  type: "critical" | "warning" | "info" | "success";
  title: string;
  detail: string;
}

/**
 * PERF-004: Accept pre-fetched data to avoid duplicate API calls.
 * Overview page already has problems + hosts, so pass them in.
 */
export async function generateInsights(prefetched?: {
  problems: any[];
  hosts: any[];
}): Promise<Insight[]> {
  const client = getZabbixClient();
  const insights: Insight[] = [];

  const now = Date.now();
  const days7 = 7 * 24 * 3600;
  const days30 = 30 * 24 * 3600;

  // Use pre-fetched data when available; cache API calls otherwise
  const problems = prefetched?.problems ?? await cached("insights_problems", () => client.getProblems() as Promise<any[]>);
  const hosts = prefetched?.hosts ?? await cached("insights_hosts", () => client.getHosts() as Promise<any[]>);

  // PERF-002: Cache Zabbix API responses (60s TTL)
  // Include time period in cache key to avoid collisions between different query periods
  const [events7d, events30d] = await cached(
    `insights_events_7d_30d`,
    () => Promise.all([
      client.request("event.get", {
        output: ["eventid", "clock", "value", "severity", "name", "objectid", "r_eventid"],
        selectTags: "extend",
        selectHosts: ["hostid", "host", "name"],
        time_from: String(Math.floor(now / 1000) - days7),
        sortfield: ["clock"],
        sortorder: "DESC",
        limit: 1000,
      }),
      client.request("event.get", {
        output: ["eventid", "clock", "value", "severity", "name", "objectid"],
        selectHosts: ["hostid", "host", "name"],
        time_from: String(Math.floor(now / 1000) - days30),
        sortfield: ["clock"],
        sortorder: "DESC",
        limit: 2000,
      }),
    ])
  );

  // --- Active problems ---
  if (problems.length === 0) {
    insights.push({
      type: "success",
      title: "Šiuo metu aktyvių problemų nėra",
      detail: "Visos stebimos sistemos veikia normaliai.",
    });
  } else {
    const critical = problems.filter((p: any) => parseInt(p.severity) >= 4);
    if (critical.length > 0) {
      const names = critical.map((p: any) => p.name).join("; ");
      insights.push({
        type: "critical",
        title: `${critical.length} kritinė(s) problema(os) dabar`,
        detail: names,
      });
    }
  }

  // --- Restart frequency analysis ---
  const restartEvents7d = events7d.filter(
    (e: any) => e.value === "1" && e.name && e.name.includes("restarted")
  );
  const restartEvents30d = events30d.filter(
    (e: any) => e.value === "1" && e.name && e.name.includes("restarted")
  );

  // Per-host restart count (7d)
  const restartsByHost7d = new Map<string, number>();
  for (const e of restartEvents7d) {
    const host = e.hosts?.[0]?.name || "?";
    restartsByHost7d.set(host, (restartsByHost7d.get(host) || 0) + 1);
  }

  const frequentRestartsHosts = Array.from(restartsByHost7d.entries())
    .filter(([, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1]);

  if (frequentRestartsHosts.length > 0) {
    const hostList = frequentRestartsHosts
      .map(([host, count]) => `${host} (${count}x)`)
      .join(", ");
    insights.push({
      type: "warning",
      title: "Dažni įrenginių restartai per 7d",
      detail: `${hostList}. Dažnas restartas gali rodyti nestabilumą arba automatinį atnaujinimą.`,
    });
  }

  // Week-over-week restart trend
  const restartsThisWeek = restartEvents7d.length;
  const restartsPrev = restartEvents30d.filter((e: any) => {
    const ts = parseInt(e.clock) * 1000;
    return ts < now - days7 * 1000 && ts > now - days7 * 2 * 1000;
  }).length;

  if (restartsPrev > 0 && restartsThisWeek > restartsPrev * 1.5) {
    insights.push({
      type: "warning",
      title: "Restartų skaičius padidėjo",
      detail: `Šią savaitę ${restartsThisWeek} restartų vs. praeitą ${restartsPrev}. Padidėjimas ${Math.round(((restartsThisWeek - restartsPrev) / restartsPrev) * 100)}%.`,
    });
  } else if (restartsPrev > 0 && restartsThisWeek < restartsPrev * 0.7) {
    insights.push({
      type: "success",
      title: "Restartų skaičius sumažėjo",
      detail: `Šią savaitę ${restartsThisWeek} vs. praeitą ${restartsPrev}. Stabilumas gerėja.`,
    });
  }

  // --- Service problems ---
  const serviceEvents7d = events7d.filter(
    (e: any) => e.value === "1" && e.name && e.name.includes("is not ACTIVE")
  );
  if (serviceEvents7d.length > 0) {
    const serviceNames = new Map<string, number>();
    for (const e of serviceEvents7d) {
      const match = e.name.match(/Service "(.+)" is not ACTIVE/);
      // Null guard: match() can return null if pattern doesn't match
      if (match && match[1]) {
        const svc = match[1];
        serviceNames.set(svc, (serviceNames.get(svc) || 0) + 1);
      }
    }
    const topServices = Array.from(serviceNames.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    const svcList = topServices.map(([name, count]) => `${name} (${count}x)`).join(", ");
    insights.push({
      type: "warning",
      title: `${serviceEvents7d.length} servisų sustojimų per 7d`,
      detail: `Dažniausiai krenta: ${svcList}. Rekomenduojama peržiūrėti šių servisų konfigūraciją.`,
    });
  }

  // --- VMI / Fiscal problems ---
  const vmiEvents7d = events7d.filter(
    (e: any) =>
      e.value === "1" &&
      e.name &&
      (e.name.includes("VMI") || e.name.includes("kvit") || e.name.includes("SM status"))
  );
  if (vmiEvents7d.length > 0) {
    const vmiHosts = new Set<string>();
    for (const e of vmiEvents7d) {
      if (e.hosts?.[0]) vmiHosts.add(e.hosts[0].name);
    }
    insights.push({
      type: "critical",
      title: `${vmiEvents7d.length} VMI/fiskalinių problemų per 7d`,
      detail: `Paveikti įrenginiai: ${Array.from(vmiHosts).join(", ")}. VMI klaidos gali reikšti, kad čekiai nepasiekia mokesčių inspekcijos.`,
    });
  } else {
    // Check 30d
    const vmiEvents30d = events30d.filter(
      (e: any) =>
        e.value === "1" &&
        e.name &&
        (e.name.includes("VMI") || e.name.includes("kvit") || e.name.includes("SM status"))
    );
    if (vmiEvents30d.length === 0) {
      insights.push({
        type: "success",
        title: "VMI duomenų perdavimas stabilus",
        detail: "Per 30 dienų VMI/fiskalinių klaidų nefiksuota.",
      });
    }
  }

  // --- Host availability (lightweight event-based detection) ---
  {
    const unavailableHosts = events30d.filter(
      (e: any) =>
        e.value === "1" &&
        e.name &&
        (e.name.includes("not available") || e.name.includes("agent is not available"))
    );
    if (unavailableHosts.length > 0) {
      const hostNames = new Set<string>();
      for (const e of unavailableHosts) {
        if (e.hosts?.[0]) hostNames.add(e.hosts[0].name);
      }
      insights.push({
        type: "critical",
        title: "Stebėjimo agentas nepasiekiamas",
        detail: `${Array.from(hostNames).join(", ")} — Zabbix agentas buvo nepasiekiamas.`,
      });
    }
  }

  // --- Memory pressure ---
  const memoryEvents = events7d.filter(
    (e: any) =>
      e.value === "1" &&
      e.name &&
      (e.name.includes("memory") || e.name.includes("swap"))
  );
  if (memoryEvents.length >= 3) {
    const memHosts = new Set<string>();
    for (const e of memoryEvents) {
      if (e.hosts?.[0]) memHosts.add(e.hosts[0].name);
    }
    insights.push({
      type: "warning",
      title: "Atminties trūkumas pastebėtas",
      detail: `${memoryEvents.length} atminties/swap įvykiai per 7d. Serveriai: ${Array.from(memHosts).join(", ")}. Gali prireikti RAM didinimo.`,
    });
  }

  // --- Per-client summary ---
  const clientProblems7d = new Map<string, number>();
  for (const e of events7d) {
    if (e.value !== "1") continue;
    const host = e.hosts?.[0]?.name || "";
    const cl = getClientForHost(host);
    if (cl) {
      clientProblems7d.set(cl, (clientProblems7d.get(cl) || 0) + 1);
    }
  }

  if (clientProblems7d.size > 1) {
    const sorted = Array.from(clientProblems7d.entries()).sort((a, b) => b[1] - a[1]);
    const worst = sorted[0];
    const best = sorted[sorted.length - 1];
    if (worst[1] > best[1] * 2) {
      insights.push({
        type: "info",
        title: `${worst[0]} turi daugiausiai problemų`,
        detail: `${worst[0]}: ${worst[1]} įvykių vs. ${best[0]}: ${best[1]} per 7d. Rekomenduojama atkreipti dėmesį į ${worst[0]} infrastruktūrą.`,
      });
    }
  }

  // --- Overall pilot health score ---
  const totalProblems7d = events7d.filter((e: any) => e.value === "1").length;
  const totalHosts = hosts.length;
  const avgProblemsPerHost = totalHosts > 0 ? totalProblems7d / totalHosts : 0;

  if (avgProblemsPerHost < 3) {
    insights.push({
      type: "success",
      title: "Piloto būklė — gera",
      detail: `Vidutiniškai ${avgProblemsPerHost.toFixed(1)} problemos per hostą per 7d. Sistema dirba stabiliai.`,
    });
  } else if (avgProblemsPerHost < 10) {
    insights.push({
      type: "info",
      title: "Piloto būklė — vidutinė",
      detail: `Vidutiniškai ${avgProblemsPerHost.toFixed(1)} problemos per hostą per 7d (${totalProblems7d} iš viso, ${totalHosts} hostai).`,
    });
  } else {
    insights.push({
      type: "warning",
      title: "Piloto būklė — reikalauja dėmesio",
      detail: `Vidutiniškai ${avgProblemsPerHost.toFixed(1)} problemos per hostą per 7d. Aukštas incidentų kiekis gali rodyti sisteminius sutrikimus.`,
    });
  }

  return insights;
}
