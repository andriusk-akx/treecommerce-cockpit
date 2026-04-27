"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/sessions";
import { requireAdmin, ALL_TABS, type TabKey } from "@/lib/auth/permissions";

async function adminGate() {
  const user = await getCurrentUser();
  if (!requireAdmin(user)) throw new Error("FORBIDDEN");
  return user;
}

function sanitiseTabs(input: string[]): TabKey[] {
  return input.filter((t): t is TabKey => (ALL_TABS as readonly string[]).includes(t));
}

export async function createRole(formData: FormData) {
  await adminGate();
  const name = String(formData.get("name") || "").trim();
  const description = String(formData.get("description") || "").trim() || null;
  const allowedTabs = sanitiseTabs(formData.getAll("tabs") as string[]);
  if (!name || name.length < 2) throw new Error("Role name too short");
  const created = await prisma.role.create({
    data: { name, description, allowedTabs, isBuiltIn: false },
  });
  revalidatePath("/settings/roles");
  redirect(`/settings/roles/${created.id}`);
}

export async function updateRole(roleId: string, formData: FormData) {
  await adminGate();
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new Error("Role not found");
  const name = String(formData.get("name") || "").trim();
  const description = String(formData.get("description") || "").trim() || null;
  const allowedTabs = sanitiseTabs(formData.getAll("tabs") as string[]);
  if (!name || name.length < 2) throw new Error("Role name too short");
  // Built-in roles can be edited (allowedTabs / description) but the name is
  // locked to keep references stable.
  await prisma.role.update({
    where: { id: roleId },
    data: role.isBuiltIn ? { description, allowedTabs } : { name, description, allowedTabs },
  });
  revalidatePath("/settings/roles");
  revalidatePath(`/settings/roles/${roleId}`);
}

export async function deleteRole(roleId: string) {
  await adminGate();
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    include: { _count: { select: { users: true } } },
  });
  if (!role) throw new Error("Role not found");
  if (role.isBuiltIn) throw new Error("Built-in roles cannot be deleted");
  if (role._count.users > 0) {
    throw new Error(`Cannot delete: ${role._count.users} user(s) still assigned to this role`);
  }
  await prisma.role.delete({ where: { id: roleId } });
  revalidatePath("/settings/roles");
  redirect("/settings/roles");
}
