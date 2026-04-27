/**
 * Probe SC02 (or any host) to understand:
 *   1. system.cpu.num value
 *   2. raw per-process CPU values (python.cpu, spss.cpu, sql.cpu, vm.cpu)
 *   3. one hour history sample to see whether values are "% of one core" or
 *      already "% of host"
 *
 * Usage: npx tsx scripts/probe-sc02-process.ts SC02 2026-04-18
 */
import "dotenv/config";

const URL_ZBX = "https://monitoring.strongpoint.com/api_jsonrpc.php";
const TOKEN = process.env.ZABBIX_TOKEN!;

async function zbx(method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(URL_ZBX, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Math.random() }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${method}: ${data.error.message} — ${data.error.data}`);
  return data.result;
}

async function main() {
  const namePattern = process.argv[2] || "SC02";
  const isoDate = process.argv[3] || "2026-04-18";

  // Find host
  const hosts = await zbx("host.get", {
    output: ["hostid", "host", "name"],
    search: { name: namePattern },
    sortfield: "name",
  });
  if (!hosts.length) {
    console.log("No host found for", namePattern);
    return;
  }
  console.log("Found", hosts.length, "host(s) — using first:");
  for (const h of hosts.slice(0, 3)) console.log("  hostid=" + h.hostid, "name=" + h.name);
  const host = hosts[0];
  console.log();

  // List system.cpu.* + *.cpu items
  const items = await zbx("item.get", {
    output: ["itemid", "key_", "name", "lastvalue", "lastclock", "status", "units"],
    hostids: [host.hostid],
  }) as Array<{ itemid: string; key_: string; name: string; lastvalue: string; lastclock: string; status: string; units: string }>;
  const cpuItems = items.filter(
    (it) => it.key_.startsWith("system.cpu") || it.key_.endsWith(".cpu")
  );
  console.log("=== CPU-related items on", host.name, "===");
  console.log("KEY".padEnd(40), "NAME".padEnd(40), "LAST", "UNITS");
  console.log("-".repeat(110));
  for (const it of cpuItems) {
    const age = it.lastclock === "0" ? "never" : `${Math.round((Date.now() / 1000 - Number(it.lastclock)) / 60)}min`;
    console.log(it.key_.padEnd(40), (it.name || "").slice(0, 38).padEnd(40), `${it.lastvalue}@${age}`, it.units || "");
  }
  console.log();

  // For the date, fetch 1 hour of history at hour 18
  const dt = new Date(`${isoDate}T18:00:00`);
  const timeFrom = Math.floor(dt.getTime() / 1000);
  const timeTill = timeFrom + 3600;
  console.log(`=== History for ${isoDate} 18:00–19:00 (epoch ${timeFrom}–${timeTill}) ===`);

  const procItems = cpuItems.filter(
    (it) =>
      it.key_.endsWith(".cpu") &&
      !it.key_.startsWith("perf_counter") &&
      !it.key_.startsWith("system.cpu")
  );
  console.log(`Per-process items: ${procItems.length}`);

  for (const item of procItems) {
    const records = (await zbx("history.get", {
      output: ["itemid", "clock", "value"],
      itemids: [item.itemid],
      history: 0,
      time_from: String(timeFrom),
      time_till: String(timeTill),
      sortfield: "clock",
      sortorder: "ASC",
      limit: 200,
    })) as Array<{ clock: string; value: string }>;
    if (!records.length) {
      console.log(`  ${item.key_.padEnd(20)} → 0 samples`);
      continue;
    }
    const values = records.map((r) => parseFloat(r.value));
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const max = Math.max(...values);
    console.log(`  ${item.key_.padEnd(20)} → ${records.length}smp, avg=${avg.toFixed(1)}%, max=${max.toFixed(1)}%`);
  }

  // Also fetch system.cpu.util for same hour
  const sysItem = cpuItems.find((it) => it.key_ === "system.cpu.util[,,avg1]" || it.key_ === "system.cpu.util");
  if (sysItem) {
    const records = (await zbx("history.get", {
      output: ["itemid", "clock", "value"],
      itemids: [sysItem.itemid],
      history: 0,
      time_from: String(timeFrom),
      time_till: String(timeTill),
      sortfield: "clock",
      sortorder: "ASC",
      limit: 200,
    })) as Array<{ clock: string; value: string }>;
    if (records.length) {
      const values = records.map((r) => parseFloat(r.value));
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const max = Math.max(...values);
      console.log(`  ${sysItem.key_.padEnd(20)} → ${records.length}smp, avg=${avg.toFixed(1)}%, max=${max.toFixed(1)}% [system overall]`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
