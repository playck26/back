-- SPEC-009:TASK-000 — Onboarding de conta do aluno.
--
-- Escrita à mão em três passos (expand -> backfill -> contract), conforme
-- ACHADO-011 da 1ª validação cruzada. O diff automático do Prisma gerava
-- `ALTER TABLE empresas ADD COLUMN slug TEXT NOT NULL`, que falha em
-- tabela com linha existente. O procedimento abaixo funciona com 1 empresa
-- (estado de hoje) e com 20.

-- =========================================================================
-- PASSO 1 — EXPAND: tudo nullable ou com default, nada quebra o código atual
-- =========================================================================

CREATE TYPE "vinculo_aluno" AS ENUM ('pendente', 'aprovado', 'recusado');

-- Default `pendente` é fail-closed de propósito: se um caminho de criação
-- novo esquecer de definir o vínculo, a conta nasce restrita (INV-010),
-- nunca liberada. Os caminhos em que a iniciativa é da empresa (convite e
-- cadastro pelo admin) definem `aprovado` explicitamente.
ALTER TABLE "alunos" ADD COLUMN "vinculo" "vinculo_aluno" NOT NULL DEFAULT 'pendente';

ALTER TABLE "usuarios"
  ADD COLUMN "senha_temporaria" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "senha_temporaria_expira_em" TIMESTAMP(3);

ALTER TABLE "empresas"
  ADD COLUMN "permite_auto_cadastro" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "slug" TEXT;

-- =========================================================================
-- PASSO 2 — BACKFILL: dado existente ganha valor coerente com o passado
-- =========================================================================

-- Quem já é aluno hoje foi cadastrado pelo admin, então já era aprovado de
-- fato. Sem este UPDATE, o default `pendente` bloquearia alunos em operação.
UPDATE "alunos" SET "vinculo" = 'aprovado' WHERE "vinculo" = 'pendente';

-- Slug a partir do nome: minúsculas, sem acento, não-alfanumérico vira '-'.
UPDATE "empresas"
SET "slug" = trim(both '-' from regexp_replace(
  lower(translate(
    "nome",
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'
  )),
  '[^a-z0-9]+', '-', 'g'
))
WHERE "slug" IS NULL;

-- Nome só com símbolos/acentos degeneraria em string vazia.
UPDATE "empresas"
SET "slug" = 'empresa-' || substr("id"::text, 1, 8)
WHERE "slug" IS NULL OR "slug" = '';

-- Desempate determinístico: dois nomes distintos podem gerar o mesmo slug
-- ("Tênis Clube" e "Tenis Clube"). Todos os colididos recebem sufixo, para
-- que nenhum dependa de ordem de linha.
UPDATE "empresas" e
SET "slug" = e."slug" || '-' || substr(e."id"::text, 1, 8)
WHERE EXISTS (
  SELECT 1 FROM "empresas" o WHERE o."slug" = e."slug" AND o."id" <> e."id"
);

-- =========================================================================
-- PASSO 3 — CONTRACT: só agora as garantias entram
-- =========================================================================

ALTER TABLE "empresas" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX "empresas_slug_key" ON "empresas"("slug");

-- =========================================================================
-- Tabela de convites (SPEC-009/REQ-002)
-- =========================================================================
--
-- `token_hash` é sha256 determinístico do token de 32 bytes, NUNCA bcrypt:
-- o token é a chave de busca da claim atômica de INV-009
-- (`UPDATE ... WHERE token_hash = ? AND usado_em IS NULL`), e bcrypt tem
-- salt por hash, então a busca por igualdade nunca casaria. O índice único
-- abaixo é parte da garantia, não otimização.

CREATE TABLE "convites_aluno" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "criado_por_id" UUID NOT NULL,
    "email" TEXT,
    "nome" TEXT,
    "telefone" TEXT,
    "nivel_id" UUID,
    "token_hash" TEXT NOT NULL,
    "expira_em" TIMESTAMP(3) NOT NULL,
    "usado_em" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "convites_aluno_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "convites_aluno_token_hash_key" ON "convites_aluno"("token_hash");
CREATE INDEX "convites_aluno_company_id_idx" ON "convites_aluno"("company_id");

ALTER TABLE "convites_aluno" ADD CONSTRAINT "convites_aluno_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "convites_aluno" ADD CONSTRAINT "convites_aluno_criado_por_id_fkey"
  FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "convites_aluno" ADD CONSTRAINT "convites_aluno_nivel_id_fkey"
  FOREIGN KEY ("nivel_id") REFERENCES "niveis"("id") ON DELETE SET NULL ON UPDATE CASCADE;
