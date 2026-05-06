/**
 * Login page — server-rendered shell + client form.
 *
 * If the user is already authenticated, we redirect immediately to /
 * (or to ?next=) so the back button doesn't bring you to a stale login form.
 */
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/sessions";
import { LoginForm } from "./LoginForm";
import { LogoX } from "@/app/components/LogoX";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: Props) {
  const { next } = await searchParams;
  const user = await getCurrentUser();
  if (user) {
    redirect(next && next.startsWith("/") ? next : "/");
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white border border-gray-200 rounded-lg shadow-sm p-6">
        <div className="text-center mb-6">
          <div className="flex items-center justify-center gap-2 mb-1 text-gray-900">
            <LogoX size={28} />
            <h1 className="text-xl font-bold tracking-tight">
              Store <span className="text-[#14532d]">X</span>
            </h1>
          </div>
          <p className="text-xs text-gray-500">Sign in to continue</p>
        </div>
        <LoginForm next={next ?? "/"} />
      </div>
    </div>
  );
}
