-- AlterTable
ALTER TABLE "contribuyentes" ADD COLUMN     "sincronizar_rcv" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "rcv_resumenes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contribuyente_id" UUID NOT NULL,
    "periodo" TEXT NOT NULL,
    "operacion" "Operacion" NOT NULL,
    "estado_rcv" TEXT NOT NULL,
    "tipo_dte" INTEGER NOT NULL,
    "nombre_tipo_doc" TEXT NOT NULL,
    "tipo_ingreso" TEXT NOT NULL,
    "tiene_detalle" BOOLEAN NOT NULL,
    "total_documentos" INTEGER NOT NULL,
    "monto_exento" BIGINT NOT NULL,
    "monto_neto" BIGINT NOT NULL,
    "monto_iva" BIGINT NOT NULL,
    "monto_iva_no_recuperable" BIGINT NOT NULL,
    "iva_uso_comun" BIGINT NOT NULL,
    "monto_total" BIGINT NOT NULL,
    "sincronizado_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rcv_resumenes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sincronizaciones_rcv" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contribuyente_id" UUID NOT NULL,
    "periodo" TEXT NOT NULL,
    "estado" TEXT NOT NULL,
    "documentos" INTEGER NOT NULL DEFAULT 0,
    "nuevos" INTEGER NOT NULL DEFAULT 0,
    "actualizados" INTEGER NOT NULL DEFAULT 0,
    "problemas" JSONB,
    "error" TEXT,
    "iniciada_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminada_en" TIMESTAMPTZ(6),

    CONSTRAINT "sincronizaciones_rcv_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rcv_resumenes_contribuyente_id_periodo_operacion_estado_rcv_key" ON "rcv_resumenes"("contribuyente_id", "periodo", "operacion", "estado_rcv", "tipo_dte");

-- CreateIndex
CREATE INDEX "sincronizaciones_rcv_contribuyente_id_periodo_iniciada_en_idx" ON "sincronizaciones_rcv"("contribuyente_id", "periodo", "iniciada_en");

-- AddForeignKey
ALTER TABLE "rcv_resumenes" ADD CONSTRAINT "rcv_resumenes_contribuyente_id_fkey" FOREIGN KEY ("contribuyente_id") REFERENCES "contribuyentes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sincronizaciones_rcv" ADD CONSTRAINT "sincronizaciones_rcv_contribuyente_id_fkey" FOREIGN KEY ("contribuyente_id") REFERENCES "contribuyentes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

