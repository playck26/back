-- SPEC-011:TASK-000 — valor da reserva e pedido de reserva.
--
-- Três passos (expand → backfill → contract). O CHECK entra por último, de
-- propósito: aplicá-lo antes do backfill recusaria as linhas existentes,
-- que ainda não têm valor.

-- =========================================================================
-- PASSO 1 — EXPAND
-- =========================================================================

CREATE TABLE "pedidos_reserva" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "client_request_id" TEXT NOT NULL,
    -- sha256 do payload normalizado. É o que distingue um retry legítimo
    -- de um pedido diferente reusando a mesma chave — sem ele, reenviar a
    -- mesma chave com outra seleção de horários criaria reservas em
    -- silêncio (achado 001 da validação cruzada).
    "fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pedidos_reserva_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pedidos_reserva_company_id_idx" ON "pedidos_reserva"("company_id");
CREATE UNIQUE INDEX "pedidos_reserva_company_id_client_request_id_key"
  ON "pedidos_reserva"("company_id", "client_request_id");

ALTER TABLE "pedidos_reserva" ADD CONSTRAINT "pedidos_reserva_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ocupacoes_quadra"
  ADD COLUMN "valor" DECIMAL(10,2),
  ADD COLUMN "pedido_id" UUID;

ALTER TABLE "ocupacoes_quadra" ADD CONSTRAINT "ocupacoes_quadra_pedido_id_fkey"
  FOREIGN KEY ("pedido_id") REFERENCES "pedidos_reserva"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =========================================================================
-- PASSO 2 — BACKFILL (só as avulsas)
-- =========================================================================
--
-- Aproximação consciente: usa o preço **atual** da quadra. Se ele mudou
-- desde a reserva, este número não é o que foi cobrado na época — e o
-- histórico real não existe para ser recuperado. Registrado em
-- DATA_MODEL.md e SECURITY_PRIVACY.md: `valor` serve para operação, não
-- para auditoria financeira do passado.

UPDATE "ocupacoes_quadra" o
SET "valor" = ROUND(
  q."preco_hora" * (EXTRACT(EPOCH FROM (o."hora_fim" - o."hora_inicio")) / 3600.0),
  2
)
FROM "quadras" q
WHERE q."id" = o."quadra_id"
  AND o."origem_tipo" = 'AVULSO';

-- =========================================================================
-- PASSO 3 — CONTRACT
-- =========================================================================
--
-- `valor` obrigatório **só** para AVULSO. Ocupação de origem TURMA é
-- gerada por `registerClassOccupancy` e não tem cobrança própria (CON-006
-- cobre reserva avulsa) — um NOT NULL global faria a criação de turma
-- passar a falhar no dia seguinte a esta migration.

ALTER TABLE "ocupacoes_quadra" ADD CONSTRAINT "ocupacoes_valor_por_origem"
  CHECK (
    ("origem_tipo" = 'AVULSO' AND "valor" IS NOT NULL AND "valor" >= 0)
    OR
    ("origem_tipo" = 'TURMA' AND "valor" IS NULL)
  );
