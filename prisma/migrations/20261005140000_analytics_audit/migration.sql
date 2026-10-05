-- CreateEnum
CREATE TYPE "AuditResourceType" AS ENUM ('USER', 'CATEGORY', 'MACHINERY', 'SUPPLIER', 'SUBSCRIPTION_PLAN', 'SUBSCRIPTION', 'REVIEW');

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" VARCHAR(80) NOT NULL,
    "resourceType" "AuditResourceType" NOT NULL,
    "resourceId" VARCHAR(100) NOT NULL,
    "context" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_id_idx" ON "audit_logs"("createdAt", "id");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_id_idx" ON "audit_logs"("actorId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "audit_logs_resourceType_resourceId_createdAt_id_idx" ON "audit_logs"("resourceType", "resourceId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_id_idx" ON "audit_logs"("action", "createdAt", "id");

-- CreateIndex
CREATE INDEX "rfq_events_createdAt_id_idx" ON "rfq_events"("createdAt", "id");

-- CreateIndex
CREATE INDEX "sales_events_createdAt_id_idx" ON "sales_events"("createdAt", "id");

-- CreateIndex
CREATE INDEX "service_ticket_events_createdAt_id_idx" ON "service_ticket_events"("createdAt", "id");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

