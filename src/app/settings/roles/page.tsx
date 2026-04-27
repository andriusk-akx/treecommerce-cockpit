import Link from "next/link";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function RolesPage() {
  const roles = await prisma.role.findMany({
    orderBy: [{ isBuiltIn: "desc" }, { name: "asc" }],
    include: { _count: { select: { users: true } } },
  });
  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Roles</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Templates for tab access. When you grant a user access to a pilot,
            their role&apos;s default tabs pre-fill the picker. Per-pilot overrides
            live on the user record.
          </p>
        </div>
        <Link
          href="/settings/roles/new"
          className="bg-gray-900 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-gray-800"
        >
          + New role
        </Link>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2">Name</th>
              <th className="text-left px-4 py-2">Default tabs</th>
              <th className="text-left px-4 py-2">Users</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id} className="border-b border-gray-100 last:border-b-0">
                <td className="px-4 py-2">
                  <div className="font-medium text-gray-900 flex items-center gap-2">
                    {r.name}
                    {r.isBuiltIn && (
                      <span className="text-[9px] uppercase tracking-wide bg-gray-100 text-gray-600 px-1 py-0.5 rounded">
                        built-in
                      </span>
                    )}
                  </div>
                  {r.description && (
                    <div className="text-xs text-gray-500">{r.description}</div>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  {r.allowedTabs.length ? r.allowedTabs.join(", ") : <span className="text-gray-400">none</span>}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">{r._count.users}</td>
                <td className="px-4 py-2 text-right">
                  <Link
                    href={`/settings/roles/${r.id}`}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    Edit →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
