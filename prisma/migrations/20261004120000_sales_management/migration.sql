-- CreateEnum
CREATE TYPE "SalesStage" AS ENUM ('NEW', 'QUALIFIED', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('RECORDED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "sales_opportunities" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "stage" "SalesStage" NOT NULL DEFAULT 'NEW',
    "internalNotes" VARCHAR(5000) NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_records" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "acceptedQuoteId" TEXT NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'RECORDED',
    "recordedById" TEXT NOT NULL,
    "cancellationReason" VARCHAR(2000),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_events" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "actorId" TEXT,
    "eventType" VARCHAR(100) NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_opportunities_recipientId_key" ON "sales_opportunities"("recipientId");

-- CreateIndex
CREATE INDEX "sales_opportunities_stage_updatedAt_id_idx" ON "sales_opportunities"("stage", "updatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_opportunities_id_recipientId_key" ON "sales_opportunities"("id", "recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_records_opportunityId_key" ON "sale_records"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_records_acceptedQuoteId_key" ON "sale_records"("acceptedQuoteId");

-- CreateIndex
CREATE INDEX "sale_records_status_createdAt_id_idx" ON "sale_records"("status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_records_opportunityId_recipientId_key" ON "sale_records"("opportunityId", "recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_records_acceptedQuoteId_recipientId_key" ON "sale_records"("acceptedQuoteId", "recipientId");

-- CreateIndex
CREATE INDEX "sales_events_opportunityId_createdAt_id_idx" ON "sales_events"("opportunityId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_quotes_id_recipientId_key" ON "rfq_quotes"("id", "recipientId");

-- AddForeignKey
ALTER TABLE "sales_opportunities" ADD CONSTRAINT "sales_opportunities_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "rfq_recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_records" ADD CONSTRAINT "sale_records_opportunityId_recipientId_fkey" FOREIGN KEY ("opportunityId", "recipientId") REFERENCES "sales_opportunities"("id", "recipientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_records" ADD CONSTRAINT "sale_records_acceptedQuoteId_recipientId_fkey" FOREIGN KEY ("acceptedQuoteId", "recipientId") REFERENCES "rfq_quotes"("id", "recipientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_records" ADD CONSTRAINT "sale_records_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_events" ADD CONSTRAINT "sales_events_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "sales_opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_events" ADD CONSTRAINT "sales_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill one private opportunity for each existing M5 recipient without changing RFQs.
INSERT INTO sales_opportunities (id, "recipientId", stage, "internalNotes", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, lead.id,
  CASE
    WHEN EXISTS (SELECT 1 FROM rfq_quotes q WHERE q."recipientId"=lead.id AND q.status='ACCEPTED') THEN 'WON'::"SalesStage"
    WHEN lead."removedAt" IS NOT NULL OR lead."leadStatus"='DECLINED' OR rfq.status IN ('ACCEPTED','CLOSED','CANCELLED','EXPIRED','DECLINED') THEN 'LOST'::"SalesStage"
    WHEN EXISTS (SELECT 1 FROM rfq_quotes q WHERE q."recipientId"=lead.id AND q.status IN ('PENDING','REJECTED')) THEN 'QUOTED'::"SalesStage"
    ELSE 'NEW'::"SalesStage"
  END, '', lead."createdAt", CURRENT_TIMESTAMP
FROM rfq_recipients lead JOIN rfqs rfq ON rfq.id=lead."rfqId";
INSERT INTO sales_events (id,"opportunityId","actorId","eventType",metadata,"createdAt")
SELECT gen_random_uuid()::text,id,NULL,'IMPORTED_FROM_M5',jsonb_build_object('stage',stage),CURRENT_TIMESTAMP FROM sales_opportunities;
ALTER TABLE sale_records ADD CONSTRAINT sale_terminal_dates CHECK (
 (status='RECORDED' AND "completedAt" IS NULL AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL) OR
 (status='COMPLETED' AND "completedAt" IS NOT NULL AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL) OR
 (status='CANCELLED' AND "cancelledAt" IS NOT NULL AND "completedAt" IS NULL AND "cancellationReason" IS NOT NULL)
);
