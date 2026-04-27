import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { updateRole, deleteRole } from "../actions";
import { RoleForm } from "../RoleForm";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ roleId: string }>;
}

export default async function EditRolePage({ params }: Props) {
  const { roleId } = await params;
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    include: { _count: { select: { users: true } } },
  });
  if (!role) return notFound();
  return (
    <div className="max-w-md space-y-6">
      <div>
        <div className="text-xs text-gray-400 mb-2">
          <Link href="/settings/roles" className="hover:text-gray-600">Roles</Link>
          <span className="mx-1">/</span>
          <span className="text-gray-600">{role.name}</span>
        </div>
        <h1 className="text-lg font-semibold text-gray-900">{role.name}</h1>
        <p className="text-xs text-gray-500 mt-1">
          {role._count.users} user{role._count.users === 1 ? "" : "s"} use this role.
        </p>
      </div>
      <RoleForm
        action={updateRole.bind(null, role.id)}
        defaultName={role.name}
        defaultDescription={role.description ?? ""}
        defaultTabs={role.allowedTabs}
        isBuiltIn={role.isBuiltIn}
        submitLabel="Save"
      />
      {!role.isBuiltIn && (
        <section className="bg-white border border-red-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-red-800 mb-1">Delete role</h2>
          <p className="text-xs text-red-700 mb-3">
            Roles with users assigned cannot be deleted. Reassign or remove those users first.
          </p>
          <form action={deleteRole.bind(null, role.id)}>
            <button
              type="submit"
              className="bg-red-600 text-white text-xs font-medium px-3 py-1.5 rounded hover:bg-red-700"
            >
              Delete role
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
