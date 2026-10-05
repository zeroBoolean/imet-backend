CREATE TABLE "auth_refresh_handoffs" ("tokenHash" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "encryptedResult" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "auth_refresh_handoffs_pkey" PRIMARY KEY ("tokenHash"));
CREATE INDEX "auth_refresh_handoffs_expiresAt_idx" ON "auth_refresh_handoffs"("expiresAt");
ALTER TABLE "auth_refresh_handoffs" ADD CONSTRAINT "auth_refresh_handoffs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "user_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
