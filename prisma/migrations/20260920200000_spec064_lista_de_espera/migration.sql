-- SPEC-064/TASK-001 (card 5331) — a lista de espera: a tabela, as duas
-- travas de forma, os quatro indices parciais e as quatro FKs compostas.
--
-- **Esta migration nao liga nada.** Nenhuma rota le ou escreve
-- `lista_de_espera` antes da TASK-002, e o varredor (TASK-003) so existe
-- depois. Binario antigo continua valido sobre este schema: nenhuma coluna
-- existente muda, nenhum enum antigo e tocado, e a unica alteracao em tabela
-- viva e uma chave NOVA em `faltas_avisadas`.
--
-- Rollback: a tabela e nova e ninguem depende dela.
--
-- **A DoR desta spec custou tres rodadas de validacao independente, e as duas
-- primeiras REPROVARAM.** O que esta aqui nao e a primeira ideia: e a terceira,
-- e duas correcoes anteriores criaram bloqueios novos. Os comentarios abaixo
-- dizem qual ensaio decidiu cada linha, porque quem mexer nisto depois vai
-- querer "simplificar" exatamente o que custou as rodadas.

-- ==========================================================================
-- 1. A chave que faltava em `faltas_avisadas` (achado v4-04, INV-064e)
-- ==========================================================================
--
-- Sem ela, a FK do credito so poderia ser `(company_id, falta_id)` — e a linha
-- da fila podia apontar para o credito **de outro aluno** da mesma empresa. O
-- banco garantia a empresa, e nada mais.
--
-- `id` ja e PK, entao `(company_id, aluno_id, id)` e redundante COMO CHAVE: ela
-- existe para SERVIR DE ALVO a uma FK composta. E o mesmo padrao de
-- `usuarios_company_id_id_key` (DEF-024) e das outras doze
-- `@@unique([companyId, id])` deste schema.
--
-- Nao recusa nenhuma linha existente: a PK `id` ja garante a unicidade da
-- tripla. `faltas_unica (ocupacao_id, aluno_id)` continua valendo.
ALTER TABLE "faltas_avisadas"
  ADD CONSTRAINT "faltas_company_aluno_id_key" UNIQUE ("company_id", "aluno_id", "id");

-- ==========================================================================
-- 2. Os seis estados (D2)
-- ==========================================================================
--
-- Nao-terminais: `aguardando` e `chamado`. Sao exatamente os dois que os
-- indices parciais e o segundo CHECK citam — quem acrescentar um estado
-- nao-terminal tem de mexer nos tres lugares.
CREATE TYPE "estado_da_fila_de_espera" AS ENUM (
  'aguardando',
  'chamado',
  'atendida',
  'expirada',
  'encerrada',
  'desistiu'
);

-- ==========================================================================
-- 3. A tabela
-- ==========================================================================

CREATE TABLE "lista_de_espera" (
  "id"           UUID                       NOT NULL,
  "company_id"   UUID                       NOT NULL,
  "aluno_id"     UUID                       NOT NULL,
  -- Exatamente UM dos dois: fila de TURMA (vaga de matricula) ou fila de AULA
  -- (vaga de reposicao). Direitos diferentes e gatilhos diferentes (D1).
  "turma_id"     UUID,
  "ocupacao_id"  UUID,
  -- O credito que da direito a fila de AULA. NULL na fila de turma, e vira
  -- NULL quando a falta e apagada — ver o bloco 6.
  "falta_id"     UUID,
  "estado"       "estado_da_fila_de_espera" NOT NULL DEFAULT 'aguardando',
  "criada_em"    TIMESTAMPTZ                NOT NULL DEFAULT now(),
  "chamado_em"   TIMESTAMPTZ,
  "chamado_ate"  TIMESTAMPTZ,
  "concluida_em" TIMESTAMPTZ,
  "motivo_fim"   TEXT,

  CONSTRAINT "lista_de_espera_pkey" PRIMARY KEY ("id"),

  -- INV-064c — fila de turma OU de aula: nunca as duas, nunca nenhuma.
  CONSTRAINT "fila_um_alvo_chk"
    CHECK (num_nonnulls("turma_id", "ocupacao_id") = 1),

  -- INV-064d — fila de AULA ativa tem credito.
  --
  -- **A clausula de estado nao e folga: e metade do mecanismo da INV-064g.**
  -- Quando a falta e apagada, a FK do bloco 6 anula `falta_id`; se este CHECK
  -- exigisse credito em qualquer estado, o `DELETE` morreria com 23514. A
  -- outra metade e a ORDEM — ver o bloco 6.
  CONSTRAINT "fila_credito_chk"
    CHECK ("ocupacao_id" IS NULL
           OR "falta_id" IS NOT NULL
           OR "estado" NOT IN ('aguardando', 'chamado'))
);

-- ==========================================================================
-- 4. Os quatro indices parciais (INV-064a, INV-064b)
-- ==========================================================================
--
-- Sao trava DE BANCO, nao disciplina de servico: a rota traduz o `23505` em
-- `409 JA_NA_FILA` (AC-001), e o varredor conta com o banco para nao criar dois
-- chamados no mesmo alvo sob concorrencia (AC-003).
--
-- Parciais `WHERE estado IN ('aguardando','chamado')` de proposito: quem saiu,
-- desistiu ou ja foi atendido pode entrar de novo. Sem o `WHERE`, uma unica
-- passagem pela fila proibiria a segunda para sempre.

-- INV-064b — uma inscricao ativa por aluno e alvo.
CREATE UNIQUE INDEX "fila_ativa_turma_key"
  ON "lista_de_espera" ("company_id", "aluno_id", "turma_id")
  WHERE "estado" IN ('aguardando', 'chamado');

CREATE UNIQUE INDEX "fila_ativa_ocupacao_key"
  ON "lista_de_espera" ("company_id", "aluno_id", "ocupacao_id")
  WHERE "estado" IN ('aguardando', 'chamado');

-- INV-064a — UM chamado por alvo. E o que permite ao varredor ser idempotente
-- sob concorrencia sem advisory lock (D8): dois ciclos simultaneos disputam
-- esta constraint, e um perde com 23505.
CREATE UNIQUE INDEX "fila_chamado_turma_key"
  ON "lista_de_espera" ("turma_id")
  WHERE "estado" = 'chamado';

CREATE UNIQUE INDEX "fila_chamado_ocupacao_key"
  ON "lista_de_espera" ("ocupacao_id")
  WHERE "estado" = 'chamado';

-- ==========================================================================
-- 5. As tres FKs de escopo (INV-064f)
-- ==========================================================================
--
-- COMPOSTAS, todas com `company_id`. FK simples nao saberia da empresa, e a
-- fila podia cruzar. Os tres alvos ja existem: `alunos_company_id_id_key`,
-- `turmas_company_id_id_key`, `ocupacoes_quadra_company_id_id_key`.
--
-- `ON DELETE RESTRICT` nos tres, como o resto do schema: apagar aluno, turma ou
-- ocupacao com fila viva e erro, nao limpeza silenciosa. Quem precisa encerrar
-- fila passa pela TASK-004, que escreve `motivo_fim`.
ALTER TABLE "lista_de_espera"
  ADD CONSTRAINT "fila_aluno_fkey"
  FOREIGN KEY ("company_id", "aluno_id")
  REFERENCES "alunos" ("company_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lista_de_espera"
  ADD CONSTRAINT "fila_turma_fkey"
  FOREIGN KEY ("company_id", "turma_id")
  REFERENCES "turmas" ("company_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lista_de_espera"
  ADD CONSTRAINT "fila_ocupacao_fkey"
  FOREIGN KEY ("company_id", "ocupacao_id")
  REFERENCES "ocupacoes_quadra" ("company_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ==========================================================================
-- 6. A FK do credito — a unica linha desta migration que custou duas rodadas
--    de validacao independente (INV-064g)
-- ==========================================================================
--
-- **A lista de colunas depois do SET NULL nao e enfeite.** Num
-- `ON DELETE SET NULL` SEM lista, o PostgreSQL anula TODAS as colunas da FK —
-- aqui tambem `company_id` e `aluno_id`, que sao NOT NULL. Medido: o `DELETE`
-- morria com **23502**. `SET NULL (coluna)` existe desde o PostgreSQL 15.
--
-- **E a FK sozinha NAO basta.** O CHECK do bloco 3 e avaliado NO ATO do
-- `SET NULL`, antes de qualquer UPDATE de encerramento chegar. Os caminhos,
-- ensaiados em PostgreSQL 18.4 na 2a e na 3a rodada:
--
--   CHECK ... DEFERRABLE             -> RECUSADO pelo Postgres:
--                                       "CHECK constraints cannot be marked DEFERRABLE"
--   SET NULL total + qualquer ordem  -> RECUSADO, 23502
--   SET NULL falta + DELETE->UPDATE  -> RECUSADO, 23514
--   SET NULL falta + UPDATE->DELETE  -> PASSA
--
-- Adiar o CHECK nao e opcao: o PostgreSQL nao aceita CHECK adiavel em versao
-- nenhuma. Entao a outra metade do mecanismo e de SEQUENCIA, e e NORMATIVA:
--
--   >> ENCERRAR A LINHA DA FILA VEM ANTES DE APAGAR A FALTA, na mesma
--   >> transacao. Nunca o contrario. (TASK-004, falta-avisada.service.ts)
--
-- **O que esta FK NAO e: uma rede.** Ela preserva `company_id` e `aluno_id`, e
-- nada mais. Com fila ativa, um apagamento de falta que NAO encerre a fila
-- antes continua morrendo com 23514 — nao ha constraint que faca isso por ele.
-- Hoje existe um unico apagamento (`falta-avisada.service.ts:217`); um segundo
-- e a forma conhecida de quebrar esta spec depois de pronta.
--
-- **O Prisma nao sabe expressar `SET NULL (coluna)`** — ver o comentario do
-- modelo `ListaDeEspera` em `schema.prisma`. Esta migration e a fonte de
-- verdade da acao referencial.
ALTER TABLE "lista_de_espera"
  ADD CONSTRAINT "fila_falta_fkey"
  FOREIGN KEY ("company_id", "aluno_id", "falta_id")
  REFERENCES "faltas_avisadas" ("company_id", "aluno_id", "id")
  ON DELETE SET NULL ("falta_id") ON UPDATE CASCADE;
