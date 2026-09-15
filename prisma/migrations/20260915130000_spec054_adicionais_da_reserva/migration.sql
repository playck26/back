-- SPEC-054 — adicionais da reserva: tipos, produtos e estoque (Entrega B).
--
-- **Pré-requisito de deploy: a Entrega A no ar** (SPEC-054/D11). Ela ensina a
-- criação e o movimento a traduzir `P3303`/`P3304`; sem ela, o rollback deste
-- código responderia `500` ao mover reserva com adicional para horário sem
-- estoque.
--
-- A seção D2 abaixo é a DDL da spec **aplicada literalmente** — foi executada
-- assim, sozinha, sobre um banco com as 39 migrations anteriores, antes de
-- virar migration (exit 0; CLI_AUDIT da SPEC-054). O tipo SQL é `origem_tipo`,
-- não `"OrigemTipo"` (nome do enum no Prisma): com o nome do Prisma, a DDL falha
-- com `42704` e a tabela não nasce (achado da 2ª rodada de validação).
BEGIN;

-- =====================================================================
-- D2 — o modelo
-- =====================================================================

-- D1: os dois nomes únicos. Nulo = o nome padrão ("Quadra", "Aula particular"),
-- no molde de `preco_aula_padrao`. Gravados por rota própria, e NUNCA pelo
-- `PUT /company-settings/operacao`, cujo `gravar` enumera três campos: um Admin
-- antigo salvando prazos não os conhece e não os apaga.
ALTER TABLE config_operacao_empresa
  ADD COLUMN nome_tipo_quadra text,
  ADD COLUMN nome_tipo_aula   text,
  ADD CONSTRAINT config_nome_tipo_quadra_check
    CHECK (nome_tipo_quadra IS NULL OR (btrim(nome_tipo_quadra) = nome_tipo_quadra AND length(nome_tipo_quadra) BETWEEN 1 AND 30)),
  ADD CONSTRAINT config_nome_tipo_aula_check
    CHECK (nome_tipo_aula IS NULL OR (btrim(nome_tipo_aula) = nome_tipo_aula AND length(nome_tipo_aula) BETWEEN 1 AND 30));

CREATE TABLE tipos_de_adicional (
  id          uuid PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES empresas(id),
  nome        text NOT NULL CHECK (btrim(nome) = nome AND length(nome) BETWEEN 1 AND 30),
  ordem       integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tipos_de_adicional_nome_key UNIQUE (company_id, nome),
  CONSTRAINT tipos_de_adicional_company_id_id_key UNIQUE (company_id, id)
);

CREATE TABLE adicionais (
  id          uuid PRIMARY KEY,
  company_id  uuid NOT NULL,
  tipo_id     uuid NOT NULL,
  nome        text NOT NULL CHECK (btrim(nome) = nome AND length(nome) BETWEEN 1 AND 40),
  preco       numeric(10,2) NOT NULL CHECK (preco > 0),
  estoque     integer NOT NULL CHECK (estoque >= 0),
  ativo       boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL,
  CONSTRAINT adicionais_nome_key UNIQUE (company_id, nome),
  CONSTRAINT adicionais_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT adicionais_tipo_fkey FOREIGN KEY (company_id, tipo_id)
    REFERENCES tipos_de_adicional (company_id, id) ON DELETE RESTRICT
);

-- INV-132 — adicional só existe em reserva AVULSA da própria empresa: FK
-- `(company_id, ocupacao_id)` e FK `(ocupacao_id, origem_da_ocupacao)` com a
-- coluna gerada `'AVULSO'` — o molde de `movimentos_de_credito`.
CREATE TABLE adicionais_da_ocupacao (
  id                 uuid PRIMARY KEY,
  company_id         uuid NOT NULL,
  ocupacao_id        uuid NOT NULL,
  origem_da_ocupacao origem_tipo GENERATED ALWAYS AS ('AVULSO'::origem_tipo) STORED,
  adicional_id       uuid NOT NULL,
  quantidade         integer NOT NULL CHECK (quantidade BETWEEN 1 AND 99),
  valor_unitario     numeric(10,2) NOT NULL CHECK (valor_unitario > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ocupacao_id, adicional_id),
  FOREIGN KEY (company_id, ocupacao_id) REFERENCES ocupacoes_quadra (company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (ocupacao_id, origem_da_ocupacao) REFERENCES ocupacoes_quadra (id, origem_tipo) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, adicional_id) REFERENCES adicionais (company_id, id) ON DELETE RESTRICT
);
CREATE INDEX adicionais_da_ocupacao_adicional_idx ON adicionais_da_ocupacao (adicional_id);

-- Em DOIS passos: numa instrução só, o default volátil reescreveria a tabela.
-- Em dois, as linhas antigas ficam NULL sem reescrita — e NULL é o valor certo:
-- reserva antiga não pode ganhar adicional (D5).
ALTER TABLE ocupacoes_quadra ADD COLUMN transacao_de_criacao bigint;
ALTER TABLE ocupacoes_quadra ALTER COLUMN transacao_de_criacao SET DEFAULT txid_current();

-- D5: o marcador é do banco — o valor enviado é ignorado
CREATE FUNCTION marcar_transacao_de_criacao() RETURNS trigger AS $$
BEGIN
  NEW.transacao_de_criacao := txid_current();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ocupacao_marca_transacao_de_criacao
  BEFORE INSERT ON ocupacoes_quadra
  FOR EACH ROW EXECUTE FUNCTION marcar_transacao_de_criacao();

-- =====================================================================
-- D5 / INV-134 — o item nasce na transação da reserva, e não muda
-- =====================================================================

-- A coluna não muda depois. Sem isto, a credencial do app faria um UPDATE no
-- marcador de uma ocupação já confirmada e anexaria item a ela.
CREATE FUNCTION transacao_de_criacao_imutavel() RETURNS trigger AS $$
BEGIN
  IF NEW.transacao_de_criacao IS DISTINCT FROM OLD.transacao_de_criacao THEN
    RAISE EXCEPTION
      'ocupacoes_quadra.transacao_de_criacao nao muda depois de gravada (SPEC-054/INV-134)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ocupacao_transacao_de_criacao_imutavel
  BEFORE UPDATE OF transacao_de_criacao ON ocupacoes_quadra
  FOR EACH ROW EXECUTE FUNCTION transacao_de_criacao_imutavel();

-- O item não muda nem some: a mesma válvula da SPEC-032, que exige o GUC E a
-- role `playck_test_cleanup` — a role só existe no banco de testes.
CREATE TRIGGER adicionais_da_ocupacao_append_only
  BEFORE UPDATE OR DELETE ON adicionais_da_ocupacao
  FOR EACH ROW EXECUTE FUNCTION append_only_com_valvula_de_teste();

-- =====================================================================
-- D3 / INV-133 — o estoque é conferido pelo BANCO, no momento em que a
-- unidade é tomada
-- =====================================================================
--
-- Estoque disponível de um adicional num intervalo = `estoque` − soma das
-- quantidades dos itens daquele adicional em ocupações NÃO canceladas cujo
-- intervalo se sobrepõe. O estoque é do clube, não da quadra.
--
-- **Por que a contagem enxerga o vencedor:** sob READ COMMITTED, cada instrução
-- de uma função VOLATILE tira snapshot novo. Quem espera o `FOR UPDATE` do passo
-- 1 executa o passo 3 depois de o outro confirmar, e vê o que ele gravou.
--
-- A mensagem nomeia o adicional (`adicional=<uuid>`): a Entrega A a lê para
-- responder `adicionalId`. Mudar o formato cala esse campo, não a recusa.
CREATE FUNCTION adicional_cabe_no_estoque() RETURNS trigger AS $$
DECLARE
  v_estoque   integer;
  v_ativo     boolean;
  v_transacao bigint;
  v_data      date;
  v_inicio    time;
  v_fim       time;
  v_reservado integer;
BEGIN
  -- 1. trava o adicional
  SELECT estoque, ativo INTO v_estoque, v_ativo
    FROM adicionais
   WHERE company_id = NEW.company_id AND id = NEW.adicional_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- ausente: a FK recusa com 23503
  END IF;
  IF NOT v_ativo THEN
    RAISE EXCEPTION 'ADICIONAL_INATIVO adicional=%', NEW.adicional_id
      USING ERRCODE = 'P3304';
  END IF;

  -- 2. a ocupação precisa ter nascido NESTA transação. `IS DISTINCT FROM`, e
  -- não `<>`: com o marcador NULL (reserva anterior à migration), `<>` dá NULL
  -- e o IF não dispara.
  SELECT transacao_de_criacao, data, hora_inicio, hora_fim
    INTO v_transacao, v_data, v_inicio, v_fim
    FROM ocupacoes_quadra
   WHERE id = NEW.ocupacao_id;
  IF NOT FOUND THEN
    RETURN NEW; -- ausente: a FK recusa com 23503
  END IF;
  IF v_transacao IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION
      'item de adicional so nasce na transacao que criou a reserva (SPEC-054/INV-134)'
      USING ERRCODE = '23514';
  END IF;

  -- 3. soma o que já está tomado no intervalo, fora a própria ocupação
  SELECT coalesce(sum(i.quantidade), 0) INTO v_reservado
    FROM adicionais_da_ocupacao i
    JOIN ocupacoes_quadra o ON o.company_id = i.company_id AND o.id = i.ocupacao_id
   WHERE i.adicional_id = NEW.adicional_id
     AND o.status_pagamento <> 'cancelado'
     AND o.id <> NEW.ocupacao_id
     AND tsrange(o.data + o.hora_inicio, o.data + o.hora_fim)
      && tsrange(v_data + v_inicio, v_data + v_fim);

  IF v_reservado + NEW.quantidade > v_estoque THEN
    RAISE EXCEPTION 'ESTOQUE_ESGOTADO adicional=%', NEW.adicional_id
      USING ERRCODE = 'P3303';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql VOLATILE;
CREATE TRIGGER adicional_cabe_no_estoque
  BEFORE INSERT ON adicionais_da_ocupacao
  FOR EACH ROW EXECUTE FUNCTION adicional_cabe_no_estoque();

-- Quando a ocupação com item muda de INTERVALO, ou sai de `cancelado`, refaz a
-- trava e a soma para cada item, em ordem de `adicional_id`. Não dispara em
-- `pendente_pagamento → pago`, em `→ cancelado`, nem em troca só de quadra.
--
-- **Sem a recusa de inativo:** o adicional desativado depois da reserva não
-- impede movê-la — a unidade já foi tomada, e só a criação é recusada por
-- inatividade (matriz da spec: `P3304` só em `createBooking`).
CREATE FUNCTION ocupacao_com_adicionais_confere_estoque() RETURNS trigger AS $$
DECLARE
  item        record;
  v_estoque   integer;
  v_reservado integer;
BEGIN
  FOR item IN
    SELECT adicional_id, quantidade
      FROM adicionais_da_ocupacao
     WHERE ocupacao_id = NEW.id
     ORDER BY adicional_id
  LOOP
    SELECT estoque INTO v_estoque
      FROM adicionais
     WHERE company_id = NEW.company_id AND id = item.adicional_id
       FOR UPDATE;

    SELECT coalesce(sum(i.quantidade), 0) INTO v_reservado
      FROM adicionais_da_ocupacao i
      JOIN ocupacoes_quadra o ON o.company_id = i.company_id AND o.id = i.ocupacao_id
     WHERE i.adicional_id = item.adicional_id
       AND o.status_pagamento <> 'cancelado'
       AND o.id <> NEW.id
       AND tsrange(o.data + o.hora_inicio, o.data + o.hora_fim)
        && tsrange(NEW.data + NEW.hora_inicio, NEW.data + NEW.hora_fim);

    IF v_reservado + item.quantidade > v_estoque THEN
      RAISE EXCEPTION 'ESTOQUE_ESGOTADO adicional=%', item.adicional_id
        USING ERRCODE = 'P3303';
    END IF;
  END LOOP;
  RETURN NULL;
END $$ LANGUAGE plpgsql VOLATILE;
CREATE TRIGGER ocupacao_com_adicionais_confere_estoque
  AFTER UPDATE ON ocupacoes_quadra
  FOR EACH ROW
  WHEN (
    (NEW.data, NEW.hora_inicio, NEW.hora_fim) IS DISTINCT FROM (OLD.data, OLD.hora_inicio, OLD.hora_fim)
    OR (OLD.status_pagamento = 'cancelado' AND NEW.status_pagamento <> 'cancelado')
  )
  EXECUTE FUNCTION ocupacao_com_adicionais_confere_estoque();

-- =====================================================================
-- D6 / INV-135 — o que o item cobra cabe no valor, e o valor não muda depois
-- =====================================================================

-- `valor` = valor-base + Σ (preço × quantidade). A soma dos itens nunca passa
-- do valor da ocupação: rede de erro de cálculo, inalcançável por rota.
CREATE FUNCTION adicionais_cabem_no_valor() RETURNS trigger AS $$
DECLARE
  v_valor numeric(10,2);
  v_soma  numeric;
BEGIN
  SELECT valor INTO v_valor FROM ocupacoes_quadra WHERE id = NEW.ocupacao_id;
  SELECT coalesce(sum(valor_unitario * quantidade), 0) INTO v_soma
    FROM adicionais_da_ocupacao
   WHERE ocupacao_id = NEW.ocupacao_id;
  IF v_valor IS NULL OR v_soma > v_valor THEN
    RAISE EXCEPTION
      'os adicionais (%) passam do valor da reserva (%) (SPEC-054/INV-135)', v_soma, v_valor
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER adicionais_cabem_no_valor
  AFTER INSERT ON adicionais_da_ocupacao
  FOR EACH ROW EXECUTE FUNCTION adicionais_cabem_no_valor();

-- O débito foi calculado sobre `valor`, e a devolução devolve o consumo sem
-- recalcular: com item, o valor não muda.
CREATE FUNCTION valor_com_adicionais_imutavel() RETURNS trigger AS $$
BEGIN
  IF NEW.valor IS DISTINCT FROM OLD.valor
     AND EXISTS (SELECT 1 FROM adicionais_da_ocupacao WHERE ocupacao_id = NEW.id) THEN
    RAISE EXCEPTION
      'o valor de reserva com adicional nao muda (SPEC-054/INV-135)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER valor_com_adicionais_imutavel
  BEFORE UPDATE OF valor ON ocupacoes_quadra
  FOR EACH ROW EXECUTE FUNCTION valor_com_adicionais_imutavel();

COMMIT;
