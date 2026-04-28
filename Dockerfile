# AKpilot production image — regular Next.js start with full node_modules.
#
# Earlier attempt with output: "standalone" + server.js produced a
# crash-loop where the standalone server.js exited silently right after
# startup. Regular `next start` reads from node_modules and stays alive.

FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

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
RUN npx prisma generate && \
    npm run version:generate && \
    npm run build

EXPOSE 8080
# Add a healthcheck that Docker (and Railway) can rely on. If healthcheck
# fails consistently, Docker marks unhealthy but doesn't restart by itself —
# Railway uses its own observation. The key is `next start` keeps running.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8080}/api/version || exit 1

# Use npm start which calls `next start` from package.json.
# `exec` makes node PID 1 — SIGTERM from Railway propagates for graceful shutdown.
CMD ["sh", "-c", "exec npm start -- -H 0.0.0.0 -p ${PORT:-8080}"]
