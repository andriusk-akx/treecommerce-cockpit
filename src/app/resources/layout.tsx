"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SUB_NAV = [
  { href: "/resources", label: "Apžvalga", exact: true },
  { href: "/resources/settings", label: "API nustatymai" },
];

export default function ResourcesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div>
      {/* Sub-navigation */}
      <div className="flex items-center gap-4 mb-6 border-b border-gray-200 pb-3">
        {SUB_NAV.map(({ href, label, exact }) => {
          const isActive = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={
                isActive
                  ? "text-sm font-semibold text-gray-900 border-b-2 border-gray-900 pb-2.5 -mb-3.5"
                  : "text-sm font-medium text-gray-400 hover:text-gray-600 pb-2.5 -mb-3.5 transition-colors"
              }
            >
              {label}
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}
