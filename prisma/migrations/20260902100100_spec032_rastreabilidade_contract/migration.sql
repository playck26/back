-- SPEC-032:TASK-001, fase CONTRACT — a trigger que MUDA comportamento.
--
-- **APLICAR SO DEPOIS que o codigo que grava eventos estiver no ar.**
--
-- Esta e a unica parte da SPEC-032 que altera comportamento existente: a
-- partir daqui, cancelar uma ocupacao sem registrar o evento e recusado pelo
-- banco. Aplicada antes do codigo, ela quebra todo cancelamento de cliente
-- durante a janela de deploy — ver o cabecalho da fase `expand`.
--
-- O CI ja demonstrou o cenario tres vezes, em fixtures: `sem transicao_id`,
-- `evento de outra transicao`, e `em autocommit`. As tres seriam, em
-- producao, um cancelamento quebrado.

-- =========================================================================
-- 6. CANCELAR EXIGE EVENTO DESTA TRANSICAO (INV-064)
-- =========================================================================
--
-- Sem isto o registro falha na primeira rota nova que fizer
-- `update({ status_pagamento: 'cancelado' })` — e a SPEC-034 tem exatamente
-- uma dessas.
--
-- DEFERRABLE INITIALLY DEFERRED de proposito: a ordem de escrita dentro da
-- transacao deixa de importar, e so o COMMIT julga. Sem isso, gravar a
-- ocupacao antes do evento (que e a ordem natural, porque o evento aponta
-- para a ocupacao) falharia sempre.
--
-- A guarda `OLD IS DISTINCT FROM 'cancelado'` limita a exigencia a TRANSICAO:
-- sem ela, uma migration que preencha outra coluna de uma ocupacao ja
-- cancelada exigiria um cancelamento novo.
CREATE FUNCTION "cancelamento_exige_evento"() RETURNS trigger AS $$
BEGIN
  IF NEW."status_pagamento" = 'cancelado'
     AND OLD."status_pagamento" IS DISTINCT FROM 'cancelado' THEN
    IF NEW."transicao_id" IS NULL THEN
      RAISE EXCEPTION
        'ocupacao % cancelada sem transicao_id (SPEC-032/INV-064)', NEW."id"
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "eventos_de_ocupacao" e
       WHERE e."ocupacao_id" = NEW."id"
         AND e."tipo" = 'cancelada'
         AND e."transicao_id" = NEW."transicao_id"
    ) THEN
      RAISE EXCEPTION
        'ocupacao % cancelada sem evento desta transicao (SPEC-032/INV-064)', NEW."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ocupacao_cancelada_exige_evento"
  AFTER UPDATE ON "ocupacoes_quadra"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "cancelamento_exige_evento"();
