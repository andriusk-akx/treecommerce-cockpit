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

async function listItems(hostId: string, label: string) {
  console.log(`\n========== ${label} (hostid=${hostId}) ==========`);
  const items = await zbx("item.get", {
    output: ["itemid", "key_", "name", "lastvalue", "lastclock", "status", "units"],
    hostids: [hostId],
    sortfield: "key_",
  });
  const active = items.filter((it: any) => it.status === "0");
  console.log(`Total items: ${items.length}, active: ${active.length}`);
  console.log("\nAll active items:");
  console.log("KEY".padEnd(70), "NAME".padEnd(50), "VALUE".padEnd(15), "UNITS", "AGE");
  console.log("─".repeat(160));
  for (const it of active) {
    const age = it.lastclock === "0" ? "never" : `${Math.round((Date.now() / 1000 - Number(it.lastclock)) / 60)}min ago`;
    const val = String(it.lastvalue ?? "").slice(0, 14);
    console.log(it.key_.slice(0, 70).padEnd(70), (it.name ?? "").slice(0, 50).padEnd(50), val.padEnd(15), (it.units ?? "").padEnd(5), age);
  }
}

async function main() {
  // Find hosts of interest
  const hosts = await zbx("host.get", {
    output: ["hostid", "host", "name"],
    filter: { host: ["LT_T813_SCOW_31", "LT_T813_SCOW_34", "LT_T777_SCOW_31", "LT_T777_SCOW_32", "LT_T777_SCOW_33", "LT_T777_SCOW_34", "LT_T777_SCOW_35"] },
    sortfield: "host",
  });
  console.log("Found hosts:");
  for (const h of hosts) console.log(`  ${h.host} (${h.name}) hostid=${h.hostid}`);

  for (const h of hosts) {
    await listItems(h.hostid, `${h.host} — ${h.name}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
