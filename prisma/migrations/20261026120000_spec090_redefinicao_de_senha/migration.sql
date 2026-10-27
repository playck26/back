-- SPEC-090/TASK-001 — o pedido de redefinicao de senha (D2): duas tabelas,
-- tres indices, um CHECK e duas FKs. Nenhuma credencial guardada.
--
-- **Esta migration nao liga nada.** Nenhuma rota le ou escreve estas tabelas
-- antes da TASK-002 (`RedefinicaoService` e as tres rotas publicas). Binario
-- antigo continua valido sobre este schema: nenhuma tabela existente muda,
-- nenhuma coluna e removida, nenhum enum e tocado — o `resultado_do_email` e
-- o da SPEC-083, reusado como esta.
--
-- Rollback: as tabelas sao novas e ninguem depende delas. Reverter o Back as
-- deixa sem escritor e sem leitor (secao "Rollout e rollback" da spec), e
-- desfaze-las seria uma migration nova, nunca a edicao desta.
--
-- **Por que nao reusar `convites_de_acesso`** (D2): o convite exige senha
-- temporaria, tem UM vivo por usuario e alimenta a situacao da ficha. Um
-- pedido de redefinicao revogaria o convite que o gestor acabou de mandar, e
-- a ficha leria a redefinicao como convite.
--
-- **Por que duas tabelas:** um link cobre N contas do mesmo e-mail (I2), cada
-- conta com a sua impressao. Uma tabela so exigiria um array de ids sem FK.
--
-- **O desenho e o da D2, coluna por coluna.** As diferencas sao de FORMA, e
-- nenhuma de regra: as constraints que o rascunho deixa sem nome (PK do
-- pedido e a FK do pedido) ganharam o nome que o Postgres e o Prisma ja dariam
-- a elas, escrito por extenso; o ON UPDATE das duas FKs e escrito (NO ACTION,
-- o padrao do Postgres), porque o padrao do Prisma e outro e o
-- `schema.prisma` o declara explicito — omitir de um lado seria drift.

-- ==========================================================================
-- 1. O pedido
-- ==========================================================================

CREATE TABLE "pedidos_de_redefinicao" (
  "id"              UUID                 NOT NULL DEFAULT gen_random_uuid(),
  -- O e-mail como foi digitado, sem normalizar (LIM-090-01, a mesma
  -- comparacao exata do login). Serve so ao teto de 3 por hora (D3); quem o
  -- pedido cobre esta em `contas_da_redefinicao`, nao aqui.
  "email"           TEXT                 NOT NULL,
  -- sha256 hex do token, pela razao da SPEC-083: o hash e a CHAVE DE BUSCA,
  -- entao tem de ser deterministico. O token cru so existe em memoria, entre a
  -- emissao e o envio (INV-090g).
  "token_hash"      TEXT                 NOT NULL,
  -- `criado_em` + 60 min (`VALIDADE_DA_REDEFINICAO_EM_MINUTOS`).
  "expira_em"       TIMESTAMPTZ          NOT NULL,
  -- INV-090a — um link redefine no maximo UMA conta, uma vez (I6). O
  -- `UPDATE ... SET usado_em = now() WHERE usado_em IS NULL AND expira_em >
  -- now()` da D5, passo 4, e a guarda: 0 linhas e `410`. Fica no PEDIDO, e
  -- nao na conta, de proposito — redefinir uma conta mata o link para todas.
  "usado_em"        TIMESTAMPTZ,
  -- O resultado do envio, gravado num UPDATE DEPOIS do commit (D3, passo 5),
  -- como o do convite. NULL e o terceiro estado: o processo caiu entre o
  -- COMMIT e a gravacao (LIM-090-06).
  "email_resultado" "resultado_do_email",
  "email_motivo"    TEXT,
  "email_em"        TIMESTAMPTZ,
  "criado_em"       TIMESTAMPTZ          NOT NULL DEFAULT now(),

  CONSTRAINT "pedidos_de_redefinicao_pkey" PRIMARY KEY ("id"),

  -- O resultado e o instante andam juntos, nos dois sentidos — o mesmo CHECK
  -- de `convites_de_acesso_email_coerente`, e pela mesma razao: e o NULL dos
  -- dois que significa "sem confirmacao", e o CHECK impede que ele seja
  -- ambiguo.
  CONSTRAINT "pedidos_de_redefinicao_email_coerente"
    CHECK (("email_resultado" IS NULL) = ("email_em" IS NULL))
);

-- O token e a chave de busca do `GET` e do `POST` publicos (D4, D5). UNIQUE
-- porque dois pedidos com o mesmo hash fariam o link de um abrir as contas do
-- outro — com 256 bits nao acontece por acaso, e o banco garante o resto.
CREATE UNIQUE INDEX "pedidos_de_redefinicao_token_hash_key"
  ON "pedidos_de_redefinicao" ("token_hash");

-- O teto por e-mail (D3, passo 3): `count(*) WHERE email = $1 AND criado_em >
-- now() - interval '1 hour'`. **O teto e so aplicacao** (LIM-090-02): este
-- indice faz a contagem barata, nao a faz valer sob corrida.
CREATE INDEX "pedidos_de_redefinicao_email_criado_em_idx"
  ON "pedidos_de_redefinicao" ("email", "criado_em");

-- ==========================================================================
-- 2. As contas do pedido
-- ==========================================================================

CREATE TABLE "contas_da_redefinicao" (
  "pedido_id"            UUID NOT NULL,
  -- NOT NULL e o que, junto com a FK composta, deixa o `super_admin` (que tem
  -- `company_id` nulo) sem pedido nenhum (D7, INV-090c) — o mesmo mecanismo do
  -- convite (INV-083d).
  "company_id"           UUID NOT NULL,
  "usuario_id"           UUID NOT NULL,
  -- sha256 de `usuarios.senha_hash` NA EMISSAO, lido na transacao do pedido e
  -- sem trava (D3, passo 4). E o que mata o link para esta conta quando a
  -- senha muda por qualquer caminho (INV-090b): o `POST` compara este valor
  -- com a senha lida sob `FOR UPDATE`, e o bcrypt tem salt — senha nova nunca
  -- volta a bater. Erro sempre para o lado fechado.
  "impressao_credencial" TEXT NOT NULL,

  -- INV-090f, a parte do banco: a associacao pedido-conta e unica. **Nada no
  -- banco condiciona o UPDATE da senha a um pedido** — quem exige esta linha
  -- antes de escrever `usuarios` e o `POST` (D5, passo 1).
  CONSTRAINT "contas_da_redefinicao_pkey" PRIMARY KEY ("pedido_id", "usuario_id")
);

-- ==========================================================================
-- 3. As duas FKs
-- ==========================================================================

-- Conta -> pedido. CASCADE: a conta nao existe sem o pedido que a cobre. **Nao
-- ha cascata reversa** — apagar a ultima conta NAO apaga o pedido, que fica
-- orfao e responde `410` (D2). Por isso a limpeza dos testes tem um passo
-- proprio para ele (`test/banco/limpar-empresa.ts`).
ALTER TABLE "contas_da_redefinicao"
  ADD CONSTRAINT "contas_da_redefinicao_pedido_id_fkey"
  FOREIGN KEY ("pedido_id")
  REFERENCES "pedidos_de_redefinicao" ("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- INV-090c — FK COMPOSTA, como `convites_de_acesso_usuario_fkey`. O alvo
-- `usuarios(company_id, id)` ja existe (`usuarios_company_id_id_key`, DEF-024
-- fase 1). O `super_admin` tem `company_id` nulo: com `company_id` NOT NULL
-- aqui, nenhuma linha dele satisfaz a FK (`23503`), e a linha com NULL nem
-- chega a ela (`23502`). E a conta do pedido nao cruza empresa.
--
-- CASCADE porque conta que nao existe mais nao tem senha para redefinir.
ALTER TABLE "contas_da_redefinicao"
  ADD CONSTRAINT "contas_da_redefinicao_usuario_fkey"
  FOREIGN KEY ("company_id", "usuario_id")
  REFERENCES "usuarios" ("company_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
