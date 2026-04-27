"use client";

import { useState, useEffect, useRef } from "react";

interface Props {
  username: string;
  isAdmin: boolean;
}

export default function UserMenu({ username, isAdmin }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Hard navigation so middleware redirects to /login.
      window.location.href = "/login";
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-2 py-1 rounded text-xs font-medium text-gray-700 hover:bg-gray-100"
      >
        <span className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-semibold text-gray-700">
          {username.slice(0, 1).toUpperCase()}
        </span>
        <span>{username}</span>
        {isAdmin && (
          <span className="text-[9px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1 py-0.5 rounded">
            admin
          </span>
        )}
        <span className="text-gray-400">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-gray-200 rounded-md shadow-md py-1 z-50">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
            Signed in as
          </div>
          <div className="px-3 py-1.5 text-xs text-gray-700">{username}</div>
          <button
            onClick={logout}
            className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 border-t border-gray-100"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
