import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { prisma } from "@/lib/db";
import NavLinks from "./components/NavLinks";
import UserMenu from "./components/UserMenu";
import { Suspense } from "react";
import { getCurrentUser } from "@/lib/auth/sessions";
import { filterAccessiblePilots } from "@/lib/auth/permissions";
import { VERSION, COMMIT, DIRTY } from "@/generated/version";
import "./globals.css";

// Layout depends on the current user's permissions — must be per-request.
// (The /login page is also rendered through this layout; it gracefully
// handles user === null.)
export const dynamic = "force-dynamic";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Store X",
  description: "Consultant-controlled pilot operations cockpit",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getCurrentUser();

  // Active pilots — filtered to what the user can see. Admins see all.
  let activePilots: { id: string; name: string; shortCode: string; productType: string }[] = [];
  if (user) {
    try {
      const all = await prisma.pilot.findMany({
        where: { status: "ACTIVE" },
        orderBy: { name: "asc" },
        select: { id: true, name: true, shortCode: true, productType: true },
      });
      activePilots = filterAccessiblePilots(user, all);
    } catch {
      // DB not ready — app still loads
    }
  }

  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-gray-50 text-gray-900 font-sans">
        {user ? (
          <header className="bg-white border-b border-gray-200 px-6 py-3">
            <div className="max-w-7xl mx-auto flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div>
                  <h1 className="text-lg font-bold text-gray-900 tracking-tight">
                    Store X
                  </h1>
                  <p className="text-[10px] text-gray-400 -mt-0.5">
                    Pilot management system
                  </p>
                </div>
                {activePilots.length > 0 && (
                  <div className="flex items-center gap-1.5 ml-4 pl-4 border-l border-gray-200">
                    {activePilots.map((p) => (
                      <a
                        key={p.id}
                        href={p.productType === "RETELLECT" ? `/retellect/${p.id}` : `/pilots/${p.id}/overview`}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          p.productType === "TREECOMMERCE" ? "bg-green-500" :
                          p.productType === "RETELLECT" ? "bg-blue-500" : "bg-gray-400"
                        }`} />
                        {p.shortCode}
                      </a>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-6">
                <Suspense fallback={null}>
                  <NavLinks isAdmin={user.isAdmin} />
                </Suspense>
                <UserMenu username={user.username} isAdmin={user.isAdmin} />
              </div>
            </div>
          </header>
        ) : null}
        <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-8">
          {children}
        </main>
        <footer className="border-t border-gray-200 px-6 py-3 text-center text-[10px] text-gray-400">
          Store X &mdash; Consultant&rsquo;s pilot management tool
          <span className="mx-2 text-gray-300">·</span>
          {/* Version string is concatenated server-side so it ends up as a
              single text node in the DOM (no React comment markers between
              "v" and the number) — easier to grep, easier to read. */}
          <span title={`build ${COMMIT}${DIRTY ? "+dirty" : ""}`}>
            {`v${VERSION} (${COMMIT}${DIRTY ? "+" : ""})`}
          </span>
        </footer>
      </body>
    </html>
  );
}
