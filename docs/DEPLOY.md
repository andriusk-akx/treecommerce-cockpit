# AKpilot — Production deploy (Railway)

## Prerequisites

- Railway account (already set up)
- GitHub repo with `main` branch
- `ZABBIX_TOKEN` from `.env.local` (read-only, ok for prod for now)

## One-time setup

### 1. Create Railway project

Railway → **New Project** → **Deploy from GitHub repo** → pick the AKpilot repo.

The git repo's root IS the Next.js app — no nested directory configuration
needed. Railway will pick up `package.json` directly.

### 2. Provision Postgres

In the project, **+ New** → **Database** → **PostgreSQL**.

Railway auto-injects `DATABASE_URL` into the app service as a reference variable
once both are in the same project. Confirm in the app service → **Variables**.

### 3. Set the rest of the variables

In the app service → **Variables**:

```
ZABBIX_URL=https://monitoring.strongpoint.com/api_jsonrpc.php
ZABBIX_TOKEN=<paste from .env.local>
TWELVEEAT_ENV=prod
SEED_ADMIN_PASSWORD=<a strong password — used ONCE on first seed>
SEED_SPRIMI_PASSWORD=<at least 6 chars — used ONCE on first seed>
```

`SEED_*` are only consulted by `scripts/seed-prod.ts` which runs once below.

### 4. Pick the deploy branch

Service → **Settings → Deploy** → **Source Branch** → `main`.

Railway will auto-build on every push to `main`.

### 5. First deploy

Push to `main` (instructions in next section). Railway:
1. Runs `npm ci && prisma generate && version:generate && next build`
2. Runs `prisma migrate deploy && next start` (in `startCommand`)
3. Healthchecks `/api/version` until it returns 200

When the deploy is **green**, open the service shell:

Service → **... → Open Shell** → run:

```bash
npx tsx scripts/seed-prod.ts
```

This creates:
- StrongPoint client + SP-RETELLECT pilot
- Roles "Full access" and "Pilot viewer (Overview + Timeline)"
- Admin user (using `SEED_ADMIN_PASSWORD`)
- Sprimi1 user (using `SEED_SPRIMI_PASSWORD`) with overview+timeline grant

Then populate the Rimi fleet (115 hosts). The expand script reads from the
committed `rimi_hosts_filtered.json`:

```bash
npx tsx scripts/seed_rimi_expand.ts
```

After both seeds, **DELETE** the `SEED_ADMIN_PASSWORD` and `SEED_SPRIMI_PASSWORD`
variables from Railway. They're only needed once; leaving them around is the
kind of trace pen-testers love.

### 6. Test the prod URL

Open `https://<your-service>.up.railway.app`:
1. Login as Admin → `/` shows the dashboard
2. Logout → login as Sprimi1 → lands directly on the Retellect pilot
3. Footer shows `v0.1.0 (<commit>)` — version tracking works

Done.

## Subsequent deploys

```bash
# In the app/ directory locally
git checkout main
git merge feat/some-branch     # or commit directly to main
git push origin main           # → triggers Railway build
```

Watch logs in Railway → service → **Deployments**.

If the build fails, the previous deploy stays running — Railway never deploys
a broken build to live traffic.

## Migrations

`prisma migrate deploy` runs as part of `startCommand` on every deploy.
Already-applied migrations are skipped. New migrations run in order.

If a migration goes wrong:
1. Railway shows the error in deploy logs
2. The previous deploy is still running (won't switch to broken one)
3. Fix the migration locally, push, redeploy

For risky schema changes, snapshot Postgres first:

Service → **Database** → **... → Backup & Restore** → take a manual backup.

## Rollback

Railway → service → **Deployments** → find the previous good deploy → **... → Redeploy**.

Note: a redeploy doesn't roll back the database. For schema rollbacks you'll
need a down migration — easier path is "fix forward" with a corrective migration.

## Monitoring

- **Logs:** service → **Deployments → Logs** (live stream)
- **Health:** `/api/version` returns 200 when alive — Railway checks it every 30s
- **Metrics:** service → **Metrics** (CPU, RAM, network, request count)
- **Backups:** automatic daily on Postgres; weekly manual `pg_dump` recommended:

  ```bash
  # Locally, with Railway DATABASE_URL in env:
  pg_dump "$DATABASE_URL" > backups/akpilot-$(date +%F).sql
  ```

## Known gotchas

- **Egress IP is dynamic.** If SP IT later requires IP-whitelisting Zabbix,
  you'll need to switch to a host with static egress (Hetzner with reserved IP,
  or Railway's static-IP add-on if available).
- **No built-in cron.** If we add scheduled Zabbix sync later, use GitHub
  Actions cron-on-schedule pinging an internal endpoint, or Railway's beta
  cron service.
- **Cold start ~5-10s** on Hobby plan after a long idle. Pro plan keeps the
  service warm. For 2-3 active users this is annoying but tolerable.

## Cost estimate

- App service (Hobby): **$5/mo** flat
- Postgres (small, ~512MB-1GB): **$5-10/mo**
- **Total: ~$10-15/mo**
