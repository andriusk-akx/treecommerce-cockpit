"use client";

import { useState, useEffect } from "react";

export default function SettingsPage() {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [apiEnv, setApiEnv] = useState<string | null>(null);
  const [apiStatus, setApiStatus] = useState<{ test: string; prod: string } | null>(null);
  const [apiMsg, setApiMsg] = useState<string | null>(null);

  // Load current state
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setAutostart(d.autostart);
        setApiEnv(d.apiEnv || "test");
      })
      .catch(() => { setAutostart(false); setApiEnv("test"); });

    // Check API connectivity
    fetch("/api/settings/api-status")
      .then((r) => r.json())
      .then((d) => setApiStatus(d))
      .catch(() => {});
  }, []);

  const toggleAutostart = async () => {
    if (autostart === null) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autostart: !autostart }),
      });
      const data = await res.json();
      if (res.ok) {
        setAutostart(data.autostart);
        setMessage(data.message);
      } else {
        setMessage(data.error || "Klaida");
      }
    } catch {
      setMessage("Nepavyko pakeisti nustatymo");
    }
    setLoading(false);
  };

  const switchApiEnv = async (env: string) => {
    setApiMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiEnv: env }),
      });
      const data = await res.json();
      if (res.ok) {
        setApiEnv(data.apiEnv);
        setApiMsg(`API aplinka perjungta į ${env.toUpperCase()}. Perkraukite Sales puslapį.`);
      } else {
        setApiMsg(data.error || "Klaida");
      }
    } catch {
      setApiMsg("Nepavyko pakeisti");
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Nustatymai</h2>
        <p className="text-xs text-gray-400 mt-0.5">Dashboard konfigūracija</p>
      </div>

      <div className="space-y-4 max-w-lg">
        {/* ── 12eat API environment ── */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-800">12eat API aplinka</h3>
              <p className="text-[11px] text-gray-400 mt-0.5">
                TEST = testiniai duomenys, PROD = tikri kliento duomenys
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => switchApiEnv("test")}
              className={`flex-1 px-4 py-2.5 rounded-lg text-[12px] font-semibold transition-all ${
                apiEnv === "test"
                  ? "bg-yellow-100 text-yellow-800 border-2 border-yellow-400"
                  : "bg-gray-50 text-gray-500 border border-gray-200 hover:border-gray-300"
              }`}
            >
              <div>TEST</div>
              <div className="text-[9px] font-normal mt-0.5 opacity-70">10.36.161.75:9051</div>
              {apiStatus && (
                <div className={`text-[9px] font-medium mt-1 ${apiStatus.test === "ok" ? "text-green-600" : "text-red-500"}`}>
                  {apiStatus.test === "ok" ? "● Pasiekiamas" : "○ Nepasiekiamas"}
                </div>
              )}
            </button>
            <button
              onClick={() => switchApiEnv("prod")}
              className={`flex-1 px-4 py-2.5 rounded-lg text-[12px] font-semibold transition-all ${
                apiEnv === "prod"
                  ? "bg-green-100 text-green-800 border-2 border-green-400"
                  : "bg-gray-50 text-gray-500 border border-gray-200 hover:border-gray-300"
              }`}
            >
              <div>PROD</div>
              <div className="text-[9px] font-normal mt-0.5 opacity-70">10.100.39.16:9051</div>
              {apiStatus && (
                <div className={`text-[9px] font-medium mt-1 ${apiStatus.prod === "ok" ? "text-green-600" : "text-red-500"}`}>
                  {apiStatus.prod === "ok" ? "● Pasiekiamas" : "○ Nepasiekiamas"}
                </div>
              )}
            </button>
          </div>

          {apiMsg && (
            <div className="mt-3 text-[11px] text-blue-600 font-medium">{apiMsg}</div>
          )}
        </div>

        {/* ── Autostart ── */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-800">Auto-start po login</h3>
              <p className="text-[11px] text-gray-400 mt-0.5">
                Prisijungus prie Mac, dashboard automatiškai pasileis fone.
                <br />
                <span className="text-gray-300">Pastaba: naudoja CPU tik build metu (~30s), po to ~0%.</span>
              </p>
            </div>
            <button
              onClick={toggleAutostart}
              disabled={loading || autostart === null}
              className={`relative w-12 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ${
                autostart ? "bg-blue-600" : "bg-gray-300"
              } ${loading ? "opacity-50 cursor-wait" : "cursor-pointer"}`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${
                  autostart ? "translate-x-6" : "translate-x-0"
                }`}
              />
            </button>
          </div>
          {message && (
            <div className="mt-3 text-[11px] text-blue-600 font-medium">{message}</div>
          )}
          <div className="mt-3 pt-3 border-t border-gray-100 text-[10px] text-gray-400">
            {autostart === null
              ? "Kraunama..."
              : autostart
                ? "✅ Įjungta — dashboard startuos automatiškai po kiekvieno login"
                : "⭕ Išjungta — naudok Desktop → StartDashboard.command rankiniam paleidimui"}
          </div>
        </div>
      </div>
    </div>
  );
}
