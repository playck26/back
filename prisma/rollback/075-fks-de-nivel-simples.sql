-- SPEC-075 — a compensatória da migration `20260925200000_spec075_nivel_por_empresa`,
-- escrita ANTES de ser necessária e guardada FORA de `prisma/migrations`.
--
-- ## Por que ela existe
--
-- A spec dizia "a migration é reversível", e a validação da implementação
-- (achado A-06, 2026-09-26) mostrou que isso era receita, não artefato:
-- reverter o merge do Back NÃO troca as FKs de volta — o Prisma não desfaz
-- migration. Este arquivo é a segunda metade do rollback, pronta.
--
-- ## Por que ela NÃO mora em `prisma/migrations`
--
-- Migration pendente É APLICADA (a lição da SPEC-069): se estivesse lá, o
-- próximo `migrate deploy` desfaria as FKs compostas em produção.
--
-- ## O que ela faz
--
-- Devolve as três FKs ao estado anterior à SPEC-075, com os mesmos nomes e a
-- mesma definição das migrations que as criaram (`20260810000000_people`,
-- `20260812000000_classes`, `20260822000000_account_onboarding`):
-- `(nivel_id) -> niveis(id)`, `ON DELETE SET NULL ON UPDATE CASCADE`. E tira a
-- chave única `(company_id, id)` de `niveis`, que só existia como alvo delas.
-- A ordem importa: as FKs compostas dependem da chave, e saem antes dela.
--
-- **O que volta junto, e é o preço:** o banco torna a aceitar o nível de OUTRA
-- empresa (quem impede passa a ser só o serviço), e apagar um nível usado por
-- turma volta a abrir a turma a todos (`SET NULL`).
--
-- ## Como se usa, no incidente
--
-- 1. reverter o merge do Back e esperar o deploy (o Back anterior funciona com
--    as FKs compostas: ele nunca aponta para nível de outra empresa);
-- 2. SÓ ENTÃO, se as FKs também tiverem de voltar: copiar este arquivo, byte a
--    byte, para `prisma/migrations/<timestamp>_reverte_spec075_fks/migration.sql`,
--    commitar e deployar.
--
-- Prova executada: `test/banco/spec-075-rollback.db-spec.ts` aplica este arquivo
-- dentro de uma transação, confere o estado de `pg_constraint`, e desfaz.

ALTER TABLE "alunos" DROP CONSTRAINT "alunos_nivel_fkey";
ALTER TABLE "alunos" ADD CONSTRAINT "alunos_nivel_id_fkey" FOREIGN KEY ("nivel_id") REFERENCES "niveis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "turmas" DROP CONSTRAINT "turmas_nivel_fkey";
ALTER TABLE "turmas" ADD CONSTRAINT "turmas_nivel_id_fkey" FOREIGN KEY ("nivel_id") REFERENCES "niveis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "convites_aluno" DROP CONSTRAINT "convites_nivel_fkey";
ALTER TABLE "convites_aluno" ADD CONSTRAINT "convites_aluno_nivel_id_fkey" FOREIGN KEY ("nivel_id") REFERENCES "niveis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "niveis" DROP CONSTRAINT "niveis_company_id_id_key";
