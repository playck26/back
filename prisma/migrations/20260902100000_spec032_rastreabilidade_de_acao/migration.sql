-- SPEC-032:TASK-001 — rastreabilidade de acao administrativa.
--
-- Duas tabelas, e a cisao entre elas e o achado que reprovou a v1 da spec:
-- `acoes_administrativas` e o GESTO HUMANO (uma), `eventos_de_ocupacao` sao
-- os ALVOS TECNICOS (N). A v1 dizia que o evento apontava por FK para uma
-- ocupacao E que criar 40 ocorrencias gerava um evento so — as duas coisas
-- nao cabem juntas.
--
-- CHECKLIST DA LICAO DE 2026-08-22 (o 500 que chegou a producao): esta
-- migration ACRESCENTA um UNIQUE e uma coluna anulavel em `ocupacoes_quadra`,
-- e nao toca em nenhum CHECK existente — nem `ocupacoes_valor_por_origem`,
-- nem a EXCLUDE `no_overlap_por_quadra`, nem os CHECKs de `chamadas`,
-- `usuarios` ou `presencas`. Conferido por
-- `grep -rn CHECK prisma/migrations/` antes de escrever, nao suposto.
--
-- Ensaiada no banco de DEV (`playck-dev`, PG 18) antes de ir para producao —
-- e o ensaio pegou um defeito: a primeira versao omitia `ON UPDATE CASCADE`
-- nas quatro FKs. O Postgres assume `NO ACTION`, o Prisma assume `CASCADE`
-- para relacao obrigatoria, e `migrate diff` acusaria drift PERMANENTE — a
-- mesma familia do drift de `avaliacoes_de_aula`, que este projeto acabou de
-- fechar. A convencao esta em `presencas_ocupacao_fkey`, conferida no banco.

-- =========================================================================
-- 1. Os alvos das FKs compostas
-- =========================================================================

-- `ocupacoes_quadra` so tinha PK simples e o UNIQUE (id, origem_tipo) da
-- INV-016. O Postgres NAO infere alvo composto a partir de PK simples, entao
-- sem esta linha o CREATE TABLE de `eventos_de_ocupacao` falha.
--
-- Redundante como chave — `id` ja e PK — e existe para ser alvo, mesmo truque
-- de `quadras_company_id_id_key` (DEF-022) e de
-- `ocupacoes_quadra_id_origem_tipo_key` (INV-016).
ALTER TABLE "ocupacoes_quadra"
  ADD CONSTRAINT "ocupacoes_quadra_company_id_id_key" UNIQUE ("company_id", "id");

-- =========================================================================
-- 2. A IDENTIDADE DA TRANSICAO (INV-064)
-- =========================================================================
--
-- Trocada a cada mudanca de estado da ocupacao. Existe porque a 3a rodada de
-- validacao cruzada derrubou a versao anterior, que usava
-- `criado_em >= transaction_timestamp()`:
--
--   (a) `transaction_timestamp()` e o INICIO da transacao, nao a identidade
--       dela. T1 abre 10:00 e cancela sem evento; T2 abre 10:01, grava evento
--       para a mesma ocupacao e confirma; no COMMIT de T1 a trigger acha o
--       evento de T2, porque 10:01 >= 10:00. T1 confirma cancelamento alheio
--       como se fosse seu;
--   (b) `cancelar -> reativar -> cancelar` na MESMA transacao passava com um
--       evento so: as duas invocacoes diferidas achavam o mesmo evento.
--
-- Anulavel porque as linhas que ja existem em producao nunca tiveram
-- transicao registrada (LIM-032a). Linha antiga com `transicao_id` nulo so
-- entra na exigencia quando alguem a cancelar — e ai a aplicacao preenche.
ALTER TABLE "ocupacoes_quadra" ADD COLUMN "transicao_id" UUID;

-- =========================================================================
-- 3. Os tipos
-- =========================================================================

-- O tipo da ACAO nomeia o GESTO; o do evento nomeia o EFEITO. Conferido em
-- `classes.service.ts:249`: um PATCH de turma abre UM $transaction que
-- cancela as ocorrencias futuras e regera as novas — e uma acao
-- (`turma_horario_editado`) com eventos `cancelada` e `criada`. Descrever
-- pelo efeito produziria duas acoes para um gesto.
CREATE TYPE "tipo_de_acao" AS ENUM (
  'reserva_criada',
  'reserva_cancelada',
  'pagamento_confirmado',
  'turma_criada',
  'turma_horario_editado',
  'credito_lancado',
  'credito_retirado'
);

CREATE TYPE "tipo_de_evento_de_ocupacao" AS ENUM (
  'criada',
  'cancelada',
  'reativada',
  'pagamento_confirmado'
);

-- =========================================================================
-- 4. As tabelas
-- =========================================================================

CREATE TABLE "acoes_administrativas" (
  "id"         UUID PRIMARY KEY,
  "company_id" UUID NOT NULL,
  "tipo"       "tipo_de_acao" NOT NULL,
  -- A perna do AUTOR nao e composta, e e DE PROPOSITO (LIM-032f):
  -- `usuarios.company_id` e NULO para `super_admin`, e uma FK composta
  -- impediria o super admin de ser autor de qualquer coisa.
  "autor_id"   UUID NOT NULL,
  "motivo"     TEXT,
  "criado_em"  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "acoes_empresa_fkey"
    FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acoes_autor_fkey"
    FOREIGN KEY ("autor_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- alvo da FK composta de `eventos_de_ocupacao`
  CONSTRAINT "acoes_company_id_id_key" UNIQUE ("company_id", "id")
);

CREATE INDEX "acoes_company_criado_em_idx"
  ON "acoes_administrativas" ("company_id", "criado_em" DESC);

CREATE TABLE "eventos_de_ocupacao" (
  "id"           UUID PRIMARY KEY,
  "company_id"   UUID NOT NULL,
  "acao_id"      UUID NOT NULL,
  "ocupacao_id"  UUID NOT NULL,
  "tipo"         "tipo_de_evento_de_ocupacao" NOT NULL,
  -- Casa com `ocupacoes_quadra.transicao_id` (INV-064). NOT NULL aqui porque
  -- todo evento NASCE agora, diferente das ocupacoes antigas.
  "transicao_id" UUID NOT NULL,
  "criado_em"    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- As duas FKs carregam a EMPRESA. A INV-054 ja ensinou que "nao ha caminho
  -- hoje" nao e a mesma coisa que "o banco nao deixa", e foi por confiar
  -- nisso que a SPEC-025 vazou nota de turma entre empresas.
  CONSTRAINT "eventos_acao_fkey"
    FOREIGN KEY ("company_id", "acao_id")
    REFERENCES "acoes_administrativas"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "eventos_ocupacao_fkey"
    FOREIGN KEY ("company_id", "ocupacao_id")
    REFERENCES "ocupacoes_quadra"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "eventos_ocupacao_idx"
  ON "eventos_de_ocupacao" ("company_id", "ocupacao_id", "criado_em" DESC);
CREATE INDEX "eventos_acao_idx"
  ON "eventos_de_ocupacao" ("company_id", "acao_id");

-- =========================================================================
-- 5. APPEND-ONLY, e por que nao e `REVOKE` (INV-061)
-- =========================================================================
--
-- A v1 da spec dizia "append-only garantido por nao existir rota". Isso
-- descreve o codigo de hoje, nao uma garantia: um
-- `prisma.eventoDeOcupacao.updateMany()` interno passaria por cima e os
-- testes de rota continuariam verdes.
--
-- E NAO e `REVOKE UPDATE, DELETE ... FROM PUBLIC`: tabela nova no Postgres
-- nao concede nada a PUBLIC, e a aplicacao conecta como DONA do schema. O
-- REVOKE seria inocuo — medido, nao suposto.
--
-- A VALVULA exige DUAS coisas, e a segunda e o que a torna inexistente em
-- producao: o GUC de transacao E a role de limpeza. `set_config` e chamavel
-- por qualquer codigo e o nome esta aqui a vista de todos; sem a role, isto
-- seria uma porta permanente que funcionaria em producao. A role e criada
-- SOMENTE no bootstrap do banco de testes — aqui so citamos o nome, e se ela
-- nao existir `current_user` nunca bate.
CREATE FUNCTION "append_only_com_valvula_de_teste"() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('playck.limpeza_append_only', true), '') = 'on'
     AND current_user = 'playck_test_cleanup' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    'tabela % e append-only: % recusado (SPEC-032/INV-061)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "acoes_append_only"
  BEFORE UPDATE OR DELETE ON "acoes_administrativas"
  FOR EACH ROW EXECUTE FUNCTION "append_only_com_valvula_de_teste"();

CREATE TRIGGER "eventos_append_only"
  BEFORE UPDATE OR DELETE ON "eventos_de_ocupacao"
  FOR EACH ROW EXECUTE FUNCTION "append_only_com_valvula_de_teste"();

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
