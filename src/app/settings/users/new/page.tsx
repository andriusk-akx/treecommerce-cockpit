/**
 * Admin → Users → New.
 *
 * Minimal create form. Pilot access is configured AFTER creation in the
 * detail editor — keeps the create flow simple and prevents partial state
 * if access grants fail.
 */
import Link from "next/link";
import { prisma } from "@/lib/db";
import { createUser } from "../actions";

export const dynamic = "force-dynamic";

export default async function NewUserPage() {
  const roles = await prisma.role.findMany({ orderBy: { name: "asc" } });
  return (
    <div className="max-w-md">
      <div className="text-xs text-gray-400 mb-2">
        <Link href="/settings/users" className="hover:text-gray-600">Users</Link>
        <span className="mx-1">/</span>
        <span className="text-gray-600">New</span>
      </div>
      <h1 className="text-lg font-semibold text-gray-900 mb-4">Create user</h1>
      <form action={createUser} className="space-y-4 bg-white border border-gray-200 rounded-lg p-5">
        <div>
          <label className="text-xs font-medium text-gray-700 block mb-1">Username</label>
          <input
            name="username"
            required
            minLength={2}
            className="w-full text-sm border border-gray-200 rounded px-3 py-2 focus:outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-400"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700 block mb-1">Password</label>
          <input
            name="password"
            type="password"
            required
            minLength={6}
            className="w-full text-sm border border-gray-200 rounded px-3 py-2 focus:outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-400"
          />
          <p className="text-[10px] text-gray-500 mt-1">Min 6 characters. Hashed with bcrypt cost 12.</p>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700 block mb-1">Role (optional)</label>
          <select
            name="roleId"
            defaultValue=""
            className="w-full text-sm border border-gray-200 rounded px-3 py-2"
          >
            <option value="">— none —</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <p className="text-[10px] text-gray-500 mt-1">
            The role&apos;s allowed-tabs template is used as a default when granting pilot access.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-700">
          <input type="checkbox" name="isAdmin" />
          Grant admin privileges (full access, bypasses pilot scoping)
        </label>
        <div className="pt-2 flex items-center gap-2">
          <button
            type="submit"
            className="bg-gray-900 text-white text-sm font-medium px-4 py-2 rounded hover:bg-gray-800"
          >
            Create user
          </button>
          <Link
            href="/settings/users"
            className="text-sm text-gray-600 hover:text-gray-800"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
