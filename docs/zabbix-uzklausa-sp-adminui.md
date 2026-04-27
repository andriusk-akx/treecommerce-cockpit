# Klausimai ir prašymai Zabbix admin'ui — Retellect SCO CPU dashboard

**Iš:** Andrius K. (AKpilot, StrongPoint)
**Data:** 2026-04-27
**Apie:** Retellect SCO CPU Analysis dashboard'as 115 Rimi SCO host'ų

---

## Kontekstas (trumpai)

Per AKpilot dashbordą stebime 115 Rimi SCO host'ų CPU panaudojimą — peak'us,
procesų skilimus, Retellect efektą. Skaitome Zabbix API per read-only tokeną.
Šiandien viskas veikia, bet liko keli nesusipratimai ir trūkumai, į kuriuos
verta atkreipti dėmesį prieš pristatant rezultatus.

**Svarbu:** prašome **NIEKO neliesti** iš to, kas jau veikia (esami `*.cpu`,
`perf_counter`, `system.cpu.util[,,avg1]` ir kt.). Žemiau — tik **papildymai**
ir paaiškinimai.

---

## A. Klausimai (į kuriuos reikia atsakymo)

### A1. Retellect proceso/services inventoriaus paklausimas

Šiuo metu kategorizuojam kaip „Retellect" tik 4 python items:
`python.cpu`, `python1.cpu`, `python2.cpu`, `python3.cpu` (plius atitinkami
`perf_counter[\Process(python#N)]`).

**Klausimai:**
- Ar Retellect produktas naudoja TIK šiuos 4 python procesus?
- Ar yra papildomų komponentų, kurių mes nematome? Pvz.:
  - Helper / agent procesas (kitas binary vardas)?
  - Windows Service (pvz. `RetellectSvc`, `RetellectAgent`)?
  - `pythonw.exe` (windowless variantas) ar kiti `*python*` variantai?
  - .NET / Node sub-procesai?

Jei yra — prašome išvardinti pavadinimus, **kad galėtume teisingai įskaityti
visą Retellect CPU footprint'ą** (dabar dalis gali kristi į „Other").

### A2. Eksperimentiniai items ant CHM Outlet SCO1

Probe parodė, kad **vienas hostas** (CHM Outlet [T813] SCO1) turi du items,
kurių NĖRA niekur kitur fleet'e:
- `system.cpu.util[,system]` — kernel CPU split
- `proc_info[python]` — python procesų count

**Klausimai:**
- Tai jūsų eksperimentas ar testas?
- Ar planuojama deploy'inti per visą fleet'ą? Jei taip — kada?
- Jei tai pavyzdys, kaip galėtų atrodyti — mums tai būtų **labai naudinga**,
  ypač `system.cpu.util[,system]` (žr. B1).

### A3. `*.cpu` vs `perf_counter` reikšmių neatitikimas

Tame pačiame momente tas pats procesas grąžina ženkliai skirtingas reikšmes:

```
Pavilnionys SCO2, 2026-04-18 14:48:
  sql.cpu                              = 8.24 %
  perf_counter[\Process(sqlservr)\…]   = 99.05 %  (= 24.7 % per host, 4 cores)
```

**Klausimas:** ar mūsų supratimas teisingas?
- `*.cpu` = 1-min sliding average, jau išreikšta „% of host"
- `perf_counter[\Process(...)]` = instantaneous, „% of one core" (reikia /cores)

Jei ne — kaip tikslintis interpretuoti? Mūsų dashboard'as dabar **prefer'uoja**
`perf_counter` (su /cores normalizacija), `*.cpu` palieka kaip fallback'ą.

---

## B. Prašymai (priority order)

### B1. Įjungti CPU split items per visą fleet'ą  ⚡ **HIGH**

```
system.cpu.util[,user]      → user-space procesų CPU
system.cpu.util[,system]    → Windows kernel CPU
system.cpu.util[,iowait]    → CPU laukimas I/O
```

**Kodėl:** dabar dashbord'e ~30% peak'o metu rodoma kaip „Other" — t.y.
„kažkas vyksta, bet nežinom kas". Su šiuo split'u galėsim aiškiai pasakyti:
„20% kernel work / 5% iowait / 5% untracked user processes".

**Kaina:** 3 standartiniai Windows agent items per host × 115 = 345 naujų items'ų,
1-min update interval = ~5,75 sample/s — apkrova nykštukiška.

**Status:** ant CHM Outlet SCO1 tai jau egzistuoja (`system.cpu.util[,system]`).
Tikriausiai užtenka template'ą atnaujinti ir relink.

### B2. Pridėti `proc.cpu.util[*]` LLD discovery (top-N procesai)

```
LLD rule: proc.cpu.util.discovery
  - Auto-discover top-N (pvz. 10) procesus, kurie sunaudoja > 1% CPU
  - Dinaminis item prototype: proc.cpu.util[{#PROC_NAME},,total,1m]
  - Update interval: 60s
```

**Kodėl:** šiandien matome tik fiksuotą sąrašą (`python`, `sp.sss`, `sqlservr`,
`vmware-vmx`). Bet kuris naujas kvėpuojantis procesas (antivirus update, naujas
service, kažkoks payment integration daemon) lieka nematomas → krenta į „Other".

**Kaina:** ~5-15 dinaminių items per host × 115 = 575-1725 papildomų items.
Galim aptarti top-N ribą / filter.

**Alternatyva (jei LLD per stambus):** statinis sąrašas papildomų procesų,
kuriuos žinote, kad sunaudoja CPU — pvz. `svchost`, `lsass`, `MsMpEng`
(Windows Defender), `WmiPrvSE`, jūsų POS payment service'ai. Net 5-8 papildomi
items'ai stipriai sumažintų „Other".

### B3. Read-write Zabbix API tokenas AKpilot service'ui  📋 *Medium*

Norėtume pas mus turėti tokeną su `item.create` / `update` / `delete`
teisėmis Rimi host group'e. Tada galėtume patys greitai testuoti naujus
items prieš prašydami template pakeitimo. Visi mūsų pakeitimai versionuojami
git'e, peržiūrimi.

Jei security policy neleidžia — toliau eisim per ticket'us, lėčiau bet veiks.

---

## Ką darysim po jūsų atsakymo / pakeitimų

**Po A1, A3 atsakymo:** atnaujinsim Retellect kategorizavimo logiką dashbord'e
(jei rasime trūkstamų procesų — įdėsim).

**Po A2 atsakymo / B1 deploy:** per ~1 dieną dashboard'as pradės skaityti
naujus 3 items, „Other" kategorija suskils į „Kernel / I/O wait / Untracked
user". Tikslesnis triage.

**Po B2 deploy:** per ~3-5 dienas pridėsim „Top processes" panel į drill-down
(top-10 procesų per host, dinamiškas).

---

## Trumpas atsakymo formatas, kurio pageidaujame

Galite tiesiog atsakyti į kiekvieną punktą trumpai:

- **A1:** *(procesų sąrašas)*
- **A2:** *(eksperimentas / planuojama / nieko)*
- **A3:** *(jūsų supratimas patvirtintas / pataisymas)*
- **B1:** *(taip / ne / kada)*
- **B2:** *(taip — su top-N=N / alternatyva — statinis sąrašas / ne)*
- **B3:** *(taip / reikia security approval / ne)*

Jei kuris klausimas ne į temą — tiesiog pasakykite, atmesim.

---

Ačiū už pagalbą! Atsiunčiu šį dokumentą todėl, kad **tikslumas svarbiau už
greitį** — dashboard'as turi tikrai parodyti, kas vyksta SCO host'uose, ne
spėlioti.

Andrius
