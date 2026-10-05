-- CreateEnum
CREATE TYPE "SupplierAssetPurpose" AS ENUM ('LOGO', 'DOCUMENT');

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "logoAssetId" TEXT;

-- CreateTable
CREATE TABLE "supplier_assets" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "supplierId" TEXT,
    "purpose" "SupplierAssetPurpose" NOT NULL,
    "state" "MediaState" NOT NULL DEFAULT 'UPLOADING',
    "storageKey" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileName" VARCHAR(250) NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_assets_storageKey_key" ON "supplier_assets"("storageKey");

-- CreateIndex
CREATE INDEX "supplier_assets_ownerId_state_createdAt_idx" ON "supplier_assets"("ownerId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "supplier_assets_supplierId_purpose_state_idx" ON "supplier_assets"("supplierId", "purpose", "state");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_logoAssetId_key" ON "suppliers"("logoAssetId");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_logoAssetId_fkey" FOREIGN KEY ("logoAssetId") REFERENCES "supplier_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_assets" ADD CONSTRAINT "supplier_assets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_assets" ADD CONSTRAINT "supplier_assets_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

