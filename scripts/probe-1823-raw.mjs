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
const items = await zbx("item.get", {
  output: ["itemid", "key_"],
  hostids: [host.hostid],
  filter: { key_: ["python1.cpu", "spss.cpu", "sql.cpu", "vm.cpu", "system.cpu.util[,,avg1]"] },
});
console.log("Items:", items.length);

// Last hour samples
const now = Math.floor(Date.now() / 1000);
const from = now - 3600;
console.log(`Window: last 1h (since ${new Date(from*1000).toLocaleString("lt-LT", {timeZone:"Europe/Vilnius"})})\n`);

for (const it of items) {
  const recs = await zbx("history.get", {
    output: ["clock", "value"], itemids: [it.itemid], history: 0,
    time_from: String(from), sortfield: "clock", sortorder: "DESC", limit: 30,
  });
  console.log(`${it.key_} (${recs.length} samples):`);
  for (const r of recs.slice(0, 8)) {
    const ts = new Date(parseInt(r.clock) * 1000).toLocaleTimeString("lt-LT", { timeZone: "Europe/Vilnius", hour12: false });
    console.log(`  ${ts}  ${parseFloat(r.value).toFixed(2)}%`);
  }
  console.log();
}
