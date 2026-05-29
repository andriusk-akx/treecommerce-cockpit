// Discover Zabbix items/triggers/events related to SCO transaction starts.
//
// SP admin promised to add events that indicate a transaction has begun
// — i.e. minute-level "active customer at the kasa" signal. This script
// surveys the Zabbix API broadly for whatever was actually enabled, so
// we can wire AKpilot's "active minutes" tracking to the right key.
//
// Usage:
//   cd app && node scripts/probe-zabbix-transaction-events.mjs
//   (reads ZABBIX_TOKEN from .env.local)
//
// Output: a structured report listing matching items/triggers/events
// across the whole Zabbix fleet, plus a Pavilnionys SCO2 deep dive.

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
  if (data.error) throw new Error(`${method}: ${data.error.message} (${data.error.data})`);
  return data.result;
}

// ── Patterns to search for ───────────────────────────────────────────
//
// SP admin's promise was about "events that indicate transaction starts"
// and "active minute tracking". We don't know the exact key names, so
// we search broadly. Anything matching here is worth a closer look.
const KEYWORDS = [
  "trans",       // transaction, transactionstart, sco.transaction.*
  "active",      // active.minutes, sco.active, kasa.active
  "session",     // session.start, customer.session
  "scan",        // scan.start, barcode.scan
  "kasa",        // kasa.busy, kasa.active
  "customer",    // customer.present, customer.start
  "checkout",    // checkout.transaction
  "busy",        // sco.busy
];

function matchesKeyword(text) {
  const lower = String(text).toLowerCase();
  return KEYWORDS.some((kw) => lower.includes(kw));
}

// ── 1. Fleet-wide item key survey ────────────────────────────────────

console.log("══ 1. Items matching transaction/active keywords ══════════════════════════\n");
const allItems = await zbx("item.get", {
  output: ["itemid", "hostid", "key_", "name", "type", "value_type", "delay", "history", "trends", "lastvalue", "lastclock"],
  filter: { status: 0 },
  search: { key_: "" },        // server-side OR isn't supported; we filter client-side
  searchByAny: true,
});

const matchingItems = allItems.filter((it) => matchesKeyword(it.key_) || matchesKeyword(it.name));
console.log(`Total enabled items in Zabbix: ${allItems.length}`);
console.log(`Matching transaction/active keywords: ${matchingItems.length}\n`);

if (matchingItems.length === 0) {
  console.log("  (no items match — SP admin's changes may not be in yet, or use different keys)\n");
} else {
  // Group by key family
  const byKey = new Map();
  for (const it of matchingItems) {
    const family = it.key_.replace(/\[.*\]$/, ""); // strip [params]
    if (!byKey.has(family)) byKey.set(family, []);
    byKey.get(family).push(it);
  }
  const sorted = [...byKey.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [family, items] of sorted.slice(0, 25)) {
    const sample = items[0];
    const hosts = new Set(items.map((i) => i.hostid)).size;
    console.log(`  ${family.padEnd(48)}  ${String(items.length).padStart(4)} items / ${String(hosts).padStart(3)} hosts`);
    console.log(`    sample: ${sample.name} (host ${sample.hostid}, lastvalue=${sample.lastvalue}, lastclock=${sample.lastclock ? new Date(parseInt(sample.lastclock) * 1000).toISOString() : "—"})`);
  }
}

// ── 2. Triggers matching keywords ────────────────────────────────────

console.log("\n══ 2. Triggers matching transaction/active keywords ═════════════════════\n");
const allTriggers = await zbx("trigger.get", {
  output: ["triggerid", "description", "expression", "priority", "status", "value", "lastchange"],
  filter: { status: 0 },
});
const matchingTriggers = allTriggers.filter((t) => matchesKeyword(t.description) || matchesKeyword(t.expression));
console.log(`Total enabled triggers: ${allTriggers.length}`);
console.log(`Matching transaction/active keywords: ${matchingTriggers.length}\n`);
for (const t of matchingTriggers.slice(0, 30)) {
  const last = t.lastchange ? new Date(parseInt(t.lastchange) * 1000).toISOString() : "—";
  console.log(`  [${t.priority}] ${t.description}`);
  console.log(`    expr: ${t.expression}`);
  console.log(`    state=${t.value} lastchange=${last}\n`);
}

// ── 3. Recent events matching keywords ───────────────────────────────

console.log("\n══ 3. Recent events (last 7 days) from matching triggers ════════════════\n");
const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
const events = matchingTriggers.length === 0
  ? []
  : await zbx("event.get", {
      output: ["eventid", "source", "object", "objectid", "clock", "value", "name", "severity"],
      objectids: matchingTriggers.map((t) => t.triggerid),
      time_from: String(weekAgo),
      sortfield: ["clock"],
      sortorder: "DESC",
      limit: 100,
    });
console.log(`Events in window: ${events.length}\n`);
for (const e of events.slice(0, 20)) {
  console.log(`  ${new Date(parseInt(e.clock) * 1000).toISOString()}  ${e.name || `trigger ${e.objectid}`}  value=${e.value}`);
}

// ── 4. Pavilnionys SCO2 deep dive ────────────────────────────────────

console.log("\n══ 4. Pavilnionys SCO2 — every item, including ones not matching keywords ══\n");
const hosts = await zbx("host.get", { output: ["hostid", "name"], search: { name: "Pavilnionys" } });
const sco2 = hosts.find((h) => /SCO2\b/.test(h.name));
if (!sco2) {
  console.log("  (Pavilnionys SCO2 host not found — adjust search above)");
} else {
  console.log(`Host: ${sco2.name} (id ${sco2.hostid})\n`);
  const hostItems = await zbx("item.get", {
    output: ["itemid", "key_", "name", "type", "value_type", "delay", "lastvalue", "lastclock", "history", "trends"],
    hostids: [sco2.hostid],
    filter: { status: 0 },
  });
  console.log(`Enabled items on this host: ${hostItems.length}\n`);
  const matching = hostItems.filter((it) => matchesKeyword(it.key_) || matchesKeyword(it.name));
  console.log(`Matching transaction/active keywords on THIS host: ${matching.length}\n`);
  for (const it of matching) {
    const last = it.lastclock ? new Date(parseInt(it.lastclock) * 1000).toISOString() : "—";
    const ageMin = it.lastclock ? Math.round((Date.now() / 1000 - parseInt(it.lastclock)) / 60) : null;
    console.log(`  ${it.key_}`);
    console.log(`    name=${it.name}`);
    console.log(`    lastvalue=${it.lastvalue} lastclock=${last}${ageMin !== null ? ` (${ageMin} min ago)` : ""}`);
    console.log(`    delay=${it.delay} history=${it.history} trends=${it.trends}\n`);
  }

  // ── 5. Sample history for any matching item to verify it's actually reporting ──
  if (matching.length > 0) {
    console.log("══ 5. Last 24 h of samples for first matching item ════════════════════════\n");
    const first = matching[0];
    console.log(`Item: ${first.key_}`);
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    for (const vt of [0, 3, 1]) {
      const rows = await zbx("history.get", {
        output: ["clock", "value"],
        itemids: [first.itemid],
        history: vt,
        time_from: String(dayAgo),
        sortfield: "clock",
        sortorder: "DESC",
        limit: 20,
      });
      if (rows.length === 0) continue;
      console.log(`  (history value_type=${vt}, ${rows.length} samples shown)\n`);
      for (const r of rows.slice(0, 15)) {
        console.log(`    ${new Date(parseInt(r.clock) * 1000).toISOString()}  value=${r.value}`);
      }
      break;
    }
  }
}

console.log("\n══ Done. Share the output above and we'll wire AKpilot to whatever was enabled. ══");
