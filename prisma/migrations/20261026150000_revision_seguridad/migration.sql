-- DropIndex
DROP INDEX "correos_sha256_key";

-- AlterTable
ALTER TABLE "documentos" ADD COLUMN     "aviso_tacito_en" TIMESTAMPTZ(6),
ADD COLUMN     "errores_revision" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "correos_sha256_destinatario_key" ON "correos"("sha256", "destinatario");

