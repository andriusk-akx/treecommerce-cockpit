import { NextResponse } from "next/server";
import { getZabbixClient } from "@/lib/zabbix/client";

export const dynamic = "force-dynamic";

// Temporary route to explore what data Zabbix API can provide
export async function GET() {
  const client = getZabbixClient();
  const results: Record<string, any> = {};

  // 1. Events with time data (for downtime calculation)
  try {
    const events = await client.request("event.get", {
      output: "extend",
      time_from: String(Math.floor(Date.now() / 1000) - 30 * 24 * 3600), // last 30 days
      sortfield: ["clock"],
      sortorder: "DESC",
      limit: 50,
    });
    results.events = { count: events.length, sample: events.slice(0, 5) };
  } catch (e) { results.events = { error: String(e) }; }

  // 2. Triggers with last change time
  try {
    const triggers = await client.request("trigger.get", {
      output: ["triggerid", "description", "priority", "lastchange", "value", "status"],
      selectHosts: ["hostid", "host", "name"],
      expandDescription: true,
      filter: {},
      limit: 50,
    });
    results.triggers = { count: triggers.length, sample: triggers.slice(0, 5) };
  } catch (e) { results.triggers = { error: String(e) }; }

  // 3. Host availability / interfaces
  try {
    const hosts = await client.request("host.get", {
      output: ["hostid", "host", "name", "status", "available", "snmp_available", "maintenance_status"],
      selectInterfaces: ["interfaceid", "ip", "port", "type", "available"],
      selectParentTemplates: ["templateid", "name"],
    });
    results.hosts = { count: hosts.length, sample: hosts.slice(0, 3) };
  } catch (e) { results.hosts = { error: String(e) }; }

  // 4. Services (SLA)
  try {
    const services = await client.request("service.get", {
      output: "extend",
    });
    results.services = { count: services.length, sample: services.slice(0, 5) };
  } catch (e) { results.services = { error: String(e) }; }

  // 5. SLA
  try {
    const sla = await client.request("sla.get", {
      output: "extend",
    });
    results.sla = { count: sla.length, sample: sla.slice(0, 5) };
  } catch (e) { results.sla = { error: String(e) }; }

  // 6. Maintenance windows
  try {
    const maintenance = await client.request("maintenance.get", {
      output: "extend",
      selectTimeperiods: "extend",
    });
    results.maintenance = { count: maintenance.length, sample: maintenance.slice(0, 5) };
  } catch (e) { results.maintenance = { error: String(e) }; }

  // 7. History (item values over time - for trends)
  try {
    // First get some items
    const items = await client.request("item.get", {
      output: ["itemid", "name", "key_", "lastvalue", "units", "hostid"],
      selectHosts: ["host", "name"],
      filter: { state: 0 },
      sortfield: "name",
      limit: 20,
    });
    results.items = { count: items.length, sample: items.slice(0, 5) };
  } catch (e) { results.items = { error: String(e) }; }

  // 8. Problems with tags and acknowledges
  try {
    const problems = await client.request("problem.get", {
      output: "extend",
      selectAcknowledges: "extend",
      selectTags: "extend",
      selectSuppressionData: "extend",
      time_from: String(Math.floor(Date.now() / 1000) - 30 * 24 * 3600),
      sortfield: ["eventid"],
      sortorder: "DESC",
      limit: 50,
    });
    results.problems_extended = { count: problems.length, sample: problems.slice(0, 3) };
  } catch (e) { results.problems_extended = { error: String(e) }; }

  // 9. Alerts
  try {
    const alerts = await client.request("alert.get", {
      output: "extend",
      time_from: String(Math.floor(Date.now() / 1000) - 30 * 24 * 3600),
      sortfield: "clock",
      sortorder: "DESC",
      limit: 20,
    });
    results.alerts = { count: alerts.length, sample: alerts.slice(0, 3) };
  } catch (e) { results.alerts = { error: String(e) }; }

  return NextResponse.json(results);
}
