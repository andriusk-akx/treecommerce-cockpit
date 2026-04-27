/**
 * Settings layout — admin-only.
 *
 * Server-side guard: non-admins see notFound(). The client middleware can't
 * check isAdmin (Edge runtime, no DB), so this is the actual enforcement
 * point. Admin bypass is single-source-of-truth via getCurrentUser().isAdmin.
 */
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/sessions";
import { requireAdmin } from "@/lib/auth/permissions";
import { SettingsNav } from "./SettingsNav";

export const dynamic = "force-dynamic";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!requireAdmin(user)) return notFound();
  return (
    <div>
      <SettingsNav />
      {children}
    </div>
  );
}
