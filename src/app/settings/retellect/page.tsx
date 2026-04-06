export default function RetellectSettingsPage() {
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Retellect nustatymai</h2>
        <p className="text-xs text-gray-400 mt-0.5">Retellect integracija ir konfigūracija</p>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-5 max-w-lg">
        <h3 className="text-sm font-semibold text-gray-800 mb-2">Retellect API</h3>
        <p className="text-xs text-gray-500 mb-4">
          Retellect specifinė konfigūracija bus pridėta kai Retellect API bus prieinamas.
          Šiuo metu CPU analizė remiasi Zabbix duomenimis.
        </p>

        <div className="bg-gray-50 rounded-lg p-4">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Duomenų šaltinis</dt>
              <dd className="text-gray-900">Zabbix (per bendrą integraciją)</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">CPU overhead modelis</dt>
              <dd className="text-gray-900">~20% CPU, ~12% RAM (grubi prognozė)</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Statusas</dt>
              <dd className="text-blue-600 font-medium">MVP — naudojame Zabbix metrikos</dd>
            </div>
          </dl>
        </div>
      </div>

      {/* TODO */}
      <div className="mt-6 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 max-w-lg">
        <p className="text-xs text-gray-500">
          <strong>TODO:</strong> Pridėti Retellect API integraciją kai bus prieinamas endpoint.
          Pridėti CPU overhead kalibraciją pagal referencinius matavimus.
          Pridėti Retellect enable/disable toggle per device.
        </p>
      </div>
    </div>
  );
}
