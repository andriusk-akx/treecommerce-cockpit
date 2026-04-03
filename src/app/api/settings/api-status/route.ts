import { NextResponse } from "next/server";

const ENDPOINTS = {
  test: "http://10.36.161.75:9051/api/v1/export/transactions/latest-cursor",
  prod: "http://10.100.39.16:9051/api/v1/export/transactions/latest-cursor",
};

async function checkEndpoint(url: string): Promise<"ok" | "fail"> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store" });
    return res.ok ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

export async function GET() {
  const [test, prod] = await Promise.all([
    checkEndpoint(ENDPOINTS.test),
    checkEndpoint(ENDPOINTS.prod),
  ]);
  return NextResponse.json({ test, prod });
}
