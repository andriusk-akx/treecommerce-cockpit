/**
 * Admin → Users.
 *
 * Lists all users with their role, admin flag, last-login time, and the
 * pilots they have access to. Each user row links to the editor.
 */
import Link from "next/link";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const users = await prisma.user.findMany({
    orderBy: [{ isAdmin: "desc" }, { username: "asc" }],
    include: {
      role: { select: { id: true, name: true } },
      pilotAccess: {
        select: {
          allowedTabs: true,
          pilot: { select: { id: true, name: true, shortCode: true } },
        },
      },
    },
  });

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Users</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Manage who can sign in and what they can see. Admins have unrestricted access; non-admins see only the pilots and tabs explicitly granted to them.
          </p>
        </div>
        <Link
          href="/settings/users/new"
          className="bg-gray-900 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-gray-800"
        >
          + New user
        </Link>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2">Username</th>
              <th className="text-left px-4 py-2">Role</th>
              <th className="text-left px-4 py-2">Admin</th>
              <th className="text-left px-4 py-2">Pilot access</th>
              <th className="text-left px-4 py-2">Last login</th>
              <th className="text-left px-4 py-2">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-gray-100 last:border-b-0">
                <td className="px-4 py-2 font-medium text-gray-900">{u.username}</td>
                <td className="px-4 py-2 text-xs text-gray-600">{u.role?.name ?? "—"}</td>
                <td className="px-4 py-2">
                  {u.isAdmin ? (
                    <span className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                      admin
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  {u.isAdmin ? (
                    <span className="text-gray-500">all pilots</span>
                  ) : u.pilotAccess.length === 0 ? (
                    <span className="text-gray-400">none</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {u.pilotAccess.map((g) => (
                        <span
                          key={g.pilot.id}
                          title={`${g.allowedTabs.join(", ") || "no tabs"}`}
                          className="inline-block bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded text-[10px]"
                        >
                          {g.pilot.shortCode || g.pilot.name} ({g.allowedTabs.length} tabs)
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-gray-500">
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("lt-LT") : "—"}
                </td>
                <td className="px-4 py-2 text-xs">
                  {!u.isActive ? (
                    <span className="text-red-600">disabled</span>
                  ) : u.lockedUntil && u.lockedUntil > new Date() ? (
                    <span className="text-amber-700">locked</span>
                  ) : (
                    <span className="text-emerald-700">active</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <Link
                    href={`/settings/users/${u.id}`}
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
