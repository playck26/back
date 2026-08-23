-- SPEC-014:TASK-001 — presença por ocorrência de aula.
--
-- Expand puro: uma tabela e um enum novos. Nenhuma linha existente muda e
-- não há backfill — não existe presença histórica a importar.
--
-- CHECKLIST DA LIÇÃO DE 2026-08-22 (o 500 que chegou a produção):
-- constraint escrita à mão não aparece no `schema.prisma` e `migrate diff`
-- não a acusa. Esta migration **não** altera nenhum enum existente e **não**
-- toca `usuarios_company_id_role_check` nem o CHECK de `valor` em
-- `ocupacoes_quadra`. Conferido antes de aplicar.

-- =========================================================================
-- PASSO 1 — o enum
-- =========================================================================

CREATE TYPE "status_presenca" AS ENUM ('presente', 'ausente', 'justificado');

-- =========================================================================
-- PASSO 2 — o alvo da FK composta
-- =========================================================================

-- `id` já é PK, então este UNIQUE é redundante para unicidade. Ele existe
-- por um motivo só: ser alvo de uma FK composta, que é o mecanismo pelo
-- qual INV-016 passa a ser imposta **pelo banco** em vez de por código.
ALTER TABLE "ocupacoes_quadra"
  ADD CONSTRAINT "ocupacoes_quadra_id_origem_tipo_key" UNIQUE ("id", "origem_tipo");

-- =========================================================================
-- PASSO 3 — a tabela
-- =========================================================================

CREATE TABLE "presencas" (
    "id" UUID NOT NULL,
    -- Escopo de tenant, como toda tabela de domínio. Sem ele, uma query que
    -- esqueça o join sai do escopo da empresa sem ninguém notar (ressalva
    -- da validação cruzada).
    "company_id" UUID NOT NULL,
    "ocupacao_id" UUID NOT NULL,
    -- Coluna constante, e é de propósito: participa da FK composta abaixo.
    -- Sozinha ela é redundante; junto com o CHECK e a FK, ela torna
    -- impossível uma presença apontar reserva avulsa.
    "origem_tipo" "origem_tipo" NOT NULL,
    "aluno_id" UUID NOT NULL,
    "status" "status_presenca" NOT NULL,
    "registrado_por" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "presencas_pkey" PRIMARY KEY ("id")
);

-- INV-015: um aluno tem no máximo um registro por aula. É o que torna o
-- PUT da chamada idempotente — reenviar o mesmo corpo não duplica nada.
CREATE UNIQUE INDEX "presencas_ocupacao_id_aluno_id_key"
  ON "presencas"("ocupacao_id", "aluno_id");

CREATE INDEX "presencas_company_id_ocupacao_id_idx"
  ON "presencas"("company_id", "ocupacao_id");
CREATE INDEX "presencas_aluno_id_idx" ON "presencas"("aluno_id");

-- INV-016, metade imposta pelo banco: presença só existe para aula de
-- turma. O CHECK trava a coluna em 'TURMA' e a FK composta obriga a
-- ocupação referenciada a ter esse mesmo `origem_tipo` — não há caminho
-- pelo qual código errado grave presença numa reserva avulsa.
--
-- A outra metade (aula não cancelada) fica no serviço, e isso é decisão,
-- não limitação: é regra de **escrita**. `cancelFutureClassOccupancies`
-- cancela com `data >= hoje`, então uma edição de horário à tarde cancela a
-- aula da manhã — se a constraint valesse para sempre, a chamada feita
-- antes do almoço viraria dado inválido e o cancelamento passaria a falhar.
-- Aula cancelada depois não desfaz quem esteve lá (AC-012).
ALTER TABLE "presencas" ADD CONSTRAINT "presencas_origem_tipo_check"
  CHECK ("origem_tipo" = 'TURMA');

ALTER TABLE "presencas" ADD CONSTRAINT "presencas_ocupacao_fkey"
  FOREIGN KEY ("ocupacao_id", "origem_tipo")
  REFERENCES "ocupacoes_quadra"("id", "origem_tipo")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "presencas" ADD CONSTRAINT "presencas_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "empresas"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT nos dois: apagar aluno ou usuário não pode apagar o registro de
-- que a aula aconteceu daquele jeito.
ALTER TABLE "presencas" ADD CONSTRAINT "presencas_aluno_id_fkey"
  FOREIGN KEY ("aluno_id") REFERENCES "alunos"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "presencas" ADD CONSTRAINT "presencas_registrado_por_fkey"
  FOREIGN KEY ("registrado_por") REFERENCES "usuarios"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
