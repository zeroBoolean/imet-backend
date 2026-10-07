-- CreateEnum
CREATE TYPE "ActivationMethod" AS ENUM ('PAYMENT', 'ADMIN_MANUAL');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('SSLCOMMERZ');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REVIEW');

-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'PENDING';

-- AlterTable
ALTER TABLE "supplier_subscriptions" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "activatedById" TEXT,
ADD COLUMN     "activationMethod" "ActivationMethod",
ADD COLUMN     "activationReason" VARCHAR(2000),
ADD COLUMN     "planVersion" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'SSLCOMMERZ',
    "transactionId" VARCHAR(40) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "validationId" VARCHAR(100),
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "gatewayStatus" VARCHAR(40),
    "gatewayTransactionId" VARCHAR(150),
    "gatewayResponse" JSONB,
    "gatewayUrl" TEXT,
    "sessionKey" VARCHAR(200),
    "riskLevel" VARCHAR(20),
    "reviewReason" VARCHAR(300),
    "paidAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_transactionId_key" ON "payment_transactions"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_validationId_key" ON "payment_transactions"("validationId");

-- CreateIndex
CREATE INDEX "payment_transactions_userId_status_createdAt_idx" ON "payment_transactions"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "payment_transactions_subscriptionId_status_idx" ON "payment_transactions"("subscriptionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_userId_idempotencyKey_key" ON "payment_transactions"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "supplier_subscriptions" ADD CONSTRAINT "supplier_subscriptions_activatedById_fkey" FOREIGN KEY ("activatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "supplier_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

