# Spec: CPU Timeline — Compare Two Periods (RT)

**Versija:** v1.1
**Data:** 2026-05-27
**Autorius:** Andrius K. (su Claude pagalba)
**Status:** ready-for-build (visi open questions patvirtinti)
**Susiję dokumentai:** `AKpilot-Architecture-Spec-v2.1.pdf`, memory `project_rollout_phase1`, `project_zabbix_retention`

---

## 1. Problemos kontekstas

Šiandien Retellect CPU Timeline tab'as (`RtTimeline.tsx`) rodo per-day heatmap'ą vienam pasirinktam periodui (14d / 30d preset). To pakanka stebėti einamą būseną, bet **netinka atsakyti į pagrindinį Retellect klausimą**: *„kaip CPU naudojimas pasikeitė įdiegus konfigūracijos pakeitimą X?"*

Realūs scenarijai, kuriuose tai būtina:

- **BES rollout** (2026-05-09): ar po įdiegimo `minutes>70%` sumažėjo? Kuriame host'e labiausiai?
- **Retellect helper Python rollout**: ar helper'is iš tiesų sumažino SCO app peak'us?
- **OS Core / Elastic kategorijos**: ar nauja kategorizacija parodė, kad senas „Other" bucket'as turėjo paslėpto OS triukšmo?
- **Hardware swap testlab → prod kasose**: 4-core vs 2-core normalizacijos efektas.

Visi šie atvejai reikalauja **before/after** palyginimo dviems aiškiai apibrėžtiems periodams, su drill-down per host'us — to dabartinis Timeline neturi.

## 2. Tikslas ir non-goals

### Tikslas

Pridėti CPU Timeline tab'e antrinį vaizdą („Compare periods" sub-view), leidžiantį pasirinkti du **vienodo ilgio** periodus A ir B, pridėti optional tekstinius label'us (pvz. „Pre BES" / „Post BES"), ir parodyti:

1. Headline KPI deltas (suminės minutės virš threshold, vidutinis CPU, P95).
2. Overlay timeline grafiką (periodų A ir B kreivės vienoje ašyje).
3. Delta lentelę su sortable kolonomis per host'ą.
4. Drill-down į konkretų host'ą.

### Non-goals (v1)

- ❌ Skirtingo ilgio periodai (tik v1+; v1 enforces vienodą ilgį).
- ❌ Daugiau nei du periodai vienu metu (A vs B only; multi-period yra v2).
- ❌ Naujas threshold per-host'ui — naudojam vieną filtro context'o `threshold`.
- ❌ Statistinis testavimas (t-test, p-value) — vizualus + skaitinis palyginimas yra MVP.
- ❌ Naujas DB rollup'as — naudojam esamą Zabbix history.get + getCpuHistoryDaily kelią.
- ❌ Configuration timeline modelis pilot settings'uose (tas yra v2; v1 turi tik optional label'ą).

## 3. Vartotojo scenarijus (acceptance walkthrough)

> Andrius atveria Rimi SCO Investigation pilot'ą → CPU Timeline tab → spaudžia segmented control „Compare periods".
>
> Pamato du datų picker'ius. **Period A:** parenka 2026-04-25 → 2026-05-01 (7 d), label'as „Pre BES rollout". **Period B:** parenka 2026-05-10 → 2026-05-16 (7 d auto, nes ilgis užrakintas), label'as „Post BES rollout".
>
> Threshold = 70% (paveldėtas iš RT filter context'o). Spaudžia „Compare".
>
> Headline'as: „Total minutes > 70%: A = 1 240 min / B = 480 min (Δ −760 min, −61%)". Žemiau overlay grafikas: mėlyna A linija po oranžine B linija nuo pirmadienio 09:00. Žemiau lentelė: 6 host'ai surūšiuoti pagal Δ %. „rimi-sco-01" turi −82% (best), „rimi-sco-04" −12% (mažiausias efektas). Andrius klikteli „rimi-sco-04" → drill-down rodo per-day breakdown, kur 2026-05-14 buvo abnormalus peak nepriklausomai nuo BES.
>
> Spaudžia „Export PNG" — vaizdas išsaugomas Andriaus stakeholder ataskaitai.

## 4. Architektūra

### 4.1 Routing / sub-view modelis

CPU Timeline tab'as išlieka vienas tab'as (`activeTab === "timeline"`), bet viduje atsiranda **dvigubas vaizdas**, valdomas URL search param'u `?view=`:

| view value | Vaizdas | Default |
|---|---|---|
| `heatmap` (default) | Esamas per-day heatmap | ✓ |
| `compare` | Naujas Compare periods sub-view | |

Sub-view selector — segmented control viršuje `RtTimeline.tsx`, kairėje virš filter bar'o:

```
[ Heatmap | Compare periods ]
```

URL `?view=compare` taip pat išsaugomas localStorage'e per esamą `rtFilters:<pilotId>` mechanizmą, kad reload'as gražintų atgal į tą patį vaizdą. URL parametras turi viršenybę prieš localStorage (deeplink'ai shareable).

**Sprendimo motyvacija:** vartotojas explicit prašė „sub-page", bet nauji route'ai nesistuktūrizuoja į esamą tab dispatch'erį. Segmented control + URL param duoda visus sub-page privalumus (shareable, deeplinkable, gerai matomas) be naujo routing layer'io. Atskira route'a (`/retellect/[pilotId]/cpu-timeline/compare`) reikštų refaktorinti `RtPilotWorkspace.tsx` — nepateisinamas darbas v1'ui.

### 4.2 Failai (build chat'ui)

```
src/components/rt/tabs/
  RtTimeline.tsx                    [MODIFY] add sub-view switch
  RtCompareView.tsx                 [NEW]    compare sub-view root
src/components/rt/compare/          [NEW]    folder
  CompareFilterBar.tsx              [NEW]    two date pickers + labels + run button
  CompareKpiCards.tsx               [NEW]    4 headline cards (A, B, Δ abs, Δ %)
  CompareOverlayChart.tsx           [NEW]    two-line overlay timeline
  CompareHostTable.tsx              [NEW]    sortable host delta table
  CompareHostDrilldown.tsx          [NEW]    per-day expansion under selected host
  CompareExportToolbar.tsx          [NEW]    PNG + CSV export buttons
  types.ts                          [NEW]    ComparePayload, CompareHostRow, etc.
src/app/api/rt/cpu-compare/
  route.ts                          [NEW]    GET handler
src/lib/zabbix/
  client.ts                         [MODIFY] reuse getCpuHistoryDaily across periods
src/lib/rt/compare/
  compute.ts                        [NEW]    aggregate A vs B, compute deltas
  align.ts                          [NEW]    time-of-day vs absolute-offset alignment
```

### 4.3 Duomenų srautas

```
[CompareFilterBar] —submit→ /api/rt/cpu-compare?pilotId=…&aFrom=…&aTo=…&bFrom=…&bTo=…&threshold=70&aLabel=…&bLabel=…
                                      │
                                      ├─ resolveHosts(pilotId) ──┐
                                      │                          │
                                      ├─ getCpuHistoryDaily(aFrom..aTo, hosts) ─┐
                                      │                                         │
                                      └─ getCpuHistoryDaily(bFrom..bTo, hosts) ─┤
                                                                                │
                                       computeComparePayload() ←────────────────┘
                                                                                │
                              { meta, kpis, overlay, hostRows } JSON ←──────────┘
```

Abi periodų užklausos vyksta lygiagrečiai (`Promise.all`).

### 4.4 Reuse points

| Esamas elementas | Kaip naudojamas |
|---|---|
| `getCpuHistoryDaily(itemIds, itemHostMap, daysBack)` | Iškviečiama du kartus (po vieną kiekvienam periodui). Reikia pridėti `from` ir `to` arg'us vietoj `daysBack`, palaikant abu signature'us per overload arba option object'ą. |
| `minutesAbove: { 20, 30, 40, 50, 60, 70, 80, 90 }` | Jau gražinama per-host per-day — pasiimame tik vieną bin'ą pagal `threshold`. Reiškia: **jokio papildomo skaičiavimo**. |
| `RtFiltersContext.threshold` | Paveldim default threshold; CompareFilterBar leidžia override per sub-view sesijai (bet nepersist'ina į RtFilters, kad nesumaišytų heatmap state'o). |
| `Pilot.devices` Prisma query | Hosts list'as toks pat kaip Timeline tab'e. |
| `process-history` endpoint'as | Drill-down naudoja tą patį endpoint'ą, kai vartotojas nori pamatyti konkretaus host'o per-day breakdown — *jei* jau būna gilesnė analizė reikalinga. |

## 5. API kontraktas

### `GET /api/rt/cpu-compare`

**Query params:**

| Param | Tipas | Privalomas | Pastabos |
|---|---|---|---|
| `pilotId` | string | ✓ | |
| `aFrom` | ISO date | ✓ | `YYYY-MM-DD`, inclusive |
| `aTo` | ISO date | ✓ | `YYYY-MM-DD`, inclusive |
| `bFrom` | ISO date | ✓ | inclusive |
| `bTo` | ISO date | ✓ | inclusive; **B periodo ilgis privalo lygtis A** (server validuoja) |
| `threshold` | number | ✓ | 20–90, žingsnis 10 (kiti bin'ai negaliojo dėl getCpuHistoryDaily — žr. §7.2) |
| `aLabel` | string | – | max 60 char |
| `bLabel` | string | – | max 60 char |
| `hostIds` | string[] | – | comma-separated; jei nepateikta — visi pilot host'ai |

**Validacija (HTTP 400, jei neatitinka):**

- `aTo - aFrom === bTo - bFrom` (lygūs ilgiai)
- A ir B periodai negali persidengti
- `Math.min(aFrom, bFrom) >= today - 42 days` (Zabbix history.get retention'as)
- `threshold ∈ {20, 30, 40, 50, 60, 70, 80, 90}`

**Response (200):**

```ts
type CompareResponse = {
  meta: {
    pilotId: string;
    threshold: number;          // 70
    periodLengthDays: number;   // 7
    periodA: { from: string; to: string; label: string | null };
    periodB: { from: string; to: string; label: string | null };
    dataQuality: {
      // perspėjimai apie retention ribas
      periodA: "full" | "trend-only" | "partial-missing";
      periodB: "full" | "trend-only" | "partial-missing";
      warnings: string[];       // pvz. "Period A older than 14d: minute-resolution unavailable; using hourly trend"
    };
    generatedAt: string;        // ISO timestamp
  };

  kpis: {
    minutesAboveThreshold: { a: number; b: number; deltaAbs: number; deltaPct: number };
    meanCpu:               { a: number; b: number; deltaAbs: number; deltaPct: number };
    p95Cpu:                { a: number; b: number; deltaAbs: number; deltaPct: number };
    pctTimeAboveThreshold: { a: number; b: number; deltaAbs: number; deltaPct: number }; // 0..100
  };

  overlay: {
    // x-axis: minutė nuo periodo pradžios (0..periodLengthDays*1440)
    // arba minutė-of-day, jei alignment='time-of-day'
    alignment: "absolute-offset" | "time-of-day";
    points: Array<{
      offsetMin: number;        // x
      aCpu: number | null;      // vidutinis CPU per visus host'us tuo momentu, periodas A
      bCpu: number | null;      // periodas B
      aMinutesAbove: number;    // suminis minute count visiem host'am tame slot'e
      bMinutesAbove: number;
    }>;
  };

  hostRows: Array<{
    hostId: string;
    hostName: string;
    storeName: string;
    cpuModel: string | null;
    cpuCores: number | null;
    aMinutesAbove: number;
    bMinutesAbove: number;
    deltaMinutesAbs: number;
    deltaMinutesPct: number | null;   // null jei a=0
    aMeanCpu: number;
    bMeanCpu: number;
    aP95Cpu: number;
    bP95Cpu: number;
    aSamples: number;
    bSamples: number;
    aSparkline: number[];             // 7 reikšmių (per-day) micro chart'ui
    bSparkline: number[];
    dataQuality: "full" | "trend-only" | "partial-missing";
  }>;
};
```

### Error codes

| HTTP | Reikšmė |
|---|---|
| 400 | Validacijos klaida (lygiai, ribos, threshold) |
| 403 | Pilot prieiga (`comparison` perm trūkumas) |
| 422 | Periodų ribos už Zabbix retention'o |
| 504 | Zabbix timeout (>20s); UI siūlo retry su mažesniu host count'u |

## 6. UX detalės

### 6.1 Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ CPU Timeline                                                     │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ [Heatmap]  [Compare periods]   ◀ esamas + naujas             │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌─ Filter bar ────────────────────────────────────────────────┐  │
│ │ Period A: [Apr 25] → [May 1]  Label: [Pre BES rollout    ]  │  │
│ │ Period B: [May 10] → [May 16] Label: [Post BES rollout   ]  │  │
│ │ Threshold: [70 %  ▾]   Hosts: [All 6 ▾]   [Run comparison] │  │
│ └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌─ KPI cards ─────────────────────────────────────────────────┐  │
│ │ Minutes > 70%   │ Mean CPU   │ P95 CPU    │ % time > 70%   │  │
│ │ A: 1 240        │ A: 58.3 %  │ A: 84.1 %  │ A: 12.3 %      │  │
│ │ B:   480        │ B: 41.7 %  │ B: 71.5 %  │ B:  4.8 %      │  │
│ │ Δ: −760 (−61%)  │ Δ: −16.6pp │ Δ: −12.6pp │ Δ: −7.5pp      │  │
│ └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌─ Overlay timeline ──────────────────────────────────────────┐  │
│ │  100% ┤                                                     │  │
│ │   75% ┤      ╱╲       A: Pre BES (blue)                     │  │
│ │   50% ┤   ╱──  ──╲    B: Post BES (orange)                  │  │
│ │   25% ┤  ╱        ╲                                         │  │
│ │    0% └──────────────────────────────                       │  │
│ │       Mon  Tue  Wed  Thu  Fri  Sat  Sun                     │  │
│ │  Alignment: ( ) Absolute  (•) Time-of-day                   │  │
│ │  [Export PNG]                                               │  │
│ └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌─ Host delta table ──────────────────────────────────────────┐  │
│ │ Host        | Min>70 A | Min>70 B | Δ abs | Δ %  | A̅ | B̅ |   │  │
│ │ rimi-sco-01 |      420 |       72 |  −348 | −83% | … | … |▾│  │
│ │ rimi-sco-02 |      280 |      110 |  −170 | −61% | … | … |▸│  │
│ │ rimi-sco-03 |      210 |       95 |  −115 | −55% | … | … |▸│  │
│ │ rimi-sco-04 |      180 |      158 |   −22 | −12% | … | … |▸│  │
│ │ ...                                                          │  │
│ │ [Export CSV]                                                 │  │
│ └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 Filter bar detalės

**Period A picker:** standart datepicker su dviem laukais (from / to). Po pasirinkimo virš lauko rodom `(7 days)`.

**Period B picker:** kai A nustatytas, B picker'is rodo TIK `from` lauką ir auto-fillina `to = from + (A length − 1) days`. Vizualus indikatorius: `to` laukas locked'inamas + tooltip „Length locked to match Period A (7 days). Change Period A to adjust.".

**Validacija real-time'u:**
- Jei periodai persidengia → raudonas border + „Periods overlap" inline error
- Jei kuris iš jų > 42d senesni → warning ikona „Outside Zabbix history retention; results may use hourly trend"
- Run mygtukas disabled kol nepateikti privalomi laukai

**Hosts filter:** dropdown su checkbox'ais.

**Default behavior (patvirtinta v1.1):**
- Pirmąkart atidarius Compare view — visi host'ai pasirinkti.
- Jei `rtCompare:<pilotId>.hostSubset` localStorage'e turi išsaugotą subset'ą iš ankstesnės sesijos — **nevykdom auto-restore**, bet rodom inline chip'ą šalia hosts dropdown'o: „Restore last 3-host selection ↺". Klikus — pritaikom subset'ą; ignoruojant — chip'as išnyksta po pirmo Run'o.
- Subset'as išsaugomas tik tada, kai vartotojas explicit pakeičia (≠ visi). Jei visi pasirinkti — localStorage entry trinama, kad chip'as nebeatsirastų.
- Tooltip ant chip'o rodo, kurie konkretūs host'ai būtų restore'inti.

Šis pattern'as nesumaišo lūkesčių: default'iškai aiškumas (visi), bet power user'is, kuris dirba su 3 problemiškais host'ais, gauna shortcut'ą be force'inimo.

**Threshold:** segmented control 50 / 60 / 70 / 80 / 90 (90+ nešifruoja, nes minutesAbove `90` reiškia ≥90%).

**Threshold default'as = paveldėtas iš `RtFiltersContext.threshold`** (patvirtinta v1.1):
- Mount'inant Compare view, jei `rtCompare:<pilotId>` localStorage'e neturi išsaugotos reikšmės — naudojam einamąjį `RtFiltersContext.threshold` (kuris pats default'inasi į 70).
- Kai vartotojas pakeičia threshold'ą Compare view — saugom į `rtCompare:<pilotId>` (NE į `rtFilters:<pilotId>`), kad nepaveiktų heatmap'o state'o.
- Compare view pirmąkart atidarius po heatmap'o naudojimo su 60% threshold'u — Compare paveldi 60%. Vartotojas vieną mažiau klikų.
- UI rodom subtle hint chip'ą šalia threshold control'o pirmą kartą: „Inherited from Heatmap (70%)" — išnyksta po pirmo Compare run'o.

**Run mygtukas:** ne auto-trigger. Naudotojas spaudžia explicit, kad būtų aiškus „query commit" moment'as (du periodai = potencialiai brangus Zabbix kvietimas, ne kiekvienas filtro keistelėjimas).

### 6.3 Overlay grafikas

**Chart library = recharts** (patvirtinta v1.1):
- Jau yra projekto deps (Phase 1 Rollout Insights, RtCpuComparison naudoja).
- API'as konsistentus su esamais chart'ais — mažiau cognitive load build chat'ui.
- Reactive'us SVG render'as, declarative composition (LineChart + Line + ReferenceLine + Tooltip + Legend).
- Performance'as ribotas su >10k taškų — Compare v1 max'as ≈ 7d × 1440 min = 10 080 taškų per kreivę, jei alignment=absolute-offset. Akceptuojama; jei p95 render time > 500ms, downsample'inam į 5-min bin'us prieš pasiunčiant į recharts.
- uPlot (alternatyva) atidedam į v2, jei perf'o trūks su daugiau host'ų arba ilgesniais periodais.

- Dvi kreivės: A = `#2563eb` (blue-600), B = `#f97316` (orange-500). Daltonizmo-friendly kontrastas.
- Y-axis: vidutinis CPU % per visus pasirinktus host'us.
- X-axis: priklauso nuo `alignment` toggle:
  - **Absolute offset (default)**: 0..N minučių nuo periodo pradžios. Geriausia, kai user'is nori matyti kreivės formą be daily seasonality išlyginimo.
  - **Time-of-day**: 0..1440 min (24h cycle), kreivės sukrenta į vieną parą per `day-of-week` apipjaustymą. Geriausia, kai user'is nori palyginti to-paties-paros-laiko peak'us.
- Hover'is rodo tooltip: timestamp (A peržiūrint kaip „A: Tue 10:30, CPU 68%; B: Tue 10:30, CPU 41%; Δ −27pp").
- Threshold horizontalė: punktyrinė linija prie y=threshold (default 70%).
- Legend rodo label'us („Pre BES rollout" / „Post BES rollout"), jei jie nustatyti; kitaip — datų range'us.

### 6.4 Host delta table

- **Default sort:** `deltaMinutesPct` ascending (didžiausi pagerėjimai viršuje). Toggle pakeisti į regresiją (descending).
- **Spalvinis akcentas Δ stulpelyje:** žalia jei Δ <0% (pagerėjimas), raudona jei >0%, neutrali jei ±2% (noise floor).
- **Sparkline'as:** 7 micro-bar'ai per-day pagrindiniame stulpelyje šalia each host'o, A virš B perdengti puslaidybiniu rendering'u (panaši logika į React rdt's compact-spark).
- **Drill-down expand'as:** kairysis arrow ▸/▾ — atveria per-day lentelę su 14 eilučių (7 A + 7 B susiporuotos pagal weekday offset) + linkutė „Open host in Timeline heatmap →".

### 6.5 Empty / error state'ai

| State'as | UI |
|---|---|
| Nepateikti datų range'ai | Filter bar aktyvus; KPI / chart / table = placeholder „Select two periods to compare" |
| Vienas iš periodų neturi duomenų | KPI lentelėje rodom „—" toje pusėje; warning chip'as „Period A: no Zabbix samples in this range". |
| `total samples = 0` abiems | Empty state ekrane: „No data for either period. Try widening the date range or checking host filters." |
| Zabbix timeout | Klaidos kortelė + „Retry with reduced hosts" mygtukas (auto-filtruoja iki 3 pirmų host'ų ir retry'ina). |

### 6.6 Eksportas

- **Export PNG**: overlay chart'as + KPI cards į vieną 1920×1080 PNG. File name: `cpu-compare-${pilotSlug}-${aFrom}-vs-${bFrom}-${threshold}pct.png`.
- **Export CSV**: host delta table'ė. Visos kolonos + label'ai header'iuose.
- Mygtukai naudoja esamą Andriaus prototipo v6 export pattern'ą (checkbox + bulk export'as ateityje, bet v1 = du atskiri mygtukai).

### 6.7 Kalba

Visi UI string'ai — anglų. Pavyzdžiai: „Period A", „Period B", „Compare periods", „Run comparison", „Minutes above threshold", „Mean CPU", „P95 CPU", „% time above", „Export PNG", „Export CSV". (Per memory `feedback_dashboard_language_english`.)

## 7. Edge cases & constraints

### 7.1 Zabbix retention ribos

- **history.get (1-min):** ~14–42d (Rimi prod'e patvirtinta ~14d).
- **trend.get (hourly):** ~29d.
- Periodai už 42d ribos = HARD reject (`422`).
- Periodai 14–42d senumo: `minutesAbove` bin'ai apskaičiuojami iš hourly trend → mažesnis tikslumas. Server response'e `dataQuality: "trend-only"`. UI rodo warning ribbon'ą.

### 7.2 Threshold bin'ų suvaržymas

`getCpuHistoryDaily` jau gražina bin'us tik 10pp žingsniu (20–90). V1 neleidžia custom threshold (pvz. 65%) — UI rodo segmented control'ą su 5 reikšmėmis (50/60/70/80/90). Custom threshold'as = v2 (reikia perkurti history.get ciklą su flexible bin'ais arba post-process'inti raw history).

### 7.3 Lokalė ir timezone

- Visi datų pickerai veikia pagal **pilot timezone'ą** (paveldimas iš `Pilot.timezone` arba default = Europe/Vilnius).
- Datų stringai API'oje — ISO date (YYYY-MM-DD) be timezone'o; server konvertuoja į pilot TZ midnight–midnight.
- Display formatas „Apr 25 → May 1" (en-US short month) — atitinka jau egzistuojantį `RtTimeline` pattern'ą.

### 7.4 Host scope evoliucija

Jei pilot tarp A ir B periodų pridėjo arba pašalino host'ą, response'e tas host'as turi `aSamples = 0` arba `bSamples = 0`. UI lentelėje pažymim chip'u „added during period B" / „removed before period B".

### 7.5 Pilot tipo apribojimas

Sub-view rodomas TIK Retellect pilot'uose (`pilot.productSlug === "rt"`). TreeCommerce pilot'uose tab'as „CPU Timeline" net neegzistuoja, todėl scope'as natūralus.

### 7.6 Permissions

Naujas perm'as nereikalingas — sub-view inheritina `timeline` permission'ą iš tabs konfigūracijos (paveldima vartotojo iš workspace role'ės). Vis dėlto, jei norėsim feature-flag'inti dėmesingam rollout'ui — pridėti `cpu_compare_v1` feature flag į `pilot.features` JSON (jei neyra true — sub-view selector hidden).

### 7.7 Performance

- Du `getCpuHistoryDaily` kvietimai paraleliai per `Promise.all`. Esamas vienas kvietimas ~14d / 6 host'ams trunka ~3–6s prod'e (per memory `project_rollout_phase1` rezultatus).
- Du periodai = ~6–12s p95 (acceptable, su loading spinner'iu ir „Run" mygtuko commit'o modeliu).
- Jei reikia agresyvesnio: cache'inti rezultatus per Redis arba in-memory LRU per `(pilotId, aFrom, aTo, bFrom, bTo, threshold)` raktą su 5 min TTL. Atidedam į v1.1, jei p95 viršys 10s.

### 7.8 Localstorage sąveika

- Compare filter state'as (datos, label'ai, threshold) saugomas atskirame raktame: `rtCompare:<pilotId>`. **Nemaišom su `rtFilters:<pilotId>`**, kad heatmap'o state'as išliktų izoliuotas.
- URL search param'ai turi viršenybę: `?aFrom=2026-04-25&aTo=2026-05-01&bFrom=2026-05-10&bTo=2026-05-16&threshold=70&view=compare` — full deeplink palaikymas.

## 8. Acceptance criteria

Spec'as laikomas įgyvendintas, kai:

1. ✅ CPU Timeline tab'as turi segmented control `[Heatmap | Compare periods]` viršuje.
2. ✅ Compare view leidžia pasirinkti dvi datas A ir B, kurių ilgis užrakintas (B `to` auto-skaičiuojamas).
3. ✅ Periodų persidengimas blokuoja Run mygtuką su aiškia klaida.
4. ✅ Datos > 42d senumo = 422 response su user-friendly UI klaida.
5. ✅ Optional label'ai (max 60 char) atsispindi KPI cards, chart legend, export'uose.
6. ✅ KPI cards rodo 4 metrikas (minutes>thr, mean CPU, P95, %time>thr) su Δ abs ir Δ %.
7. ✅ Overlay chart'as turi alignment toggle (absolute / time-of-day) ir threshold horizontalę.
8. ✅ Host delta lentelė sortable visomis kolonomis, default sort = ΔPct asc.
9. ✅ Spalvinis Δ akcentas: žalia gerėjimui, raudona regresijai, neutrali ±2% noise floor.
10. ✅ Drill-down per host'ą rodo per-day breakdown su pažymėtomis dienomis A ir B.
11. ✅ Export PNG ir Export CSV mygtukai veikia.
12. ✅ URL deeplink atstato pilną state'ą po reload'o.
13. ✅ Zabbix timeout = retry su mažesniu host scope.
14. ✅ Visi UI string'ai anglų kalba.
15. ✅ Compare state'as nesumaišo heatmap state'o (`rtFilters` ir `rtCompare` localStorage raktai izoliuoti).

## 9. Roadmap atitikimas

Atitinka AKpilot Roadmap (memory `project_roadmap`) — pradžioje buvo R4 „Retellect timeline visualizations". Šis spec'as praplečia NOW fazę papildomu komponentu, kuris nereikalauja DB schemos pakeitimų ir tiesiogiai padeda Andriui artimiausioms stakeholder ataskaitoms po BES rollout'o (memory `project_rt_category_split`).

## 10. Patvirtinti sprendimai (v1.1)

Visi v1.0 open questions patvirtinti pagal rekomendacijas (Andrius, 2026-05-27):

- **D1 (threshold default):** Paveldim iš `RtFiltersContext.threshold`. Detalės §6.2 → „Threshold default'as".
- **D2 (chart library):** recharts. Detalės §6.3.
- **D3 (hosts default):** Visi by default; localStorage subset'as restore'inamas tik per opt-in chip'ą „Restore last N-host selection". Detalės §6.2 → „Hosts filter".

Nauji open questions, jei iškils build metu — adresuojam direct build chat'e ir grįžtam atnaujinti spec'ą iki v1.2.

---

**Build entry point:** pradėk nuo §4.2 failų sąrašo. Pirmas commit'as = `RtCompareView.tsx` skeleton + segmented control į `RtTimeline.tsx` + `/api/rt/cpu-compare/route.ts` su mocked response'u. Antras = realus duomenų kelias (`compute.ts`, `align.ts`). Trečias = UI komponentai. Ketvirtas = eksportas.

Wireframe SVG: `docs/specs/cpu-timeline-compare-periods-wireframe.svg` (atskiras failas šalia šio spec'o).
