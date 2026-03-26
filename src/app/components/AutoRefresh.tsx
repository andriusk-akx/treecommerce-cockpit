"use client";

import { useEffect } from "react";

export default function AutoRefresh({ intervalMs = 300000 }: { intervalMs?: number }) {
  useEffect(() => {
    const timer = setInterval(() => {
      window.location.reload();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return null;
}
