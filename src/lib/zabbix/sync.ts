import { getZabbixClient } from "./client";
import { prisma } from "../db";

interface SyncResult {
  created: number;
  updated: number;
  resolved: number;
  skipped: number;
  errors: string[];
}

function mapZabbixSeverity(severity: string): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  switch (severity) {
    case "5": return "CRITICAL";
    case "4": return "HIGH";
    case "3":
    case "2": return "MEDIUM";
    default: return "LOW";
  }
}

function categorizeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("service") || lower.includes("process")) return "Service";
  if (lower.includes("cpu") || lower.includes("load") || lower.includes("performance")) return "Performance";
  if (lower.includes("memory") || lower.includes("swap")) return "Memory";
  if (lower.includes("disk") || lower.includes("storage") || lower.includes("space")) return "Disk";
  if (lower.includes("network") || lower.includes("interface") || lower.includes("ping")) return "Network";
  if (lower.includes("security") || lower.includes("auth")) return "Security";
  if (lower.includes("backup")) return "Backup";
  return "General";
}

export async function syncZabbixProblems(clientId: string): Promise<SyncResult> {
  const client = getZabbixClient();
  const result: SyncResult = { created: 0, updated: 0, resolved: 0, skipped: 0, errors: [] };

  try {
    const problems = await client.getProblems() as any[];

    const store = await prisma.store.findFirst({ where: { clientId } });
    if (!store) {
      throw new Error("No store found for client");
    }

    const externalIds = problems.map((p: any) => "ZBX-" + p.eventid);

    const existingIncidents = await prisma.incident.findMany({
      where: { externalId: { in: externalIds } },
    });
    const existingMap = new Map(existingIncidents.map((i) => [i.externalId, i]));

    for (const problem of problems) {
      const externalId = "ZBX-" + problem.eventid;
      const existing = existingMap.get(externalId);

      const severity = mapZabbixSeverity(problem.severity);
      const category = categorizeFromName(problem.name);
      const startedAt = new Date(parseInt(problem.clock) * 1000);
      const isResolved = problem.r_eventid !== "0";

      if (existing) {
        const newStatus = isResolved ? "RESOLVED" as const : existing.status;
        if (existing.severity !== severity || existing.status !== newStatus) {
          await prisma.incident.update({
            where: { id: existing.id },
            data: { severity, status: newStatus, endedAt: isResolved ? new Date() : null },
          });
          result.updated++;
        } else {
          result.skipped++;
        }
      } else {
        await prisma.incident.create({
          data: {
            clientId,
            storeId: store.id,
            sourceType: "ZABBIX",
            externalId,
            title: problem.name,
            description: problem.opdata || "",
            severity,
            status: isResolved ? "RESOLVED" : "OPEN",
            category,
            startedAt,
          },
        });
        result.created++;
      }
    }

    // Resolve stale incidents
    const staleIncidents = await prisma.incident.findMany({
      where: {
        clientId,
        sourceType: "ZABBIX",
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        externalId: { notIn: externalIds, not: null },
      },
    });
    for (const stale of staleIncidents) {
      await prisma.incident.update({
        where: { id: stale.id },
        data: { status: "RESOLVED", endedAt: new Date() },
      });
      result.resolved++;
    }

  } catch (error) {
    result.errors.push(String(error));
  }

  return result;
}
