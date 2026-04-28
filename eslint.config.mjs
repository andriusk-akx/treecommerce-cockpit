import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Skip legacy/exploratory scripts — they're one-off Zabbix probes, not
    // production code, and they're not shipped to Railway anyway.
    "scripts/probe-*",
    "scripts/_probe-*",
    "scripts/perf-bench-*",
    "scripts/check-devices.*",
    "scripts/fix-outlet-db.*",
    "scripts/verify-*",
    "scripts/seed-prod.ts",
    "scripts/unlock-user.ts",
    "scripts/generate-version.ts",
    "**/*.bak",
    // Claude worktrees — temporary working copies, not project sources.
    ".claude/**",
  ]),
  {
    // Downgrade legacy lint rules to warnings — these fire on pre-existing
    // code (Zabbix client wrappers, dashboard pages) that would take a
    // focused refactor to clean up. Keeping them visible as warnings means
    // we still see them locally without blocking the CI/CD pipeline.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/error-boundaries": "warn",
      "react-hooks/static-components": "warn",
      "@next/next/no-html-link-for-pages": "warn",
    },
  },
]);

export default eslintConfig;
