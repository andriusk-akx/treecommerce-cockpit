-- Authentication & Authorization tables
--
--   User              — credentials, admin flag, lockout state
--   Role              — template of allowed pilot tabs (admin-creatable)
--   UserPilotAccess   — per-pilot scoped access for non-admin users
--   UserSession       — server-side session table backing cookie auth

CREATE TABLE "User" (
  "id"                  TEXT PRIMARY KEY,
  "username"            TEXT NOT NULL UNIQUE,
  "passwordHash"        TEXT NOT NULL,
  "isAdmin"             BOOLEAN NOT NULL DEFAULT false,
  "roleId"              TEXT,
  "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil"         TIMESTAMP(3),
  "lastLoginAt"         TIMESTAMP(3),
  "isActive"            BOOLEAN NOT NULL DEFAULT true,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL
);
CREATE INDEX "User_username_idx" ON "User"("username");

CREATE TABLE "Role" (
  "id"          TEXT PRIMARY KEY,
  "name"        TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "isBuiltIn"   BOOLEAN NOT NULL DEFAULT false,
  "allowedTabs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);

ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "UserPilotAccess" (
  "id"          TEXT PRIMARY KEY,
  "userId"      TEXT NOT NULL,
  "pilotId"     TEXT NOT NULL,
  "allowedTabs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "grantedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "grantedBy"   TEXT
);
CREATE UNIQUE INDEX "UserPilotAccess_userId_pilotId_key"
  ON "UserPilotAccess"("userId", "pilotId");
CREATE INDEX "UserPilotAccess_userId_idx" ON "UserPilotAccess"("userId");
CREATE INDEX "UserPilotAccess_pilotId_idx" ON "UserPilotAccess"("pilotId");
ALTER TABLE "UserPilotAccess" ADD CONSTRAINT "UserPilotAccess_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserPilotAccess" ADD CONSTRAINT "UserPilotAccess_pilotId_fkey"
  FOREIGN KEY ("pilotId") REFERENCES "Pilot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UserSession" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL,
  "tokenHash"  TEXT NOT NULL UNIQUE,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userAgent"  TEXT,
  "ipAddress"  TEXT
);
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
