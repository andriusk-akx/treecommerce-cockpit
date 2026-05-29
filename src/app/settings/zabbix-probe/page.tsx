/**
 * Admin → Zabbix probe.
 *
 * One-off diagnostic page that surveys Zabbix for items / triggers / events
 * matching a list of transaction-related keywords. Built to answer:
 * "did SP admin actually enable the active-minute / transaction-start
 *  tracking yet?". Runs server-side using getZabbixClient() so we don't
 * need the user to share a token from .env.local.
 *
 * Gated by the settings layout's `requireAdmin` check.
 */
import { getZabbixClient } from "@/lib/zabbix/client";

export const dynamic = "force-dynamic";

const KEYWORDS = [
  "trans", "active", "session", "scan", "kasa",
  "customer", "checkout", "busy", "minute", "purchase",
];

function matchesKeyword(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return KEYWORDS.some((kw) => lower.includes(kw));
}

interface ZItem {
  itemid: string;
  hostid: string;
  key_: string;
  name: string;
  type: string;
  value_type: string;
  delay: string;
  history: string;
  trends: string;
  lastvalue: string | null;
  lastclock: string | null;
}

interface ZTrigger {
  triggerid: string;
  description: string;
  expression: string;
  priority: string;
  status: string;
  value: string;
  lastchange: string | null;
}

interface ZEvent {
  eventid: string;
  source: string;
  object: string;
  objectid: string;
  clock: string;
  value: string;
  name: string;
  severity: string;
}

interface ZHost {
  hostid: string;
  name: string;
}

function fmtClock(s: string | null): string {
  if (!s) return "—";
  const sec = parseInt(s, 10);
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  return new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function ageMin(s: string | null): string {
  if (!s) return "";
  const sec = parseInt(s, 10);
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const ago = Math.round((Date.now() / 1000 - sec) / 60);
  if (ago < 0) return "";
  return ` (${ago} min ago)`;
}

export default async function ZabbixProbePage() {
  const client = getZabbixClient();
  const startedAt = Date.now();

  // 1) Pull all enabled items and filter client-side by keyword.
  const allItems = (await client.request("item.get", {
    output: ["itemid", "hostid", "key_", "name", "type", "value_type", "delay", "history", "trends", "lastvalue", "lastclock"],
    filter: { status: 0 },
  })) as ZItem[];

  const matchingItems = allItems.filter((it) => matchesKeyword(it.key_) || matchesKeyword(it.name));

  // Group by key family (strip [params] suffix).
  const itemFamilies = new Map<string, ZItem[]>();
  for (const it of matchingItems) {
    const family = it.key_.replace(/\[.*\]$/, "");
    if (!itemFamilies.has(family)) itemFamilies.set(family, []);
    itemFamilies.get(family)!.push(it);
  }
  const sortedFamilies = [...itemFamilies.entries()].sort((a, b) => b[1].length - a[1].length);

  // 2) Pull all enabled triggers.
  const allTriggers = (await client.request("trigger.get", {
    output: ["triggerid", "description", "expression", "priority", "status", "value", "lastchange"],
    filter: { status: 0 },
  })) as ZTrigger[];

  const matchingTriggers = allTriggers.filter(
    (t) => matchesKeyword(t.description) || matchesKeyword(t.expression),
  );

  // 3) Recent events from matching triggers.
  const weekAgoSec = Math.floor(Date.now() / 1000) - 7 * 86_400;
  const events: ZEvent[] = matchingTriggers.length === 0
    ? []
    : ((await client.request("event.get", {
        output: ["eventid", "source", "object", "objectid", "clock", "value", "name", "severity"],
        objectids: matchingTriggers.map((t) => t.triggerid),
        time_from: String(weekAgoSec),
        sortfield: ["clock"],
        sortorder: "DESC",
        limit: 100,
      })) as ZEvent[]);

  // 4) Pavilnionys SCO2 deep dive.
  const sco2Search = (await client.request("host.get", {
    output: ["hostid", "name"],
    search: { name: "Pavilnionys" },
  })) as ZHost[];
  const sco2 = sco2Search.find((h) => /SCO2\b/.test(h.name)) ?? null;

  let sco2Items: ZItem[] = [];
  let sco2Matching: ZItem[] = [];
  let firstItemHistory: Array<{ clock: string; value: string }> = [];
  let firstItemKey = "";

  if (sco2) {
    sco2Items = (await client.request("item.get", {
      output: ["itemid", "key_", "name", "type", "value_type", "delay", "history", "trends", "lastvalue", "lastclock"],
      hostids: [sco2.hostid],
      filter: { status: 0 },
    })) as ZItem[];
    sco2Matching = sco2Items.filter((it) => matchesKeyword(it.key_) || matchesKeyword(it.name));

    if (sco2Matching.length > 0) {
      const first = sco2Matching[0];
      firstItemKey = first.key_;
      const dayAgo = Math.floor(Date.now() / 1000) - 86_400;
      for (const vt of [0, 3, 1]) {
        const rows = (await client.request("history.get", {
          output: ["clock", "value"],
          itemids: [first.itemid],
          history: vt,
          time_from: String(dayAgo),
          sortfield: "clock",
          sortorder: "DESC",
          limit: 20,
        })) as Array<{ clock: string; value: string }>;
        if (rows.length > 0) { firstItemHistory = rows; break; }
      }
    }
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

  return (
    <div className="max-w-6xl">
      <h1 className="text-lg font-semibold text-gray-900 mb-2">Zabbix probe — transaction / active-minute signals</h1>
      <p className="text-sm text-gray-500 mb-4">
        Searches the enabled item/trigger/event registry for keywords related to
        transaction starts and active minutes (<code>{KEYWORDS.join(", ")}</code>).
        Fleet scan took {elapsedSec}s.
      </p>

      {/* ── Section 1: Item families ────────────────────────────── */}
      <section className="mb-8">
        <h2 className="text-base font-semibold mb-2">1. Matching items ({matchingItems.length} of {allItems.length})</h2>
        {sortedFamilies.length === 0 ? (
          <p className="text-sm text-gray-500">No items found. SP admin&apos;s changes haven&apos;t landed (or use different keys).</p>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-100 text-left">
                <th className="px-2 py-1 border-b">Key family</th>
                <th className="px-2 py-1 border-b text-right">Items</th>
                <th className="px-2 py-1 border-b text-right">Hosts</th>
                <th className="px-2 py-1 border-b">Sample name</th>
                <th className="px-2 py-1 border-b">Last value</th>
                <th className="px-2 py-1 border-b">Last clock</th>
              </tr>
            </thead>
            <tbody>
              {sortedFamilies.slice(0, 40).map(([family, items]) => {
                const sample = items[0];
                const hosts = new Set(items.map((i) => i.hostid)).size;
                return (
                  <tr key={family} className="border-b">
                    <td className="px-2 py-1 font-mono">{family}</td>
                    <td className="px-2 py-1 text-right">{items.length}</td>
                    <td className="px-2 py-1 text-right">{hosts}</td>
                    <td className="px-2 py-1">{sample.name}</td>
                    <td className="px-2 py-1">{sample.lastvalue ?? "—"}</td>
                    <td className="px-2 py-1">{fmtClock(sample.lastclock)}{ageMin(sample.lastclock)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Section 2: Triggers ─────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="text-base font-semibold mb-2">2. Matching triggers ({matchingTriggers.length} of {allTriggers.length})</h2>
        {matchingTriggers.length === 0 ? (
          <p className="text-sm text-gray-500">No matching triggers.</p>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-100 text-left">
                <th className="px-2 py-1 border-b">Priority</th>
                <th className="px-2 py-1 border-b">Description</th>
                <th className="px-2 py-1 border-b">Expression</th>
                <th className="px-2 py-1 border-b">State</th>
                <th className="px-2 py-1 border-b">Last change</th>
              </tr>
            </thead>
            <tbody>
              {matchingTriggers.slice(0, 40).map((t) => (
                <tr key={t.triggerid} className="border-b">
                  <td className="px-2 py-1">{t.priority}</td>
                  <td className="px-2 py-1">{t.description}</td>
                  <td className="px-2 py-1 font-mono text-xs">{t.expression}</td>
                  <td className="px-2 py-1">{t.value === "1" ? "PROBLEM" : "OK"}</td>
                  <td className="px-2 py-1">{fmtClock(t.lastchange)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Section 3: Recent events ────────────────────────────── */}
      <section className="mb-8">
        <h2 className="text-base font-semibold mb-2">3. Recent events from matching triggers ({events.length}, last 7 days)</h2>
        {events.length === 0 ? (
          <p className="text-sm text-gray-500">
            {matchingTriggers.length === 0
              ? "No matching triggers → no events to query."
              : "No events in the last 7 days. Triggers exist but haven't fired."}
          </p>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-100 text-left">
                <th className="px-2 py-1 border-b">Clock</th>
                <th className="px-2 py-1 border-b">Trigger</th>
                <th className="px-2 py-1 border-b">Value</th>
                <th className="px-2 py-1 border-b">Severity</th>
              </tr>
            </thead>
            <tbody>
              {events.slice(0, 30).map((e) => (
                <tr key={e.eventid} className="border-b">
                  <td className="px-2 py-1">{fmtClock(e.clock)}</td>
                  <td className="px-2 py-1">{e.name || `trigger ${e.objectid}`}</td>
                  <td className="px-2 py-1">{e.value === "1" ? "PROBLEM" : "OK"}</td>
                  <td className="px-2 py-1">{e.severity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Section 4: Pavilnionys SCO2 deep dive ───────────────── */}
      <section className="mb-8">
        <h2 className="text-base font-semibold mb-2">4. Pavilnionys SCO2 — host-specific items</h2>
        {!sco2 ? (
          <p className="text-sm text-gray-500">Pavilnionys SCO2 host not found in Zabbix.</p>
        ) : (
          <>
            <p className="text-sm text-gray-700 mb-2">
              <strong>{sco2.name}</strong> (host id <code>{sco2.hostid}</code>) — {sco2Items.length} enabled items;
              {" "}{sco2Matching.length} match the transaction/active keywords.
            </p>
            {sco2Matching.length === 0 ? (
              <p className="text-sm text-gray-500">No matching items on this host.</p>
            ) : (
              <table className="w-full text-xs border-collapse mb-4">
                <thead>
                  <tr className="bg-gray-100 text-left">
                    <th className="px-2 py-1 border-b">Key</th>
                    <th className="px-2 py-1 border-b">Name</th>
                    <th className="px-2 py-1 border-b">Last value</th>
                    <th className="px-2 py-1 border-b">Last clock</th>
                    <th className="px-2 py-1 border-b">Delay</th>
                  </tr>
                </thead>
                <tbody>
                  {sco2Matching.map((it) => (
                    <tr key={it.itemid} className="border-b">
                      <td className="px-2 py-1 font-mono">{it.key_}</td>
                      <td className="px-2 py-1">{it.name}</td>
                      <td className="px-2 py-1">{it.lastvalue ?? "—"}</td>
                      <td className="px-2 py-1">{fmtClock(it.lastclock)}{ageMin(it.lastclock)}</td>
                      <td className="px-2 py-1">{it.delay}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {firstItemHistory.length > 0 && (
              <>
                <h3 className="text-sm font-semibold mb-1">5. Last 24h samples from first matching item: <code>{firstItemKey}</code></h3>
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-100 text-left">
                      <th className="px-2 py-1 border-b">Clock</th>
                      <th className="px-2 py-1 border-b">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {firstItemHistory.slice(0, 20).map((r, i) => (
                      <tr key={i} className="border-b">
                        <td className="px-2 py-1">{fmtClock(r.clock)}</td>
                        <td className="px-2 py-1 font-mono">{r.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </section>

      <p className="text-xs text-gray-400 mt-8">
        Probe ran at {new Date().toISOString()}. Refresh to re-poll Zabbix.
      </p>
    </div>
  );
}
