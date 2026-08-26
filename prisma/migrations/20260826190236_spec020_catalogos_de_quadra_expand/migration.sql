-- AlterTable
ALTER TABLE "quadras" ADD COLUMN     "categoria_id" UUID,
ADD COLUMN     "esporte_id" UUID;

-- CreateTable
CREATE TABLE "esportes_de_quadra" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "esportes_de_quadra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categorias_de_quadra" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categorias_de_quadra_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "esportes_de_quadra_company_id_idx" ON "esportes_de_quadra"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "esportes_de_quadra_company_id_nome_key" ON "esportes_de_quadra"("company_id", "nome");

-- CreateIndex
CREATE UNIQUE INDEX "esportes_de_quadra_company_id_id_key" ON "esportes_de_quadra"("company_id", "id");

-- CreateIndex
CREATE INDEX "categorias_de_quadra_company_id_idx" ON "categorias_de_quadra"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "categorias_de_quadra_company_id_nome_key" ON "categorias_de_quadra"("company_id", "nome");

-- CreateIndex
CREATE UNIQUE INDEX "categorias_de_quadra_company_id_id_key" ON "categorias_de_quadra"("company_id", "id");

-- AddForeignKey
ALTER TABLE "esportes_de_quadra" ADD CONSTRAINT "esportes_de_quadra_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categorias_de_quadra" ADD CONSTRAINT "categorias_de_quadra_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quadras" ADD CONSTRAINT "quadras_esporte_fkey" FOREIGN KEY ("company_id", "esporte_id") REFERENCES "esportes_de_quadra"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quadras" ADD CONSTRAINT "quadras_categoria_fkey" FOREIGN KEY ("company_id", "categoria_id") REFERENCES "categorias_de_quadra"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- SPEC-020/TASK-001 — BACKFILL
--
-- Semeia `esportes_de_quadra` com a UNIAO das duas listas de esporte que
-- existiam e nunca se falavam, e aponta as quadras para a opcao certa.
--
--   `empresas.esportes`  String[]  escrito pelo super_admin ao criar a
--                                  empresa; lido pela lista do SAdmin
--   `quadras.esporte`    String    escrito pelo company_admin por quadra;
--                                  e o que alimenta o filtro do app do aluno
--
-- Uniao, e nao "a das quadras": um clube que declarou "tenis, padel" e so tem
-- quadra de tenis nao pode perder o padel na migration. Ele vira opcao sem
-- quadra, e a AC-008 cuida de nao mostra-lo como filtro vazio ao aluno.
--
-- DEDUP E POR `lower(nome)`, e a escolha do nome exibido tem regra:
-- "Tenis" e "tenis" viram UMA opcao — e o problema que esta spec existe para
-- resolver e exatamente esse. Entre as grafias, ganha a de `empresas.esportes`
-- (prioridade 0), porque foi declarada de proposito por uma pessoa, enquanto a
-- da quadra foi digitada de novo a cada cadastro.
-- ============================================================================

WITH fontes AS (
  SELECT e.id AS company_id, btrim(x) AS nome, 0 AS prioridade
  FROM empresas e, unnest(e.esportes) AS x
  WHERE btrim(x) <> ''

  UNION ALL

  SELECT q.company_id, btrim(q.esporte) AS nome, 1 AS prioridade
  FROM quadras q
  WHERE btrim(q.esporte) <> ''
),
escolhidos AS (
  SELECT DISTINCT ON (company_id, lower(nome)) company_id, nome
  FROM fontes
  ORDER BY company_id, lower(nome), prioridade, nome
)
INSERT INTO esportes_de_quadra (id, company_id, nome, ordem, created_at)
SELECT
  gen_random_uuid(),
  company_id,
  nome,
  (row_number() OVER (PARTITION BY company_id ORDER BY nome))::int - 1,
  now()
FROM escolhidos;

-- Aponta cada quadra para a opcao da PROPRIA empresa. O `lower()` fecha o
-- ciclo do dedup: a quadra escrita "Tenis" acha a opcao "tenis".
UPDATE quadras q
SET esporte_id = e.id
FROM esportes_de_quadra e
WHERE e.company_id = q.company_id
  AND lower(e.nome) = lower(btrim(q.esporte));

-- ============================================================================
-- A PROVA, DENTRO DA PROPRIA MIGRATION.
--
-- A AC-010 diz "nenhuma quadra fica sem esporte", e uma migration que deixa a
-- afirmacao para um teste rodar depois ja aplicou o dano quando alguem
-- descobre. Aqui ela ABORTA: quadra com esporte preenchido e sem `esporte_id`
-- e defeito de backfill, nao de dado.
--
-- Quadra com `esporte` em branco fica de fora de proposito — nao ha nome para
-- catalogar. Ela sai como AVISO, e e a TASK-004 (NOT NULL) que vai cobrar.
-- ============================================================================

DO $$
DECLARE
  orfas integer;
  em_branco integer;
BEGIN
  SELECT count(*) INTO orfas
  FROM quadras
  WHERE btrim(esporte) <> '' AND esporte_id IS NULL;

  IF orfas > 0 THEN
    RAISE EXCEPTION
      'SPEC-020/AC-010: % quadra(s) com esporte preenchido ficaram sem esporte_id. O backfill nao fechou.', orfas;
  END IF;

  SELECT count(*) INTO em_branco
  FROM quadras
  WHERE btrim(esporte) = '';

  IF em_branco > 0 THEN
    RAISE NOTICE
      'SPEC-020: % quadra(s) com esporte em branco ficaram sem esporte_id. A TASK-004 (NOT NULL) vai cobrar.', em_branco;
  END IF;
END $$;
