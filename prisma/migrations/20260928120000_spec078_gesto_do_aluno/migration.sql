-- SPEC-078/D1 — a familia de aviso das acoes do ALUNO (`tipo = 'gesto_do_aluno'`).
--
-- O mesmo par da SPEC-063, da SPEC-068 e da SPEC-074: indice unico parcial MAIS
-- o CHECK de origem. Sem o CHECK o indice seria letra morta -- no PostgreSQL
-- `NULL` nao colide com `NULL` (ressalva 078-V2-04 da DoR).
--
-- So expansao: hoje nenhuma linha tem `tipo = 'gesto_do_aluno'`, entao o indice
-- nasce vazio e o `ADD CONSTRAINT` valida a tabela sem achar nada. Vai a producao
-- no merge, pelo `run_command` do App Platform, e a instancia antiga que ainda
-- atende durante a troca nao grava este tipo.
CREATE UNIQUE INDEX "notificacoes_gesto_do_aluno_por_destinatario_key"
  ON "notificacoes" ("origem_id", "destinatario_id")
  WHERE "tipo" = 'gesto_do_aluno';

ALTER TABLE "notificacoes"
  ADD CONSTRAINT "notificacoes_gesto_do_aluno_tem_origem_chk"
  CHECK ("tipo" <> 'gesto_do_aluno' OR "origem_id" IS NOT NULL);
