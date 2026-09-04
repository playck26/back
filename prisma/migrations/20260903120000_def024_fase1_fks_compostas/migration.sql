-- DEF-024, FASE 1 — as FKs que nao carregam a empresa (4 de 14).
--
-- Ver `DEF-024-FKS-CROSS-TENANT.md` na raiz da governanca para a varredura
-- completa: 19 FKs cujo filho E pai tem `company_id` e cuja FK nao o inclui;
-- 14 sao defeito, 5 sao benignas (as de AUTORIA para `usuarios`, LIM-032f:
-- `usuarios.company_id` e NULO para `super_admin`, e FK composta impediria o
-- super admin de ser autor de qualquer coisa).
--
-- E A TERCEIRA VEZ DESTA FAMILIA:
--   SPEC-025  vazou nota de turma entre empresas (schema.prisma:1029)
--   DEF-022   fechou 3 FKs -- so as que apontavam para `quadras`
--   DEF-024   a varredura completa, que o DEF-022 nao fez
--
-- POR QUE SO QUATRO NESTA MIGRATION, e nao as 14:
--
--   * 3 delas (`chamadas -> ocupacoes`, `presencas -> ocupacoes`,
--     `presencas -> chamadas`) JA sao compostas com `origem_tipo`. Fecha-las
--     exige uma SEGUNDA FK na mesma tabela-pai, ou um UNIQUE de tres colunas
--     que nao existe. E desenho, nao substituicao -- fase 2.
--   * 7 delas sao `ON DELETE SET NULL`. Numa FK composta, `SET NULL` anula
--     TODAS as colunas da chave, inclusive `company_id`, que e `NOT NULL`:
--     apagar um nivel passaria a falhar com `23502`. A forma correta e
--     `ON DELETE SET NULL (coluna)`, que existe do PG 15 (producao roda 18.6,
--     conferido) -- **mas o Prisma nao sabe expressar isso**, e uma constraint
--     que o `schema.prisma` nao descreve e drift esperando acontecer. Fase 3,
--     com a decisao escrita antes.
--
-- As quatro daqui sao SUBSTITUICAO LIMPA: FK de uma coluna vira FK de duas,
-- a acao de delete e a MESMA, e o `schema.prisma` descreve as duas pontas.
--
-- PRE-CHEQUE JA FEITO, e este e o motivo de nao haver backfill: conferido em
-- PRODUCAO (somente leitura), **zero** linha cruzada nas 14 -- cada filho
-- comparado com o `company_id` do seu pai. Nenhuma constraint aqui nasce
-- invalida.
--
-- **Se a migration abortar, ela achou dado torto**, e a mensagem do Postgres
-- nomeia a linha. Abortar e o comportamento certo.

-- =========================================================================
-- PASSO 1 -- os alvos das FKs compostas
-- =========================================================================

-- `id` ja e PK nas duas; estes indices existem para o `REFERENCES` de duas
-- colunas ter onde se apoiar. Mesmo papel do `quadras_company_id_id_key` do
-- DEF-022 e do `ocupacoes_quadra_company_id_id_key` da SPEC-032.
CREATE UNIQUE INDEX "alunos_company_id_id_key" ON "alunos"("company_id", "id");

-- `usuarios.company_id` e NULAVEL (super_admin). Um UNIQUE sobre uma coluna
-- nulavel e legitimo -- e como `id` e PK, este indice nunca pode falhar por
-- duplicata. Ele so existe para ser alvo.
CREATE UNIQUE INDEX "usuarios_company_id_id_key" ON "usuarios"("company_id", "id");

-- Este terceiro e exigencia do PRISMA, nao do dominio: o lado definidor de uma
-- relacao 1:1 precisa de unique sobre os campos da relacao, e `alunos.usuario`
-- e 1:1. Ele e IMPLICADO pelo `alunos_usuario_id_key` que ja existe -- se
-- `usuario_id` e unico, `(company_id, usuario_id)` tambem e. Fica registrado
-- para ninguem procurar a regra de negocio que ele exprime: nao ha nenhuma.
CREATE UNIQUE INDEX "alunos_company_id_usuario_id_key" ON "alunos"("company_id", "usuario_id");

-- =========================================================================
-- PASSO 2 -- as quatro FKs
-- =========================================================================

-- 1. avaliacoes_de_aula -> alunos
--    O aluno que avaliou tem de ser da mesma empresa da avaliacao.
ALTER TABLE "avaliacoes_de_aula" DROP CONSTRAINT "avaliacoes_de_aula_aluno_fkey";
ALTER TABLE "avaliacoes_de_aula" ADD CONSTRAINT "avaliacoes_de_aula_aluno_fkey"
    FOREIGN KEY ("company_id", "aluno_id") REFERENCES "alunos"("company_id", "id")
    ON UPDATE CASCADE ON DELETE CASCADE;

-- 2. presencas -> alunos
--    E a tabela que a SPEC-031 apontou: a v3 dela dizia nascer "no molde de
--    `presencas`", e o molde tinha o buraco.
ALTER TABLE "presencas" DROP CONSTRAINT "presencas_aluno_id_fkey";
ALTER TABLE "presencas" ADD CONSTRAINT "presencas_aluno_fkey"
    FOREIGN KEY ("company_id", "aluno_id") REFERENCES "alunos"("company_id", "id")
    ON UPDATE CASCADE ON DELETE RESTRICT;

-- 3. avaliacoes_de_aula -> ocupacoes_quadra
--    O UNIQUE alvo ja existia desde a SPEC-032.
ALTER TABLE "avaliacoes_de_aula" DROP CONSTRAINT "avaliacoes_de_aula_ocupacao_fkey";
ALTER TABLE "avaliacoes_de_aula" ADD CONSTRAINT "avaliacoes_de_aula_ocupacao_fkey"
    FOREIGN KEY ("company_id", "ocupacao_id") REFERENCES "ocupacoes_quadra"("company_id", "id")
    ON UPDATE CASCADE ON DELETE CASCADE;

-- 4. alunos -> usuarios
--    IDENTIDADE, nao autoria -- e por isso a LIM-032f nao a cobre. Um
--    `super_admin` nunca e aluno, entao exigir que o usuario do aluno seja da
--    mesma empresa nao impede ninguem de existir. Sem esta FK, a ficha de um
--    aluno da empresa A podia apontar para o usuario da B, e a tela de alunos
--    mostraria nome e e-mail de outra empresa.
ALTER TABLE "alunos" DROP CONSTRAINT "alunos_usuario_id_fkey";
ALTER TABLE "alunos" ADD CONSTRAINT "alunos_usuario_fkey"
    FOREIGN KEY ("company_id", "usuario_id") REFERENCES "usuarios"("company_id", "id")
    ON UPDATE CASCADE ON DELETE CASCADE;
