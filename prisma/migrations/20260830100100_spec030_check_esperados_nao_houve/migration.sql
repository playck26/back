-- SPEC-030:TASK-001 (2 de 2) — `nao_houve` entra no CHECK de `esperados`.
--
-- Depende de `20260830100000_spec030_completude_nao_houve` ter COMMITADO:
-- ela cria o valor no enum, e um literal 'nao_houve' so e valido depois
-- disso. Ver o cabecalho de la.
--
-- CHECKLIST DA LICAO DE 2026-08-22 (o 500 que chegou a producao): esta
-- migration toca **um** CHECK, `chamadas_completude_esperados_check`, criado
-- em `20260823140000_chamadas_expand`. Nao toca
-- `chamadas_origem_tipo_check`, nem os CHECKs de `usuarios`, `presencas` ou
-- `ocupacoes_quadra`. Conferido por `grep -rn CHECK prisma/migrations/`
-- antes de escrever, nao suposto.

-- =========================================================================
-- O CHECK, com o terceiro caso
-- =========================================================================

-- DROP + ADD, e nao ALTER: Postgres nao tem `ALTER CONSTRAINT` para mudar a
-- expressao de um CHECK. O nome e reaproveitado de proposito — quem for
-- procurar a regra amanha procura por este nome.
ALTER TABLE "chamadas" DROP CONSTRAINT "chamadas_completude_esperados_check";

-- Os TRES casos enumerados, um a um. A alternativa curta seria
-- `completude <> 'completa' AND esperados IS NULL`, que cobriria
-- `desconhecida` e `nao_houve` de uma vez **e tambem qualquer valor futuro**
-- — e e exatamente isso que a descarta: um valor futuro que precise de
-- `esperados` passaria calado por uma regra que ninguem reescreveu. Enumerar
-- falha alto no dia em que alguem acrescentar o quarto valor, e falhar alto
-- e o comportamento desejado aqui.
--
-- `nao_houve` com `esperados IS NULL` pela mesma razao que `desconhecida`:
-- quem afirma que a aula nao aconteceu nao esta afirmando sobre quantos
-- alunos eram esperados. Nao ha chamada, entao nao ha universo.
ALTER TABLE "chamadas" ADD CONSTRAINT "chamadas_completude_esperados_check"
  CHECK (
    ("completude" = 'completa' AND "esperados" IS NOT NULL AND "esperados" > 0)
    OR
    ("completude" = 'desconhecida' AND "esperados" IS NULL)
    OR
    ("completude" = 'nao_houve' AND "esperados" IS NULL)
  );
