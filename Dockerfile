# AKpilot production image — official Next.js standalone Docker pattern.
#
# Multi-stage:
#   1. deps    — install all node_modules (incl. dev for build)
#   2. build   — generate Prisma client, version.ts, run `next build`
#                with output: 'standalone' set in next.config.ts
#   3. runner  — slim image with only the standalone server bundle
#
# Standalone output gives us:
#   - .next/standalone/server.js  (entry point, self-contained)
#   - .next/standalone/.next/...  (server bundle)
#   - .next/standalone/node_modules (only the production deps Next traced)
#   We then re-add public/ and .next/static/ which standalone doesn't include.

# ─── deps ──────────────────────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
RUN npm ci

# ─── build ─────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl git
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG RAILWAY_GIT_COMMIT_SHA
ARG RAILWAY_GIT_BRANCH
ENV AKPILOT_COMMIT_OVERRIDE=${RAILWAY_GIT_COMMIT_SHA:-unknown}
ENV AKPILOT_COMMIT_FULL_OVERRIDE=${RAILWAY_GIT_COMMIT_SHA:-unknown}
ENV AKPILOT_BRANCH_OVERRIDE=${RAILWAY_GIT_BRANCH:-unknown}
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate
RUN npm run version:generate
RUN npm run build

# ─── runner ────────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache libc6-compat openssl

# Standalone bundle — server.js + traced node_modules
COPY --from=build /app/.next/standalone ./
# Static assets (Next.js doesn't copy these into standalone)
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Prisma — generated client + engine binaries needed at runtime.
# Prisma 7 emits the client to src/generated/prisma; @prisma/client is the
# runtime peer that loads it. The standalone bundle traces both.
COPY --from=build /app/src/generated/prisma ./src/generated/prisma
COPY --from=build /app/prisma ./prisma
# prisma.config.ts is intentionally NOT copied — it's only needed for
# `prisma migrate deploy` which runs once via `railway run npx prisma
# migrate deploy` after first deploy. At runtime the app uses PrismaPg
# adapter with DATABASE_URL directly, no config file required.
# Files referenced by app at runtime
COPY --from=build /app/rimi_hosts_filtered.json ./rimi_hosts_filtered.json
COPY --from=build /app/scripts ./scripts

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# server.js is the standalone entry point. It binds to 0.0.0.0 by default
# and listens on PORT (Railway sets this). PID 1 = node, so SIGTERM
# propagates correctly for graceful shutdown.
CMD ["node", "server.js"]
