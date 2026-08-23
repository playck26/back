-- SPEC-013:TASK-001 — identidade do professor.
--
-- Expand puro: um valor de enum e uma coluna nula. Sem backfill e sem
-- contract, porque nao existe dado antigo a converter — nenhum professor
-- tem conta hoje, e nulo e um estado final legitimo, nao transitorio.
--
-- RESTRICAO DO POSTGRES QUE GOVERNA ESTE ARQUIVO: `ALTER TYPE ... ADD VALUE`
-- cria o valor, mas ele nao pode ser **usado** antes do commit da transacao
-- que o criou — e o Prisma roda cada migration dentro de uma transacao.
-- Por isso nenhuma instrucao abaixo referencia 'professor' como valor.
-- Um `UPDATE ... SET role = 'professor'` aqui falharia; ele pertence ao
-- codigo da aplicacao, depois desta migration ter commitado.

-- =========================================================================
-- PASSO 1 — o papel
-- =========================================================================

-- Sem BEFORE/AFTER: anexa ao fim da ordem do enum, que e como o
-- `schema.prisma` declara. Inserir no meio exigiria reescrever a ordem
-- declarada e produziria drift a cada `prisma migrate diff`.
ALTER TYPE "usuario_role" ADD VALUE IF NOT EXISTS 'professor';

-- =========================================================================
-- PASSO 2 — o vinculo
-- =========================================================================

ALTER TABLE "professores" ADD COLUMN "usuario_id" UUID;

-- INV-014: uma conta serve no maximo um professor. UNIQUE em coluna
-- anulavel e exatamente o que se quer aqui — o Postgres nao considera dois
-- NULLs iguais, entao qualquer numero de professores sem conta convive.
CREATE UNIQUE INDEX "professores_usuario_id_key" ON "professores"("usuario_id");

-- SET NULL, e nao CASCADE: apagar a conta nao pode apagar a ficha do
-- professor, com o historico de turmas atras dela. Perde-se o acesso, nao
-- o cadastro.
ALTER TABLE "professores" ADD CONSTRAINT "professores_usuario_id_fkey"
  FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
