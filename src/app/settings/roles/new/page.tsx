import Link from "next/link";
import { createRole } from "../actions";
import { RoleForm } from "../RoleForm";

export const dynamic = "force-dynamic";

export default function NewRolePage() {
  return (
    <div className="max-w-md">
      <div className="text-xs text-gray-400 mb-2">
        <Link href="/settings/roles" className="hover:text-gray-600">Roles</Link>
        <span className="mx-1">/</span>
        <span className="text-gray-600">New</span>
      </div>
      <h1 className="text-lg font-semibold text-gray-900 mb-4">Create role</h1>
      <RoleForm action={createRole} submitLabel="Create role" />
    </div>
  );
}
