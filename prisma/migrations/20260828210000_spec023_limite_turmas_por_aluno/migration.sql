-- SPEC-023/TASK-001 — o clube define quantas turmas um aluno pode entrar
-- por conta propria (ADR-017, item 2; decisao do Israel em 2026-08-28).
--
-- NULL = sem limite, e esse e o padrao de proposito: empresa que ja existe
-- nao muda de comportamento por causa de uma coluna nova. Um default
-- numerico seria uma regra inventada por nos entrando em vigor sem ninguem
-- pedir.
--
-- Aditiva: nenhuma coluna cai, nenhum backfill roda. O oposto do risco da
-- SPEC-019, que derrubou tres colunas em producao.
ALTER TABLE "empresas" ADD COLUMN "limite_turmas_por_aluno" INTEGER;

-- O limite so faz sentido a partir de 1. Zero significaria "ninguem entra",
-- que nao e limite, e desligar a funcionalidade — e para isso existe
-- desativar a turma. Negativo nao significa nada.
ALTER TABLE "empresas" ADD CONSTRAINT "empresas_limite_turmas_por_aluno_check"
  CHECK ("limite_turmas_por_aluno" IS NULL OR "limite_turmas_por_aluno" >= 1);
