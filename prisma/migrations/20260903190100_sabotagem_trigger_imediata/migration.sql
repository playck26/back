-- SABOTAGEM (SPEC-043, sabotagem 2) -- NAO MERGEAR. Tira o DEFERRABLE da trigger
-- da INV-064: a ordem de escrita passa a importar, e o cancelamento em
-- transacao (ocupacao antes do evento) tem de virar 500 no cenario (d).
DROP TRIGGER "ocupacao_cancelada_exige_evento" ON "ocupacoes_quadra";
CREATE CONSTRAINT TRIGGER "ocupacao_cancelada_exige_evento"
  AFTER UPDATE ON "ocupacoes_quadra"
  NOT DEFERRABLE
  FOR EACH ROW EXECUTE FUNCTION "cancelamento_exige_evento"();
