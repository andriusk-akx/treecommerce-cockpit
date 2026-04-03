# TreeCommerce Cockpit

## Project Overview

TreeCommerce Cockpit is a monitoring dashboard for TreeCommerce e-commerce pilot operations. Built with Next.js, Prisma, and PostgreSQL. Provides real-time analytics, incident tracking, uptime monitoring, sales data, and resource management.

## Architecture

### Pattern: Next.js App Router + Prisma ORM + PostgreSQL

- **Frontend**: Next.js (App Router), React, TailwindCSS
- **ORM**: Prisma with PostgreSQL adapter (`@prisma/adapter-pg`)
- **Database**: PostgreSQL 16 (via Docker)
- **Data Sources**: Zabbix API integration, direct DB queries

### Key Patterns

- **Universal Data Source Manager** (`src/lib/data-source/index.ts`) — every external API call goes through `fetchSource()`. On success → saves to `.cache/` as JSON (status: "live"). On failure → loads from cache (status: "cached"). If both fail → status: "unavailable". Use `fetchAll()` for parallel multi-source fetching (dashboard).
- **Server Components by default** — all pages use `export const dynamic = "force-dynamic"`. Client components only for interactivity (NavLinks, ClientFilter, TimelineChart, etc.).
- **DataSourceStatus component** — collapsible bar showing LIVE/CACHED/DOWN per source, used on every page.

### Key Directories

```
src/
  app/                    — Next.js App Router pages
    analytics/            — Zabbix analytics aggregation
    api/                  — API routes
      notes/              — Notes CRUD
      settings/           — App settings + API status check
      zabbix/             — Zabbix proxy: health/, resources/, sync/, status/, explore/, event-detail/, test/
    components/           — NavLinks, ClientFilter, DataSourceStatus, SyncButton, AutoSync, AutoRefresh
    incidents/            — Incident list with filtering
    notes/                — Operations notes CRUD
    patterns/             — Incident pattern analysis + TimelineChart
    promotions/           — 12eat promo/campaign analytics
    resources/            — Server resource monitoring (CPU/RAM/Disk/Network per host)
      settings/           — Zabbix API configuration & health check
    sales/                — 12eat POS sales data per store
    settings/             — App settings (autostart, 12eat API env toggle)
    uptime/               — Device uptime, MTTR, downtime periods
    layout.tsx            — Root layout (header, nav, footer)
    page.tsx              — Dashboard/Overview: KPIs, AI insights, live problems, severity breakdown
  generated/              — Prisma generated client
  lib/
    db.ts                 — Prisma client singleton
    params.ts             — URL param sanitization helpers
    data-source/index.ts  — Universal Data Source Manager with cache fallback
    zabbix/               — Zabbix integration
      client.ts           — ZabbixClient class (JSON-RPC 2.0, Bearer token)
      types.ts            — TypeScript interfaces
      sync.ts             — Zabbix → DB import
      insights.ts         — AI-style insights from Zabbix data
      uptime.ts           — Per-device uptime calculation
      patterns.ts         — Recurring incident pattern detection
      analytics.ts        — Metrics aggregation
      availability.ts     — Host availability calculations
      cache.ts            — Zabbix-specific caching
    12eat/client.ts       — 12eat POS REST client (test/prod env switchable)
prisma/
  schema.prisma           — Database schema
  migrations/             — SQL migrations
  seed.ts                 — Database seeding
```

## Tech Stack

- Next.js (App Router, TypeScript)
- React 19
- TailwindCSS + PostCSS
- Prisma ORM
- PostgreSQL 16 (Docker)
- ESLint (next/core-web-vitals + typescript)

## Build & Run

```bash
# Start database
docker-compose -f ../docker-compose.yml up -d

# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Run migrations
npx prisma migrate deploy

# Development server
npm run dev

# Production build
npm run build && npm start
```

## Development

- Playbook: `~/Projects/AKplaybook/PRINCIPLES.md`
- Template: `web-react`
- CI: `.github/workflows/ci.yml`
- Lint: ESLint (`eslint.config.mjs`)
- Database: PostgreSQL via `../docker-compose.yml`

## Important Notes

1. **AGENTS.md** — Contains Next.js-specific agent rules. Next.js APIs may differ from training data — always check `node_modules/next/dist/docs/` for current API docs.

2. **Database connection** — Uses `@prisma/adapter-pg` (not default Prisma connection). Connection config in `src/lib/db.ts`.

3. **Docker** — PostgreSQL runs via `docker-compose.yml` in the parent directory (one level up). Credentials: `treecommerce/treecommerce_dev`, DB: `treecommerce_cockpit`, port 5432.

4. **Prisma workflow** — Schema changes: edit `prisma/schema.prisma` → `npx prisma migrate dev --name description` → commit migration files.

5. **Zabbix** — Connected to `monitoring.strongpoint.com` (v7.4.5, 9 hosts). Auth via Bearer token (`ZABBIX_TOKEN` in `.env.local`). JSON-RPC 2.0 protocol.

6. **12eat POS** — REST API client switchable between TEST and PROD via Settings page. Requires VPN, 5s timeout.

7. **UI language** — All user-facing labels are in Lithuanian. Code and comments are in English.

8. **Data source cache** — `.cache/` directory stores JSON fallbacks. Never commit this directory.
