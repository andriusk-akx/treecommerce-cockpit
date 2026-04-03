# TreeCommerce Cockpit

## Project Overview

TreeCommerce Cockpit is a monitoring dashboard for TreeCommerce e-commerce pilot operations. Built with Next.js, Prisma, and PostgreSQL. Provides real-time analytics, incident tracking, uptime monitoring, sales data, and resource management.

## Architecture

### Pattern: Next.js App Router + Prisma ORM + PostgreSQL

- **Frontend**: Next.js (App Router), React, TailwindCSS
- **ORM**: Prisma with PostgreSQL adapter (`@prisma/adapter-pg`)
- **Database**: PostgreSQL 16 (via Docker)
- **Data Sources**: Zabbix API integration, direct DB queries

### Key Directories

```
src/
  app/                    — Next.js App Router pages
    analytics/            — Analytics dashboard
    api/                  — API routes
    components/           — Shared UI components
    incidents/            — Incident tracking
    notes/                — Notes system
    patterns/             — Pattern analysis
    promotions/           — Promotions management
    resources/            — Resource management
    sales/                — Sales monitoring
    settings/             — App settings
    uptime/               — Uptime monitoring
    layout.tsx            — Root layout
    page.tsx              — Home/Overview page
  generated/              — Prisma generated client
  lib/
    db.ts                 — Database connection
    params.ts             — Shared param utilities
    data-source/          — Data source connectors
    zabbix/               — Zabbix API client
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
