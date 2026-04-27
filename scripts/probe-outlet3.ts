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
  // Search globally (no group filter) for T813
  console.log("=== Global search for T813 (no group filter) ===");
  const allT813 = await zbx("host.get", {
    output: ["hostid", "host", "name", "status"],
    search: { host: "T813" },
    searchWildcardsEnabled: true,
    selectGroups: ["groupid", "name"],
  });
  console.log(`Found ${allT813.length} hosts with T813 in host field`);
  for (const h of allT813) {
    const groups = (h.groups || []).map((g: any) => g.name).join(", ");
    console.log(`  host="${h.host}"  name="${h.name}"  groups=[${groups}]`);
  }

  // Also by Outlet in name (no group filter)
  const allOutlet = await zbx("host.get", {
    output: ["hostid", "host", "name", "status"],
    search: { name: "Outlet" },
    searchWildcardsEnabled: true,
    selectGroups: ["groupid", "name"],
  });
  console.log(`\nFound ${allOutlet.length} hosts with 'Outlet' in name field`);
  for (const h of allOutlet) {
    const groups = (h.groups || []).map((g: any) => g.name).join(", ");
    console.log(`  host="${h.host}"  name="${h.name}"  groups=[${groups}]`);
  }

  // All items on the 2 Outlet hosts: let's see what data we CAN get
  console.log("\n=== What data is available on the Outlet hosts? ===");
  for (const hostId of ["10627", "10628"]) { /* placeholder - need actual IDs */ }
  // Get host IDs
  const outletHosts = allT813.length > 0 ? allT813 : [];
  for (const h of outletHosts) {
    console.log(`\n--- Host ${h.host} (${h.name}) hostid=${h.hostid} ---`);
    const items = await zbx("item.get", {
      output: ["itemid", "key_", "name", "lastvalue", "lastclock", "status"],
      hostids: [h.hostid],
      filter: { status: 0 }, // only active items
    });
    console.log(`  Active items: ${items.length}`);
    // Show only CPU/memory/disk/process items
    const relevant = items.filter((it: any) =>
      it.key_.includes("cpu") || it.key_.includes("memory") || it.key_.includes("vm.memory") ||
      it.key_.includes("proc") || it.key_.includes("system.hw") || it.key_.includes("agent")
    );
    console.log(`  Relevant (cpu/mem/proc/hw/agent): ${relevant.length}`);
    for (const it of relevant.slice(0, 20)) {
      console.log(`    ${it.key_} = ${it.lastvalue} [lastclock=${it.lastclock}]`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
