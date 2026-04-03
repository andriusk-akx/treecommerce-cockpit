import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { prisma } from "@/lib/db";
import ClientFilter from "./components/ClientFilter";
import NavLinks from "./components/NavLinks";
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
  let stores: { id: string; name: string }[] = [];
  try {
    stores = await prisma.store.findMany({ orderBy: { name: "asc" } });
  } catch {
    // DB not ready — app still loads, just without store filter
  }

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
                Piloto stebėjimas ir incidentų valdymas
              </p>
            </div>
            <div className="flex items-center gap-6">
              <Suspense fallback={null}>
                <ClientFilter stores={stores.map((s) => ({ id: s.id, name: s.name }))} />
              </Suspense>
              <Suspense fallback={null}>
                <NavLinks />
              </Suspense>
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
