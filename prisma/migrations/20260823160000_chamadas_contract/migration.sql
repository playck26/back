-- SPEC-015:TASK-000d (DEF-002) — backfill + contract.
--
-- **Só pode ser aplicada com o backend novo já em produção e o rollout
-- fechado.** O backend antigo grava `presencas` sem cabeçalho; com a FK
-- abaixo no lugar, ele passaria a falhar por FK — 500 na cara do professor.
-- E uma escrita dele entre o backfill e o contract faria o próprio contract
-- falhar, por nascer uma presença que o backfill não alcançou.
--
-- **Ponto sem volta:** depois desta migration, voltar o backend para a
-- versão anterior quebra a escrita de chamada, porque aquela versão não
-- sabe criar cabeçalho. Reverter exige derrubar esta FK junto.

-- =========================================================================
-- BACKFILL — uma linha `desconhecida` para cada ocorrência com presença e
-- sem cabeçalho.
-- =========================================================================
--
-- Não afirma completude: afirma que ela **não é conhecida**, que é a única
-- coisa verdadeira sobre chamadas gravadas antes da correção.
--
-- Idempotente por construção, não por intenção (4ª validação cruzada):
-- `DISTINCT ON` com desempate estável (`created_at, id`) fixa **qual**
-- presença define `registrada_por`, e `ON CONFLICT DO NOTHING` faz a
-- reexecução — ou o reinício depois de falha parcial — não mudar nada.

INSERT INTO "chamadas" (
    "ocupacao_id", "origem_tipo", "company_id",
    "registrada_em", "registrada_por", "updated_at",
    "completude", "esperados"
)
SELECT DISTINCT ON (p."ocupacao_id")
    p."ocupacao_id",
    'TURMA'::"origem_tipo",
    p."company_id",
    p."created_at",
    p."registrado_por",
    NOW(),
    'desconhecida'::"completude_chamada",
    NULL
FROM "presencas" p
ORDER BY p."ocupacao_id", p."created_at", p."id"
ON CONFLICT ("ocupacao_id") DO NOTHING;

-- =========================================================================
-- CONTRACT — a FK que torna a INV-027 verdadeira no banco
-- =========================================================================
--
-- Sem ela, "presença sem cabeçalho é impossível" seria disciplina do
-- serviço — e a DEF-002 existe justamente porque confiar no serviço para
-- mandar o payload completo não bastou.
--
-- `ON DELETE NO ACTION`, e a escolha tem motivo:
--
-- * **não CASCADE**: apagar um cabeçalho passaria a apagar o histórico de
--   presença. O cabeçalho é metadado do fato; não pode ter poder de
--   destruir o fato.
-- * **não RESTRICT**: apagar uma ocorrência cascateia para `presencas` (FK
--   composta existente) **e** para `chamadas` (FK composta da fase expand)
--   na mesma instrução. RESTRICT é checado imediatamente e abortaria essa
--   deleção; NO ACTION é checado no fim da instrução, quando as duas pontas
--   já caíram. É a diferença entre os dois, e ela decide o caso.

ALTER TABLE "presencas" ADD CONSTRAINT "presencas_chamada_fkey"
  FOREIGN KEY ("ocupacao_id") REFERENCES "chamadas"("ocupacao_id")
  ON DELETE NO ACTION ON UPDATE CASCADE;
