import Link from "next/link";

export default function WorkbenchPage() {
  const tools = [
    {
      href: "/workbench/context-export",
      title: "Konteksto eksportas",
      description: "Generuoti struktūruotą projekto/piloto kontekstą Claude CoWork sesijoms",
      status: "MVP",
    },
    {
      href: "/workbench/prompt-studio",
      title: "Prompt Studio",
      description: "Prompt šablonai UI tobulinimui, API integracijai, duomenų modeliavimui",
      status: "MVP",
    },
    {
      href: "/workbench/source-explorer",
      title: "Šaltinių naršyklė",
      description: "Peržiūrėti Zabbix / TreeCommerce API atsakymus ir duomenų struktūras",
      status: "MVP",
    },
    {
      href: "/workbench/diagnostics",
      title: "Diagnostika",
      description: "Šaltinių sveikata, sinchronizacijos statusas, cache būsena, klaidos",
      status: "MVP",
    },
    {
      href: "/workbench/view-builder",
      title: "View Builder",
      description: "Kurti ir konfigūruoti view tipus pilotams",
      status: "Planuojama",
    },
  ];

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Workbench</h2>
        <p className="text-xs text-gray-400 mt-0.5">Vidinis kūrimo ir optimizavimo įrankių rinkinys</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {tools.map((tool) => (
          <Link
            key={tool.href}
            href={tool.href}
            className="bg-white rounded-lg border border-gray-200 px-5 py-4 hover:border-gray-300 transition-colors"
          >
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-gray-900">{tool.title}</h3>
              <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
                tool.status === "MVP" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
              }`}>
                {tool.status}
              </span>
            </div>
            <p className="text-xs text-gray-500">{tool.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
