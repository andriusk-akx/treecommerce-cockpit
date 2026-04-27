"use server";

/**
 * Server actions for user management. Every action re-checks admin gate —
 * never trust the client. No direct mutation goes to Prisma without the
 * adminGate() pre-flight.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/sessions";
import { requireAdmin, ALL_TABS, type TabKey } from "@/lib/auth/permissions";
import { hashPassword } from "@/lib/auth/passwords";

async function adminGate() {
  const user = await getCurrentUser();
  if (!requireAdmin(user)) throw new Error("FORBIDDEN");
  return user;
}

function sanitiseTabs(input: string[] | string | undefined): TabKey[] {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr.filter((t): t is TabKey => (ALL_TABS as readonly string[]).includes(t));
}

export async function createUser(formData: FormData) {
  await adminGate();
  const username = String(formData.get("username") || "").trim();
  const password = String(formData.get("password") || "");
  const isAdmin = formData.get("isAdmin") === "on";
  const roleId = String(formData.get("roleId") || "") || null;
  if (!username || username.length < 2) throw new Error("Username too short");
  if (password.length < 6) throw new Error("Password must be at least 6 characters");
  // Username uniqueness — case-insensitive.
  const existing = await prisma.user.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
  });
  if (existing) throw new Error("Username already exists");
  const passwordHash = await hashPassword(password);
  const created = await prisma.user.create({
    data: { username, passwordHash, isAdmin, roleId, isActive: true },
  });
  revalidatePath("/settings/users");
  redirect(`/settings/users/${created.id}`);
}

export async function updateUser(userId: string, formData: FormData) {
  const admin = await adminGate();
  const data: Record<string, unknown> = {};
  if (formData.has("isAdmin")) data.isAdmin = formData.get("isAdmin") === "on";
  if (formData.has("isActive")) data.isActive = formData.get("isActive") === "on";
  if (formData.has("roleId")) data.roleId = String(formData.get("roleId") || "") || null;
  // Block self-demotion: admins can't strip their own admin or disable
  // themselves — prevents lockout. They have to be removed by another admin.
  if (userId === admin.id && data.isAdmin === false) {
    throw new Error("You cannot remove your own admin flag");
  }
  if (userId === admin.id && data.isActive === false) {
    throw new Error("You cannot disable your own account");
  }
  await prisma.user.update({ where: { id: userId }, data });
  revalidatePath("/settings/users");
  revalidatePath(`/settings/users/${userId}`);
}

export async function resetPassword(userId: string, formData: FormData) {
  await adminGate();
  const password = String(formData.get("password") || "");
  if (password.length < 6) throw new Error("Password must be at least 6 characters");
  const passwordHash = await hashPassword(password);
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash,
      // Force-reset lockout state on password change.
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });
  // Optionally also revoke all existing sessions so the user is forced to
  // log in again with the new password.
  await prisma.userSession.deleteMany({ where: { userId } });
  revalidatePath(`/settings/users/${userId}`);
}

export async function deleteUser(userId: string) {
  const admin = await adminGate();
  if (userId === admin.id) throw new Error("You cannot delete yourself");
  await prisma.user.delete({ where: { id: userId } });
  revalidatePath("/settings/users");
  redirect("/settings/users");
}

export async function setPilotAccess(
  userId: string,
  pilotId: string,
  formData: FormData,
) {
  const admin = await adminGate();
  // FormData "tabs" comes back as multiple entries. .getAll preserves all.
  const allowedTabs = sanitiseTabs(formData.getAll("tabs") as string[]);
  // No tabs → delete the grant entirely. Otherwise upsert.
  if (allowedTabs.length === 0) {
    await prisma.userPilotAccess.deleteMany({ where: { userId, pilotId } });
  } else {
    await prisma.userPilotAccess.upsert({
      where: { userId_pilotId: { userId, pilotId } },
      create: { userId, pilotId, allowedTabs, grantedBy: admin.id },
      update: { allowedTabs, grantedBy: admin.id },
    });
  }
  revalidatePath(`/settings/users/${userId}`);
}
