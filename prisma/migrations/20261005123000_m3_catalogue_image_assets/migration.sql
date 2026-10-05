-- AlterTable
ALTER TABLE "machine_images" ADD COLUMN     "assetId" TEXT;

-- CreateTable
CREATE TABLE "catalogue_image_assets" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "state" "MediaState" NOT NULL DEFAULT 'UPLOADING',
    "storageKey" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileName" VARCHAR(250) NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalogue_image_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalogue_image_assets_storageKey_key" ON "catalogue_image_assets"("storageKey");

-- CreateIndex
CREATE INDEX "catalogue_image_assets_ownerId_state_createdAt_idx" ON "catalogue_image_assets"("ownerId", "state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "machine_images_assetId_key" ON "machine_images"("assetId");

-- AddForeignKey
ALTER TABLE "machine_images" ADD CONSTRAINT "machine_images_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "catalogue_image_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue_image_assets" ADD CONSTRAINT "catalogue_image_assets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

