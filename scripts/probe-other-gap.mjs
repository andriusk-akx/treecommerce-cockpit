// At Pavilnionys SCO2 04-24 15:25, "Other" = ~30% of CPU. Find which Zabbix
// items were non-zero at that exact minute and aren't in our 4 categories.
import * as fs from "node:fs";
const env = fs.readFileSync(".env.local", "utf8");
const TOKEN = env.match(/^ZABBIX_TOKEN=["']?([^"'\n]+)/m)[1];
const URL_ZBX = "https://monitoring.strongpoint.com/api_jsonrpc.php";

async function zbx(method, params = {}) {
  const res = await fetch(URL_ZBX, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Math.random() }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

const hosts = await zbx("host.get", { output: ["hostid", "name"], search: { name: "Pavilnionys" } });
const host = hosts.find(h => /SCO2\b/.test(h.name));
console.log("Host:", host.name);

// All active items
const items = await zbx("item.get", {
  output: ["itemid", "key_", "name", "delay", "units"],
  hostids: [host.hostid],
  filter: { status: 0, state: 0 },
});
console.log("Active items:", items.length);

// Window: 04-24 15:25 ±2min (Vilnius)
const dt = new Date("2026-04-24T15:25:00");
const t = Math.floor(dt.getTime() / 1000);
console.log(`Probing: ${dt.toLocaleString("lt-LT", { timeZone: "Europe/Vilnius" })}\n`);

// Categorise items into our 4 buckets vs "untracked"
const isProcCpu = (k) => k.endsWith(".cpu") && !k.startsWith("perf_counter") && !k.startsWith("system.cpu");
const ourCategory = (k) => {
  const base = k.replace(/\.cpu$/, "").toLowerCase();
  if (/^python\d*$/.test(base)) return "retellect";
  if (base === "spss" || base === "sp.sss" || base === "sp") return "scoApp";
  if (base === "sql" || base === "sqlservr") return "db";
  if (base === "vm" || base === "vmware-vmx") return "system";
  return null;
};

const procCpuItems = items.filter(it => isProcCpu(it.key_));
const tracked = procCpuItems.filter(it => ourCategory(it.key_));
const untrackedProcCpu = procCpuItems.filter(it => !ourCategory(it.key_));
const perfCounterProc = items.filter(it => it.key_.startsWith("perf_counter[\\Process"));
const systemCpu = items.filter(it => it.key_.startsWith("system.cpu"));

const probe = async (it) => {
  const recs = await zbx("history.get", {
    output: ["clock", "value"], itemids: [it.itemid], history: 0,
    time_from: String(t - 120), time_till: String(t + 120),
    sortfield: "clock", sortorder: "ASC", limit: 10,
  });
  if (!recs.length) {
    // try uint type
    const recs2 = await zbx("history.get", {
      output: ["clock", "value"], itemids: [it.itemid], history: 3,
      time_from: String(t - 120), time_till: String(t + 120),
      sortfield: "clock", sortorder: "ASC", limit: 10,
    });
    if (!recs2.length) return null;
    return recs2;
  }
  return recs;
};

console.log(`=== TRACKED process items (${tracked.length}) at 15:25 ===`);
for (const it of tracked) {
  const recs = await probe(it);
  if (!recs?.length) continue;
  const closest = recs.reduce((m, r) => Math.abs(parseInt(r.clock) - t) < Math.abs(parseInt(m.clock) - t) ? r : m);
  const v = parseFloat(closest.value);
  if (v < 0.01) continue;
  console.log(`  ${it.key_.padEnd(36)}  ${v.toFixed(2)}%  → ${ourCategory(it.key_)}`);
}

console.log(`\n=== UNTRACKED *.cpu items (${untrackedProcCpu.length}) at 15:25 ===`);
let untrackedSum = 0;
for (const it of untrackedProcCpu) {
  const recs = await probe(it);
  if (!recs?.length) { console.log(`  ${it.key_.padEnd(36)}  no samples`); continue; }
  const closest = recs.reduce((m, r) => Math.abs(parseInt(r.clock) - t) < Math.abs(parseInt(m.clock) - t) ? r : m);
  const v = parseFloat(closest.value);
  console.log(`  ${it.key_.padEnd(36)}  ${v.toFixed(2)}%  ← would go to "Other"`);
  untrackedSum += v;
}
console.log(`  SUM: ${untrackedSum.toFixed(2)}%`);

console.log(`\n=== perf_counter[\\Process(*)] items (${perfCounterProc.length}) at 15:25 ===`);
console.log("(These are % of one core. With 4 cores, divide by 4 for % of host.)");
for (const it of perfCounterProc) {
  const recs = await probe(it);
  if (!recs?.length) { continue; }
  const closest = recs.reduce((m, r) => Math.abs(parseInt(r.clock) - t) < Math.abs(parseInt(m.clock) - t) ? r : m);
  const v = parseFloat(closest.value);
  if (v < 1) continue;
  const procName = it.key_.match(/Process\(([^)]+)\)/)?.[1] || "?";
  console.log(`  ${procName.padEnd(20)}  ${v.toFixed(2)}% (per core) = ${(v/4).toFixed(2)}% (host)`);
}

console.log(`\n=== system.cpu.* items (${systemCpu.length}) at 15:25 ===`);
for (const it of systemCpu) {
  const recs = await probe(it);
  if (!recs?.length) { console.log(`  ${it.key_.padEnd(40)}  no samples`); continue; }
  const closest = recs.reduce((m, r) => Math.abs(parseInt(r.clock) - t) < Math.abs(parseInt(m.clock) - t) ? r : m);
  const v = parseFloat(closest.value);
  console.log(`  ${it.key_.padEnd(40)}  ${v.toFixed(2)}%`);
}
