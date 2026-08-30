-- SPEC-030:TASK-001 (1 de 2) — o valor `nao_houve` em `completude_chamada`.
--
-- POR QUE ESTA MIGRATION FAZ UMA COISA SO, E POR QUE HA UMA SEGUNDA:
-- `ALTER TYPE ... ADD VALUE` cria o valor, mas ele nao pode ser **usado**
-- antes do commit da transacao que o criou — e o Prisma roda cada migration
-- dentro de uma transacao. O CHECK de `esperados` precisa citar 'nao_houve'
-- como literal, entao ele **nao cabe aqui**: vive na migration seguinte,
-- `20260830100100_spec030_check_esperados_nao_houve`.
--
-- Esta e a segunda vez que esta restricao governa um arquivo neste projeto.
-- A primeira foi `20260823000000_login_professor`, quando a SPEC-013
-- acrescentou 'professor' a `usuario_role`. O comentario de la ja avisava.
--
-- AS DUAS PRECISAM SER APLICADAS JUNTAS. Sozinha, esta migration deixa o
-- banco num estado onde 'nao_houve' existe no enum e o CHECK antigo o
-- recusa em qualquer INSERT — nao ha corrupcao possivel, so escrita
-- rejeitada. O codigo que usa o valor so entra depois das duas.

-- =========================================================================
-- O valor
-- =========================================================================

-- Sem BEFORE/AFTER: anexa ao FIM da ordem do enum, que e como o
-- `schema.prisma` o declara. Inserir no meio exigiria reescrever a ordem
-- declarada e produziria drift a cada `prisma migrate diff` — a licao esta
-- escrita em `schema.prisma`, no enum `usuario_role`.
--
-- `IF NOT EXISTS` porque re-aplicar migration acontece, e falhar por isso
-- seria falhar por nada.
ALTER TYPE "completude_chamada" ADD VALUE IF NOT EXISTS 'nao_houve';
