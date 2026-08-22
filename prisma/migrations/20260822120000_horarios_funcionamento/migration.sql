-- SPEC-010:TASK-000 — horário de funcionamento por dia da semana.
--
-- Pré-requisito verificado no harness antes de aplicar:
-- `UNIQUE NULLS NOT DISTINCT` exige PostgreSQL 15+. O Neon deste projeto
-- roda 18.6 (`server_version_num = 180006`, verificado em 2026-08-22).

-- =========================================================================
-- PASSO 1 — EXPAND: tabela nova, nada existente muda
-- =========================================================================

CREATE TABLE "horarios_funcionamento" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    -- NULL = padrão da empresa. Quadra que segue o padrão não tem linha:
    -- a herança é ausência de registro, não cópia (SPEC-010/REQ-003).
    "quadra_id" UUID,
    -- 0 = domingo, mesma convenção de Date.getDay() em JS.
    "dia_semana" SMALLINT NOT NULL,
    "hora_inicio" TIME(0),
    "hora_fim" TIME(0),
    "fechado" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "horarios_funcionamento_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "horarios_funcionamento_company_id_idx" ON "horarios_funcionamento"("company_id");
CREATE INDEX "horarios_funcionamento_quadra_id_idx" ON "horarios_funcionamento"("quadra_id");

ALTER TABLE "horarios_funcionamento" ADD CONSTRAINT "horarios_funcionamento_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "horarios_funcionamento" ADD CONSTRAINT "horarios_funcionamento_quadra_id_fkey"
  FOREIGN KEY ("quadra_id") REFERENCES "quadras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =========================================================================
-- Constraints que o Prisma não expressa — escritas à mão, como a EXCLUDE
-- de INV-001 (SPEC-004)
-- =========================================================================

-- Sem `NULLS NOT DISTINCT`, o Postgres considera NULL distinto de NULL num
-- índice único — e o padrão da empresa é exatamente `quadra_id IS NULL`.
-- Ou seja: sem isto, dava para cadastrar dois padrões para a mesma
-- segunda-feira e o banco não reclamaria.
CREATE UNIQUE INDEX "horarios_funcionamento_escopo_dia_key"
  ON "horarios_funcionamento" ("company_id", "quadra_id", "dia_semana")
  NULLS NOT DISTINCT;

ALTER TABLE "horarios_funcionamento" ADD CONSTRAINT "horarios_dia_semana_valido"
  CHECK ("dia_semana" BETWEEN 0 AND 6);

-- Coerência entre `fechado` e as horas: ou fechado sem horas, ou aberto
-- com as duas e fim depois do início. Sem isto o banco aceita "aberto das
-- 10h às 8h" e "fechado das 9h às 18h", e a aplicação passa a ter que
-- desconfiar do próprio dado.
ALTER TABLE "horarios_funcionamento" ADD CONSTRAINT "horarios_coerencia_fechado"
  CHECK (
    ("fechado" = true  AND "hora_inicio" IS NULL AND "hora_fim" IS NULL)
    OR
    ("fechado" = false AND "hora_inicio" IS NOT NULL AND "hora_fim" IS NOT NULL
       AND "hora_fim" > "hora_inicio")
  );

-- Hora cheia (SPEC-010/REQ-008, AC-014). A regra também vive na aplicação;
-- aqui é a rede de baixo.
ALTER TABLE "horarios_funcionamento" ADD CONSTRAINT "horarios_hora_cheia"
  CHECK (
    ("hora_inicio" IS NULL OR (EXTRACT(MINUTE FROM "hora_inicio") = 0 AND EXTRACT(SECOND FROM "hora_inicio") = 0))
    AND
    ("hora_fim" IS NULL OR (EXTRACT(MINUTE FROM "hora_fim") = 0 AND EXTRACT(SECOND FROM "hora_fim") = 0))
  );

-- =========================================================================
-- PASSO 2 — BACKFILL: empresa existente mantém exatamente o comportamento
-- de hoje (REQ-007/AC-013)
-- =========================================================================
--
-- 6h–22h em todos os 7 dias é o que as constantes
-- EXPEDIENTE_INICIO_HORA/EXPEDIENTE_FIM_HORA produzem hoje. O objetivo do
-- backfill é que ninguém acorde com a agenda diferente da de ontem.

INSERT INTO "horarios_funcionamento" ("id", "company_id", "quadra_id", "dia_semana", "hora_inicio", "hora_fim", "fechado", "updated_at")
SELECT gen_random_uuid(), e."id", NULL, d."dia", TIME '06:00:00', TIME '22:00:00', false, CURRENT_TIMESTAMP
FROM "empresas" e
CROSS JOIN generate_series(0, 6) AS d("dia");
