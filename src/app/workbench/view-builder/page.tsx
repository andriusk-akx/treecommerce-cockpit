export default function ViewBuilderPage() {
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">View Builder</h2>
        <p className="text-xs text-gray-400 mt-0.5">Piloto view konfigūravimas ir peržiūra</p>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
        <p className="text-gray-400 mb-2">View Builder bus prieinamas kitoje iteracijoje.</p>
        <p className="text-xs text-gray-300">
          Planuojama: view tipų kūrimas (overview, business, technical, executive),
          matomumo valdymas, screenshot/share režimai.
        </p>
      </div>

      {/* TODO marker */}
      <div className="mt-6 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
        <p className="text-xs text-gray-500">
          <strong>TODO:</strong> View CRUD. Prisma View modelio naudojimas. Konfigūracijos JSON redaktorius.
          Preview režimai (internal, shareable, client-facing).
        </p>
      </div>
    </div>
  );
}
