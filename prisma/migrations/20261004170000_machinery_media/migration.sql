CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO', 'MODEL_3D', 'VIEW_360');
CREATE TYPE "MediaState" AS ENUM ('ACTIVE', 'DELETING');
CREATE TABLE "machine_media" (
 "id" TEXT PRIMARY KEY, "machineId" TEXT NOT NULL,
 "type" "MediaType" NOT NULL, "state" "MediaState" NOT NULL DEFAULT 'ACTIVE',
 "title" VARCHAR(150) NOT NULL, "storageKey" TEXT NOT NULL,
 "fileName" VARCHAR(250) NOT NULL, "fileType" VARCHAR(100) NOT NULL,
 "fileSize" INTEGER NOT NULL, "sha256" VARCHAR(64) NOT NULL,
 "position" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "machine_media_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "machine_media_size" CHECK ("fileSize" > 0 AND "fileSize" <= 26214400),
 CONSTRAINT "machine_media_hash" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
 CONSTRAINT "machine_media_position" CHECK ("position" >= 0),
 CONSTRAINT "machine_media_supported" CHECK (("type" = 'MODEL_3D' AND "fileType" = 'model/gltf-binary') OR ("type" = 'VIEW_360' AND "fileType" IN ('image/png','image/jpeg') AND "fileSize" <= 10485760)),
 CONSTRAINT "machine_media_key" CHECK ("storageKey" ~ '^machinery/[0-9a-f-]{36}/[0-9a-f-]{36}\.(glb|png|jpg)$')
);
CREATE UNIQUE INDEX "machine_media_storageKey_key" ON "machine_media"("storageKey");
CREATE INDEX "machine_media_machineId_state_position_id_idx" ON "machine_media"("machineId", "state", "position", "id");
