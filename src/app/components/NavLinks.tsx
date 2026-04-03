"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Apžvalga" },
  { href: "/incidents", label: "Įvykiai" },
  { href: "/notes", label: "Pastabos" },
  { href: "/uptime", label: "Uptime" },
  { href: "/patterns", label: "Šablonai" },
  { href: "/sales", label: "Pardavimai" },
  { href: "/promotions", label: "Akcijos" },
  { href: "/analytics", label: "Analitika" },
  { href: "/resources", label: "Resursai" },
  { href: "/settings", label: "⚙" },
];

export default function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-5 text-sm font-medium">
      {NAV_ITEMS.map(({ href, label }) => {
        const isActive =
          href === "/" ? pathname === "/" : pathname.startsWith(href);

        return (
          <Link
            key={href}
            href={href}
            className={
              isActive
                ? "text-gray-900 border-b-2 border-gray-900 pb-0.5 transition-colors"
                : "text-gray-500 hover:text-gray-800 transition-colors"
            }
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
