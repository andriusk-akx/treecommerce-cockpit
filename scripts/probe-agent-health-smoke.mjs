// Smoke test: hit live Zabbix via the new getAgentHealthSummary path,
// verify the Dangeručio SCO1/SCO2 split shows up as expected.
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
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

// Mirror the exact method body of ZabbixClient.getAgentHealthSummary.
async function getAgentHealthSummary(hostIds) {
  if (hostIds.length === 0) return [];
  const items = await zbx("item.get", {
    output: ["itemid", "hostid", "key_", "state", "error"],
    hostids: hostIds,
    filter: { status: 0 },
  });
  const byHost = new Map();
  for (const it of items) {
    let entry = byHost.get(it.hostid);
    if (!entry) {
      entry = { totalEnabled: 0, supported: 0, unsupported: 0, sampleErrors: [] };
      byHost.set(it.hostid, entry);
    }
    entry.totalEnabled += 1;
    if (it.state === "1") {
      entry.unsupported += 1;
      if (entry.sampleErrors.length < 5 && it.error) entry.sampleErrors.push(it.error);
    } else {
      entry.supported += 1;
    }
  }
  return hostIds.map((hostId) => {
    const e = byHost.get(hostId);
    return {
      hostId,
      totalEnabled: e?.totalEnabled ?? 0,
      supported: e?.supported ?? 0,
      unsupported: e?.unsupported ?? 0,
      sampleErrors: e?.sampleErrors ?? [],
    };
  });
}

// Replicate the dashboard classification rule.
function classifyAgentHealth(supported, unsupported, totalEnabled) {
  if (totalEnabled === 0) return "no-data";
  const ratio = unsupported / totalEnabled;
  if (ratio > 0.5) return "broken";
  if (ratio >= 0.25) return "partial";
  return "healthy";
}

const hostIds = ["25249", "25250"]; // Dangeručio SCO1 + SCO2
const result = await getAgentHealthSummary(hostIds);

console.log("Agent health smoke test:");
result.forEach((r) => {
  const label = r.hostId === "25249" ? "Dangeručio SCO1" : "Dangeručio SCO2";
  const bucket = classifyAgentHealth(r.supported, r.unsupported, r.totalEnabled);
  console.log(
    `  ${label.padEnd(20)}  ${r.supported}/${r.totalEnabled} supported  ` +
    `${r.unsupported} unsupported  →  bucket=${bucket}`,
  );
  if (r.sampleErrors.length > 0) {
    console.log(`    sample error: ${r.sampleErrors[0].slice(0, 80)}...`);
  }
});

console.log("\nExpected: SCO1 = 'partial' (~33% unsupported), SCO2 = 'broken' (>90% unsupported)");
