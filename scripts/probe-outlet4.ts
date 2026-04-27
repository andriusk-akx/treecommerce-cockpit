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
  // Exact host filter
  const hosts = await zbx("host.get", {
    output: ["hostid", "host", "name", "status"],
    filter: { host: ["LT_T813_SCOW_31", "LT_T813_SCOW_34"] },
    selectInventory: ["type", "hardware", "os", "software", "hw_arch"],
    selectInterfaces: ["ip", "type"],
    selectGroups: ["groupid", "name"],
  });
  console.log("=== Outlet hosts (exact filter) ===");
  for (const h of hosts) {
    const groups = (h.groups || []).map((g: any) => g.name).join(", ");
    const inv = h.inventory && typeof h.inventory === "object" && !Array.isArray(h.inventory) ? h.inventory : {};
    const interfaces = (h.interfaces || []).map((i: any) => `${i.ip}(type=${i.type})`).join(", ");
    console.log(`  hostid=${h.hostid}  host="${h.host}"  name="${h.name}"  status=${h.status}`);
    console.log(`    groups=[${groups}]`);
    console.log(`    interfaces=[${interfaces}]`);
    console.log(`    inventory.hw="${(inv as any).hardware ?? ""}"  os="${(inv as any).os ?? ""}"  type="${(inv as any).type ?? ""}"`);
  }

  // Items on these hosts
  const hostIds = hosts.map((h: any) => h.hostid);
  for (const h of hosts) {
    console.log(`\n--- Items on ${h.host} (hostid=${h.hostid}) ---`);
    const items = await zbx("item.get", {
      output: ["itemid", "key_", "name", "lastvalue", "lastclock", "status"],
      hostids: [h.hostid],
    });
    console.log(`  Total items: ${items.length}`);
    const active = items.filter((it: any) => it.status === "0");
    console.log(`  Active: ${active.length}`);
    // Classify
    const byType: Record<string, any[]> = { cpu: [], memory: [], proc: [], agent: [], other: [] };
    for (const it of active) {
      if (it.key_.includes("cpu")) byType.cpu.push(it);
      else if (it.key_.includes("memory")) byType.memory.push(it);
      else if (it.key_.includes("proc")) byType.proc.push(it);
      else if (it.key_.includes("agent")) byType.agent.push(it);
      else byType.other.push(it);
    }
    for (const [category, arr] of Object.entries(byType)) {
      console.log(`  ${category}: ${arr.length}`);
      for (const it of arr.slice(0, 8)) {
        const date = it.lastclock !== "0" ? new Date(Number(it.lastclock) * 1000).toISOString() : "never";
        console.log(`    ${it.key_} = ${it.lastvalue} [lastclock=${date}]`);
      }
      if (arr.length > 8) console.log(`    ... and ${arr.length - 8} more`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
