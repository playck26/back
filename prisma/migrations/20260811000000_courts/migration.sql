-- CreateEnum
CREATE TYPE "quadra_status" AS ENUM ('ativa', 'inativa');

-- CreateEnum
CREATE TYPE "origem_tipo" AS ENUM ('TURMA', 'AVULSO');

-- CreateEnum
CREATE TYPE "status_pagamento" AS ENUM ('pendente_pagamento', 'pago', 'cancelado');

-- CreateTable
CREATE TABLE "quadras" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "esporte" TEXT NOT NULL,
    "preco_hora" DECIMAL(10,2) NOT NULL,
    "status" "quadra_status" NOT NULL DEFAULT 'ativa',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quadras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocupacoes_quadra" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "quadra_id" UUID NOT NULL,
    "data" DATE NOT NULL,
    "hora_inicio" TIME NOT NULL,
    "hora_fim" TIME NOT NULL,
    "origem_tipo" "origem_tipo" NOT NULL,
    "origem_turma_id" UUID,
    "aluno_id" UUID,
    "status_pagamento" "status_pagamento" NOT NULL DEFAULT 'pendente_pagamento',
    "client_request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ocupacoes_quadra_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quadras_company_id_idx" ON "quadras"("company_id");

-- CreateIndex
CREATE INDEX "ocupacoes_quadra_company_id_quadra_id_data_idx" ON "ocupacoes_quadra"("company_id", "quadra_id", "data");

-- AddForeignKey
ALTER TABLE "quadras" ADD CONSTRAINT "quadras_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocupacoes_quadra" ADD CONSTRAINT "ocupacoes_quadra_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocupacoes_quadra" ADD CONSTRAINT "ocupacoes_quadra_quadra_id_fkey" FOREIGN KEY ("quadra_id") REFERENCES "quadras"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocupacoes_quadra" ADD CONSTRAINT "ocupacoes_quadra_aluno_id_fkey" FOREIGN KEY ("aluno_id") REFERENCES "alunos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- INV-001 (DATA_MODEL.md, ADR-009): a prova física de "sem overbooking de
-- quadra" — não expressável no schema.prisma, escrita manualmente.
-- Requer a extensão btree_gist (já habilitada na migration inicial de
-- SPEC-001). Zero overbooking sob concorrência é garantido pelo Postgres
-- rejeitando a segunda escrita, não por uma checagem SELECT+INSERT da
-- aplicação (que teria race condition).
ALTER TABLE "ocupacoes_quadra"
  ADD CONSTRAINT "no_overlap_por_quadra"
  EXCLUDE USING gist (
    "quadra_id" WITH =,
    tsrange("data" + "hora_inicio", "data" + "hora_fim") WITH &&
  )
  WHERE ("status_pagamento" <> 'cancelado');

-- Idempotência de criação via API (AC-004, SPEC-004; CON-005.4) — reenviar
-- o mesmo Idempotency-Key/client_request_id não pode duplicar a reserva.
-- Único parcial porque client_request_id é opcional (ocupações de TURMA
-- nunca o preenchem).
CREATE UNIQUE INDEX "ux_ocupacoes_quadra_client_request_id"
  ON "ocupacoes_quadra" ("company_id", "client_request_id")
  WHERE "client_request_id" IS NOT NULL;

