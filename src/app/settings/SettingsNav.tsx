"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SETTINGS_NAV = [
  { href: "/settings", label: "General", exact: true },
  { href: "/settings/users", label: "Users" },
  { href: "/settings/roles", label: "Roles" },
  { href: "/settings/data-sources", label: "Data sources" },
  { href: "/settings/zabbix", label: "Zabbix" },
  { href: "/settings/treecommerce-api", label: "TreeCommerce API" },
  { href: "/settings/retellect", label: "Retellect" },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 mb-6 border-b border-gray-200 pb-3 overflow-x-auto">
      {SETTINGS_NAV.map(({ href, label, exact }) => {
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
  );
}
