-- SPEC-076 — a compensatória da migration
-- `20260926120000_spec076_presenca_sem_autor_humano`, escrita ANTES de ser
-- necessária e guardada FORA de `prisma/migrations`.
--
-- ## Por que ela NÃO mora em `prisma/migrations`
--
-- Migration pendente É APLICADA (a lição da SPEC-069): se estivesse lá, o
-- próximo `migrate deploy` tiraria os gatilhos da D10 em produção.
--
-- ## Como se usa, no incidente — e a ORDEM é normativa (3ª rodada, R7)
--
-- 1. copiar este arquivo, byte a byte, para
--    `prisma/migrations/<timestamp>_reverte_spec076_gatilhos/migration.sql`,
--    commitar e deployar **com o binário novo ainda no ar** — ele não depende
--    dos gatilhos — e confirmar que a migration terminou;
-- 2. SÓ ENTÃO reverter o merge do Back.
--
-- Na ordem inversa, o binário antigo volta a expor o `PUT` da chamada com os
-- gatilhos no banco, e cada gravação vira `23514` → `500`.
--
-- Prova executada: `test/banco/spec-076-rollback.db-spec.ts` aplica este
-- arquivo dentro de uma transação, confere que o que o binário antigo grava
-- volta a passar, e desfaz.

DROP TRIGGER "presencas_sem_autor_humano" ON "presencas";
DROP FUNCTION "presenca_sem_autor_humano"();

DROP TRIGGER "chamadas_completa_so_automatica" ON "chamadas";
DROP FUNCTION "chamada_completa_so_automatica"();
