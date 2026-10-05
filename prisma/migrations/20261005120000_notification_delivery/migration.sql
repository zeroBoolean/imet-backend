-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RfqEmailStatus" ADD VALUE 'SUPPRESSED';
ALTER TYPE "RfqEmailStatus" ADD VALUE 'REVIEW_REQUIRED';

-- AlterTable
ALTER TABLE "rfq_email_deliveries" ADD COLUMN     "dispatchLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "firstAttemptAt" TIMESTAMP(3),
ADD COLUMN     "providerMessageId" VARCHAR(200),
ADD COLUMN     "sendAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "notification_email_deliveries" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RfqEmailStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sendAttempts" INTEGER NOT NULL DEFAULT 0,
    "firstAttemptAt" TIMESTAMP(3),
    "providerMessageId" VARCHAR(200),
    "dispatchLeaseUntil" TIMESTAMP(3),
    "lastError" VARCHAR(500),
    "queuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_email_deliveries_status_createdAt_id_idx" ON "notification_email_deliveries"("status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_email_deliveries_eventId_userId_key" ON "notification_email_deliveries"("eventId", "userId");

-- AddForeignKey
ALTER TABLE "notification_email_deliveries" ADD CONSTRAINT "notification_email_deliveries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "service_ticket_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_email_deliveries" ADD CONSTRAINT "notification_email_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing queued RFQ records may have already reached the provider. Preserve a conservative retry boundary.
UPDATE "rfq_email_deliveries" SET "firstAttemptAt" = "queuedAt" WHERE "status" = 'QUEUED';
ALTER TABLE "rfq_email_deliveries" ADD CONSTRAINT "rfq_email_send_attempts_check" CHECK ("sendAttempts" BETWEEN 0 AND 5);
ALTER TABLE "notification_email_deliveries" ADD CONSTRAINT "notification_email_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5 AND "sendAttempts" BETWEEN 0 AND 5);
