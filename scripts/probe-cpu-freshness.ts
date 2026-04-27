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
      method: "item.get",
      params: {
        output: ["itemid", "hostid", "key_", "lastclock", "lastvalue", "delay", "status", "state"],
        groupids: ["198"],
        search: { key_: "system.cpu.util[,,avg1]" },
      },
      id: 1,
    }),
  });
  const data = await res.json();
  const items = data.result;
  const now = Math.floor(Date.now() / 1000);
  
  const ages = items.map((i: any) => ({
    hostid: i.hostid, 
    lastclock: Number(i.lastclock), 
    ageMin: Number(i.lastclock) > 0 ? Math.floor((now - Number(i.lastclock)) / 60) : -1, 
    delay: i.delay,
  }));
  
  const byDelay = new Map<string, number[]>();
  for (const a of ages) {
    if (a.ageMin < 0) continue;
    if (!byDelay.has(a.delay)) byDelay.set(a.delay, []);
    byDelay.get(a.delay)!.push(a.ageMin);
  }
  console.log("Age by delay:");
  for (const [delay, arr] of byDelay) {
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    const median = sorted[Math.floor(n / 2)];
    const p95 = sorted[Math.floor(n * 0.95)];
    console.log(`  delay=${delay}  n=${n}  min=${sorted[0]}min  median=${median}min  p95=${p95}min  max=${sorted[n-1]}min`);
  }
  
  // Diagnose "never reported" hosts
  const neverHosts = ages.filter((a: any) => a.ageMin < 0);
  console.log(`\n"Never reported" hosts: ${neverHosts.length}`);
  if (neverHosts.length > 0) {
    console.log("Sample hostids:", neverHosts.slice(0, 5).map((h: any) => h.hostid));
  }
}
main();
