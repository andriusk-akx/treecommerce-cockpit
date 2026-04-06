import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { prisma } from "@/lib/db";
import NavLinks from "./components/NavLinks";
import { Suspense } from "react";
import "./globals.css";

export const dynamic = "force-dynamic";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AKpilot",
  description: "Consultant-controlled pilot operations cockpit",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Load active pilots for navigation context
  let activePilots: { id: string; name: string; shortCode: string; productType: string }[] = [];
  try {
    activePilots = await prisma.pilot.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, shortCode: true, productType: true },
    });
  } catch {
    // DB not ready — app still loads
  }

  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-gray-50 text-gray-900 font-sans">
        <header className="bg-white border-b border-gray-200 px-6 py-3">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div>
                <h1 className="text-lg font-bold text-gray-900 tracking-tight">
                  AKpilot
                </h1>
                <p className="text-[10px] text-gray-400 -mt-0.5">
                  Pilotų valdymo sistema
                </p>
              </div>
              {activePilots.length > 0 && (
                <div className="flex items-center gap-1.5 ml-4 pl-4 border-l border-gray-200">
                  {activePilots.map((p) => (
                    <a
                      key={p.id}
                      href={`/pilots/${p.id}/overview`}
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
            <Suspense fallback={null}>
              <NavLinks />
            </Suspense>
          </div>
        </header>
        <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-8">
          {children}
        </main>
        <footer className="border-t border-gray-200 px-6 py-3 text-center text-[10px] text-gray-400">
          AKpilot &mdash; Konsultanto pilotų valdymo įrankis
        </footer>
      </body>
    </html>
  );
}
