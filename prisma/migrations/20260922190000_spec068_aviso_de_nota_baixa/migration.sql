-- SPEC-068/TASK-002 — a idempotencia do aviso de nota baixa, por CONSTRAINT.
--
-- **As duas metades sao uma coisa so**, e a migration da SPEC-063 ja escreveu
-- por que: sem o CHECK, o indice parcial e letra morta e EM SILENCIO -- no
-- PostgreSQL NULL nao colide com NULL, entao a UNIQUE aceitaria quantas linhas
-- sem origem quisessem entrar, e ninguem veria ate alguem receber o mesmo
-- aviso cinco vezes.
--
-- `origem_id` aqui e o id da AVALIACAO, que e estavel: a UNIQUE
-- (ocupacao_id, aluno_id) garante uma avaliacao por aluno e aula, para sempre.
--
-- **Isto e o que dispensa isolamento serializavel.** O mesmo aluno em dois
-- aparelhos: as duas transacoes podem ler "nao havia nota baixa", as duas
-- tentam inserir, e o banco resolve -- uma insere, a outra vira no-op pelo
-- ON CONFLICT DO NOTHING. Nenhuma precisa de retry, lock ou Serializable,
-- porque a protecao deixou de morar na leitura (SPEC-068/D3).
--
-- Consequencia nomeada e aceita: UM aviso por (avaliacao, gestor), para
-- sempre. 1 -> 5 -> 1 nao avisa de novo.
CREATE UNIQUE INDEX "notificacoes_avaliacao_por_destinatario_key"
  ON "notificacoes" ("origem_id", "destinatario_id")
  WHERE "tipo" = 'avaliacao_baixa';

ALTER TABLE "notificacoes"
  ADD CONSTRAINT "notificacoes_avaliacao_tem_origem_chk"
  CHECK ("tipo" <> 'avaliacao_baixa' OR "origem_id" IS NOT NULL);
