-- SPEC-046 — reposição de aula. Fecha o GAP-008, aberto em 2026-08-09.
--
-- A metade "cancelar" já existia: `faltas_avisadas` (SPEC-031) é a tabela de
-- ausência por aluno/ocorrência que o GAP dizia faltar. Esta migration traz a
-- metade que faltava — o aluno frequentar OUTRA ocorrência no lugar.
BEGIN;

-- =====================================================================
-- As duas configurações, no lugar onde configuração de operação já mora
-- =====================================================================
--
-- **Nulas, e nulo significa "usa o padrão" — nunca "zero".** É a lição que o
-- próprio `ConfigOperacaoService` documenta sobre os prazos: *"`prazo ?? 0`
-- compila neste projeto, e produziria prazo de zero horas, que é o oposto de
-- sem prazo"*. Teto zero seria "nenhuma reposição permitida", que é o oposto
-- de "o clube não configurou".
ALTER TABLE "config_operacao_empresa"
  ADD COLUMN "reposicoes_por_mes" INTEGER,
  ADD COLUMN "reposicao_validade_dias" INTEGER;

-- Positivos quando existirem. Sem os CHECKs, um `-1` no teto faria toda
-- reposição ser recusada com "teto estourado", e a mensagem culparia o aluno
-- por um erro de digitação do gestor.
ALTER TABLE "config_operacao_empresa"
  ADD CONSTRAINT "config_reposicoes_por_mes_positivo"
    CHECK ("reposicoes_por_mes" IS NULL OR "reposicoes_por_mes" > 0),
  ADD CONSTRAINT "config_reposicao_validade_positiva"
    CHECK ("reposicao_validade_dias" IS NULL OR "reposicao_validade_dias" > 0);

-- =====================================================================
-- A reposição
-- =====================================================================
CREATE TABLE "reposicoes_de_aula" (
  "id"          UUID NOT NULL,
  "company_id"  UUID NOT NULL,
  "aluno_id"    UUID NOT NULL,
  -- Qual falta esta reposição consome. **É a chave da INV-118.**
  "falta_id"    UUID NOT NULL,
  -- Qual ocorrência ele vai frequentar.
  "ocupacao_id" UUID NOT NULL,
  -- INV-119 — constante `TURMA`, o lado que APONTA na FK composta.
  --
  -- **`NOT NULL DEFAULT` + `CHECK`, e não `GENERATED ALWAYS`** — é o molde do
  -- `presencas.origem_tipo` (INV-016), e a escolha tem consequência de TIPO:
  -- coluna gerada obriga o Prisma a declarar o campo opcional, e com ele a
  -- relação inteira (`OcupacaoQuadra?`). Seria mentira no tipo, porque a linha
  -- sempre tem ocupação. O `CHECK` dá a mesma garantia sem esse custo.
  --
  -- Repor numa reserva avulsa não faz sentido — não há turma, não há chamada,
  -- não há professor esperando. O banco recusa, e não por lembrança de quem
  -- escreve o serviço.
  "origem_tipo" "origem_tipo" NOT NULL DEFAULT 'TURMA'::"origem_tipo",
  "criado_em"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "reposicoes_de_aula_pkey" PRIMARY KEY ("id")
);

-- =====================================================================
-- INV-118 — uma falta gera no máximo UMA reposição
-- =====================================================================
--
-- **É o que torna o crédito DERIVADO seguro.** A SPEC-046/D1 decidiu não ter
-- coluna de saldo: crédito é `faltas − reposições`. Sob concorrência, sem esta
-- constraint, dois `POST` simultâneos com a mesma `falta_id` produziriam duas
-- reposições para uma falta — e a subtração ficaria NEGATIVA. "Crédito
-- derivado" viraria "crédito inventado".
--
-- A pré-checagem no serviço existe para a mensagem (`409 FALTA_JA_REPOSTA`);
-- a garantia é esta linha. Mesma divisão de trabalho da `EXCLUDE` na INV-001.
ALTER TABLE "reposicoes_de_aula"
  ADD CONSTRAINT "reposicoes_falta_unica" UNIQUE ("falta_id");

ALTER TABLE "reposicoes_de_aula"
  ADD CONSTRAINT "reposicoes_origem_tipo_constante"
    CHECK ("origem_tipo" = 'TURMA'::"origem_tipo");

-- INV-120 — o mesmo aluno não repõe duas vezes na mesma ocorrência.
-- Sem ela, a chamada mostraria o mesmo nome duas vezes e o professor não
-- saberia qual marcar.
ALTER TABLE "reposicoes_de_aula"
  ADD CONSTRAINT "reposicoes_aluno_ocupacao" UNIQUE ("ocupacao_id", "aluno_id");

-- =====================================================================
-- As FKs — todas compostas, todas carregando a empresa (DEF-024)
-- =====================================================================
ALTER TABLE "reposicoes_de_aula"
  ADD CONSTRAINT "reposicoes_company_fkey"
    FOREIGN KEY ("company_id") REFERENCES "empresas" ("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

-- INV-121 — o aluno é da MESMA empresa. Sem o par, a reposição do clube A
-- poderia apontar para o aluno do clube B.
ALTER TABLE "reposicoes_de_aula"
  ADD CONSTRAINT "reposicoes_aluno_fkey"
    FOREIGN KEY ("company_id", "aluno_id") REFERENCES "alunos" ("company_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

-- INV-119 — a ocupação é de TURMA, e é o par (id, origem_tipo) que o prova:
-- a constante do CHECK acima só casa com linha cuja origem seja TURMA.
ALTER TABLE "reposicoes_de_aula"
  ADD CONSTRAINT "reposicoes_ocupacao_tipo_fkey"
    FOREIGN KEY ("ocupacao_id", "origem_tipo")
    REFERENCES "ocupacoes_quadra" ("id", "origem_tipo")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

-- E a ocupação também é da mesma empresa.
ALTER TABLE "reposicoes_de_aula"
  ADD CONSTRAINT "reposicoes_ocupacao_empresa_fkey"
    FOREIGN KEY ("company_id", "ocupacao_id")
    REFERENCES "ocupacoes_quadra" ("company_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

-- A falta que ela consome. `RESTRICT` de propósito: apagar a falta deixaria a
-- reposição órfã, e o crédito derivado passaria a contar errado para sempre.
ALTER TABLE "reposicoes_de_aula"
  ADD CONSTRAINT "reposicoes_falta_fkey"
    FOREIGN KEY ("falta_id") REFERENCES "faltas_avisadas" ("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

-- =====================================================================
-- Índices
-- =====================================================================
--
-- `(company_id, aluno_id)` é a consulta do crédito, feita a cada abertura da
-- tela do aluno. `(ocupacao_id)` é a da chamada e a da capacidade — esta roda
-- DENTRO da transação que segura `turmas FOR UPDATE`, então varredura aqui
-- seguraria o lock por mais tempo, que é o custo que ninguém vê até doer.
CREATE INDEX "reposicoes_aluno_idx" ON "reposicoes_de_aula" ("company_id", "aluno_id");
CREATE INDEX "reposicoes_ocupacao_idx" ON "reposicoes_de_aula" ("ocupacao_id");

COMMIT;
