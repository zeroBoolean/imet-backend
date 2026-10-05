ALTER TABLE "users" ADD COLUMN "googleSubject" TEXT;
CREATE UNIQUE INDEX "users_googleSubject_key" ON "users"("googleSubject");
CREATE TABLE "auth_email_intents" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "purpose" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "encryptedToken" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "sentAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "auth_email_intents_pkey" PRIMARY KEY ("id"));
CREATE INDEX "auth_email_intents_sentAt_expiresAt_idx" ON "auth_email_intents"("sentAt", "expiresAt");
ALTER TABLE "auth_email_intents" ADD CONSTRAINT "auth_email_intents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
