"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Home", exact: true },
  { href: "/retellect", label: "Retellect" },
  { href: "/pilots", label: "Pilotai" },
  { href: "/clients", label: "Klientai" },
  { href: "/settings", label: "Settings" },
];

export default function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-5 text-sm font-medium">
      {NAV_ITEMS.map(({ href, label, exact }) => {
        const isActive = exact
          ? pathname === href
          : pathname.startsWith(href);

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
