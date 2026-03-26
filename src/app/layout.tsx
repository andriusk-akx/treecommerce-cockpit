import type { Metadata } from "next";
import { Geist } from "next/font/google";
import Link from "next/link";
import { prisma } from "@/lib/db";
import ClientFilter from "./components/ClientFilter";
import { Suspense } from "react";
import "./globals.css";

export const dynamic = "force-dynamic";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TreeCommerce Pilot Cockpit",
  description: "Pilot monitoring cockpit for TreeCommerce operations",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const stores = await prisma.store.findMany({ orderBy: { name: "asc" } });

  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-gray-50 text-gray-900 font-sans">
        <header className="bg-white border-b border-gray-200 px-6 py-4">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">
                TreeCommerce Pilot Cockpit
              </h1>
              <p className="text-sm text-gray-500">
                Pilot monitoring &amp; incident tracking
              </p>
            </div>
            <div className="flex items-center gap-6">
              <Suspense fallback={null}>
                <ClientFilter stores={stores.map((s) => ({ id: s.id, name: s.name }))} />
              </Suspense>
              <nav className="flex gap-6 text-sm font-medium">
                <Link
                  href="/"
                  className="text-gray-600 hover:text-gray-900 transition-colors"
                >
                  Overview
                </Link>
                <Link
                  href="/incidents"
                  className="text-gray-600 hover:text-gray-900 transition-colors"
                >
                  Events
                </Link>
                <Link
                  href="/notes"
                  className="text-gray-600 hover:text-gray-900 transition-colors"
                >
                  Notes
                </Link>
                <Link
                  href="/uptime"
                  className="text-gray-600 hover:text-gray-900 transition-colors"
                >
                  Uptime
                </Link>
                <Link
                  href="/patterns"
                  className="text-gray-600 hover:text-gray-900 transition-colors"
                >
                  Patterns
                </Link>
                <Link
                  href="/analytics"
                  className="text-gray-600 hover:text-gray-900 transition-colors"
                >
                  Analytics
                </Link>
              </nav>
            </div>
          </div>
        </header>
        <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-8">
          {children}
        </main>
        <footer className="border-t border-gray-200 px-6 py-4 text-center text-xs text-gray-400">
          TreeCommerce Pilot Cockpit &mdash; Internal Tool
        </footer>
      </body>
    </html>
  );
}
