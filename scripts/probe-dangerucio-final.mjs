// Final diagnosis — overall reporting health per host.
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

const TARGETS = [
  { id: "25249", label: "SCO1 same store (T822)" },
  { id: "25250", label: "SCO2 SUSPECT (T822)" },
  { id: "25229", label: "Pavilnionys SCO2 (KNOWN-WORKING)" }, // T803_SCOW_32
];

console.log("=== Reporting health per host ===");
for (const t of TARGETS) {
  const items = await zbx("item.get", {
    output: ["itemid", "key_", "lastclock", "status", "state", "error"],
    hostids: [t.id],
  });
  const enabled = items.filter(i => i.status === "0");
  const reporting = enabled.filter(i => i.lastclock !== "0");
  const unsupported = enabled.filter(i => i.state === "1");
  const recent = enabled.filter(i => i.lastclock !== "0" && (Date.now()/1000 - parseInt(i.lastclock)) < 600);
  console.log(`\n  ${t.label}`);
  console.log(`    enabled total:    ${enabled.length}`);
  console.log(`    ever reported:    ${reporting.length}`);
  console.log(`    last <10min ago:  ${recent.length}`);
  console.log(`    Zabbix-marked UNSUPPORTED (state=1): ${unsupported.length}`);
  if (unsupported.length > 0) {
    console.log(`    Sample errors:`);
    unsupported.slice(0, 3).forEach(i => {
      console.log(`      ${i.key_}: ${i.error || "(no error msg)"}`);
    });
  }

  // Find newest reporting item
  if (reporting.length > 0) {
    const newest = reporting.reduce((m, i) => parseInt(i.lastclock) > parseInt(m.lastclock) ? i : m);
    const age = Math.round((Date.now()/1000 - parseInt(newest.lastclock))/60);
    console.log(`    freshest item:    ${newest.key_} (${age}m ago)`);
  } else {
    console.log(`    freshest item:    NONE — agent never delivered any data`);
  }
}
