-- SPEC-037/TASK-001 — plano, matricula, e o contrato exigido PELO BANCO.
--
-- **SQL manual, e e norma nesta base** (mesma razao da SPEC-033): o DDL que o
-- `prisma migrate diff` gera a partir do modelo transforma `GENERATED ALWAYS
-- ... STORED` num `DEFAULT CASE ...` que o Postgres recusa com `0A000`. O
-- `schema.prisma` declara as duas colunas geradas como `dbgenerated`, que e
-- como o Prisma as REPRESENTA; quem cria o banco e este arquivo.
--
-- Ensaiada bloco a bloco contra PostgreSQL 18.4 local ANTES de existir, com o
-- caso que importa: `ALTER TABLE aceites ADD COLUMN ... GENERATED` numa tabela
-- que **ja tem linhas**, que e o estado de producao.

-- ==========================================================================
-- 1. PLANOS
-- ==========================================================================
--
-- **Sem contador de versao, e a ausencia e a decisao (D3).** A matricula
-- CONGELA valor e prazo, entao mudar o preco do plano amanha nao reescreve o
-- que foi contratado ontem -- que e exatamente o trabalho que um `versao`
-- faria. Um contador que nada le e cerimonia. O que impede apagar historia e a
-- FK `RESTRICT` de `matriculas.plano_id`: plano contratado nao e excluido, e
-- **desativado**.
--
-- `link_pagamento_url` NULO significa "herda da empresa" (D6), e nao "nao
-- tem". Mesma forma de `horarios_funcionamento`, onde `quadra_id IS NULL` e o
-- padrao do clube: mudar o link da empresa alcanca todos os planos sem
-- escrever em nenhum.
CREATE TABLE "planos" (
  "id"                 UUID PRIMARY KEY,
  "company_id"         UUID NOT NULL,
  "nome"               TEXT NOT NULL,
  "valor_centavos"     INTEGER NOT NULL,
  "prazo_meses"        INTEGER NOT NULL,
  "link_pagamento_url" TEXT,
  "ativo"              BOOLEAN NOT NULL DEFAULT true,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- **Sem DEFAULT, e e o padrao das irmas** (`config_operacao_empresa`,
  -- `disponibilidades_professor`): quem escreve `updated_at` e o Prisma, pelo
  -- `@updatedAt`. Um DEFAULT no banco faria o `migrate diff` acusar drift
  -- permanente, porque o modelo nao declara default nenhum -- conferido.
  "updated_at"         TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "planos_empresa_fkey"
    FOREIGN KEY ("company_id") REFERENCES "empresas" ("id") ON DELETE RESTRICT,
  -- Zero e legitimo: plano de cortesia existe. Negativo nao e desconto, e
  -- digitacao errada -- e viraria receita negativa em qualquer relatorio.
  CONSTRAINT "planos_valor_nao_negativo" CHECK ("valor_centavos" >= 0),
  -- 60 e o teto porque plano de mais de cinco anos e engano de digitacao, nao
  -- produto. O piso de 1 impede o plano de zero mes, cujo `fim` cairia no
  -- proprio `inicio` e quebraria o CHECK da matricula la embaixo.
  CONSTRAINT "planos_prazo_positivo" CHECK ("prazo_meses" BETWEEN 1 AND 60),
  CONSTRAINT "planos_nome_nao_vazio" CHECK (btrim("nome") <> '')
);

CREATE INDEX "planos_company_idx" ON "planos" ("company_id");

-- Alvo das FKs compostas (DEF-024). `id` ja e PK, entao este UNIQUE nunca
-- falha por duplicata: existe so para o `REFERENCES` de duas colunas ter onde
-- se apoiar. Mesmo papel de `quadras_company_id_id_key`.
ALTER TABLE "planos"
  ADD CONSTRAINT "planos_company_id_id_key" UNIQUE ("company_id", "id");

-- ==========================================================================
-- 2. A COLUNA GERADA EM `aceites`, E A UNIQUE QUE A FK VAI MIRAR (D5)
-- ==========================================================================
--
-- **Este bloco e o coracao da spec.** Uma matricula sem o contrato aceito e
-- buraco juridico, e "a aplicacao confere" e premissa -- a mesma classe de
-- premissa que ja reprovou spec inteira nesta base.
--
-- A coluna gerada e um DISCRIMINANTE CONSTANTE: vale `'contrato'` na linha de
-- contrato e NULO na de termo. Sem ela, uma `UNIQUE (usuario_id, versao)`
-- casaria tambem o aceite do **TERMO** de mesma versao, e a matricula passaria
-- apontando para o aceite errado. Ensaiado: com so o termo v1 aceito, a
-- insercao da matricula v1 e recusada com `23503`.
--
-- `aceites` e **append-only por regra** (INV-024a). Acrescentar coluna gerada
-- nao e escrita de dado: e DDL, e foi conferido por execucao numa tabela com
-- linhas antes de este arquivo existir.
ALTER TABLE "aceites"
  ADD COLUMN "tipo_contrato" "tipo_de_aceite"
    GENERATED ALWAYS AS (CASE WHEN "tipo" = 'contrato'
                              THEN 'contrato'::"tipo_de_aceite" END) STORED;

ALTER TABLE "aceites"
  ADD CONSTRAINT "aceites_contrato_key"
  UNIQUE ("usuario_id", "tipo_contrato", "versao");

-- ==========================================================================
-- 3. MATRICULAS
-- ==========================================================================
--
-- **Congela valor E valor de tabela** (D1/D2). O primeiro e o que foi
-- acertado; o segundo e o que o plano cobrava naquele dia. Sem os dois,
-- ninguem distingue "houve desconto" de "o plano mudou de preco depois" -- e e
-- a primeira pergunta de quem ve uma matricula abaixo da tabela.
--
-- `usuario_id` esta aqui e parece redundante com `aluno_id`: e a **perna da FK
-- do aceite**, porque `aceites` e por USUARIO (quem assina e a pessoa, nao a
-- ficha). Sem ela, a FK causal nao teria como existir.
--
-- `fim` e GRAVADO, nao derivado na leitura (D9): consultar "quem vence este
-- mes" viraria varredura com aritmetica de data, e a primeira tela que
-- precisasse repetiria a regra. Gravado, e indice.
CREATE TABLE "matriculas" (
  "id"                       UUID PRIMARY KEY,
  "company_id"               UUID NOT NULL,
  "aluno_id"                 UUID NOT NULL,
  "usuario_id"               UUID NOT NULL,
  "plano_id"                 UUID NOT NULL,
  "valor_centavos"           INTEGER NOT NULL,
  "valor_de_tabela_centavos" INTEGER NOT NULL,
  "prazo_meses"              INTEGER NOT NULL,
  "inicio"                   DATE NOT NULL,
  "fim"                      DATE NOT NULL,
  "contrato_versao"          INTEGER NOT NULL,
  "criado_por_id"            UUID NOT NULL,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  -- O discriminante do lado que APONTA. **`CASE WHEN contrato_versao IS NOT
  -- NULL` e nao a constante nua**, e o motivo e ferramental: com
  -- `GENERATED ALWAYS AS ('contrato'::tipo_de_aceite)`, o `prisma migrate
  -- diff` le a expressao como um literal de enum e emite `SET DEFAULT
  -- 'contrato'` -- drift permanente entre modelo e banco. Com o CASE, ele a
  -- trata como expressao crua e o diff fica limpo (conferido).
  --
  -- E a forma tambem diz a verdade: o tipo e `contrato` PORQUE ha versao de
  -- contrato. `contrato_versao` e NOT NULL, entao o ramo nulo nunca ocorre.
  "tipo_contrato" "tipo_de_aceite"
    GENERATED ALWAYS AS (CASE WHEN "contrato_versao" IS NOT NULL
                              THEN 'contrato'::"tipo_de_aceite" END) STORED,

  CONSTRAINT "matriculas_valor_nao_negativo" CHECK ("valor_centavos" >= 0),
  CONSTRAINT "matriculas_tabela_nao_negativo"
    CHECK ("valor_de_tabela_centavos" >= 0),
  CONSTRAINT "matriculas_prazo_positivo"
    CHECK ("prazo_meses" BETWEEN 1 AND 60),
  -- INV-113. Nao ha matricula de duracao zero: o `fim` sai de `inicio +
  -- prazo_meses`, e prazo >= 1 ja garante -- mas a regra vive no banco
  -- tambem, porque a aplicacao nao e o unico caminho.
  CONSTRAINT "matriculas_fim_depois_do_inicio" CHECK ("fim" > "inicio"),

  -- DEF-024: FKs COMPOSTAS. Sem elas o banco aceitaria matricula da empresa A
  -- apontando para aluno ou plano da B.
  CONSTRAINT "matriculas_empresa_fkey"
    FOREIGN KEY ("company_id") REFERENCES "empresas" ("id") ON DELETE RESTRICT,
  CONSTRAINT "matriculas_aluno_fkey"
    FOREIGN KEY ("company_id", "aluno_id")
    REFERENCES "alunos" ("company_id", "id") ON DELETE RESTRICT,
  -- INV-115: plano contratado NAO e apagado. `RESTRICT`, e a rota de exclusao
  -- nem existe -- o gestor desativa.
  CONSTRAINT "matriculas_plano_fkey"
    FOREIGN KEY ("company_id", "plano_id")
    REFERENCES "planos" ("company_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "matriculas_autor_fkey"
    FOREIGN KEY ("criado_por_id") REFERENCES "usuarios" ("id") ON DELETE RESTRICT,

  -- INV-114 — **a que da valor legal a tudo isto.**
  CONSTRAINT "matriculas_contrato_aceito_fkey"
    FOREIGN KEY ("usuario_id", "tipo_contrato", "contrato_versao")
    REFERENCES "aceites" ("usuario_id", "tipo_contrato", "versao")
    ON DELETE RESTRICT
);

CREATE INDEX "matriculas_aluno_idx" ON "matriculas" ("company_id", "aluno_id");
-- LIM-037e: nada avisa quando a matricula vence, e o indice existe para o dia
-- em que houver canal. Custa pouco e evita a varredura da primeira consulta.
CREATE INDEX "matriculas_fim_idx" ON "matriculas" ("company_id", "fim");

-- ==========================================================================
-- 4. O CONVITE CARREGA O PLANO (D8)
-- ==========================================================================
--
-- Opcional: o convite sem plano continua sendo o de hoje. Com plano, o aceite
-- cria conta + aceite + matricula na MESMA transacao (AC-015).
ALTER TABLE "convites_aluno" ADD COLUMN "plano_id" UUID;

ALTER TABLE "convites_aluno"
  ADD CONSTRAINT "convites_plano_fkey"
  FOREIGN KEY ("company_id", "plano_id")
  REFERENCES "planos" ("company_id", "id") ON DELETE RESTRICT;
