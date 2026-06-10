-- E6 / M3.8a: Custom Docker Image Registry schema.
--
-- Adds:
--   - User.maxRegistryGb     (per-buyer storage quota, default 5 GB)
--   - DockerImage            (one row per pushed (userId, repository, tag))
--   - ImageScan              (Trivy result history, one row per scan)
--   - ImageScanStatus enum   (PENDING / RUNNING / COMPLETED / FAILED)
--
-- All additive: no existing rows touched, no downtime needed.

-- AlterTable: per-buyer storage quota
ALTER TABLE "User" ADD COLUMN "maxRegistryGb" INTEGER NOT NULL DEFAULT 5;

-- CreateEnum: scan lifecycle
CREATE TYPE "ImageScanStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable: DockerImage
CREATE TABLE "DockerImage" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "repository"      TEXT NOT NULL,
    "tag"             TEXT NOT NULL,
    "digest"          TEXT NOT NULL,
    "sizeBytes"       BIGINT NOT NULL DEFAULT 0,
    "pushedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt"       TIMESTAMP(3),
    "pullBlocked"     BOOLEAN NOT NULL DEFAULT false,
    "pullBlockReason" TEXT,

    CONSTRAINT "DockerImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ImageScan
CREATE TABLE "ImageScan" (
    "id"             TEXT NOT NULL,
    "imageId"        TEXT NOT NULL,
    "status"         "ImageScanStatus" NOT NULL DEFAULT 'PENDING',
    "criticalCount"  INTEGER NOT NULL DEFAULT 0,
    "highCount"      INTEGER NOT NULL DEFAULT 0,
    "mediumCount"    INTEGER NOT NULL DEFAULT 0,
    "lowCount"       INTEGER NOT NULL DEFAULT 0,
    "unknownCount"   INTEGER NOT NULL DEFAULT 0,
    "resultJson"     JSONB,
    "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"    TIMESTAMP(3),
    "errorMessage"   TEXT,

    CONSTRAINT "ImageScan_pkey" PRIMARY KEY ("id")
);

-- Indexes on DockerImage
CREATE UNIQUE INDEX "DockerImage_userId_repository_tag_key"
    ON "DockerImage"("userId", "repository", "tag");
CREATE INDEX "DockerImage_userId_idx"   ON "DockerImage"("userId");
CREATE INDEX "DockerImage_digest_idx"   ON "DockerImage"("digest");
CREATE INDEX "DockerImage_pushedAt_idx" ON "DockerImage"("pushedAt");

-- Indexes on ImageScan
CREATE INDEX "ImageScan_imageId_idx"   ON "ImageScan"("imageId");
CREATE INDEX "ImageScan_status_idx"    ON "ImageScan"("status");
CREATE INDEX "ImageScan_startedAt_idx" ON "ImageScan"("startedAt");

-- Foreign keys
ALTER TABLE "DockerImage"
    ADD CONSTRAINT "DockerImage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ImageScan"
    ADD CONSTRAINT "ImageScan_imageId_fkey"
    FOREIGN KEY ("imageId") REFERENCES "DockerImage"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
