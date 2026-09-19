-- SPEC-062/TASK-002 (card 5328, parte 1) — infraestrutura de push: as duas
-- tabelas, o enum e as tres travas que o Prisma nao expressa.
--
-- **Esta migration nao liga nada.** Sem `PUSH_VAPID_PRIVATE_KEY`,
-- `PUSH_VAPID_PUBLIC_KEY` e `PUSH_VAPID_SUBJECT` o servico nasce desligado, a
-- rota de assinar responde `503` e o tick nao roda (D1b/D1c). A ordem do
-- rollout e TASK-002 -> TASK-003 -> TASK-001 (as variaveis) -> TASK-004/005.
--
-- **Binario antigo continua valido sobre este schema:** nenhuma tabela
-- existente muda, nenhuma coluna e removida, nenhum enum antigo e tocado. Quem
-- nao conhece `assinaturas_push` nem `notificacoes` simplesmente nao as le.
--
-- Rollback: as duas tabelas sao novas e ninguem depende delas.

-- ==========================================================================
-- D4 — os sete estados. Nao-terminais: `pendente` e `enviando`.
-- ==========================================================================

CREATE TYPE "estado_da_notificacao" AS ENUM (
  'pendente',
  'enviando',
  'aceita_pelo_servico',
  'sem_destino',
  'falha_definitiva',
  'falha_operacional',
  'expirada'
);

-- ==========================================================================
-- D2 — a assinatura e do APARELHO
-- ==========================================================================

CREATE TABLE "assinaturas_push" (
  "id"              UUID        NOT NULL,
  "company_id"      UUID        NOT NULL,
  "usuario_id"      UUID        NOT NULL,
  -- CREDENCIAL (INV-062f): estes tres nunca vao para log, telemetria,
  -- resposta ou mensagem de erro. No log vai a impressao de 8 caracteres.
  "endpoint"        TEXT        NOT NULL,
  "p256dh"          TEXT        NOT NULL,
  "auth"            TEXT        NOT NULL,
  "criada_em"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "ultimo_uso_em"   TIMESTAMPTZ,
  "falhas_seguidas" INTEGER     NOT NULL DEFAULT 0,

  CONSTRAINT "assinaturas_push_pkey" PRIMARY KEY ("id")
);

-- INV-062d — um `endpoint`, um dono. E o banco que garante; a rota traduz o
-- `23505` para `409 ENDPOINT_EM_USO`.
CREATE UNIQUE INDEX "assinaturas_push_endpoint_key"
  ON "assinaturas_push" ("endpoint");

CREATE INDEX "assinaturas_push_usuario_idx"
  ON "assinaturas_push" ("company_id", "usuario_id");

-- INV-062c — FK COMPOSTA. O alvo `usuarios(company_id, id)` ja existe
-- (`usuarios_company_id_id_key`, DEF-024 fase 1). FK simples nao saberia de
-- `company_id`, e o aviso podia cruzar empresa.
ALTER TABLE "assinaturas_push"
  ADD CONSTRAINT "assinaturas_push_usuario_fkey"
  FOREIGN KEY ("company_id", "usuario_id")
  REFERENCES "usuarios" ("company_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ==========================================================================
-- D4 — a caixa de saida
-- ==========================================================================

CREATE TABLE "notificacoes" (
  "id"                   UUID                    NOT NULL,
  "company_id"           UUID                    NOT NULL,
  "destinatario_id"      UUID                    NOT NULL,
  -- OPACO nesta spec: a 063 poe a acao administrativa, a 064 a linha da fila.
  "origem_id"            UUID,
  "tipo"                 TEXT                    NOT NULL,
  "titulo"               TEXT                    NOT NULL,
  "corpo"                TEXT                    NOT NULL,
  "destino_url"          TEXT,
  "criada_em"            TIMESTAMPTZ             NOT NULL DEFAULT now(),
  -- D1a — de onde sai o TTL. `NULL` = sem prazo (TTL_PADRAO, 24 h).
  "expira_em"            TIMESTAMPTZ,
  "estado"               "estado_da_notificacao" NOT NULL DEFAULT 'pendente',
  "tentativas"           INTEGER                 NOT NULL DEFAULT 0,
  "proxima_tentativa_em" TIMESTAMPTZ             NOT NULL DEFAULT now(),
  "reivindicada_ate"     TIMESTAMPTZ,
  -- INV-062e — a CERCA.
  "reivindicada_por"     TEXT,
  "concluida_em"         TIMESTAMPTZ,
  "ultimo_erro"          TEXT,

  CONSTRAINT "notificacoes_pkey" PRIMARY KEY ("id")
);

-- INV-062h — **estado terminal e `concluida_em` andam juntos.**
--
-- Isto nasceu de um defeito real: a versao anterior da transicao 4 podia
-- gravar `expirada` com `concluida_em = NULL` — terminal que o relatorio le
-- como inconclusa. Consertar so o SQL deixaria a regra viva num lugar so: no
-- texto. Com o CHECK, QUALQUER transicao futura que erre esse par falha na
-- hora com `23514`, em vez de produzir uma linha que mente calada.
ALTER TABLE "notificacoes"
  ADD CONSTRAINT "notificacoes_terminal_conclusao_chk"
  CHECK (
    ("estado" IN ('aceita_pelo_servico', 'sem_destino', 'falha_definitiva',
                  'falha_operacional', 'expirada'))
    = ("concluida_em" IS NOT NULL)
  );

-- INV-062g — no maximo UM teste pendente por pessoa (D6). O `@Throttle` cai se
-- alguem esquecer o decorador; o indice parcial vale para qualquer caminho de
-- escrita, inclusive um `INSERT` futuro que ninguem reviu. A rota traduz o
-- `23505` para `409 TESTE_JA_ENFILEIRADO` — conflito de ESTADO, nao excesso de
-- ritmo (o `429` fica para o teto horario).
CREATE UNIQUE INDEX "notificacoes_teste_pendente_key"
  ON "notificacoes" ("destinatario_id")
  WHERE "tipo" = 'teste' AND "estado" IN ('pendente', 'enviando');

-- A reivindicacao (transicao 1) varre por aqui.
CREATE INDEX "notificacoes_fila_idx"
  ON "notificacoes" ("estado", "proxima_tentativa_em", "criada_em");

-- D6 — o teto horario conta por aqui: duas igualdades e um range.
CREATE INDEX "notificacoes_teste_janela_idx"
  ON "notificacoes" ("destinatario_id", "tipo", "criada_em");

-- INV-062c — mesma FK composta. **Sem CASCADE**: apagar usuario e gesto de
-- dominio que esta spec nao decide.
ALTER TABLE "notificacoes"
  ADD CONSTRAINT "notificacoes_destinatario_fkey"
  FOREIGN KEY ("company_id", "destinatario_id")
  REFERENCES "usuarios" ("company_id", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;
