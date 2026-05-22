# AKpilot production image — regular Next.js start with full node_modules.
#
# Earlier attempt with output: "standalone" + server.js produced a
# crash-loop where the standalone server.js exited silently right after
# startup. Regular `next start` reads from node_modules and stays alive.

FROM node:24-alpine
WORKDIR /app
# git is needed at build time so scripts/generate-version.ts can run
# `git rev-list --count HEAD` to derive the auto-incrementing patch
# version. It's not retained in the final image — .git is removed after
# version:generate runs (see RUN block below).
RUN apk add --no-cache libc6-compat openssl git

# Install all deps (including dev — needed for prisma + next CLI at boot)
COPY package.json package-lock.json ./
RUN npm ci

# App source
COPY . .

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

ARG RAILWAY_GIT_COMMIT_SHA
ARG RAILWAY_GIT_BRANCH
ENV AKPILOT_COMMIT_OVERRIDE=${RAILWAY_GIT_COMMIT_SHA:-unknown}
ENV AKPILOT_COMMIT_FULL_OVERRIDE=${RAILWAY_GIT_COMMIT_SHA:-unknown}
ENV AKPILOT_BRANCH_OVERRIDE=${RAILWAY_GIT_BRANCH:-unknown}

# Build Prisma client + version stamp + Next.js production bundle.
# .git is included in the build context (see .dockerignore) so that
# version:generate can derive the auto-incrementing patch from
# `git rev-list --count HEAD`. It's deleted right after to keep history
# (and any unused refs) out of the final image.
RUN echo "=== git debug ===" && \
    (ls -la .git 2>&1 | head -3 || echo "NO .git dir") && \
    (git rev-list --count HEAD 2>&1 || echo "rev-list failed") && \
    (git --version 2>&1 || echo "git missing") && \
    echo "=== end debug ===" && \
    npx prisma generate && \
    npm run version:generate && \
    rm -rf .git && \
    npm run build

EXPOSE 8080
# Add a healthcheck that Docker (and Railway) can rely on. If healthcheck
# fails consistently, Docker marks unhealthy but doesn't restart by itself —
# Railway uses its own observation. The key is `next start` keeps running.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8080}/api/version || exit 1

# Apply any pending Prisma migrations BEFORE starting the server. `migrate
# deploy` is idempotent (no-op when prod is already current), so on quiet
# deploys this adds ~200 ms to cold-start and nothing on warm restarts. The
# chain stops on failure, so a broken migration prevents the server from
# coming up against a half-migrated schema — better than a 500-storm.
#
# Added 2026-05-20 alongside the cpu_num normalisation fix: that release
# adds three columns to Device, and without this step the new Prisma client
# queries would error against an unmigrated prod DB.
#
# `exec` on the final command keeps Next.js as PID 1 so SIGTERM from Railway
# propagates for graceful shutdown.
CMD ["sh", "-c", "npx prisma migrate deploy && exec npm start -- -H 0.0.0.0 -p ${PORT:-8080}"]
