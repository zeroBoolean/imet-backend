-- CreateEnum
CREATE TYPE "TranslationLanguage" AS ENUM ('en', 'bn', 'zh');

-- CreateEnum
CREATE TYPE "TranslationField" AS ENUM ('NAME', 'DESCRIPTION', 'LABEL', 'BODY');

-- CreateEnum
CREATE TYPE "TranslationStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "content_translations" (
    "id" TEXT NOT NULL,
    "cacheKey" VARCHAR(160) NOT NULL,
    "machineId" TEXT,
    "specificationId" TEXT,
    "supplierId" TEXT,
    "reviewId" TEXT,
    "field" "TranslationField" NOT NULL,
    "sourceLanguage" "TranslationLanguage" NOT NULL,
    "targetLanguage" "TranslationLanguage" NOT NULL,
    "sourceHash" VARCHAR(64) NOT NULL,
    "translatedText" TEXT,
    "status" "TranslationStatus" NOT NULL,
    "claimId" TEXT,
    "processingUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_usage" (
    "day" DATE NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "translation_usage_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_translations_cacheKey_key" ON "content_translations"("cacheKey");

-- CreateIndex
CREATE INDEX "content_translations_machineId_field_targetLanguage_idx" ON "content_translations"("machineId", "field", "targetLanguage");

-- CreateIndex
CREATE INDEX "content_translations_specificationId_targetLanguage_idx" ON "content_translations"("specificationId", "targetLanguage");

-- CreateIndex
CREATE INDEX "content_translations_supplierId_targetLanguage_idx" ON "content_translations"("supplierId", "targetLanguage");

-- CreateIndex
CREATE INDEX "content_translations_reviewId_targetLanguage_idx" ON "content_translations"("reviewId", "targetLanguage");

-- CreateIndex
CREATE INDEX "content_translations_status_processingUntil_idx" ON "content_translations"("status", "processingUntil");

-- AddForeignKey
ALTER TABLE "content_translations" ADD CONSTRAINT "content_translations_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_translations" ADD CONSTRAINT "content_translations_specificationId_fkey" FOREIGN KEY ("specificationId") REFERENCES "machine_specifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_translations" ADD CONSTRAINT "content_translations_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_translations" ADD CONSTRAINT "content_translations_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One real resource FK and its allowed field; originals never move into this cache.
ALTER TABLE content_translations ADD CONSTRAINT translation_resource_guard CHECK (
  ("machineId" IS NOT NULL AND "specificationId" IS NULL AND "supplierId" IS NULL AND "reviewId" IS NULL AND field IN ('NAME','DESCRIPTION')) OR
  ("machineId" IS NULL AND "specificationId" IS NOT NULL AND "supplierId" IS NULL AND "reviewId" IS NULL AND field='LABEL') OR
  ("machineId" IS NULL AND "specificationId" IS NULL AND "supplierId" IS NOT NULL AND "reviewId" IS NULL AND field='DESCRIPTION') OR
  ("machineId" IS NULL AND "specificationId" IS NULL AND "supplierId" IS NULL AND "reviewId" IS NOT NULL AND field='BODY')
);
ALTER TABLE content_translations ADD CONSTRAINT translation_hash_guard CHECK ("sourceHash" ~ '^[a-f0-9]{64}$');
ALTER TABLE content_translations ADD CONSTRAINT translation_result_guard CHECK (
  (status='COMPLETED' AND "translatedText" IS NOT NULL AND length(btrim("translatedText"))>0 AND "claimId" IS NULL AND "processingUntil" IS NULL) OR
  (status='PROCESSING' AND "translatedText" IS NULL AND "claimId" IS NOT NULL AND "processingUntil" IS NOT NULL) OR
  (status='FAILED' AND "translatedText" IS NULL AND "claimId" IS NULL AND "processingUntil" IS NULL)
);
ALTER TABLE translation_usage ADD CONSTRAINT translation_usage_guard CHECK (requests>=0);
