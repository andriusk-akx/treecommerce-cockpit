import * as fs from "node:fs";
async function main() {
  const envRaw = fs.readFileSync(".env.local", "utf8");
  const url = envRaw.match(/^ZABBIX_URL="?([^"\n]+)"?/m)![1];
  const token = envRaw.match(/^ZABBIX_TOKEN="?([^"\n]+)"?/m)![1];
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "host.get",
      params: {
        output: ["hostid", "host", "name"],
        selectInventory: "extend",
        groupids: ["198"],
      },
      id: 1,
    }),
  });
  const data = await res.json();
  const hosts = data.result;
  console.log(`${hosts.length} hosts`);
  
  // Count which fields are populated (non-empty, not "0")
  const counts: Record<string, number> = {};
  const samples: Record<string, string[]> = {};
  for (const h of hosts) {
    const inv = h.inventory;
    if (!inv || typeof inv !== "object") continue;
    for (const [k, v] of Object.entries(inv)) {
      if (v && typeof v === "string" && v.trim() !== "" && v !== "0") {
        counts[k] = (counts[k] || 0) + 1;
        if (!samples[k]) samples[k] = [];
        if (samples[k].length < 3 && !samples[k].includes(v)) samples[k].push(v);
      }
    }
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log("\nPopulated inventory fields (count out of " + hosts.length + "):");
  for (const [k, n] of sorted) {
    console.log(`  ${k}: ${n} — e.g. ${samples[k].slice(0, 2).join(" | ")}`);
  }
}
main();
