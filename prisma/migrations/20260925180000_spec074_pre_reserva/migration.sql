-- SPEC-074/TASK-001 — a pre-reserva: a tabela, os tres CHECK, as duas FKs
-- compostas, os quatro indices, o trigger do slot imutavel, e o indice e o
-- CHECK do aviso em `notificacoes`.
--
-- **Esta migration nao liga nada.** Nenhuma rota le ou escreve `pre_reservas`
-- antes da TASK-002, e o varredor (TASK-003) so existe depois. Binario antigo
-- continua valido sobre este schema: nenhuma coluna existente muda, e a unica
-- alteracao em tabela viva e um indice PARCIAL e um CHECK em `notificacoes`
-- que so mordem `tipo = 'pre_reserva'` -- tipo que nenhuma linha tem hoje.
--
-- Rollback: a tabela e nova e ninguem depende dela; o indice e o CHECK de
-- `notificacoes` saem com `DROP`.
--
-- **A DoR desta spec custou oito rodadas de validacao independente, e as sete
-- primeiras REPROVARAM.** Os comentarios dizem qual rodada decidiu cada linha,
-- porque quem mexer nisto depois vai querer "simplificar" exatamente o que
-- custou as rodadas.

-- ==========================================================================
-- 1. Os cinco estados
-- ==========================================================================
--
-- Nao-terminal: so `aguardando`. E o unico que o indice de unicidade, o
-- CHECK de conclusao e os tres indices parciais citam -- quem acrescentar um
-- estado nao-terminal tem de mexer nos cinco lugares.
--
-- `avisada` e TERMINAL por decisao do Israel (decisao 4, devolvida a ele pela
-- 1a rodada): um aviso por pedido. Perdeu a corrida, pede de novo.
CREATE TYPE "estado_da_pre_reserva" AS ENUM (
  'aguardando',
  'avisada',
  'cancelada',
  'expirada',
  'encerrada'
);

-- ==========================================================================
-- 2. A tabela
-- ==========================================================================

CREATE TABLE "pre_reservas" (
  "id"            UUID                     NOT NULL,
  "company_id"    UUID                     NOT NULL,
  "aluno_id"      UUID                     NOT NULL,
  "quadra_id"     UUID                     NOT NULL,
  -- O slot, na MESMA forma de `ocupacoes_quadra` (D6): e com estas tres que o
  -- varredor confere a sobreposicao, e a comparacao nao pode depender de fuso.
  "data"          DATE                     NOT NULL,
  "hora_inicio"   TIME                     NOT NULL,
  "hora_fim"      TIME                     NOT NULL,
  -- O instante do inicio, gravado na criacao por `instanteNoFusoDoClube` (D6).
  -- **E redundante com as tres de cima, e nenhum CHECK os amarra**: amarrar
  -- exigiria o fuso aqui dentro, a segunda fonte que a D6 existe para evitar.
  -- Na criacao, quem garante e a aplicacao; depois dela, o trigger da secao 5.
  "inicio_em"     TIMESTAMPTZ(6)           NOT NULL,
  "estado"        "estado_da_pre_reserva"  NOT NULL DEFAULT 'aguardando',
  "criada_em"     TIMESTAMPTZ(6)           NOT NULL DEFAULT now(),
  -- A chave do rodizio do varredor e `coalesce(verificada_em, criada_em)`
  -- (D7) -- **nao** `verificada_em NULLS FIRST`, que deixava todo pedido novo
  -- furar a fila (achado da 2a rodada).
  "verificada_em" TIMESTAMPTZ(6),
  "avisada_em"    TIMESTAMPTZ(6),
  "concluida_em"  TIMESTAMPTZ(6),
  "motivo_fim"    TEXT,

  CONSTRAINT "pre_reservas_pkey" PRIMARY KEY ("id"),

  -- INV-074f
  CONSTRAINT "pre_reserva_faixa_chk" CHECK ("hora_fim" > "hora_inicio"),
  -- INV-074b — terminal se, e so se, concluida.
  CONSTRAINT "pre_reserva_conclusao_chk"
    CHECK (("estado" = 'aguardando') = ("concluida_em" IS NULL)),
  -- INV-074c — avisada tem o instante do aviso.
  CONSTRAINT "pre_reserva_aviso_chk"
    CHECK ("estado" <> 'avisada' OR "avisada_em" IS NOT NULL)
);

-- ==========================================================================
-- 3. As duas FKs compostas (INV-074e)
-- ==========================================================================
--
-- `(company_id, id)` ja e alvo de outras FKs nas duas tabelas: de
-- `fila_aluno_fkey` em `alunos`, de `ocupacoes_quadra_quadra_fkey` em
-- `quadras`. **RESTRICT** pelo mesmo motivo da `lista_de_espera`: apagar aluno
-- ou quadra e decisao de dominio que esta spec nao toma.
--
-- `ON UPDATE CASCADE` e o padrao das FKs da casa. Ids nao mudam; se um dia
-- mudassem, o trigger da secao 5 recusaria a cascata -- o que e o certo para
-- um slot que ja foi prometido a alguem.
ALTER TABLE "pre_reservas"
  ADD CONSTRAINT "pre_reserva_aluno_fkey"
  FOREIGN KEY ("company_id", "aluno_id")
  REFERENCES "alunos" ("company_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pre_reservas"
  ADD CONSTRAINT "pre_reserva_quadra_fkey"
  FOREIGN KEY ("company_id", "quadra_id")
  REFERENCES "quadras" ("company_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ==========================================================================
-- 4. Os quatro indices
-- ==========================================================================

-- INV-074a — um pedido VIVO por aluno e slot. **Parcial**, e e isso que deixa
-- pedir de novo depois de cancelar ou de ser avisado (AC-003, decisao 4).
CREATE UNIQUE INDEX "pre_reserva_ativa_key"
  ON "pre_reservas" ("company_id", "aluno_id", "quadra_id", "data", "hora_inicio")
  WHERE "estado" = 'aguardando';

-- O lote do varredor: as vivas por slot.
CREATE INDEX "pre_reserva_varredura_idx"
  ON "pre_reservas" ("quadra_id", "data", "hora_inicio")
  WHERE "estado" = 'aguardando';

-- A expiracao (etapa 1 do ciclo).
CREATE INDEX "pre_reserva_expiracao_idx"
  ON "pre_reservas" ("inicio_em")
  WHERE "estado" = 'aguardando';

-- A tela: as vivas do aluno, por inicio.
CREATE INDEX "pre_reserva_do_aluno_idx"
  ON "pre_reservas" ("company_id", "aluno_id", "inicio_em")
  WHERE "estado" = 'aguardando';

-- ==========================================================================
-- 5. INV-074h, a metade de DEPOIS da criacao: o slot e o instante nao mudam
-- ==========================================================================
--
-- Achado B-07 da 1a rodada: `data`/`hora_inicio` dizem QUAL slot, `inicio_em`
-- diz QUANDO expira, e divergirem e avisar um horario e expirar outro. Nenhum
-- caminho do produto altera um slot -- mudar de horario e cancelar um pedido e
-- fazer outro --, entao recusar a mudanca nao recusa nada legitimo.
--
-- `IS DISTINCT FROM` sobre a tupla e null-safe e pega a troca de UMA coluna
-- so (medido pela 3a rodada). `check_violation` (23514): nenhum caso vira
-- HTTP, e a mensagem diz a causa. Precedente: o trigger que recusa mudar
-- `transacao_de_criacao` (SPEC-054/D5).
CREATE FUNCTION "pre_reserva_slot_imutavel"() RETURNS trigger AS $$
BEGIN
  IF (NEW."company_id", NEW."aluno_id", NEW."quadra_id", NEW."data",
      NEW."hora_inicio", NEW."hora_fim", NEW."inicio_em")
     IS DISTINCT FROM
     (OLD."company_id", OLD."aluno_id", OLD."quadra_id", OLD."data",
      OLD."hora_inicio", OLD."hora_fim", OLD."inicio_em") THEN
    RAISE EXCEPTION 'o slot de uma pre-reserva nao muda depois de criado'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "pre_reserva_slot_imutavel"
  BEFORE UPDATE ON "pre_reservas"
  FOR EACH ROW EXECUTE FUNCTION "pre_reserva_slot_imutavel"();

-- ==========================================================================
-- 6. INV-074d — um aviso por pre-reserva, e as DUAS metades do padrao
-- ==========================================================================
--
-- O mesmo par da SPEC-063 e da SPEC-068: indice unico parcial MAIS o CHECK de
-- origem. Sem o CHECK o indice seria letra morta -- no PostgreSQL `NULL` nao
-- colide com `NULL`.
--
-- O varredor escreve com `ON CONFLICT (origem_id, destinatario_id) WHERE tipo =
-- 'pre_reserva' DO NOTHING` (achado B-02 da 1a rodada): a duplicata vira
-- CONTAGEM, e nao um `23505` que abortaria a transacao inteira.
--
-- O `ADD CONSTRAINT` valida a tabela toda; hoje nenhuma linha tem
-- `tipo = 'pre_reserva'`, e e o mesmo `ADD` que a SPEC-068 fez em producao.
CREATE UNIQUE INDEX "notificacoes_pre_reserva_por_destinatario_key"
  ON "notificacoes" ("origem_id", "destinatario_id")
  WHERE "tipo" = 'pre_reserva';

ALTER TABLE "notificacoes"
  ADD CONSTRAINT "notificacoes_pre_reserva_tem_origem_chk"
  CHECK ("tipo" <> 'pre_reserva' OR "origem_id" IS NOT NULL);
