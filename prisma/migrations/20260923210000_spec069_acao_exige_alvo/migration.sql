-- SPEC-069/TASK-005 — **o Deploy 2, e so ele.**
--
-- Esta migration instala o `acao_exige_alvo`: a INV-069a passa a ser garantia
-- do banco, e nao disciplina de quem escreve. A partir dela, **nenhuma acao
-- commita sem ao menos um efeito** — ocupacao, matricula, credito ou turma.
--
-- ## Por que ela sobe SOZINHA, num deploy proprio
--
-- Producao migra no proprio deploy (`deploy_on_push` + `db:migrate:deploy &&
-- start:prod`), entao `migrate deploy` aplica tudo o que estiver no commit. Se
-- ela tivesse vindo junto com a tabela e o codigo (Deploy 1), teria existido
-- uma janela em que o trigger ja estava no banco e o binario ANTERIOR ainda
-- servia trafego — e todo `PATCH` que troca professor falharia com `23514` no
-- COMMIT, derrubando a transacao inteira (`turma.update`,
-- `cancelFutureClassOccupancies`, `registerClassOccupancy`). O gestor receberia
-- **500** e a edicao de turma voltaria atras.
--
-- A drenagem foi provada antes desta migration existir (AC-015): um unico
-- deployment `ACTIVE`, com `cause` = `commit 55a1625`, o
-- `Nest application successfully started` no log, e a migration do Deploy 1
-- aplicada no primeiro deploy da onda. O residuo de acoes sem efeito foi
-- contado com ESTA MESMA consulta: **3**, e elas ficam (LIM-069b) — o trigger
-- confere no INSERT e nao alcanca linha antiga.
--
-- ## Por que `DEFERRABLE INITIALLY DEFERRED`
--
-- O efeito aponta para a acao, entao a acao e gravada primeiro. Um trigger
-- imediato reprovaria toda escrita legitima. Diferido, a ordem dentro da
-- transacao deixa de importar e so o COMMIT julga — mesmo mecanismo do
-- `ocupacao_cancelada_exige_evento` (SPEC-032/INV-064), um nivel acima.
--
-- ## Por que cada EXISTS filtra `company_id` E `acao_id`
--
-- `company_id` LIDERA os quatro btrees. Um `EXISTS` so por `acao_id` — como faz
-- o precedente da SPEC-032 — nao usaria indice nenhum, e cada commit pagaria
-- quatro varreduras. Os quatro indices entraram no Deploy 1, de proposito: o
-- trigger nunca existe sem eles.
--
-- ## O rollback NAO e `DROP TRIGGER` na mao
--
-- O `DROP` manual remove o trigger e deixa esta migration marcada como
-- aplicada em `_prisma_migrations`: o proximo deploy nao a recria, e o banco
-- fica num estado que o historico do Prisma nega. O rollback e **para a
-- frente**, e o artefato ja existe, revisado, em
-- `prisma/rollback/069-remove-acao-exige-alvo.sql` — **fora** deste diretorio,
-- porque migration pendente E APLICADA, e "pendente de proposito" nao existe
-- para o Prisma.
--
-- ## O DDL abaixo e BYTE A BYTE o que a TASK-004 usou para medir
--
-- Ele foi aplicado a um banco local para descobrir quais fixtures o trigger
-- quebrava (19), e o arquivo que serviu de fonte esta versionado na
-- governanca: `specs/changes/069-a-acao-sem-alvo/acao-exige-alvo.sql`. Se o
-- que sobe fosse reescrito, o que foi medido deixaria de ser o que vai valer.
CREATE FUNCTION "acao_tem_alvo"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
        SELECT 1 FROM "eventos_de_ocupacao" e
         WHERE e."company_id" = NEW."company_id" AND e."acao_id" = NEW."id")
     AND NOT EXISTS (
        SELECT 1 FROM "eventos_de_matricula" m
         WHERE m."company_id" = NEW."company_id" AND m."acao_id" = NEW."id")
     AND NOT EXISTS (
        SELECT 1 FROM "movimentos_de_credito" c
         WHERE c."company_id" = NEW."company_id" AND c."acao_id" = NEW."id")
     AND NOT EXISTS (
        SELECT 1 FROM "eventos_de_turma" t
         WHERE t."company_id" = NEW."company_id" AND t."acao_id" = NEW."id")
  THEN
    RAISE EXCEPTION
      'acao % do tipo % commitada sem efeito (SPEC-069/INV-069a)',
      NEW."id", NEW."tipo"
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "acao_exige_alvo"
  AFTER INSERT ON "acoes_administrativas"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "acao_tem_alvo"();
