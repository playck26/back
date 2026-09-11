-- SPEC-035/TASK-001 — os valores de acao novos, e a METADE QUE FALTAVA da
-- INV-064.
--
-- ## Por que esta migration abre transacao a mao
--
-- Mesma razao da 20260904140000_spec034_enums, e o comentario dela vale
-- inteiro: o Prisma Migrate **nao** envolve migration do PostgreSQL em
-- transacao. Sem `BEGIN`, cinco statements independentes -- e se o quarto
-- falhar, os tres primeiros ficam aplicados sem volta.
--
-- E os valores de enum NAO SAO USADOS aqui, o que e exigencia do Postgres:
-- `ALTER TYPE ... ADD VALUE` cria o rotulo, mas ele nao pode ser referenciado
-- antes do COMMIT da transacao que o criou. Quem os usa e o codigo da
-- TASK-002 e da TASK-003.
BEGIN;

-- =========================================================================
-- 1. As tres acoes novas (SPEC-035/D7)
-- =========================================================================
--
-- Anexados no FIM do enum, pela regra que o `movida` ja pagou: `ALTER TYPE
-- ADD VALUE` sem `BEFORE`/`AFTER` anexa ao final, e declarar no
-- `schema.prisma` em outra posicao criaria drift permanente.
--
-- **Reusar `turma_horario_editado` para a inativacao foi considerado e
-- recusado** (D7): a acao e o que o gestor FEZ, e um extrato de auditoria que
-- dissesse "horario editado" quando ele desligou a turma mentiria para quem
-- investigasse uma quadra bloqueada.
ALTER TYPE "tipo_de_acao" ADD VALUE IF NOT EXISTS 'turma_inativada';
ALTER TYPE "tipo_de_acao" ADD VALUE IF NOT EXISTS 'turma_reativada';
ALTER TYPE "tipo_de_acao" ADD VALUE IF NOT EXISTS 'aula_reativada';

-- =========================================================================
-- 2. INV-106 — DESCANCELAR EXIGE EVENTO DESTA TRANSACAO
-- =========================================================================
--
-- ## A invariante que estava pela metade, e por que so agora
--
-- A `cancelamento_exige_evento` (SPEC-032/INV-064) guarda **so** a transicao
-- PARA `cancelado`. Descancelar nunca exigiu evento nenhum -- e ate hoje isso
-- estava certo, porque **nao existia caminho que descancelasse**. A SPEC-035
-- cria o primeiro (AC-011).
--
-- Sem esta metade, a linha do tempo de uma ocupacao mostraria um cancelamento
-- sem a reativacao correspondente: a agenda responderia "cancelada por
-- Fulano em tal dia" sobre uma aula que esta no ar. **A INV-064 nao estava
-- errada -- estava incompleta**, e quem completa e quem cria o caminho.
--
-- ## O corpo e o molde LITERAL da irma
--
-- Mesmas tres decisoes, pelas mesmas razoes:
--
-- - `DEFERRABLE INITIALLY DEFERRED`: o evento aponta para a ocupacao, entao a
--   ordem natural de escrita e ocupacao primeiro. So o COMMIT julga.
-- - a guarda `OLD = 'cancelado'` limita a exigencia a TRANSICAO: sem ela,
--   qualquer `UPDATE` de outra coluna numa ocupacao viva exigiria uma
--   reativacao que nunca houve.
-- - `ERRCODE = '23514'`: o mesmo SQLSTATE da irma, porque e a mesma classe de
--   violacao -- e `sqlstate-por-invariante.py` confere isso.
CREATE FUNCTION "reativacao_exige_evento"() RETURNS trigger AS $$
BEGIN
  IF NEW."status_pagamento" <> 'cancelado'
     AND OLD."status_pagamento" = 'cancelado' THEN
    IF NEW."transicao_id" IS NULL THEN
      RAISE EXCEPTION
        'ocupacao % reativada sem transicao_id (SPEC-035/INV-106)', NEW."id"
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "eventos_de_ocupacao" e
       WHERE e."ocupacao_id" = NEW."id"
         AND e."tipo" = 'reativada'
         AND e."transicao_id" = NEW."transicao_id"
    ) THEN
      RAISE EXCEPTION
        'ocupacao % reativada sem evento desta transicao (SPEC-035/INV-106)', NEW."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ocupacao_reativada_exige_evento"
  AFTER UPDATE ON "ocupacoes_quadra"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "reativacao_exige_evento"();

COMMIT;
