/**
 * Fetch the Retellect configuration log-items from Zabbix.
 *
 * The StrongPoint admin configured three log-monitoring items per SCO host:
 *   • config.ini dump      key: log[…\server.log,"config.ini",…]
 *   • Retellect version    key: log[…\server.log,"Starting server",…]
 *   • SCO / SPSSS version   key: log[E:\logs\spsss\app.log,"DEBUG.*evtAppStart",…]
 *
 * These are `value_type = 2` (log) items, so current value comes from
 * `item.get.lastvalue` and change history from `history.get(history: 2)`.
 * Parsing lives in `src/lib/rt/config-tracking/parse.ts`; this module only
 * fetches and groups raw values by host.
 */
import { getZabbixClient } from "./client";
import { cached } from "./cache";

export interface RawConfigItem {
  value: string;
  /** Unix seconds. */
  clock: number;
}

export interface RawHostConfig {
  hostId: string;
  hostName: string;
  configIni: RawConfigItem | null;
  /** Ascending by clock. */
  configIniHistory: RawConfigItem[];
  rtVersion: RawConfigItem | null;
  rtVersionHistory: RawConfigItem[];
  scoVersion: RawConfigItem | null;
  scoVersionHistory: RawConfigItem[];
}

type Kind = "ini" | "rtver" | "scover";

function classify(key: string): Kind | null {
  if (/config\.ini/.test(key)) return "ini";
  if (/Starting server/.test(key)) return "rtver";
  if (/evtAppStart/.test(key)) return "scover";
  return null;
}

interface RawItem {
  itemid: string;
  hostid: string;
  key_: string;
  lastvalue?: string;
  lastclock?: string;
}

interface HistRow {
  itemid: string;
  clock: string;
  value: string;
}

export interface FetchedConfig {
  byHostName: Map<string, RawHostConfig>;
  status: "live" | "unavailable";
}

/**
 * Fetch + group the three config items for all hosts, with `windowDays` of
 * history. Returns a map keyed by Zabbix host NAME (callers join to their
 * device list by name / sourceHostKey).
 */
export async function fetchRetellectConfig(windowDays: number): Promise<FetchedConfig> {
  try {
    const client = getZabbixClient();

    const hosts = (await cached(
      "cfg_hosts",
      () => client.request("host.get", { output: ["hostid", "name"] }) as Promise<{ hostid: string; name: string }[]>,
      300_000,
    )) as { hostid: string; name: string }[];
    const nameByHostId = new Map(hosts.map((h) => [h.hostid, h.name]));

    const items = (await cached(
      "cfg_items",
      () =>
        client.request("item.get", {
          output: ["itemid", "hostid", "key_", "lastvalue", "lastclock"],
          search: { key_: "log[" },
          searchWildcardsEnabled: false,
        }) as Promise<RawItem[]>,
    )) as RawItem[];

    const tracked = items
      .map((it) => ({ it, kind: classify(it.key_) }))
      .filter((x): x is { it: RawItem; kind: Kind } => x.kind !== null);

    const itemKind = new Map<string, Kind>();
    const itemHost = new Map<string, string>();
    for (const { it, kind } of tracked) {
      itemKind.set(it.itemid, kind);
      itemHost.set(it.itemid, it.hostid);
    }

    const timeFrom = Math.floor(Date.now() / 1000) - windowDays * 86400;
    const idsByKind: Record<Kind, string[]> = { ini: [], rtver: [], scover: [] };
    for (const { it, kind } of tracked) idsByKind[kind].push(it.itemid);

    // One history.get per kind (log history is sparse — config only re-logs
    // on restart), so this is 3 calls regardless of host count.
    async function histFor(kind: Kind): Promise<HistRow[]> {
      const ids = idsByKind[kind];
      if (ids.length === 0) return [];
      return cached(
        `cfg_hist_${kind}_${windowDays}`,
        () =>
          client.request("history.get", {
            output: ["itemid", "clock", "value"],
            itemids: ids,
            history: 2,
            time_from: timeFrom,
            sortfield: "clock",
            sortorder: "ASC",
            limit: 20000,
          }) as Promise<HistRow[]>,
        120_000,
      ) as Promise<HistRow[]>;
    }

    const [iniHist, rtHist, scoHist] = await Promise.all([histFor("ini"), histFor("rtver"), histFor("scover")]);

    const byHostName = new Map<string, RawHostConfig>();
    const ensure = (hostId: string): RawHostConfig => {
      const hostName = nameByHostId.get(hostId) ?? hostId;
      let rec = byHostName.get(hostName);
      if (!rec) {
        rec = {
          hostId,
          hostName,
          configIni: null,
          configIniHistory: [],
          rtVersion: null,
          rtVersionHistory: [],
          scoVersion: null,
          scoVersionHistory: [],
        };
        byHostName.set(hostName, rec);
      }
      return rec;
    };

    // Current values from lastvalue/lastclock.
    for (const { it, kind } of tracked) {
      const clock = it.lastclock ? parseInt(it.lastclock, 10) : 0;
      if (!it.lastvalue || clock <= 0) continue;
      const rec = ensure(it.hostid);
      const cur: RawConfigItem = { value: it.lastvalue, clock };
      if (kind === "ini") rec.configIni = cur;
      else if (kind === "rtver") rec.rtVersion = cur;
      else rec.scoVersion = cur;
    }

    // History rows (already ascending).
    const pushHist = (rows: HistRow[], target: (r: RawHostConfig) => RawConfigItem[]) => {
      for (const row of rows) {
        const hostId = itemHost.get(row.itemid);
        if (!hostId) continue;
        target(ensure(hostId)).push({ value: row.value, clock: parseInt(row.clock, 10) });
      }
    };
    pushHist(iniHist, (r) => r.configIniHistory);
    pushHist(rtHist, (r) => r.rtVersionHistory);
    pushHist(scoHist, (r) => r.scoVersionHistory);

    return { byHostName, status: "live" };
  } catch {
    return { byHostName: new Map(), status: "unavailable" };
  }
}
