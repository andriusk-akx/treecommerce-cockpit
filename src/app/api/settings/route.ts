import { NextResponse } from "next/server";
import { writeFile, unlink, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import path from "path";

const PLIST_NAME = "com.treecommerce.cockpit.plist";
const LAUNCH_AGENTS_DIR = path.join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, PLIST_NAME);
const STARTUP_SCRIPT = path.join(homedir(), "Projects", "treecommerce-cockpit", "start-cockpit.sh");
const ENV_PATH = path.join(homedir(), "Projects", "treecommerce-cockpit", "app", ".env.local");

function buildPlist(): string {
  const home = homedir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.treecommerce.cockpit</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${STARTUP_SCRIPT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${home}/Projects/treecommerce-cockpit/cockpit.log</string>
    <key>StandardErrorPath</key>
    <string>${home}/Projects/treecommerce-cockpit/cockpit.log</string>
</dict>
</plist>`;
}

// Read current .env.local to get TWELVEEAT_ENV
async function readApiEnv(): Promise<string> {
  try {
    const { readFile } = require("fs/promises");
    const content = await readFile(ENV_PATH, "utf-8");
    const match = content.match(/^TWELVEEAT_ENV=(.+)$/m);
    return match?.[1]?.trim() || "test";
  } catch {
    return "test";
  }
}

// Write TWELVEEAT_ENV to .env.local (preserving other vars)
async function writeApiEnv(env: string): Promise<void> {
  let content = "";
  try {
    const { readFile } = require("fs/promises");
    content = await readFile(ENV_PATH, "utf-8");
  } catch {
    content = "";
  }

  // Replace or add TWELVEEAT_ENV
  if (content.includes("TWELVEEAT_ENV=")) {
    content = content.replace(/^TWELVEEAT_ENV=.+$/m, `TWELVEEAT_ENV=${env}`);
  } else {
    content = content.trimEnd() + (content ? "\n" : "") + `TWELVEEAT_ENV=${env}\n`;
  }

  await writeFile(ENV_PATH, content, "utf-8");

  // Also set runtime env for current process
  process.env.TWELVEEAT_ENV = env;
}

// GET — check current settings
export async function GET() {
  const autostart = existsSync(PLIST_PATH);
  const apiEnv = await readApiEnv();
  return NextResponse.json({ autostart, apiEnv });
}

// POST — update settings
export async function POST(request: Request) {
  const body = await request.json();

  // Handle API env switch
  if (body.apiEnv !== undefined) {
    const env = body.apiEnv === "prod" ? "prod" : "test";
    try {
      await writeApiEnv(env);
      return NextResponse.json({ apiEnv: env, message: `API aplinka: ${env.toUpperCase()}` });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  // Handle autostart toggle
  const enable = !!body.autostart;
  try {
    if (enable) {
      if (!existsSync(STARTUP_SCRIPT)) {
        return NextResponse.json(
          { error: "start-cockpit.sh nerastas. Paleisk StartDashboard.command pirmą kartą." },
          { status: 400 }
        );
      }
      if (!existsSync(LAUNCH_AGENTS_DIR)) {
        await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
      }
      await writeFile(PLIST_PATH, buildPlist(), "utf-8");
      const { execSync } = require("child_process");
      execSync(`launchctl load "${PLIST_PATH}" 2>/dev/null || true`);
      return NextResponse.json({ autostart: true, message: "Auto-start įjungtas" });
    } else {
      if (existsSync(PLIST_PATH)) {
        const { execSync } = require("child_process");
        execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
        await unlink(PLIST_PATH);
      }
      return NextResponse.json({ autostart: false, message: "Auto-start išjungtas" });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
