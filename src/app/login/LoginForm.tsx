"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogoX } from "@/app/components/LogoX";

interface Props {
  next: string;
}

export function LoginForm({ next }: Props) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Separate from `submitting`: stays true from successful auth until the
  // destination route swaps in. Without this the user faces a blank window
  // for the 1–3 s SSR + Zabbix wait, because the login form has already
  // received its response but the new route's HTML isn't here yet. The
  // overlay backed by `navigating` covers that gap with a clear progress
  // message.
  const [navigating, setNavigating] = useState(false);

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
        // Client-side navigation so the destination route's `loading.tsx`
        // and Suspense fallbacks fire IMMEDIATELY — no blank-window gap
        // between submit-success and SSR-arrival. The session cookie was
        // set on the response we just received, so `router.push`'s next
        // RSC fetch carries it and the destination renders authenticated.
        //
        // `router.refresh()` makes the shared `force-dynamic` RootLayout
        // re-fetch with the new session so the header reflects the
        // logged-in user immediately when the layout re-mounts.
        setNavigating(true);
        router.refresh();
        router.push(data.redirect || "/");
        // Deliberately do NOT clear `submitting` / `navigating` — we want
        // the overlay to stay visible until the new route replaces this
        // component tree.
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
      setSubmitting(false);
    } catch {
      setError("Could not reach the server. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <>
      {navigating && <NavigatingOverlay />}
      <form onSubmit={onSubmit} className="space-y-4" aria-busy={navigating || submitting}>
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
        disabled={submitting || navigating}
        className="w-full bg-gray-900 text-white text-sm font-medium px-3 py-2 rounded hover:bg-gray-800 transition disabled:opacity-50"
      >
        {navigating ? "Loading dashboard…" : submitting ? "Signing in…" : "Sign in"}
      </button>
      </form>
    </>
  );
}

/**
 * Full-screen overlay rendered between successful auth and the destination
 * route mounting. Without it the user sees the login form (with "Signing
 * in…" still on the button) for the 1–3 s window where:
 *
 *   1. /api/auth/login has already returned
 *   2. router.push has kicked off an RSC fetch for the new route
 *   3. The destination's loading.tsx hasn't yet replaced this React tree
 *
 * The overlay is positioned `fixed inset-0 z-50` so it covers the form
 * regardless of where the form sits in the layout. Pure CSS animation,
 * no client deps.
 */
function NavigatingOverlay() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(255, 255, 255, 0.96)",
        backdropFilter: "blur(2px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        animation: "akpilot-overlay-fade 200ms ease-out",
      }}
    >
      <style>{`
        @keyframes akpilot-overlay-fade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes akpilot-spinner {
          to { transform: rotate(360deg); }
        }
        @keyframes akpilot-dots {
          0%, 20%   { opacity: 0.2; }
          50%       { opacity: 1; }
          80%, 100% { opacity: 0.2; }
        }
      `}</style>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
        {/* Logo above the spinner — gives the user immediate "yes, I'm in
            the right app" reassurance during the loading window. */}
        <LogoX size={36} />

        {/* Spinner ring */}
        <div
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            border: "2.5px solid #e5e7eb",
            borderTopColor: "#3f4f1f",
            animation: "akpilot-spinner 0.8s linear infinite",
          }}
        />

        <div style={{ textAlign: "center", maxWidth: 320 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#111827", marginBottom: 4 }}>
            Welcome to Store X
          </div>
          <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.5 }}>
            Loading your dashboard
            <span style={{ display: "inline-block", animation: "akpilot-dots 1.4s ease-in-out infinite", animationDelay: "0s" }}>.</span>
            <span style={{ display: "inline-block", animation: "akpilot-dots 1.4s ease-in-out infinite", animationDelay: "0.2s" }}>.</span>
            <span style={{ display: "inline-block", animation: "akpilot-dots 1.4s ease-in-out infinite", animationDelay: "0.4s" }}>.</span>
            <br />
            <span style={{ fontSize: 11, color: "#9ca3af" }}>
              Pulling live monitoring data from Zabbix
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
