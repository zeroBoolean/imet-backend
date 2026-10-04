-- CreateEnum
CREATE TYPE "ReviewTarget" AS ENUM ('MACHINERY', 'SUPPLIER');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED', 'HIDDEN', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "target" "ReviewTarget" NOT NULL,
    "machineId" TEXT,
    "supplierId" TEXT,
    "rating" INTEGER NOT NULL,
    "body" VARCHAR(5000) NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "moderationNote" VARCHAR(2000),
    "moderatedById" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reviews_authorId_createdAt_id_idx" ON "reviews"("authorId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "reviews_status_createdAt_id_idx" ON "reviews"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "reviews_machineId_status_createdAt_id_idx" ON "reviews"("machineId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "reviews_supplierId_status_createdAt_id_idx" ON "reviews"("supplierId", "status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_saleId_target_key" ON "reviews"("saleId", "target");

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sale_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Exactly one target, with backend-derived ownership and completed-sale eligibility.
ALTER TABLE reviews ADD CONSTRAINT review_target_guard CHECK (
  (target='MACHINERY' AND "machineId" IS NOT NULL AND "supplierId" IS NULL) OR
  (target='SUPPLIER' AND "supplierId" IS NOT NULL AND "machineId" IS NULL)
);
ALTER TABLE reviews ADD CONSTRAINT review_rating_guard CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE reviews ADD CONSTRAINT review_body_guard CHECK (length(btrim(body)) BETWEEN 1 AND 5000);
