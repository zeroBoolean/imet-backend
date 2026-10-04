-- CreateEnum
CREATE TYPE "RfqStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'ROUTED', 'QUOTED', 'ACCEPTED', 'CLOSED', 'CANCELLED', 'EXPIRED', 'DECLINED');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'VIEWED', 'QUOTED', 'DECLINED', 'CLOSED');

-- CreateEnum
CREATE TYPE "RfqRecipientRole" AS ENUM ('SUPPLIER', 'MANUFACTURER', 'SALESPERSON', 'SELLER');

-- CreateEnum
CREATE TYPE "RfqRoutingReason" AS ENUM ('AUTO', 'MANUAL', 'ADMIN_OVERRIDE');

-- CreateEnum
CREATE TYPE "RfqQuoteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RfqEmailStatus" AS ENUM ('PENDING', 'QUEUED', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "subscription_plans" ADD COLUMN     "canRevealContacts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "leadLimitPerMonth" INTEGER DEFAULT 0,
ADD COLUMN     "rfqEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "supplier_subscriptions" ADD COLUMN     "canRevealContacts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "leadLimitPerMonth" INTEGER DEFAULT 0,
ADD COLUMN     "rfqEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "contactBlocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "rfqs" (
    "id" TEXT NOT NULL,
    "sequence" SERIAL NOT NULL,
    "rfqNumber" VARCHAR(40) NOT NULL,
    "buyerId" TEXT NOT NULL,
    "machineId" TEXT,
    "categoryId" TEXT,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" VARCHAR(40) NOT NULL,
    "targetBudget" DECIMAL(16,2),
    "budgetCurrency" VARCHAR(3),
    "deliveryLocation" VARCHAR(2000) NOT NULL,
    "deliveryTimeline" VARCHAR(500) NOT NULL,
    "supplierCountry" VARCHAR(100),
    "preferredLanguage" VARCHAR(2) NOT NULL DEFAULT 'en',
    "status" "RfqStatus" NOT NULL DEFAULT 'DRAFT',
    "expiresAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "isFlagged" BOOLEAN NOT NULL DEFAULT false,
    "flagReason" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_recipients" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "recipientRole" "RfqRecipientRole" NOT NULL,
    "leadStatus" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "routingReason" "RfqRoutingReason" NOT NULL,
    "routedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "quotaMonth" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rfq_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_quotes" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "unitPrice" DECIMAL(16,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "moq" DECIMAL(14,3) NOT NULL,
    "leadTimeDays" INTEGER NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "notes" TEXT NOT NULL,
    "status" "RfqQuoteStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rfq_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_attachments" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" VARCHAR(250) NOT NULL,
    "fileType" VARCHAR(100) NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rfq_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_quote_attachments" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" VARCHAR(250) NOT NULL,
    "fileType" VARCHAR(100) NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rfq_quote_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_messages" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "rfq_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_events" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "actorId" TEXT,
    "eventType" VARCHAR(100) NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rfq_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_email_deliveries" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RfqEmailStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(500),
    "queuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rfq_email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_sequence_key" ON "rfqs"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_rfqNumber_key" ON "rfqs"("rfqNumber");

-- CreateIndex
CREATE INDEX "rfqs_buyerId_createdAt_id_idx" ON "rfqs"("buyerId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "rfqs_status_expiresAt_idx" ON "rfqs"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "rfqs_categoryId_createdAt_idx" ON "rfqs"("categoryId", "createdAt");

-- CreateIndex
CREATE INDEX "rfq_recipients_recipientId_leadStatus_routedAt_idx" ON "rfq_recipients"("recipientId", "leadStatus", "routedAt");

-- CreateIndex
CREATE INDEX "rfq_recipients_recipientId_quotaMonth_idx" ON "rfq_recipients"("recipientId", "quotaMonth");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_recipients_rfqId_recipientId_key" ON "rfq_recipients"("rfqId", "recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_recipients_id_rfqId_key" ON "rfq_recipients"("id", "rfqId");

-- CreateIndex
CREATE INDEX "rfq_quotes_rfqId_status_idx" ON "rfq_quotes"("rfqId", "status");

-- CreateIndex
CREATE INDEX "rfq_quotes_recipientId_createdAt_idx" ON "rfq_quotes"("recipientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_attachments_storageKey_key" ON "rfq_attachments"("storageKey");

-- CreateIndex
CREATE INDEX "rfq_attachments_rfqId_idx" ON "rfq_attachments"("rfqId");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_quote_attachments_storageKey_key" ON "rfq_quote_attachments"("storageKey");

-- CreateIndex
CREATE INDEX "rfq_quote_attachments_quoteId_idx" ON "rfq_quote_attachments"("quoteId");

-- CreateIndex
CREATE INDEX "rfq_messages_recipientId_createdAt_id_idx" ON "rfq_messages"("recipientId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "rfq_events_rfqId_createdAt_id_idx" ON "rfq_events"("rfqId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "rfq_email_deliveries_status_createdAt_idx" ON "rfq_email_deliveries"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_email_deliveries_eventId_userId_key" ON "rfq_email_deliveries"("eventId", "userId");

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "machine_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_recipients" ADD CONSTRAINT "rfq_recipients_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_recipients" ADD CONSTRAINT "rfq_recipients_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_quotes" ADD CONSTRAINT "rfq_quotes_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_quotes" ADD CONSTRAINT "rfq_quotes_recipientId_rfqId_fkey" FOREIGN KEY ("recipientId", "rfqId") REFERENCES "rfq_recipients"("id", "rfqId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_attachments" ADD CONSTRAINT "rfq_attachments_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_attachments" ADD CONSTRAINT "rfq_attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_quote_attachments" ADD CONSTRAINT "rfq_quote_attachments_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "rfq_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_quote_attachments" ADD CONSTRAINT "rfq_quote_attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_messages" ADD CONSTRAINT "rfq_messages_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_messages" ADD CONSTRAINT "rfq_messages_recipientId_rfqId_fkey" FOREIGN KEY ("recipientId", "rfqId") REFERENCES "rfq_recipients"("id", "rfqId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_messages" ADD CONSTRAINT "rfq_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_events" ADD CONSTRAINT "rfq_events_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_events" ADD CONSTRAINT "rfq_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_email_deliveries" ADD CONSTRAINT "rfq_email_deliveries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "rfq_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_email_deliveries" ADD CONSTRAINT "rfq_email_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Business invariants also hold under concurrent lifecycle operations.
CREATE UNIQUE INDEX "one_accepted_quote_per_rfq" ON "rfq_quotes" ("rfqId") WHERE "status" = 'ACCEPTED';
ALTER TABLE "rfqs" ADD CONSTRAINT "rfq_positive_quantity" CHECK ("quantity" > 0);
ALTER TABLE "rfqs" ADD CONSTRAINT "rfq_valid_budget" CHECK (("targetBudget" IS NULL AND "budgetCurrency" IS NULL) OR ("targetBudget" >= 0 AND "budgetCurrency" ~ '^[A-Z]{3}$'));
ALTER TABLE "rfqs" ADD CONSTRAINT "rfq_valid_language" CHECK ("preferredLanguage" IN ('en', 'bn', 'zh'));
ALTER TABLE "rfq_quotes" ADD CONSTRAINT "quote_valid_amounts" CHECK ("unitPrice" >= 0 AND "moq" > 0 AND "leadTimeDays" >= 0 AND "currency" ~ '^[A-Z]{3}$');
ALTER TABLE "rfq_attachments" ADD CONSTRAINT "rfq_attachment_positive_size" CHECK ("fileSize" > 0);
ALTER TABLE "rfq_quote_attachments" ADD CONSTRAINT "quote_attachment_positive_size" CHECK ("fileSize" > 0);
ALTER TABLE "subscription_plans" ADD CONSTRAINT "plan_valid_lead_cap" CHECK ("leadLimitPerMonth" IS NULL OR "leadLimitPerMonth" >= 0);
ALTER TABLE "supplier_subscriptions" ADD CONSTRAINT "term_valid_lead_cap" CHECK ("leadLimitPerMonth" IS NULL OR "leadLimitPerMonth" >= 0);
