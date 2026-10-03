-- CreateEnum
CREATE TYPE "SupplierType" AS ENUM ('LOCAL', 'INTERNATIONAL');

-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SubscriptionState" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MarketplaceVisibility" AS ENUM ('HIDDEN', 'STANDARD', 'FEATURED');

-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "supplierId" TEXT;

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyName" VARCHAR(200) NOT NULL,
    "type" "SupplierType" NOT NULL,
    "description" TEXT NOT NULL,
    "contactName" VARCHAR(100) NOT NULL,
    "businessEmail" VARCHAR(254) NOT NULL,
    "businessPhone" VARCHAR(40) NOT NULL,
    "address" VARCHAR(2000) NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "country" VARCHAR(100) NOT NULL,
    "registrationNumber" VARCHAR(150),
    "website" TEXT,
    "logoUrl" TEXT,
    "documents" JSONB NOT NULL,
    "status" "SupplierStatus" NOT NULL DEFAULT 'PENDING',
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "marketplaceVisible" BOOLEAN NOT NULL DEFAULT false,
    "reviewNote" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "eligibleTypes" "SupplierType"[],
    "durationDays" INTEGER NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "listingLimit" INTEGER NOT NULL,
    "imageLimit" INTEGER NOT NULL,
    "specificationLimit" INTEGER NOT NULL,
    "canPublishMachinery" BOOLEAN NOT NULL,
    "visibility" "MarketplaceVisibility" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_subscriptions" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "state" "SubscriptionState" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "planName" VARCHAR(100) NOT NULL,
    "supplierType" "SupplierType" NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "listingLimit" INTEGER NOT NULL,
    "imageLimit" INTEGER NOT NULL,
    "specificationLimit" INTEGER NOT NULL,
    "canPublishMachinery" BOOLEAN NOT NULL,
    "visibility" "MarketplaceVisibility" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_userId_key" ON "suppliers"("userId");

-- CreateIndex
CREATE INDEX "suppliers_status_marketplaceVisible_idx" ON "suppliers"("status", "marketplaceVisible");

-- CreateIndex
CREATE INDEX "supplier_subscriptions_supplierId_isCurrent_state_startsAt__idx" ON "supplier_subscriptions"("supplierId", "isCurrent", "state", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "machines_supplierId_status_idx" ON "machines"("supplierId", "status");

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_subscriptions" ADD CONSTRAINT "supplier_subscriptions_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_subscriptions" ADD CONSTRAINT "supplier_subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One current term per supplier; previous terms remain available to owner/admin.
CREATE UNIQUE INDEX "one_current_supplier_subscription" ON "supplier_subscriptions" ("supplierId") WHERE "isCurrent" = true;
ALTER TABLE "supplier_subscriptions" ADD CONSTRAINT "subscription_dates_valid" CHECK ("endsAt" > "startsAt");
ALTER TABLE "subscription_plans" ADD CONSTRAINT "plan_limits_valid" CHECK ("durationDays" > 0 AND "price" >= 0 AND "listingLimit" > 0 AND "imageLimit" >= 0 AND "imageLimit" <= 20 AND "specificationLimit" >= 0 AND "specificationLimit" <= 100);
