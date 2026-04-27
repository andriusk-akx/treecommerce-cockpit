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
  // Broad search by multiple keywords
  const terms = ["Outlet", "T813", "CHM Outlet", "outlet", "oulet"];
  for (const term of terms) {
    const byName = await zbx("host.get", {
      output: ["hostid", "host", "name", "status"],
      search: { name: term },
      searchWildcardsEnabled: true,
      limit: 10,
    });
    const byHost = await zbx("host.get", {
      output: ["hostid", "host", "name", "status"],
      search: { host: term },
      searchWildcardsEnabled: true,
      limit: 10,
    });
    console.log(`\n--- Term "${term}": byName=${byName.length}  byHost=${byHost.length}`);
    for (const h of [...byName, ...byHost]) console.log(`   host="${h.host}"  name="${h.name}"  status=${h.status}`);
  }

  // Try group filter for Rimi SCO WIN — show all of them sorted
  console.log("\n--- All hosts in Rimi SCO WIN group (id 198) ---");
  const groupHosts = await zbx("host.get", {
    output: ["hostid", "host", "name", "status"],
    groupids: ["198"],
    sortfield: "name",
  });
  console.log(`  Total: ${groupHosts.length}`);
  // Show only those with "out" (case-insensitive) anywhere
  const outletLike = groupHosts.filter((h: any) =>
    (h.host + " " + h.name).toLowerCase().includes("outlet") ||
    (h.host + " " + h.name).toLowerCase().includes("t813") ||
    (h.host + " " + h.name).toLowerCase().includes("outl"));
  console.log(`  Matching 'outl' or 'T813': ${outletLike.length}`);
  for (const h of outletLike) console.log(`   host="${h.host}"  name="${h.name}"  status=${h.status}`);

  // Show first 5 and last 5 names for reference
  console.log("\n  First 5:");
  for (const h of groupHosts.slice(0, 5)) console.log(`   host="${h.host}"  name="${h.name}"`);
  console.log("  Last 5:");
  for (const h of groupHosts.slice(-5)) console.log(`   host="${h.host}"  name="${h.name}"`);
}
main().catch((e) => { console.error(e); process.exit(1); });
