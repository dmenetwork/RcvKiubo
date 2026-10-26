-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."Ambiente" AS ENUM ('certificacion', 'produccion');

-- CreateEnum
CREATE TYPE "public"."EstadoEntrega" AS ENUM ('pendiente', 'entregado', 'fallido');

-- CreateEnum
CREATE TYPE "public"."Operacion" AS ENUM ('COMPRA', 'VENTA');

-- CreateTable
CREATE TABLE "public"."acciones_registradas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contribuyente_id" UUID NOT NULL,
    "documento_id" UUID,
    "rut_emisor_doc" TEXT NOT NULL,
    "tipo_dte" INTEGER NOT NULL,
    "folio" INTEGER NOT NULL,
    "accion" TEXT NOT NULL,
    "codigo" INTEGER,
    "glosa" TEXT,
    "resultado" TEXT NOT NULL,
    "error" TEXT,
    "api_key_id" UUID,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acciones_registradas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consumidor_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "prefijo" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "creada_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revocada_en" TIMESTAMPTZ(6),
    "ultimo_uso_en" TIMESTAMPTZ(6),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."auditoria" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consumidor_id" UUID,
    "contribuyente_id" UUID,
    "api_key_id" UUID,
    "accion" TEXT NOT NULL,
    "detalle" JSONB,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."certificados" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contribuyente_id" UUID NOT NULL,
    "rut_titular" TEXT NOT NULL,
    "nombre_titular" TEXT NOT NULL,
    "emisor" TEXT NOT NULL,
    "valido_desde" TIMESTAMPTZ(6) NOT NULL,
    "valido_hasta" TIMESTAMPTZ(6) NOT NULL,
    "huella" TEXT NOT NULL,
    "x509" TEXT NOT NULL,
    "llave_sellada" BYTEA NOT NULL,
    "aviso_vencimiento_en" TIMESTAMPTZ(6),
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificados_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."consumidores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "webhook_url" TEXT,
    "webhook_secreto_sellado" BYTEA,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consumidores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."contribuyentes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consumidor_id" UUID NOT NULL,
    "rut" TEXT NOT NULL,
    "razon_social" TEXT,
    "ambiente" "public"."Ambiente" NOT NULL,
    "correo_intercambio" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "horas_aviso_plazo" INTEGER NOT NULL DEFAULT 48,
    "sincronizar_sii" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contribuyentes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."correos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contribuyente_id" UUID,
    "destinatario" TEXT NOT NULL,
    "remitente" TEXT,
    "asunto" TEXT,
    "message_id" TEXT,
    "sha256" TEXT NOT NULL,
    "estado" TEXT NOT NULL,
    "documentos" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "crudo" BYTEA,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."documentos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contribuyente_id" UUID NOT NULL,
    "operacion" "public"."Operacion" NOT NULL,
    "rut_contraparte" TEXT NOT NULL,
    "razon_social_contraparte" TEXT,
    "tipo_dte" INTEGER NOT NULL,
    "folio" INTEGER NOT NULL,
    "fecha_emision" DATE,
    "monto_exento" BIGINT,
    "monto_neto" BIGINT,
    "monto_iva" BIGINT,
    "monto_total" BIGINT,
    "en_xml" BOOLEAN NOT NULL DEFAULT false,
    "xml" TEXT,
    "xml_sha256" TEXT,
    "codificacion" TEXT,
    "firma_dte" TEXT,
    "verificacion" JSONB,
    "xml_recibido_en" TIMESTAMPTZ(6),
    "en_rcv" BOOLEAN NOT NULL DEFAULT false,
    "estado_rcv" TEXT,
    "periodo_rcv" TEXT,
    "datos_rcv" JSONB,
    "fecha_recepcion_sii" TIMESTAMPTZ(6),
    "plazo_vence" TIMESTAMPTZ(6),
    "evento_receptor" TEXT,
    "eventos_sii" JSONB,
    "eventos_consultados_en" TIMESTAMPTZ(6),
    "cedibilidad" TEXT,
    "estado_sii" TEXT,
    "clase_estado_sii" TEXT,
    "estado_sii_en" TIMESTAMPTZ(6),
    "proxima_revision_en" TIMESTAMPTZ(6),
    "intentos_revision" INTEGER NOT NULL DEFAULT 0,
    "error_revision" TEXT,
    "aviso_plazo_en" TIMESTAMPTZ(6),
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "documentos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."importaciones_rcv" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contribuyente_id" UUID NOT NULL,
    "operacion" "public"."Operacion" NOT NULL,
    "estado_rcv" TEXT,
    "periodo" TEXT NOT NULL,
    "nombre_archivo" TEXT,
    "sha256" TEXT NOT NULL,
    "filas" INTEGER NOT NULL,
    "nuevos" INTEGER NOT NULL,
    "actualizados" INTEGER NOT NULL,
    "problemas" JSONB NOT NULL,
    "columnas_desconocidas" JSONB NOT NULL,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "importaciones_rcv_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."latidos" (
    "id" TEXT NOT NULL,
    "ultimo_en" TIMESTAMPTZ(6) NOT NULL,
    "pendientes" INTEGER,
    "mas_antiguo" TIMESTAMPTZ(6),

    CONSTRAINT "latidos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."webhook_entregas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consumidor_id" UUID NOT NULL,
    "evento" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "estado" "public"."EstadoEntrega" NOT NULL DEFAULT 'pendiente',
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "proximo_intento_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_status" INTEGER,
    "ultimo_error" TEXT,
    "entregado_en" TIMESTAMPTZ(6),
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_entregas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "acciones_registradas_contribuyente_id_creado_en_idx" ON "public"."acciones_registradas"("contribuyente_id" ASC, "creado_en" ASC);

-- CreateIndex
CREATE INDEX "api_keys_consumidor_id_idx" ON "public"."api_keys"("consumidor_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_hash_key" ON "public"."api_keys"("hash" ASC);

-- CreateIndex
CREATE INDEX "auditoria_consumidor_id_creado_en_idx" ON "public"."auditoria"("consumidor_id" ASC, "creado_en" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "certificados_contribuyente_id_key" ON "public"."certificados"("contribuyente_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "contribuyentes_consumidor_id_rut_ambiente_key" ON "public"."contribuyentes"("consumidor_id" ASC, "rut" ASC, "ambiente" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "contribuyentes_correo_intercambio_key" ON "public"."contribuyentes"("correo_intercambio" ASC);

-- CreateIndex
CREATE INDEX "correos_contribuyente_id_creado_en_idx" ON "public"."correos"("contribuyente_id" ASC, "creado_en" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "correos_sha256_key" ON "public"."correos"("sha256" ASC);

-- CreateIndex
CREATE INDEX "documentos_contribuyente_id_operacion_fecha_emision_idx" ON "public"."documentos"("contribuyente_id" ASC, "operacion" ASC, "fecha_emision" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "documentos_contribuyente_id_operacion_rut_contraparte_tipo__key" ON "public"."documentos"("contribuyente_id" ASC, "operacion" ASC, "rut_contraparte" ASC, "tipo_dte" ASC, "folio" ASC);

-- CreateIndex
CREATE INDEX "documentos_contribuyente_id_periodo_rcv_idx" ON "public"."documentos"("contribuyente_id" ASC, "periodo_rcv" ASC);

-- CreateIndex
CREATE INDEX "documentos_plazo_vence_idx" ON "public"."documentos"("plazo_vence" ASC);

-- CreateIndex
CREATE INDEX "documentos_proxima_revision_en_idx" ON "public"."documentos"("proxima_revision_en" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "importaciones_rcv_contribuyente_id_sha256_key" ON "public"."importaciones_rcv"("contribuyente_id" ASC, "sha256" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_entregas_consumidor_id_clave_key" ON "public"."webhook_entregas"("consumidor_id" ASC, "clave" ASC);

-- CreateIndex
CREATE INDEX "webhook_entregas_estado_proximo_intento_en_idx" ON "public"."webhook_entregas"("estado" ASC, "proximo_intento_en" ASC);

-- AddForeignKey
ALTER TABLE "public"."acciones_registradas" ADD CONSTRAINT "acciones_registradas_contribuyente_id_fkey" FOREIGN KEY ("contribuyente_id") REFERENCES "public"."contribuyentes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."acciones_registradas" ADD CONSTRAINT "acciones_registradas_documento_id_fkey" FOREIGN KEY ("documento_id") REFERENCES "public"."documentos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."api_keys" ADD CONSTRAINT "api_keys_consumidor_id_fkey" FOREIGN KEY ("consumidor_id") REFERENCES "public"."consumidores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."certificados" ADD CONSTRAINT "certificados_contribuyente_id_fkey" FOREIGN KEY ("contribuyente_id") REFERENCES "public"."contribuyentes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."contribuyentes" ADD CONSTRAINT "contribuyentes_consumidor_id_fkey" FOREIGN KEY ("consumidor_id") REFERENCES "public"."consumidores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."correos" ADD CONSTRAINT "correos_contribuyente_id_fkey" FOREIGN KEY ("contribuyente_id") REFERENCES "public"."contribuyentes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."documentos" ADD CONSTRAINT "documentos_contribuyente_id_fkey" FOREIGN KEY ("contribuyente_id") REFERENCES "public"."contribuyentes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."importaciones_rcv" ADD CONSTRAINT "importaciones_rcv_contribuyente_id_fkey" FOREIGN KEY ("contribuyente_id") REFERENCES "public"."contribuyentes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."webhook_entregas" ADD CONSTRAINT "webhook_entregas_consumidor_id_fkey" FOREIGN KEY ("consumidor_id") REFERENCES "public"."consumidores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

