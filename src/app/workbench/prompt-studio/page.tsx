export default function PromptStudioPage() {
  const templates = [
    {
      category: "UI Tobulinimas",
      prompts: [
        { title: "Dashboard kortelės", prompt: "Peržiūrėk {page} puslapį ir pasiūlyk kaip pagerinti KPI kortelių dizainą..." },
        { title: "Lentelės UX", prompt: "Analizuok {page} lentelę ir pasiūlyk filtravimo/rūšiavimo patobulinimus..." },
        { title: "Mobilumo optimizacija", prompt: "Peržiūrėk {page} responsive dizainą ir pasiūlyk patobulinimus..." },
      ],
    },
    {
      category: "API Integracija",
      prompts: [
        { title: "Naujas duomenų šaltinis", prompt: "Pridėk naują duomenų šaltinį '{source}' prie Universal Data Source Manager..." },
        { title: "Zabbix užklausos", prompt: "Optimizuok Zabbix API užklausas {endpoint} sumažinant latency..." },
        { title: "Cache strategija", prompt: "Peržiūrėk cache strategiją ir pasiūlyk TTL reikšmes šaltiniui '{source}'..." },
      ],
    },
    {
      category: "Duomenų modelis",
      prompts: [
        { title: "Schema evoliucija", prompt: "Pridėk lauką '{field}' prie modelio '{model}' su migracija..." },
        { title: "Seed duomenys", prompt: "Atnaujink seed.ts pridedant testinių duomenų pilotui '{pilot}'..." },
        { title: "Reliacijos", prompt: "Peržiūrėk {model1} ir {model2} reliacijas ir pasiūlyk optimizacijas..." },
      ],
    },
    {
      category: "Analizė",
      prompts: [
        { title: "CPU bottleneck", prompt: "Analizuok CPU duomenis ir identifikuok bottleneck pagal CPU modelį..." },
        { title: "Incident patterns", prompt: "Peržiūrėk incidentų istoriją ir identifikuok pasikartojančius šablonus..." },
        { title: "Capacity planning", prompt: "Sukurk talpos planavimo modelį pagal dabartines metrikos ir augimo prognozes..." },
      ],
    },
  ];

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Prompt Studio</h2>
        <p className="text-xs text-gray-400 mt-0.5">Prompt šablonai Claude CoWork sesijoms</p>
      </div>

      <div className="space-y-6">
        {templates.map((category) => (
          <div key={category.category}>
            <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">{category.category}</h3>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {category.prompts.map((item) => (
                <div key={item.title} className="bg-white rounded-lg border border-gray-200 px-4 py-3">
                  <h4 className="text-sm font-medium text-gray-900 mb-1">{item.title}</h4>
                  <p className="text-xs text-gray-500 font-mono leading-relaxed">{item.prompt}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* TODO marker */}
      <div className="mt-8 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
        <p className="text-xs text-gray-500">
          <strong>TODO:</strong> Pridėti interaktyvų prompt generavimą pagal kontekstą (dabartinis puslapis, pilotas, šaltinis).
          Pridėti kopijavimo mygtukus. Pridėti custom prompt formą.
        </p>
      </div>
    </div>
  );
}
