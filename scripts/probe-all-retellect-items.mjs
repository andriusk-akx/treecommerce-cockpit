// Sweep all Rimi hosts for items whose key/name could plausibly be Retellect-
// related but isn't matched by our current python.* / perf_counter[python] rule.
// Outputs unique item keys grouped by pattern, so we can spot any process
// we should be including in the Retellect category but currently are not.
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

// Pull EVERY item across the Rimi host group; this is the only way to find
// hidden ones. Group id 198 confirmed from earlier probes.
const items = await zbx("item.get", {
  output: ["itemid", "hostid", "key_", "name", "lastvalue", "lastclock", "status"],
  groupids: ["198"],
});
console.log("Total items across all Rimi hosts:", items.length);

// 1) Find every UNIQUE key in the group (across hosts).
const uniqueKeys = new Set();
for (const it of items) uniqueKeys.add(it.key_);
console.log("Unique item keys:", uniqueKeys.size);

// 2) Filter to anything plausibly process-related.
const procRegex = /python|retell|node|java|spss|sql|vm|udm|nhst|cs300|agent|service|proc\.|perf_counter|\.exe|\.cpu/i;
const procKeys = [...uniqueKeys].filter(k => procRegex.test(k));
console.log("\nProcess-related unique keys (" + procKeys.length + "):");
const groupedByPrefix = new Map();
for (const k of procKeys) {
  // Group by the first chunk before [ or .
  const prefix = k.match(/^[^.[]+/)?.[0] || k;
  if (!groupedByPrefix.has(prefix)) groupedByPrefix.set(prefix, []);
  groupedByPrefix.get(prefix).push(k);
}
for (const [prefix, keys] of [...groupedByPrefix.entries()].sort()) {
  console.log("\n[" + prefix + "] " + keys.length + " unique keys:");
  for (const k of keys.slice(0, 25)) console.log("    " + k);
  if (keys.length > 25) console.log("    ... +" + (keys.length - 25) + " more");
}

// 3) Specifically look for anything matching retellect-specific terms.
console.log("\n=== Items containing 'retell' / 'agent' / 'optim' / 'opt.exe' (case-insensitive) ===");
const retellectish = [...uniqueKeys].filter(k => /retell|agent|optim|optimi/i.test(k));
if (retellectish.length === 0) {
  console.log("(none found)");
} else {
  for (const k of retellectish) console.log("  " + k);
}

// 4) Dump ALL perf_counter[\Process(...)] process names seen anywhere.
console.log("\n=== Unique process names seen in perf_counter[\\Process(*)] ===");
const procNames = new Set();
for (const k of uniqueKeys) {
  const m = k.match(/\\Process\(([^)]+)\)/);
  if (m) procNames.add(m[1]);
}
for (const n of [...procNames].sort()) console.log("  " + n);

// 5) Dump ALL *.cpu prefixes seen.
console.log("\n=== Unique '*.cpu' prefixes seen ===");
const cpuPrefixes = new Set();
for (const k of uniqueKeys) {
  if (k.endsWith(".cpu") && !k.startsWith("perf_counter") && !k.startsWith("system.cpu")) {
    cpuPrefixes.add(k.replace(/\.cpu$/, ""));
  }
}
for (const p of [...cpuPrefixes].sort()) console.log("  " + p + ".cpu");
