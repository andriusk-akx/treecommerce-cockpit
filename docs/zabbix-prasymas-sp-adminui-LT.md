# Prašymas StrongPoint Zabbix admin'ui — papildomi items SCO host'ams

**Iš:** Andrius K. (AKpilot)
**Data:** 2026-04-25
**Dėl:** Retellect SCO CPU Analysis dashboard'as

> Pilna techninė versija anglų kalba — `zabbix-template-request-strongpoint.md`.
> Šis dokumentas — trumpas santrauka diskusijai.

---

## Svarbiausia

**NIEKO neliesti iš to, kas jau dirba.** Dashboard'as remiasi esamais items
(visų `*.cpu`, `system.cpu.util[,,avg1]`, `system.cpu.load`, `perf_counter`
ir t.t.). Prašymas **PAPILDYTI** template'ą, ne keisti.

---

## Kontekstas

Dashboard'as parodo per-process CPU paskirstymą per ~115 Rimi SCO host'ų.
Šiandien su esamais Zabbix items galim paaiškinti **~65% host CPU**;
likę **~30% rodomi kaip „Other"** — žinome kad CPU naudojamas, bet neturim
items'ų pavadinti procesą.

Pavyzdys (Pavilnionys SCO2, 2026-04-24 15:25):

```
Host CPU:    91 %
SCO App:     34.7 %  (spss.cpu)
DB:          19.7 %  (sql.cpu)
System:       5.9 %  (vmware-vmx)
Retellect:    1.1 %  (python*)
─────────────────
Sum:         61.4 %
Other:       29.5 %  ← nepaaiškinta
```

---

## 3 prašymai

### 1. Įjungti `system.cpu.util[,user/system/iowait]` (PRIORITETAS — HIGH)

Trys Windows agento standartiniai items, paimantys CPU split'ą:

```
system.cpu.util[,user]    — % naudojamas user-space procesų
system.cpu.util[,system]  — % naudojamas Windows kernel'io
system.cpu.util[,iowait]  — % laukimo I/O (diskas / tinklas)
```

Update interval: 60 s. Itemai per host'ą: 3 × 115 = 345 naujų items'ų,
~5,75 sample/s visam fleet'ui — apkrova nykštukiška.

**Kodėl reikia:** dabar 30% „Other" yra juoda dėžė. Su šiuo split'u žinosim
ar tai kernel work (struktūrinis Windows overhead, nieko nepakeisi), ar
iowait (disko bottleneck'as), ar realiai nematomi user procesai.

### 2. Pridėti `proc.cpu.util[*]` LLD discovery (PRIORITETAS — HIGH)

Auto-discovery rule'as, kuris dinamiškai sukuria items'us kiekvienam
top-N CPU naudojančiam procesui:

```
LLD rule:  proc.cpu.util.discovery
  Update interval: 1h
Item prototype:
  proc.cpu.util[{#PROC_NAME},,total,1m]
  Update interval: 60s
Filter: tik procesai, kurie discovery metu > 1% CPU
```

**Kainos rizika:** ~5-15 dinaminių items'ų per host'ą × 115 = 1000-1700
papildomų. Per-host būtų ~25 sample/s. Reikėtų patikrinti ar Zabbix
proxy / DB tai pakelia. Jei ne — alternatyva žemiau.

### 2b. Alternatyva — statinis sąrašas

Jei LLD per brangus, pridėti statinius items'us konkrečiu sąrašu:

```
proc.cpu.util[svchost]      — Windows service host
proc.cpu.util[lsass]        — security authority
proc.cpu.util[MsMpEng]      — Windows Defender
proc.cpu.util[explorer]     — desktop shell
proc.cpu.util[WmiPrvSE]     — WMI
proc.cpu.util[Java]         — jei naudojama POS
```

4–8 items'ai, žinomi „kaltininkai" sąraše — užtenka kad „Other" gerokai
sumažėtų be LLD apkrovos.

### 3. Read-write Zabbix API tokenas AKpilot service'ui (PRIORITETAS — Medium)

API tokenas su `item.create / update / delete` teisėmis Rimi host group'ui.
Leistų mums patiems tunninti procesų aprėptį be ticket'ų. Visi pakeitimai
versionuojami git'e (`prisma/seed.ts` referuoja itemid'us).

Jei security policy neleidžia — toliau eisim per ticket'us, tiesiog lėčiau.

---

## Klausimai diskusijai

1. Ar gali pridėti `system.cpu.util[,user/system/iowait]` SCO template'e?
2. Ar `proc.cpu.util[*]` LLD įmanomas šiame Zabbix instance'e? Koks rekomenduojamas top-N filter?
3. Jei LLD nepriimtina — ar comfortable pridėti 5 statinius `proc.cpu.util[<vardas>]` items'us? Kuriuos procesus įtartum kaip „kaltininkus" pagal anksčiau matytus tickets?
4. Read-write tokenas AKpilot — taip / ne / reikia security approval?
5. Ką realistiškai siektum kaip deploy window'ą Request 1'ui? (Norėtume pataikyti į kitą maintenance ciklą.)

---

## Ką darysim po pakeitimų

**Po Request 1 (per ~1 dieną):**
- Dashboard'as pradės skaityti naujus 3 items'us
- „Other" bar drill-down'e suskils į: untracked user procesai / kernel / iowait
- Nauja alert'a: jei `[,iowait]` > 20% per >5 min — disko bottleneck įspėjimas

**Po Request 2 (per ~3-5 dienas):**
- Naujas drill-down panel'is „Top processes" — dinamiška top-10 lentelė per host'ą
- Auto-kategorizavimas naujų atrastų procesų

---

**Verifikuotos detalės** — pilnoje versijoje (anglų k.) yra probe rezultatai
patvirtinantys current item inventory + token permission įrodymas (item.create
DENIED) — galim pridėti į ticket jei reikės.
