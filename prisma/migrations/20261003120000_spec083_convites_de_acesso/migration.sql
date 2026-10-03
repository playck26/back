-- SPEC-083/TASK-002 — o convite de acesso (D6): o enum do resultado do e-mail,
-- a tabela, as duas FKs, os dois CHECK e o indice unico parcial.
--
-- **Esta migration nao liga nada.** Nenhuma rota le ou escreve
-- `convites_de_acesso` antes da TASK-004 (emitir, consultar, ativar) e da
-- TASK-005 (a importacao com convidados). Binario antigo continua valido sobre
-- este schema: nenhuma tabela existente muda, nenhuma coluna e removida,
-- nenhum enum antigo e tocado.
--
-- Rollback: a tabela e o tipo sao novos e ninguem depende deles. Reverter o
-- Back deixa a tabela sem escritor (secao "Rollout e rollback" da spec), e
-- desfaze-la seria uma migration nova, nunca a edicao desta.
--
-- **O desenho e o da D6, coluna por coluna.** Duas diferencas de FORMA, e
-- nenhuma de regra: as constraints que o rascunho deixa sem nome (PK, UNIQUE
-- do token e as duas FKs) ganharam nome, para o erro do banco dizer qual delas
-- mordeu; e o UNIQUE do token e um indice unico, e nao uma constraint inline,
-- que e como o Prisma escreve `@unique` (o mesmo de
-- `assinaturas_push_endpoint_key`, SPEC-062). A recusa e a mesma: `23505`.

-- ==========================================================================
-- 1. O resultado do envio
-- ==========================================================================
--
-- So dois valores, e NULL e o terceiro estado: "o processo caiu entre o
-- COMMIT e a gravacao do resultado". A ficha mostra esse caso como `falhou`
-- com motivo `sem_confirmacao` (D8, D9) — ele nao vira valor do enum porque
-- ninguem o grava: e justamente a ausencia de gravacao.
CREATE TYPE "resultado_do_email" AS ENUM ('enviado', 'falhou');

-- ==========================================================================
-- 2. A tabela
-- ==========================================================================

CREATE TABLE "convites_de_acesso" (
  "id"                   UUID                 NOT NULL DEFAULT gen_random_uuid(),
  -- NOT NULL e o que, junto com a FK composta, deixa o `super_admin` (que tem
  -- `company_id` nulo) sem convite nenhum (INV-083d).
  "company_id"           UUID                 NOT NULL,
  "usuario_id"           UUID                 NOT NULL,
  "criado_por_id"        UUID                 NOT NULL,
  -- sha256 do token, pela razao da SPEC-009 (`convites_aluno`): o hash e a
  -- CHAVE DE BUSCA, entao tem de ser deterministico — bcrypt, com salt, nunca
  -- casaria por igualdade. O token cru so existe em memoria, entre a emissao
  -- e o envio (INV-083f).
  "token_hash"           TEXT                 NOT NULL,
  -- sha256 de `usuarios.senha_hash` NA EMISSAO. E o que mata o link quando a
  -- senha muda por qualquer caminho (INV-083c): a ativacao compara este valor
  -- com a senha lida sob `FOR UPDATE`, e o bcrypt tem salt — senha nova nunca
  -- volta a bater. Compara ESTADO, e por isso nao precisa de lista de caminhos.
  "impressao_credencial" TEXT                 NOT NULL,
  -- 7 dias, a validade do convite e da senha temporaria desde a ADR-013.
  "expira_em"            TIMESTAMPTZ          NOT NULL,
  "usado_em"             TIMESTAMPTZ,
  "revogado_em"          TIMESTAMPTZ,
  -- O resultado do envio, gravado num UPDATE DEPOIS do commit (D8).
  "email_resultado"      "resultado_do_email",
  "email_motivo"         TEXT,
  "email_em"             TIMESTAMPTZ,
  "criado_em"            TIMESTAMPTZ          NOT NULL DEFAULT now(),

  CONSTRAINT "convites_de_acesso_pkey" PRIMARY KEY ("id"),

  -- Um convite termina de UM jeito: usado ou revogado, nunca os dois. Sem
  -- isto, um reenvio que revogasse um convite ja usado produziria uma linha
  -- que a situacao da ficha (D9) leria de dois modos.
  CONSTRAINT "convites_de_acesso_fim_unico"
    CHECK ("usado_em" IS NULL OR "revogado_em" IS NULL),

  -- O resultado e o instante andam juntos, nos dois sentidos: resultado sem
  -- instante, ou instante sem resultado, e uma gravacao pela metade. E o
  -- NULL dos dois que significa `sem_confirmacao` (secao 1), e o CHECK e o
  -- que impede esse NULL de ser ambiguo.
  CONSTRAINT "convites_de_acesso_email_coerente"
    CHECK (("email_resultado" IS NULL) = ("email_em" IS NULL))
);

-- ==========================================================================
-- 3. Os dois unicos
-- ==========================================================================

-- O token e a chave de busca da ativacao (D7, passo 1). UNIQUE porque dois
-- convites com o mesmo hash fariam o link de um ativar a conta do outro — com
-- 256 bits de entropia nao acontece por acaso, e o banco garante o resto.
CREATE UNIQUE INDEX "convites_de_acesso_token_hash_key"
  ON "convites_de_acesso" ("token_hash");

-- INV-083b — **no maximo UM convite vivo por usuario.** "Vivo" e nao usado e
-- nao revogado, e SO isso: um convite EXPIRADO e nao usado continua vivo para
-- o indice, de proposito. Por isso o reenvio (D9) o revoga na mesma transacao
-- em que emite o novo, sob `FOR UPDATE` no usuario; se a trava faltar numa
-- corrida, quem perde recebe `23505` aqui, e a ficha traduz para `409
-- CONVITE_EM_EMISSAO`.
--
-- Por que o prazo nao entra no predicado: `now()` nao e IMMUTABLE e nao pode
-- estar no WHERE de um indice — e, se pudesse, o indice mudaria de opiniao
-- sozinho com o relogio, sem nenhuma escrita.
--
-- **Parcial, e o Prisma nao expressa `WHERE`:** este indice NAO aparece no
-- `schema.prisma` (mesmo caso dos indices de `pre_reservas`, SPEC-074). Esta
-- migration e a fonte de verdade dele.
CREATE UNIQUE INDEX "convites_de_acesso_um_vivo_por_usuario"
  ON "convites_de_acesso" ("usuario_id")
  WHERE "usado_em" IS NULL AND "revogado_em" IS NULL;

-- ==========================================================================
-- 4. As duas FKs
-- ==========================================================================

-- INV-083d — FK COMPOSTA. O alvo `usuarios(company_id, id)` ja existe
-- (`usuarios_company_id_id_key`, DEF-024 fase 1). O `super_admin` tem
-- `company_id` nulo: com `company_id` NOT NULL aqui, nenhuma linha dele
-- satisfaz a FK (`23503`), e a linha com NULL nem chega a ela (`23502`).
-- E de quebra o convite nao cruza empresa.
--
-- CASCADE porque convite de conta que nao existe mais nao tem o que ativar.
-- ON UPDATE fica no padrao do Postgres (NO ACTION), como a D6 escreve: ids nao
-- mudam, e se um dia mudassem nao ha razao para o convite segui-los calado.
ALTER TABLE "convites_de_acesso"
  ADD CONSTRAINT "convites_de_acesso_usuario_fkey"
  FOREIGN KEY ("company_id", "usuario_id")
  REFERENCES "usuarios" ("company_id", "id")
  ON DELETE CASCADE;

-- Quem emitiu: o gestor, na ficha ou na importacao. FK SIMPLES, como a D6
-- escreve. Sem acao no DELETE (NO ACTION): apagar o gestor que convidou e
-- gesto de dominio que esta spec nao decide, e o banco recusa em vez de
-- escolher por ele.
ALTER TABLE "convites_de_acesso"
  ADD CONSTRAINT "convites_de_acesso_criado_por_fkey"
  FOREIGN KEY ("criado_por_id")
  REFERENCES "usuarios" ("id");
