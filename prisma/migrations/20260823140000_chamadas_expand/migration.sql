-- SPEC-015:TASK-000b (DEF-002) — o cabeçalho da chamada.
--
-- **EXPAND PURO. Esta migration NÃO cria a FK de `presencas` para
-- `chamadas`.** Aquela é a fase `contract`, arquivo separado, e só pode ser
-- aplicada depois que o backend novo estiver em produção com o rollout
-- fechado. Se as duas estiverem pendentes no mesmo disparo,
-- `prisma migrate deploy` aplica as duas e produção quebra: o backend antigo
-- ainda grava `presencas` sem cabeçalho, e passaria a falhar por FK.
--
-- Por que a tabela existe: a SPEC-014 modelou as linhas da chamada
-- (`presencas`) e não o fato dela. Duas linhas em `presencas` significam
-- tanto "chamada completa de uma turma de 2" quanto "chamada pela metade de
-- uma turma de 10", e nada no banco separava as duas — era a DEF-002.
--
-- CHECKLIST DA LIÇÃO DE 2026-08-22 (o 500 que chegou a produção):
-- constraint escrita à mão não aparece no `schema.prisma` e `migrate diff`
-- não a acusa. Esta migration **não** altera nenhum enum existente, **não**
-- toca `usuarios_company_id_role_check`, o CHECK de `valor` em
-- `ocupacoes_quadra` nem `presencas_origem_tipo_check`. Conferido antes de
-- aplicar.

-- =========================================================================
-- PASSO 1 — o enum de completude
-- =========================================================================

-- `desconhecida` não é estado transitório nem defeito: é o que se sabe sobre
-- as chamadas gravadas antes desta correção. O backfill (fase seguinte) as
-- marca assim, e isso é a única afirmação verdadeira possível sobre elas.
CREATE TYPE "completude_chamada" AS ENUM ('completa', 'desconhecida');

-- =========================================================================
-- PASSO 2 — a tabela
-- =========================================================================

CREATE TABLE "chamadas" (
    -- PK **e** parte da FK composta: uma chamada por ocorrência, com a
    -- cardinalidade vindo do banco e não da disciplina do serviço.
    "ocupacao_id" UUID NOT NULL,
    -- Coluna constante, igual a `presencas` e pelo mesmo motivo: sozinha é
    -- redundante; com o CHECK e a FK composta, torna impossível um cabeçalho
    -- apontar reserva avulsa. Escrever a tabela nova sem copiar esta
    -- construção da tabela vizinha foi o BLOQUEADOR-1 da 3ª validação.
    "origem_tipo" "origem_tipo" NOT NULL,
    "company_id" UUID NOT NULL,
    "registrada_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registrada_por" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completude" "completude_chamada" NOT NULL,
    -- Nulo **apenas** quando a completude é desconhecida: quem afirma que a
    -- chamada está completa tem de dizer sobre quantos alunos.
    "esperados" INTEGER,

    CONSTRAINT "chamadas_pkey" PRIMARY KEY ("ocupacao_id")
);

CREATE INDEX "chamadas_company_id_idx" ON "chamadas"("company_id");

-- =========================================================================
-- PASSO 3 — as constraints que fazem o trabalho
-- =========================================================================

ALTER TABLE "chamadas" ADD CONSTRAINT "chamadas_origem_tipo_check"
  CHECK ("origem_tipo" = 'TURMA');

-- Os dois sentidos, de propósito: `completa` sem `esperados` seria uma
-- afirmação sem lastro, e `desconhecida` com `esperados` seria lastro sem
-- afirmação. A promoção de `desconhecida` para `completa` tem de acontecer
-- num único UPDATE — dois updates separados passam por um estado que este
-- CHECK recusa, e o erro apareceria no meio de uma correção de chamada.
ALTER TABLE "chamadas" ADD CONSTRAINT "chamadas_completude_esperados_check"
  CHECK (
    ("completude" = 'completa' AND "esperados" IS NOT NULL AND "esperados" > 0)
    OR
    ("completude" = 'desconhecida' AND "esperados" IS NULL)
  );

-- CASCADE: apagar a ocorrência apaga o cabeçalho junto, como já apaga as
-- presenças. O cabeçalho é metadado do fato; sem o fato, ele não significa
-- nada.
ALTER TABLE "chamadas" ADD CONSTRAINT "chamadas_ocupacao_fkey"
  FOREIGN KEY ("ocupacao_id", "origem_tipo")
  REFERENCES "ocupacoes_quadra"("id", "origem_tipo")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chamadas" ADD CONSTRAINT "chamadas_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "empresas"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT: apagar o usuário não pode apagar o registro de quem fez a
-- chamada.
ALTER TABLE "chamadas" ADD CONSTRAINT "chamadas_registrada_por_fkey"
  FOREIGN KEY ("registrada_por") REFERENCES "usuarios"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
