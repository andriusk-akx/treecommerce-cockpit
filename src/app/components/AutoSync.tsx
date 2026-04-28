"use client";

import { useEffect, useState } from "react";

export default function AutoSync({ intervalMs = 300000 }: { intervalMs?: number }) {
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [nextSync, setNextSync] = useState<number>(intervalMs / 1000);

  useEffect(() => {
    // Define runSync inside the effect so the lint rule doesn't complain
    // about temporal-dead-zone access (function declared below the effect).
    async function runSync() {
      try {
        const res = await fetch("/api/zabbix/sync", { method: "POST" });
        const data = await res.json();
        const now = new Date().toLocaleTimeString("lt-LT");
        if (data.error) {
          setLastSync(`${now} — error`);
        } else {
          const changes = data.created + data.updated + data.resolved;
          setLastSync(`${now} — ${changes > 0 ? `${changes} changes` : "no changes"}`);
          if (changes > 0) {
            setTimeout(() => window.location.reload(), 500);
          }
        }
        setNextSync(intervalMs / 1000);
      } catch {
        setLastSync(`${new Date().toLocaleTimeString("lt-LT")} — connection error`);
      }
    }

    // Run sync immediately on mount
    runSync();

    // Then run every intervalMs
    const syncTimer = setInterval(runSync, intervalMs);

    // Countdown timer
    const countdownTimer = setInterval(() => {
      setNextSync((prev) => (prev <= 1 ? intervalMs / 1000 : prev - 1));
    }, 1000);

    return () => {
      clearInterval(syncTimer);
      clearInterval(countdownTimer);
    };
  }, [intervalMs]);

  function formatCountdown(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  return (
    <div className="text-xs text-gray-400">
      {lastSync && <span>Last sync: {lastSync}</span>}
      <span className="ml-3">Next: {formatCountdown(nextSync)}</span>
    </div>
  );
}
