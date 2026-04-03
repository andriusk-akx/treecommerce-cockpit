import { NextResponse } from "next/server";
import { getZabbixClient, ZabbixApiError } from "@/lib/zabbix/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.ZABBIX_URL;
  const token = process.env.ZABBIX_TOKEN;

  // Check if credentials are configured
  if (!url || !token) {
    return NextResponse.json({
      ok: false,
      configured: false,
      url: null,
      version: null,
      hostsCount: null,
      error: "ZABBIX_URL ir ZABBIX_TOKEN nenustatyti .env faile",
      checkedAt: new Date().toISOString(),
    });
  }

  try {
    const client = getZabbixClient();
    const t0 = Date.now();

    // Test connection with version check + host count
    const [version, hosts] = await Promise.all([client.getVersion(), client.getHosts()]);

    const latencyMs = Date.now() - t0;

    return NextResponse.json({
      ok: true,
      configured: true,
      url: url.replace(/\/api_jsonrpc\.php$/, ""), // Strip endpoint for display
      version,
      hostsCount: hosts.length,
      latencyMs,
      error: null,
      checkedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    const isAuthError = e instanceof ZabbixApiError && (e.code === -32602 || e.data?.includes("auth"));
    return NextResponse.json({
      ok: false,
      configured: true,
      url: url.replace(/\/api_jsonrpc\.php$/, ""),
      version: null,
      hostsCount: null,
      error: isAuthError ? "Autentifikacijos klaida — patikrinkite ZABBIX_TOKEN" : e.message || "Nepavyko prisijungti prie Zabbix",
      checkedAt: new Date().toISOString(),
    });
  }
}
