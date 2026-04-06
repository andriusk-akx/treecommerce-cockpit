"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface PilotNavProps {
  pilotId: string;
  productType: string;
}

interface Tab {
  href: string;
  label: string;
  exact?: boolean;
}

export default function PilotNav({ pilotId, productType }: PilotNavProps) {
  const pathname = usePathname();

  const sharedTabs: Tab[] = [
    { href: `/pilots/${pilotId}/overview`, label: "Apžvalga", exact: true },
    { href: `/pilots/${pilotId}/technical`, label: "Technika" },
    { href: `/pilots/${pilotId}/incidents`, label: "Įvykiai" },
    { href: `/pilots/${pilotId}/uptime`, label: "Uptime" },
    { href: `/pilots/${pilotId}/patterns`, label: "Šablonai" },
    { href: `/pilots/${pilotId}/analytics`, label: "Analitika" },
    { href: `/pilots/${pilotId}/notes`, label: "Pastabos" },
    { href: `/pilots/${pilotId}/data-sources`, label: "Šaltiniai" },
  ];

  const treecommerceTabs: Tab[] = [
    { href: `/pilots/${pilotId}/sales`, label: "Pardavimai" },
    { href: `/pilots/${pilotId}/promotions`, label: "Akcijos" },
  ];

  const retellectTabs: Tab[] = [
    { href: `/pilots/${pilotId}/devices`, label: "Įrenginiai" },
    { href: `/pilots/${pilotId}/cpu-analysis`, label: "CPU analizė" },
    { href: `/pilots/${pilotId}/capacity-risk`, label: "Talpos rizika" },
  ];

  const tabs: Tab[] = [
    ...sharedTabs,
    ...(productType === "TREECOMMERCE" ? treecommerceTabs : []),
    ...(productType === "RETELLECT" ? retellectTabs : []),
  ];

  return (
    <div className="flex items-center gap-1 mb-6 border-b border-gray-200 pb-3 overflow-x-auto">
      {tabs.map(({ href, label, exact }) => {
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
