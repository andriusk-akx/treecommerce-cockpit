"use client";

import { useState } from "react";

export default function SyncButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleSync() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/zabbix/sync", { method: "POST" });
      const data = await res.json();
      if (data.error) {
        setResult("Error: " + data.error);
      } else {
        setResult(
          "Created: " + data.created +
          ", Updated: " + data.updated +
          ", Resolved: " + data.resolved +
          ", Skipped: " + data.skipped
        );
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch (err) {
      setResult("Error: " + String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <button
        onClick={handleSync}
        disabled={loading}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
      >
        {loading ? "Syncing..." : "Sync Zabbix"}
      </button>
      {result && <span className="text-sm text-gray-600">{result}</span>}
    </div>
  );
}
