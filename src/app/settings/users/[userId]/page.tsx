/**
 * Admin → Users → Detail.
 *
 * One page covers everything an admin needs: change role, toggle admin/active,
 * reset password, and per-pilot tab access editor. All actions are server
 * actions defined in ../actions.ts so the admin gate is enforced server-side.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { updateUser, resetPassword, deleteUser, setPilotAccess } from "../actions";
import { ALL_TABS, TAB_LABELS, type TabKey } from "@/lib/auth/permissions";
import { getCurrentUser } from "@/lib/auth/sessions";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ userId: string }>;
}

export default async function EditUserPage({ params }: Props) {
  const { userId } = await params;
  const [me, user, roles, pilots] = await Promise.all([
    getCurrentUser(),
    prisma.user.findUnique({
      where: { id: userId },
      include: {
        role: true,
        pilotAccess: { include: { pilot: true } },
      },
    }),
    prisma.role.findMany({ orderBy: { name: "asc" } }),
    prisma.pilot.findMany({
      orderBy: [{ status: "asc" }, { name: "asc" }],
      select: { id: true, name: true, shortCode: true, productType: true, status: true },
    }),
  ]);
  if (!user) return notFound();
  const isSelf = me?.id === user.id;
  const accessByPilot = new Map(user.pilotAccess.map((g) => [g.pilotId, g]));

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <div className="text-xs text-gray-400 mb-2">
          <Link href="/settings/users" className="hover:text-gray-600">Users</Link>
          <span className="mx-1">/</span>
          <span className="text-gray-600">{user.username}</span>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-gray-900">{user.username}</h1>
          {user.isAdmin && (
            <span className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
              admin
            </span>
          )}
          {!user.isActive && (
            <span className="text-[10px] uppercase tracking-wide bg-red-100 text-red-800 px-1.5 py-0.5 rounded">
              disabled
            </span>
          )}
          {isSelf && (
            <span className="text-[10px] uppercase tracking-wide bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">
              you
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Created {new Date(user.createdAt).toLocaleDateString("lt-LT")}
          {user.lastLoginAt && (
            <> · Last login {new Date(user.lastLoginAt).toLocaleString("lt-LT")}</>
          )}
        </p>
      </div>

      {/* ── Profile ──────────────────────────────── */}
      <section className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-800 mb-3">Profile</h2>
        <form action={updateUser.bind(null, user.id)} className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-700 block mb-1">Role</label>
            <select
              name="roleId"
              defaultValue={user.roleId ?? ""}
              className="text-sm border border-gray-200 rounded px-3 py-1.5"
            >
              <option value="">— none —</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-xs text-gray-700">
              <input
                type="checkbox"
                name="isAdmin"
                defaultChecked={user.isAdmin}
                disabled={isSelf}
              />
              Admin
              {isSelf && <span className="text-gray-400">(can&apos;t change own)</span>}
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-700">
              <input
                type="checkbox"
                name="isActive"
                defaultChecked={user.isActive}
                disabled={isSelf}
              />
              Active (can sign in)
            </label>
          </div>
          <button
            type="submit"
            className="bg-gray-900 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-gray-800"
          >
            Save
          </button>
        </form>
      </section>

      {/* ── Password reset ──────────────────────────────── */}
      <section className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-800 mb-1">Reset password</h2>
        <p className="text-xs text-gray-500 mb-3">
          Sets a new password and revokes all existing sessions for this user.
        </p>
        <form action={resetPassword.bind(null, user.id)} className="flex items-end gap-2">
          <input
            name="password"
            type="password"
            required
            minLength={6}
            placeholder="New password"
            className="flex-1 text-sm border border-gray-200 rounded px-3 py-1.5"
          />
          <button
            type="submit"
            className="bg-gray-900 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-gray-800"
          >
            Reset
          </button>
        </form>
      </section>

      {/* ── Pilot access (only for non-admin users) ──── */}
      {!user.isAdmin && (
        <section className="bg-white border border-gray-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-800 mb-1">Pilot access</h2>
          <p className="text-xs text-gray-500 mb-3">
            Pick which pilots this user can see, and which tabs are visible inside each pilot.
            Empty = no access. Admin users see everything by default.
          </p>
          <div className="space-y-3">
            {pilots.map((p) => {
              const grant = accessByPilot.get(p.id);
              const granted = new Set<TabKey>(
                (grant?.allowedTabs ?? []).filter((t): t is TabKey =>
                  (ALL_TABS as readonly string[]).includes(t),
                ),
              );
              return (
                <form
                  key={p.id}
                  action={setPilotAccess.bind(null, user.id, p.id)}
                  className="border border-gray-200 rounded p-3"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="text-sm font-medium text-gray-900">{p.name}</div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wide">
                        {p.shortCode} · {p.productType.toLowerCase()}
                      </div>
                    </div>
                    <button
                      type="submit"
                      className="bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium px-3 py-1 rounded"
                    >
                      Save
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {ALL_TABS.map((tab) => (
                      <label
                        key={tab}
                        className="flex items-center gap-1.5 text-xs text-gray-700 bg-gray-50 px-2 py-1 rounded border border-gray-200 cursor-pointer hover:border-gray-400"
                      >
                        <input
                          type="checkbox"
                          name="tabs"
                          value={tab}
                          defaultChecked={granted.has(tab)}
                        />
                        {TAB_LABELS[tab]}
                      </label>
                    ))}
                  </div>
                </form>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Danger zone ──────────────────────────────── */}
      {!isSelf && (
        <section className="bg-white border border-red-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-red-800 mb-1">Danger zone</h2>
          <p className="text-xs text-red-700 mb-3">
            Deletes this user permanently. All sessions and pilot grants are removed.
            This cannot be undone.
          </p>
          <form action={deleteUser.bind(null, user.id)}>
            <button
              type="submit"
              className="bg-red-600 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-red-700"
            >
              Delete user
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
