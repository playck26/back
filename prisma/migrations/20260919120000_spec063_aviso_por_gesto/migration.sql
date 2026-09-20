-- SPEC-063/TASK-000 (card 5328, parte 2) — as duas travas do aviso por gesto.
--
-- **Esta migration não faz nada acontecer.** Nenhum gesto enfileira aviso
-- ainda; isso é a TASK-001. Ela vem antes por uma razão mecânica: o
-- `INSERT ... ON CONFLICT (origem_id, destinatario_id) WHERE tipo = 'gesto'`
-- **precisa de um índice que case exatamente com a cláusula** — sem ele o
-- Postgres devolve `42P10` e nenhum aviso é gravado.
--
-- **Binário antigo continua válido:** nenhuma coluna nova, nenhum enum tocado.
-- Quem não grava `tipo = 'gesto'` não é alcançado por nada disto — inclusive o
-- aviso de teste da SPEC-062, que usa `tipo = 'teste'`.
--
-- Rollback: `DROP INDEX` + `DROP CONSTRAINT`. Nada depende delas ainda.

-- ==========================================================================
-- INV-063b — um aviso por gesto e destinatário
-- ==========================================================================

-- O discriminador é `tipo`, e **não `origem_tipo`**: a primeira versão da spec
-- propunha `WHERE origem_tipo = 'acao'`, e `origem_tipo` NÃO é coluna desta
-- tabela — é o enum de origem da OCUPAÇÃO (`TURMA`, `AVULSO`). A spec reusava
-- um nome já ocupado, com outro sentido.
CREATE UNIQUE INDEX "notificacoes_gesto_por_destinatario_key"
  ON "notificacoes" ("origem_id", "destinatario_id")
  WHERE "tipo" = 'gesto';

-- **Sem este CHECK o índice acima seria letra morta**, e em silêncio: no
-- PostgreSQL `NULL` não colide com `NULL`, então a UNIQUE parcial aceitaria
-- quantos gestos sem origem quisessem entrar. Ninguém veria o problema até
-- alguém receber o mesmo aviso cinco vezes.
ALTER TABLE "notificacoes"
  ADD CONSTRAINT "notificacoes_gesto_tem_origem_chk"
  CHECK ("tipo" <> 'gesto' OR "origem_id" IS NOT NULL);
