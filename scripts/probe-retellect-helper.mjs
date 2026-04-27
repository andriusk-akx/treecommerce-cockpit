// Specific search for any item that could be a Retellect helper / service /
// auxiliary process. Goes wider than the previous sweep — checks names,
// keys, service items, anything that might match.
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

// Strategy: pull ALL items in Rimi group with NO filter, dump unique keys
// AND unique names, then grep both for anything matching helper/service/etc.
console.log("Pulling all items …");
const items = await zbx("item.get", {
  output: ["itemid", "key_", "name", "lastvalue"],
  groupids: ["198"],
});
console.log("Total items:", items.length);

const uniqueKeys = new Set();
const uniqueNames = new Set();
for (const it of items) {
  uniqueKeys.add(it.key_);
  if (it.name) uniqueNames.add(it.name);
}
console.log("Unique keys:", uniqueKeys.size, "  Unique names:", uniqueNames.size);

// Search both keys and names for relevant terms.
const search = (label, regex) => {
  const ks = [...uniqueKeys].filter(k => regex.test(k));
  const ns = [...uniqueNames].filter(n => regex.test(n));
  console.log("\n=== " + label + " ===");
  if (ks.length === 0 && ns.length === 0) {
    console.log("  (no matches)");
    return;
  }
  if (ks.length) {
    console.log("  KEYS:");
    for (const k of ks) console.log("    " + k);
  }
  if (ns.length) {
    console.log("  NAMES (display labels):");
    for (const n of ns) console.log("    " + n);
  }
};

search("retellect / retell", /retell/i);
search("helper", /helper/i);
search("agent (any)", /agent/i);
search("optim / optimizer / optimization", /optim/i);
search("rt[._-] / rtsvc / rt-svc", /\brt[._-]/i);
search("Service.* (Zabbix Windows service items)", /^service\.|service_state|service_status/i);
search("anything *.exe (process names embedded)", /\.exe/i);
search("custom proc.* items", /^proc\./i);
search("UserParameter style keys", /^user\.|^custom\./i);

// Also dump ALL keys grouped by first chunk so we can eyeball anything weird.
console.log("\n=== All key prefixes (first chunk before . or [) ===");
const prefixes = new Map();
for (const k of uniqueKeys) {
  const p = k.match(/^[^.[]+/)?.[0] || k;
  prefixes.set(p, (prefixes.get(p) ?? 0) + 1);
}
for (const [p, c] of [...prefixes.entries()].sort()) {
  console.log("  " + p.padEnd(40) + " (" + c + " unique key" + (c === 1 ? "" : "s") + ")");
}
