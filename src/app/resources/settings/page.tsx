"use client";

import { useState, useEffect, useCallback } from "react";

interface HealthStatus {
  ok: boolean;
  configured: boolean;
  url: string | null;
  version: string | null;
  hostsCount: number | null;
  latencyMs?: number;
  error: string | null;
  checkedAt: string;
}

export default function ResourcesSettingsPage() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const checkHealth = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/zabbix/health");
      const data = await res.json();
      setHealth(data);
    } catch {
      setHealth({
        ok: false,
        configured: false,
        url: null,
        version: null,
        hostsCount: null,
        error: "Nepavyko pasiekti health endpoint",
        checkedAt: new Date().toISOString(),
      });
    }
    setChecking(false);
  }, []);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">API nustatymai</h2>
        <p className="text-xs text-gray-400 mt-0.5">Zabbix API konfigūracija ir ryšio testavimas</p>
      </div>

      <div className="space-y-4 max-w-2xl">
        {/* Connection Status Card */}
        <div className={`bg-white rounded-lg border ${health?.ok ? "border-green-300" : health?.configured ? "border-red-300" : "border-gray-200"} p-5`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <span className={`w-3 h-3 rounded-full ${
                health === null ? "bg-gray-300 animate-pulse" 
                : health.ok ? "bg-green-500" 
                : "bg-red-500"
              }`} />
              <h3 className="text-sm font-semibold text-gray-800">
                Zabbix API ryšys
              </h3>
              {health && (
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                  health.ok 
                    ? "bg-green-100 text-green-700 border border-green-300" 
                    : health.configured 
                      ? "bg-red-100 text-red-700 border border-red-300"
                      : "bg-gray-100 text-gray-500 border border-gray-300"
                }`}>
                  {health.ok ? "PRISIJUNGTA" : health.configured ? "KLAIDA" : "NEKONFIGŪRUOTA"}
                </span>
              )}
            </div>
            <button
              onClick={checkHealth}
              disabled={checking}
              className={`px-3 py-1.5 text-xs rounded font-medium transition-all ${
                checking 
                  ? "bg-gray-100 text-gray-400 cursor-wait" 
                  : "bg-gray-800 text-white hover:bg-gray-700"
              }`}
            >
              {checking ? "Tikrinama..." : "Tikrinti ryšį"}
            </button>
          </div>

          {health && (
            <div className="space-y-3">
              {/* API URL */}
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400 min-w-[100px]">API URL</span>
                <span className="text-xs font-mono text-gray-700">
                  {health.url || "—  (nenustatyta)"}
                </span>
              </div>

              {/* Token */}
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400 min-w-[100px]">API Token</span>
                <span className={`text-xs font-medium ${health.configured ? "text-green-600" : "text-red-500"}`}>
                  {health.configured ? "✓ Konfigūruotas" : "✗ Nenustatytas"}
                </span>
              </div>

              {/* Version */}
              {health.version && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-400 min-w-[100px]">Zabbix versija</span>
                  <span className="text-xs font-medium text-gray-700">v{health.version}</span>
                </div>
              )}

              {/* Hosts */}
              {health.hostsCount !== null && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-400 min-w-[100px]">Stebimi hostai</span>
                  <span className="text-xs font-medium text-gray-700">{health.hostsCount}</span>
                </div>
              )}

              {/* Latency */}
              {health.latencyMs !== undefined && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-400 min-w-[100px]">Atsakymo laikas</span>
                  <span className={`text-xs font-medium ${
                    health.latencyMs < 500 ? "text-green-600" : health.latencyMs < 2000 ? "text-yellow-600" : "text-red-600"
                  }`}>
                    {health.latencyMs}ms
                  </span>
                </div>
              )}

              {/* Last check */}
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400 min-w-[100px]">Tikrinta</span>
                <span className="text-xs text-gray-500">
                  {new Date(health.checkedAt).toLocaleString("lt-LT", {
                    hour: "2-digit", minute: "2-digit", second: "2-digit",
                  })}
                </span>
              </div>

              {/* Error */}
              {health.error && (
                <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                  <p className="text-xs font-medium text-red-700">{health.error}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Configuration Instructions */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">Kaip konfigūruoti</h3>
          <div className="text-xs text-gray-600 space-y-2">
            <p>
              Zabbix API konfigūracija nustatoma per aplinkos kintamuosius faile{" "}
              <code className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-800 font-mono text-[11px]">.env.local</code>
            </p>
            <div className="bg-gray-50 rounded-lg p-3 font-mono text-[11px] text-gray-700 space-y-1">
              <p>ZABBIX_URL=https://your-zabbix-server/api_jsonrpc.php</p>
              <p>ZABBIX_TOKEN=your_api_token_here</p>
            </div>
            <p className="text-gray-400">
              API token galite sugeneruoti Zabbix web UI → Administration → API tokens.
              Po pakeitimo reikia perkrauti dev serverį.
            </p>
          </div>
        </div>

        {/* Data Source Info */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">Duomenų šaltinio informacija</h3>
          <div className="text-xs text-gray-600 space-y-2">
            <p>
              Resursų modulis naudoja universalią duomenų šaltinio sistemą su automatiniu cache.
              Jei Zabbix API nepasiekiamas, automatiškai naudojami paskutiniai kešuoti duomenys.
            </p>
            <div className="flex items-center gap-3 mt-3">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                <span className="text-[11px] text-gray-500">LIVE — gyvi duomenys</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                <span className="text-[11px] text-gray-500">CACHED — kešuoti duomenys</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-red-500"></span>
                <span className="text-[11px] text-gray-500">DOWN — nepasiekiamas</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
