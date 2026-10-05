-- CreateEnum
CREATE TYPE "ServiceTicketStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "WarrantyAssessment" AS ENUM ('NOT_REQUESTED', 'PENDING', 'APPROVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "ServiceEventVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- CreateTable
CREATE TABLE "service_tickets" (
    "id" TEXT NOT NULL,
    "sequence" SERIAL NOT NULL,
    "customerId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "assignedToId" TEXT,
    "customerRequestId" TEXT NOT NULL,
    "status" "ServiceTicketStatus" NOT NULL DEFAULT 'OPEN',
    "subject" VARCHAR(200) NOT NULL,
    "description" VARCHAR(10000) NOT NULL,
    "resolution" VARCHAR(5000),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "warrantyAssessment" "WarrantyAssessment" NOT NULL DEFAULT 'NOT_REQUESTED',
    "warrantyNote" VARCHAR(2000),
    "warrantyReviewedById" TEXT,
    "warrantyReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_ticket_events" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "visibility" "ServiceEventVisibility" NOT NULL DEFAULT 'PUBLIC',
    "note" VARCHAR(5000),
    "fromStatus" "ServiceTicketStatus",
    "toStatus" "ServiceTicketStatus",
    "assignedToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_tickets_sequence_key" ON "service_tickets"("sequence");

-- CreateIndex
CREATE INDEX "service_tickets_customerId_createdAt_id_idx" ON "service_tickets"("customerId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "service_tickets_assignedToId_status_updatedAt_id_idx" ON "service_tickets"("assignedToId", "status", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "service_tickets_status_updatedAt_id_idx" ON "service_tickets"("status", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "service_tickets_machineId_idx" ON "service_tickets"("machineId");

-- CreateIndex
CREATE INDEX "service_tickets_saleId_idx" ON "service_tickets"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "service_tickets_customerId_customerRequestId_key" ON "service_tickets"("customerId", "customerRequestId");

-- CreateIndex
CREATE INDEX "service_ticket_events_ticketId_createdAt_id_idx" ON "service_ticket_events"("ticketId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sale_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_warrantyReviewedById_fkey" FOREIGN KEY ("warrantyReviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket_events" ADD CONSTRAINT "service_ticket_events_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "service_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket_events" ADD CONSTRAINT "service_ticket_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket_events" ADD CONSTRAINT "service_ticket_events_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE service_tickets ADD CONSTRAINT ticket_subject CHECK (length(trim(subject)) > 0 AND length(trim(description)) > 0);
ALTER TABLE service_tickets ADD CONSTRAINT ticket_assignment CHECK ((status IN ('OPEN','UNDER_REVIEW') AND "assignedToId" IS NULL) OR (status IN ('ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED') AND "assignedToId" IS NOT NULL));
ALTER TABLE service_tickets ADD CONSTRAINT ticket_not_self_assigned CHECK ("assignedToId" IS NULL OR "assignedToId" <> "customerId");
ALTER TABLE service_tickets ADD CONSTRAINT ticket_resolution CHECK ((status IN ('RESOLVED','CLOSED') AND resolution IS NOT NULL AND length(trim(resolution)) > 0 AND "resolvedAt" IS NOT NULL) OR (status NOT IN ('RESOLVED','CLOSED') AND resolution IS NULL AND "resolvedAt" IS NULL));
ALTER TABLE service_tickets ADD CONSTRAINT ticket_closure CHECK ((status='CLOSED' AND "closedAt" IS NOT NULL AND "closedAt">="resolvedAt") OR (status<>'CLOSED' AND "closedAt" IS NULL));
ALTER TABLE service_tickets ADD CONSTRAINT ticket_warranty CHECK (("warrantyAssessment" IN ('NOT_REQUESTED','PENDING') AND "warrantyNote" IS NULL AND "warrantyReviewedById" IS NULL AND "warrantyReviewedAt" IS NULL) OR ("warrantyAssessment" IN ('APPROVED','DECLINED') AND "warrantyNote" IS NOT NULL AND length(trim("warrantyNote"))>0 AND "warrantyReviewedById" IS NOT NULL AND "warrantyReviewedAt" IS NOT NULL));
ALTER TABLE service_ticket_events ADD CONSTRAINT ticket_event_note CHECK (note IS NULL OR length(trim(note))>0);
