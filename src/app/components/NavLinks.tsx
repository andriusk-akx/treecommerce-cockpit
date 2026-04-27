"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  exact?: boolean;
  /** Hide from non-admin users. */
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", exact: true },
  { href: "/retellect", label: "Retellect" },
  { href: "/pilots", label: "Pilotai", adminOnly: true },
  { href: "/clients", label: "Klientai", adminOnly: true },
  { href: "/settings", label: "Settings", adminOnly: true },
];

export default function NavLinks({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((it) => !it.adminOnly || isAdmin);

  return (
    <nav className="flex gap-5 text-sm font-medium">
      {items.map(({ href, label, exact }) => {
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
