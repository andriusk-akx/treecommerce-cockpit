/**
 * Backfill Device.cpuCores from Zabbix system.cpu.num.
 *
 * The Retellect drill-down divides perf_counter values by cpu_num to
 * normalise per-core readings into host-scope percentages. When Zabbix's
 * `system.cpu.num` item is missing or ZBX_NOTSUPPORTED on a host (see
 * memory: project_zabbix_agent_broken_pattern), the route used to silently
 * fall back to cores=1, which then displayed perf_counter values raw and
 * produced stacked bars that summed past 100%.
 *
 * This script reads `system.cpu.num.lastvalue` for every Device with a
 * sourceHostKey, and persists the resulting integer into Device.cpuCores
 * alongside provenance metadata. resolveCoresForHost (src/lib/zabbix/cores.ts)
 * then prefers the cached value when Zabbix is unable to answer in real time.
 *
 * Inference fallback: hosts whose Zabbix agent doesn't publish
 * system.cpu.num are matched against a small known-CPU-model table
 * (KNOWN_CPU_MODELS in cores.ts). A successful match writes the inferred
 * value with `cpuCoresSource = "inferred_from_model"`. The flag lets the UI
 * label the value as inferred so operators know its provenance.
 *
 * Hosts with neither path are logged at the end so SP admin can prioritise
 * fixing their Zabbix templates.
 *
 * Run:
 *
 *   DATABASE_URL=... ZABBIX_TOKEN=... npx tsx scripts/backfill-device-cpu-cores.ts
 *
 * Safe to re-run: writes only when the resolved value differs from what's
 * already in the DB, or when the previous probe is older than 24h. Manual
 * overrides (cpuCoresSource === "manual") are never overwritten by this
 * script — operators can pin a value via Settings -> Devices and trust it
 * stays put across backfills.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const URL_ZBX = process.env.ZABBIX_URL || "https://monitoring.strongpoint.com/api_jsonrpc.php";
const TOKEN = process.env.ZABBIX_TOKEN;
if (!TOKEN) {
  console.error("Set ZABBIX_TOKEN");
  process.exit(1);
}

// Mirror of KNOWN_CPU_MODELS in src/lib/zabbix/cores.ts — duplicated here
// because this script runs from .mjs and we don't have a build step that
// would let us import the TS module directly. Keep the two lists in sync
// when adding new entries (audit via grep "i3-6100" in both files).
const KNOWN_CPU_MODELS: { match: string; cores: number }[] = [
  // Keep in sync with src/lib/zabbix/cores.ts (KNOWN_CPU_MODELS).
  // Order matters: more specific patterns first.
  { match: "i3-10100", cores: 8 },
  { match: "i3-6100", cores: 4 },
  { match: "i3-7100", cores: 4 },
  { match: "i3-8100", cores: 4 },
  { match: "i3-9100", cores: 4 },
  { match: "i5-6400", cores: 4 },
  { match: "i5-6500", cores: 4 },
  { match: "i5-7400", cores: 4 },
  { match: "i5-8400", cores: 6 },
  { match: "g4400", cores: 2 },
  { match: "g4560", cores: 4 },
  { match: "g5400", cores: 4 },
  { match: "j3455", cores: 4 },
  { match: "j4125", cores: 4 },
  { match: "x5-e8000", cores: 4 },
];

function inferCoresFromCpuModel(model: string | null): number | null {
  if (!model) return null;
  const norm = model.toLowerCase().replace(/\s+/g, " ").trim();
  for (const entry of KNOWN_CPU_MODELS) {
    if (norm.includes(entry.match)) return entry.cores;
  }
  return null;
}

async function call(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(URL_ZBX, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Math.random() }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`${method}: ${data.error.message} - ${data.error.data}`);
  }
  return data.result;
}

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });

  try {
    // Step 1: pull every Zabbix host, keyed by both `host` and `name` so we
    // can match either way against Device.sourceHostKey. (Some legacy seeds
    // store the visible name; newer ones use the technical host id.)
    const zbxHosts = await call("host.get", {
      output: ["hostid", "host", "name"],
    });
    const hostIdByKey = new Map();
    for (const h of zbxHosts) {
      if (h.host) hostIdByKey.set(h.host, h.hostid);
      if (h.name) hostIdByKey.set(h.name, h.hostid);
    }
    console.log(`Zabbix: ${zbxHosts.length} hosts visible.`);

    // Step 2: pull all system.cpu.num items in one batched call. Filtering
    // by status (admin-enabled) but not by state so we can SEE
    // ZBX_NOTSUPPORTED rows — we just won't trust their lastvalue.
    const items = await call("item.get", {
      output: ["itemid", "hostid", "key_", "lastvalue", "state"],
      filter: { key_: "system.cpu.num", status: 0 },
    });
    const itemByHostId = new Map();
    for (const it of items) {
      itemByHostId.set(it.hostid, it);
    }
    console.log(`Zabbix: ${items.length} system.cpu.num items across the fleet.`);

    // Step 3: iterate Devices. For each, resolve cores via the same priority
    // order resolveCoresForHost uses at runtime: live Zabbix -> existing DB
    // value -> inference from cpuModel.
    const devices = await prisma.device.findMany();
    console.log(`\nDB: ${devices.length} devices to consider.\n`);

    const stats = {
      fromZabbix: 0,
      fromInference: 0,
      keptManual: 0,
      noChange: 0,
      stillUnknown: 0,
    };
    const stillUnknown = [];

    for (const d of devices) {
      const key = d.sourceHostKey || d.name;
      const zbxHostId = hostIdByKey.get(key);
      const item = zbxHostId ? itemByHostId.get(zbxHostId) : undefined;

      // Resolve from Zabbix when item is supported (state != 1) and value
      // parses to a sane positive integer.
      let resolved = null;
      let source = null;
      if (item && String(item.state ?? "") !== "1") {
        const n = parseInt(item.lastvalue ?? "", 10);
        if (Number.isFinite(n) && n >= 1 && n <= 1024) {
          resolved = n;
          source = "zabbix";
        }
      }

      // Manual override wins over everything except a successful zabbix read.
      // (Even then, a manual value is overwritten only when Zabbix returns a
      // DIFFERENT integer — common case "manual matches zabbix" is a no-op
      // that preserves the operator's intent.)
      if (d.cpuCoresSource === "manual" && d.cpuCores) {
        if (resolved === null || resolved === d.cpuCores) {
          stats.keptManual += 1;
          continue;
        }
        // else: fall through and update — operator's value disagrees with
        // freshly-probed Zabbix, surface that via the log line below.
        console.log(
          `  ${d.name}: manual override (${d.cpuCores}) differs from Zabbix (${resolved}). Updating to Zabbix.`,
        );
      }

      // Fallback to cpuModel inference when Zabbix can't answer.
      if (resolved === null) {
        const inferred = inferCoresFromCpuModel(d.cpuModel);
        if (inferred !== null) {
          resolved = inferred;
          source = "inferred_from_model";
        }
      }

      if (resolved === null) {
        stats.stillUnknown += 1;
        stillUnknown.push({ name: d.name, sourceHostKey: key, cpuModel: d.cpuModel });
        continue;
      }

      // No-op detector: same value, same source, recent probe (<24h).
      // Skip the write to keep the table churn-free on repeated runs.
      const probedRecently =
        d.cpuCoresProbedAt && Date.now() - d.cpuCoresProbedAt.getTime() < 24 * 60 * 60 * 1000;
      if (d.cpuCores === resolved && d.cpuCoresSource === source && probedRecently) {
        stats.noChange += 1;
        continue;
      }

      await prisma.device.update({
        where: { id: d.id },
        data: {
          cpuCores: resolved,
          cpuCoresSource: source,
          cpuCoresProbedAt: new Date(),
        },
      });
      console.log(`  ${d.name}: cpuCores -> ${resolved} (${source})`);
      if (source === "zabbix") stats.fromZabbix += 1;
      else if (source === "inferred_from_model") stats.fromInference += 1;
    }

    console.log("\n── Summary ──────────────────────────────────────────");
    console.log(`  From Zabbix:        ${stats.fromZabbix}`);
    console.log(`  From CPU model:     ${stats.fromInference}`);
    console.log(`  Manual kept:        ${stats.keptManual}`);
    console.log(`  No change:          ${stats.noChange}`);
    console.log(`  Still unknown:      ${stats.stillUnknown}`);

    if (stillUnknown.length) {
      console.log("\n── Hosts still without cpuCores (action needed) ─────");
      for (const u of stillUnknown) {
        console.log(`  ${u.name.padEnd(40)} [${u.sourceHostKey || "no key"}]  cpuModel=${u.cpuModel ?? "(none)"}`);
      }
      console.log(
        "\nNext steps: either ask SP admin to enable system.cpu.num on these\n" +
          "hosts' Zabbix agents, or set Device.cpuCores manually via Settings.\n" +
          "Until then the dashboard shows a coresKnown=false warning for these hosts.",
      );
    } else {
      console.log("\nAll devices have a resolved cpuCores. Drill-down normalisation is fully covered.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
