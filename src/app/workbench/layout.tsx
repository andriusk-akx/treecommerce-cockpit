"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const WORKBENCH_NAV = [
  { href: "/workbench", label: "Apžvalga", exact: true },
  { href: "/workbench/context-export", label: "Konteksto eksportas" },
  { href: "/workbench/prompt-studio", label: "Prompt Studio" },
  { href: "/workbench/source-explorer", label: "Šaltinių naršyklė" },
  { href: "/workbench/diagnostics", label: "Diagnostika" },
  { href: "/workbench/view-builder", label: "View Builder" },
];

export default function WorkbenchLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div>
      <div className="flex items-center gap-1 mb-6 border-b border-gray-200 pb-3 overflow-x-auto">
        {WORKBENCH_NAV.map(({ href, label, exact }) => {
          const isActive = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`whitespace-nowrap px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                isActive
                  ? "bg-gray-900 text-white"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
              }`}
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
