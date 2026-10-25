-- SPEC-089/REQ-001 — o clube escolhe se o nível restringe o acesso às turmas
-- (decisão I1 do Israel, 2026-10-25).
--
-- `true` é o padrão de propósito: toda empresa que já existe continua com a
-- regra da SPEC-075, exatamente como estava (AC-001). Desligar é um gesto
-- explícito, por empresa.
--
-- Aditiva: nenhuma coluna cai, nenhum backfill roda — o `DEFAULT` preenche as
-- linhas existentes na mesma instrução.
ALTER TABLE "empresas"
  ADD COLUMN "nivel_restringe_acesso" BOOLEAN NOT NULL DEFAULT true;
