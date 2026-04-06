"use client";

import { useState, useEffect } from "react";

export default function TreeCommerceApiSettingsPage() {
  const [apiEnv, setApiEnv] = useState<string | null>(null);
  const [apiStatus, setApiStatus] = useState<{ test: string; prod: string } | null>(null);
  const [apiMsg, setApiMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => setApiEnv(d.apiEnv || "test"))
      .catch(() => setApiEnv("test"));

    fetch("/api/settings/api-status")
      .then((r) => r.json())
      .then((d) => setApiStatus(d))
      .catch(() => {});
  }, []);

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
        setApiMsg(`API aplinka perjungta į ${env.toUpperCase()}.`);
      }
    } catch {
      setApiMsg("Nepavyko pakeisti");
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">TreeCommerce API nustatymai</h2>
        <p className="text-xs text-gray-400 mt-0.5">12eat POS API konfigūracija</p>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-5 max-w-lg">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">12eat API aplinka</h3>
        <p className="text-[11px] text-gray-400 mb-4">
          TEST = testiniai duomenys, PROD = tikri kliento duomenys. Reikalauja VPN.
        </p>

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

        {apiMsg && <div className="mt-3 text-[11px] text-blue-600 font-medium">{apiMsg}</div>}
      </div>
    </div>
  );
}
