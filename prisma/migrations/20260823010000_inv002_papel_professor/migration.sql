-- SPEC-013 — corrige INV-002 para o papel novo.
--
-- A migration anterior (20260823000000) acrescentou 'professor' ao enum e
-- parou ali. Faltou este arquivo, e o defeito foi para producao: criar o
-- acesso de um professor devolvia 500, porque o CHECK de INV-002 — escrito
-- a mao em 2026-08-09 — lista os papeis que **podem** ter company_id, e
-- 'professor' nao estava nela.
--
-- POR QUE NADA PEGOU ISSO ANTES DE PRODUCAO: constraint escrita a mao nao
-- aparece no `schema.prisma`, entao o Prisma Client nao a conhece e o
-- TypeScript nao a ve; e toda a suite (223 unit + 58 e2e) roda com Prisma
-- **mockado**, justamente para nao depender do Neon. O dry-run provou a
-- constraint que esta spec **adicionou** (INV-014) e nao tocou na que ela
-- **quebrou**. Adicionar papel exige revisar todo CHECK que enumere papeis.
--
-- Expand-contract num arquivo so e seguro aqui: nao ha linha existente que
-- passe a violar (o CHECK novo e mais permissivo que o antigo).

ALTER TABLE "usuarios" DROP CONSTRAINT "usuarios_company_id_role_check";

-- `professor` entra junto de company_admin/aluno: e sempre de uma empresa.
-- Um professor sem `company_id` nao existe — nao ha professor da
-- plataforma, so professor de um clube.
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_company_id_role_check" CHECK (
    ("role" = 'super_admin' AND "company_id" IS NULL)
    OR ("role" IN ('company_admin', 'aluno', 'professor') AND "company_id" IS NOT NULL)
);
