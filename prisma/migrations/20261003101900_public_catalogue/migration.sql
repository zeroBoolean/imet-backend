-- CreateEnum
CREATE TYPE "MachineStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "machine_categories" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,

    CONSTRAINT "machine_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machines" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(220) NOT NULL,
    "description" TEXT NOT NULL,
    "manufacturer" VARCHAR(200) NOT NULL,
    "model" VARCHAR(200) NOT NULL,
    "categoryId" TEXT NOT NULL,
    "status" "MachineStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_images" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" VARCHAR(250) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "machine_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_specifications" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "value" VARCHAR(500) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "machine_specifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "machine_categories_slug_key" ON "machine_categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "machines_slug_key" ON "machines"("slug");

-- CreateIndex
CREATE INDEX "machines_status_categoryId_name_id_idx" ON "machines"("status", "categoryId", "name", "id");

-- CreateIndex
CREATE INDEX "machine_images_machineId_position_idx" ON "machine_images"("machineId", "position");

-- CreateIndex
CREATE INDEX "machine_specifications_machineId_position_idx" ON "machine_specifications"("machineId", "position");

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "machine_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_images" ADD CONSTRAINT "machine_images_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_specifications" ADD CONSTRAINT "machine_specifications_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
