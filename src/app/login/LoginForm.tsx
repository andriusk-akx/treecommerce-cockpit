"use client";

import { useState } from "react";

interface Props {
  next: string;
}

export function LoginForm({ next }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, next }),
      });
      const data = await res.json();
      if (data.ok) {
        // Hard navigation so the new session cookie + server-rendered shell
        // both apply on the destination page.
        window.location.href = data.redirect || "/";
        return;
      }
      // Map server reasons to user-facing copy. "invalid_credentials" stays
      // intentionally vague so we don't leak whether the username exists.
      if (data.reason === "locked") {
        setError("Account temporarily locked. Try again in 15 minutes.");
      } else if (data.reason === "disabled") {
        setError("This account is disabled. Contact your administrator.");
      } else {
        setError("Invalid username or password.");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="text-xs font-medium text-gray-700 mb-1 block">Username</label>
        <input
          type="text"
          autoComplete="username"
          autoFocus
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full text-sm border border-gray-200 rounded px-3 py-2 focus:outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-400"
        />
      </div>
      <div>
        <label className="text-xs font-medium text-gray-700 mb-1 block">Password</label>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full text-sm border border-gray-200 rounded px-3 py-2 focus:outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-400"
        />
      </div>
      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="w-full bg-gray-900 text-white text-sm font-medium px-3 py-2 rounded hover:bg-gray-800 transition disabled:opacity-50"
      >
        {submitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
