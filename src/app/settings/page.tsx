"use client";

import { useState, useEffect } from "react";

export default function SettingsPage() {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => setAutostart(d.autostart))
      .catch(() => setAutostart(false));
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

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Bendri nustatymai</h2>
        <p className="text-xs text-gray-400 mt-0.5">AKpilot platformos konfigūracija</p>
      </div>

      <div className="space-y-4 max-w-lg">
        {/* App Info */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">Apie AKpilot</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Versija</dt>
              <dd className="text-gray-900 font-mono">1.0.0-alpha</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Stekas</dt>
              <dd className="text-gray-900">Next.js 16 + Prisma 7 + PostgreSQL</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Portas</dt>
              <dd className="text-gray-900 font-mono">3001</dd>
            </div>
          </dl>
        </div>

        {/* Autostart */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-800">Auto-start po login</h3>
              <p className="text-[11px] text-gray-400 mt-0.5">
                Prisijungus prie Mac, AKpilot automatiškai pasileis fone.
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
          {message && <div className="mt-3 text-[11px] text-blue-600 font-medium">{message}</div>}
          <div className="mt-3 pt-3 border-t border-gray-100 text-[10px] text-gray-400">
            {autostart === null
              ? "Kraunama..."
              : autostart
                ? "Įjungta — AKpilot startuos automatiškai po kiekvieno login"
                : "Išjungta — rankiniam paleidimui naudok start-cockpit.sh"}
          </div>
        </div>
      </div>
    </div>
  );
}
