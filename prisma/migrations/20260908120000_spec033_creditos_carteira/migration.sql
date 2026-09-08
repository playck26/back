-- SPEC-033 — créditos, carteira V1. TASK-001.
--
-- **Esta migration é SQL MANUAL, e isso é norma, não preguiça.** O DDL que o
-- `prisma migrate diff` gera a partir do modelo transforma as duas colunas
-- `GENERATED ALWAYS … STORED` num `DEFAULT CASE …` que o Postgres recusa com
-- `0A000`. O `schema.prisma` declara as duas como `dbgenerated`, que é como o
-- Prisma as REPRESENTA — o cliente lê certo, e quem cria o banco é este
-- arquivo. Conferência: `migrate diff` do modelo contra o banco migrado dá
-- "No difference detected."
--
-- Ensaiada bloco a bloco antes de existir (PostgreSQL 18.4 local):
-- DDL 22/23, comportamento 22/22, erro estruturado 8/8, concorrência 200/200,
-- preflight 7/7. Ver `specs/changes/033-creditos-carteira-v1/`.
--
-- `alunos_company_id_id_key` NÃO entra: existe desde a DEF-024 fase 1
-- (2026-09-04), e recriá-la abortaria a migration com `42P07`.

-- ---------------------------------------------------------------------------
-- PREFLIGHT A — antes de qualquer DDL.
-- ---------------------------------------------------------------------------
DO $preflight_a$
DECLARE
  tabela regclass := to_regclass('public.movimentos_de_credito');
  linhas bigint;
  avulsas_sem_aluno bigint;
BEGIN
  -- A referência a `movimentos_de_credito` é DINÂMICA de propósito: no caso
  -- normal a tabela não existe, e uma referência estática quebraria o
  -- preflight exatamente no ambiente em que ele precisa funcionar. Duas
  -- validações cruzadas reprovaram este bloco por isso (`42703` e `42P01`).
  IF tabela IS NULL THEN
    RAISE NOTICE 'preflight A1: movimentos_de_credito nao existe — migration inedita, seguir';
  ELSE
    EXECUTE 'SELECT count(*) FROM public.movimentos_de_credito' INTO linhas;
    IF linhas > 0 THEN
      RAISE EXCEPTION 'preflight A1: movimentos_de_credito ja tem % linha(s) — ha ledger, ABORTAR', linhas;
    END IF;
    RAISE NOTICE 'preflight A1: movimentos_de_credito existe e esta VAZIA — conferir a DEFINICAO (colunas, CHECKs, FKs) antes de seguir';
  END IF;

  SELECT count(*) INTO avulsas_sem_aluno
    FROM ocupacoes_quadra
   WHERE origem_tipo = 'AVULSO' AND aluno_id IS NULL;
  -- Não aborta: elas são PERMITIDAS e continuam válidas — ficam sem carteira.
  RAISE NOTICE 'preflight A2: % ocupacao(oes) AVULSO com aluno_id nulo — permitidas, ficarao sem carteira', avulsas_sem_aluno;
END
$preflight_a$;

-- ---------------------------------------------------------------------------
-- O saldo, e o preflight B logo depois dele.
-- ---------------------------------------------------------------------------
ALTER TABLE alunos
  ADD COLUMN saldo_creditos INTEGER NOT NULL DEFAULT 0
  CONSTRAINT alunos_saldo_nao_negativo CHECK (saldo_creditos >= 0);

DO $preflight_b$
DECLARE
  com_saldo bigint;
BEGIN
  SELECT count(*) INTO com_saldo FROM alunos WHERE saldo_creditos <> 0;
  IF com_saldo > 0 THEN
    RAISE EXCEPTION 'preflight B: % aluno(s) com saldo_creditos <> 0 sem ledger que o explique — ABORTAR', com_saldo;
  END IF;
  -- Hoje é trivial: a coluna nasce com DEFAULT 0. Deixa de ser no dia em que
  -- houver importação, e é para esse dia que a conferência fica escrita.
  RAISE NOTICE 'preflight B: nenhum aluno com saldo fora de zero';
END
$preflight_b$;

-- ---------------------------------------------------------------------------
-- O ledger.
-- ---------------------------------------------------------------------------
CREATE TYPE tipo_movimento_credito AS ENUM
  ('entrada','retirada','consumo','devolucao');

CREATE TABLE movimentos_de_credito (
  id                  UUID PRIMARY KEY,
  company_id          UUID NOT NULL,
  aluno_id            UUID NOT NULL,
  tipo                tipo_movimento_credito NOT NULL,
  valor_centavos      INTEGER NOT NULL CHECK (valor_centavos > 0),
  motivo              TEXT,
  autor_id            UUID NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  acao_id             UUID NOT NULL,
  ocupacao_id         UUID,
  movimento_origem_id UUID REFERENCES movimentos_de_credito(id) ON DELETE RESTRICT,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A FK do autor é SIMPLES de propósito: `usuarios.company_id` é nulo para
  -- `super_admin`, e uma FK composta o impediria de ser autor.
  CONSTRAINT movimentos_acao_fkey
    FOREIGN KEY (company_id, acao_id)
    REFERENCES acoes_administrativas(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT movimentos_aluno_fkey
    FOREIGN KEY (company_id, aluno_id) REFERENCES alunos(company_id, id)
    ON DELETE RESTRICT,
  -- A FK da ocupação NÃO entra aqui: é de QUATRO colunas e depende de coluna
  -- gerada, então vem por ALTER TABLE mais abaixo (INV-097).
  CONSTRAINT movimentos_motivo_administrativo CHECK (
    (tipo IN ('entrada','retirada') AND btrim(coalesce(motivo,'')) <> '')
    OR tipo IN ('consumo','devolucao')),
  CONSTRAINT movimentos_origem_check CHECK (
    (tipo = 'devolucao' AND movimento_origem_id IS NOT NULL)
    OR (tipo <> 'devolucao' AND movimento_origem_id IS NULL)),
  -- Sem este CHECK, `MATCH SIMPLE` pularia a FK de quatro colunas sempre que
  -- `ocupacao_id` fosse nulo, e a INV-097 não alcançaria nada.
  CONSTRAINT movimentos_ocupacao_por_tipo CHECK (
    (tipo IN ('consumo','devolucao') AND ocupacao_id IS NOT NULL)
    OR (tipo IN ('entrada','retirada') AND ocupacao_id IS NULL))
);

-- INV-085: uma devolução por consumo.
CREATE UNIQUE INDEX ux_movimentos_devolucao_por_consumo
  ON movimentos_de_credito (movimento_origem_id) WHERE tipo = 'devolucao';

-- D5 — a FK causal: a devolução tem de apontar para um CONSUMO do mesmo
-- aluno, da mesma ocupação e do mesmo valor. O alvo UNIQUE primeiro.
ALTER TABLE movimentos_de_credito
  ADD CONSTRAINT movimentos_origem_alvo_key
  UNIQUE (id, tipo, company_id, aluno_id, ocupacao_id, valor_centavos);

-- Coluna GERADA como discriminante constante — o truque que faz a FK exigir
-- `tipo = 'consumo'` no alvo sem uma trigger.
ALTER TABLE movimentos_de_credito
  ADD COLUMN origem_tipo tipo_movimento_credito
    GENERATED ALWAYS AS (CASE WHEN tipo = 'devolucao'
                              THEN 'consumo'::tipo_movimento_credito END) STORED;

ALTER TABLE movimentos_de_credito
  ADD CONSTRAINT movimentos_origem_causal_fkey
    FOREIGN KEY (movimento_origem_id, origem_tipo, company_id, aluno_id,
                 ocupacao_id, valor_centavos)
    REFERENCES movimentos_de_credito (id, tipo, company_id, aluno_id,
                 ocupacao_id, valor_centavos) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- D1 / INV-071 — o saldo é escrito PELO ledger, e só por ele.
-- ---------------------------------------------------------------------------
CREATE FUNCTION saldo_do_ledger() RETURNS trigger AS $$
BEGIN
  PERFORM set_config('playck.escrita_de_saldo', 'ledger', true);
  UPDATE alunos SET saldo_creditos = saldo_creditos
    + CASE WHEN NEW.tipo IN ('entrada','devolucao') THEN NEW.valor_centavos
           ELSE -NEW.valor_centavos END
   WHERE id = NEW.aluno_id AND company_id = NEW.company_id;
  PERFORM set_config('playck.escrita_de_saldo', '', true);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- **`BEFORE UPDATE OF` não intercepta INSERT**, e a primeira versão desta
-- guarda só cobria UPDATE: a validação cruzada inseriu um aluno com saldo
-- 12345 e zero movimentos sem tocar em trigger nenhuma (DEF-VC033-01).
CREATE FUNCTION saldo_so_pelo_ledger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.saldo_creditos <> 0 THEN
      RAISE EXCEPTION 'aluno nasce com saldo zero; carga entra por movimento (INV-071)'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.saldo_creditos IS DISTINCT FROM OLD.saldo_creditos
     AND coalesce(current_setting('playck.escrita_de_saldo', true),'') <> 'ledger' THEN
    RAISE EXCEPTION 'saldo so muda por movimento (INV-071)' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER movimentos_atualiza_saldo AFTER INSERT ON movimentos_de_credito
  FOR EACH ROW EXECUTE FUNCTION saldo_do_ledger();

CREATE TRIGGER alunos_saldo_so_pelo_ledger
  BEFORE INSERT OR UPDATE OF saldo_creditos ON alunos
  FOR EACH ROW EXECUTE FUNCTION saldo_so_pelo_ledger();

-- ---------------------------------------------------------------------------
-- INV-097 — consumo e devolução só alcançam ocupação AVULSA.
--
-- O `CHECK ocupacoes_valor_por_origem` que já existe confere o VALOR da
-- ocupação; ele não liga o movimento à origem. A validação cruzada inseriu um
-- consumo de 200 numa ocupação de TURMA (DEF-VC033-02). O alvo da FK ganha
-- `origem_tipo`, e a coluna gerada abaixo fixa 'AVULSO' do lado do movimento.
-- ---------------------------------------------------------------------------
ALTER TABLE ocupacoes_quadra
  ADD CONSTRAINT ocupacoes_quadra_company_id_id_aluno_id_origem_key
  UNIQUE (company_id, id, aluno_id, origem_tipo);

ALTER TABLE movimentos_de_credito
  ADD COLUMN ocupacao_origem origem_tipo
    GENERATED ALWAYS AS (CASE WHEN tipo IN ('consumo','devolucao')
                              THEN 'AVULSO'::origem_tipo END) STORED;

ALTER TABLE movimentos_de_credito
  ADD CONSTRAINT movimentos_ocupacao_avulsa_fkey
    FOREIGN KEY (company_id, ocupacao_id, aluno_id, ocupacao_origem)
    REFERENCES ocupacoes_quadra (company_id, id, aluno_id, origem_tipo)
    ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- INV-070 — o ledger é append-only. Reusa a função da SPEC-032, com a válvula
-- de teste, para a limpeza de empresa continuar possível no banco de testes.
-- ---------------------------------------------------------------------------
CREATE TRIGGER movimentos_append_only
  BEFORE UPDATE OR DELETE ON movimentos_de_credito
  FOR EACH ROW EXECUTE FUNCTION "append_only_com_valvula_de_teste"();

-- ---------------------------------------------------------------------------
-- INV-096 — cancelar exige devolução, por QUALQUER caminho.
--
-- Molde da `ocupacao_cancelada_exige_evento` (SPEC-032/INV-064). O corpo é o
-- protótipo escrito pelo validador em 2026-09-07, adotado com atribuição.
-- SQLSTATE customizado: com o `SET CONSTRAINTS` NOMEADO no fim da transação,
-- chega ao Prisma como `P2010` + `meta.code`, e a tradução deixa de casar
-- texto (D7).
-- ---------------------------------------------------------------------------
CREATE FUNCTION ocupacao_cancelada_exige_devolucao() RETURNS trigger AS $$
BEGIN
  IF NEW.status_pagamento = 'cancelado'
     AND OLD.status_pagamento IS DISTINCT FROM 'cancelado'
     AND NEW.origem_tipo = 'AVULSO'
     AND EXISTS (
       SELECT 1 FROM movimentos_de_credito c
        WHERE c.company_id = NEW.company_id AND c.ocupacao_id = NEW.id
          AND c.tipo = 'consumo'
          AND NOT EXISTS (SELECT 1 FROM movimentos_de_credito d
                           WHERE d.movimento_origem_id = c.id AND d.tipo = 'devolucao')
     ) THEN
    RAISE EXCEPTION 'cancelamento sem devolucao (INV-096)'
      USING ERRCODE = 'P3301', CONSTRAINT = 'ocupacao_cancelada_exige_devolucao';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ocupacao_cancelada_exige_devolucao
  AFTER UPDATE ON ocupacoes_quadra DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ocupacao_cancelada_exige_devolucao();

-- ---------------------------------------------------------------------------
-- INV-098 — no máximo UM consumo ATIVO por ocupação.
--
-- Declarada impossível por mim (ex-LIM-033k), sob o argumento de que proteger
-- quebraria a reativação. **Errado**: contar consumos SEM devolução deixa a
-- reativação (consumo/devolução/consumo) passar e barra o débito duplo.
-- Provado pelo validador em 20/20. Corpo do protótipo dele.
-- ---------------------------------------------------------------------------
CREATE FUNCTION consumo_ativo_unico() RETURNS trigger AS $$
BEGIN
  IF NEW.tipo = 'consumo' AND EXISTS (
    SELECT 1
      FROM movimentos_de_credito c
     WHERE c.company_id = NEW.company_id
       AND c.aluno_id   = NEW.aluno_id
       AND c.ocupacao_id = NEW.ocupacao_id
       AND c.tipo = 'consumo'
       AND NOT EXISTS (SELECT 1 FROM movimentos_de_credito d
                        WHERE d.tipo = 'devolucao' AND d.movimento_origem_id = c.id)
     GROUP BY c.company_id, c.aluno_id, c.ocupacao_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'mais de um consumo ativo para a ocupacao (INV-098)'
      USING ERRCODE = 'P3302', CONSTRAINT = 'movimentos_consumo_ativo_unico';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER movimentos_consumo_ativo_unico
  AFTER INSERT ON movimentos_de_credito DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION consumo_ativo_unico();
