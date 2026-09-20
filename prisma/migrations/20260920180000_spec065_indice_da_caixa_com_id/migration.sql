-- SPEC-065 — **o índice da caixa ganha o `id`, e por que isto é uma migration
-- NOVA em vez de uma correção na anterior.**
--
-- A `20260920120000_spec065_caixa_de_avisos` criou
-- `notificacoes_caixa_idx (company_id, destinatario_id, criada_em DESC)` e
-- **já rodou**. Editar migration aplicada é drift: o Prisma guarda o checksum
-- de cada uma em `_prisma_migrations`, e mudar o arquivo faz o próximo deploy
-- recusar-se a subir.
--
-- Eu cheguei a escrever a correção dentro daquela migration, numa branch
-- empilhada — e o merge da anterior aconteceu antes. **A lição é a que eu
-- mesmo tinha escrito no commit dela:** migration é imutável depois de rodar,
-- e branch empilhada não muda isso.
--
-- ## O que a medição mostrou
--
-- A consulta da caixa pede `ORDER BY criada_em DESC, id DESC` — o desempate é
-- obrigatório, porque um gesto da SPEC-063 grava todas as suas linhas num
-- `INSERT` só, com `criada_em` idêntico. Sem desempate, a ordem entre elas é
-- indefinida, e a paginação pode repetir ou pular linha.
--
-- Medido com avisos de uma pessoa, todos no mesmo instante, pedindo
-- `LIMIT 20 OFFSET 20`:
--
--   linhas | índice de 3 colunas | de 4 colunas (com id)
--      200 |  Sort               |  Sort
--     1000 |  Sort               |  Index Scan
--     5000 |  Sort               |  Index Scan
--
-- **A partir de mil linhas, o `id` aqui é a diferença entre caminhar o índice
-- e ler tudo e ordenar, a cada página.** Com ele, a garantia de ordem sai de
-- graça.
--
-- `DROP` + `CREATE`, e não `CREATE ... IF NOT EXISTS` com outro nome: dois
-- índices sobre as mesmas colunas pagariam escrita duas vezes em toda a fila.
DROP INDEX IF EXISTS "notificacoes_caixa_idx";

CREATE INDEX "notificacoes_caixa_idx"
  ON "notificacoes" ("company_id", "destinatario_id", "criada_em" DESC, "id" DESC);
