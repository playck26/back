-- SPEC-065/TASK-000 — a coluna de leitura, o índice da caixa e o backfill.
--
-- A `notificacoes` nasceu na SPEC-062 como **caixa de saída**: fila, lease,
-- cerca, índice de disputa. Esta migration a faz servir também de **caixa de
-- entrada**, sem tirar nada do que já existe.
--
-- Três instruções, e a ordem entre elas importa.

-- 1) A coluna. `NULL` = não lida (SPEC-065/D2).
--
-- "Lido" é do SERVIDOR, e não do aparelho: quem tem celular e computador vê a
-- mesma caixa, e marcar lido num e continuar com bolinha no outro é o que faz
-- a pessoa parar de confiar no número.
ALTER TABLE "notificacoes" ADD COLUMN "lida_em" TIMESTAMPTZ(6);

-- 2) O BACKFILL, e ele vem ANTES do índice (SPEC-065/D10).
--
-- **Sem isto, todo mundo abre o app no dia do deploy com o sino gritando o
-- histórico inteiro** — e um contador que nasce errado ensina a ignorá-lo na
-- primeira hora de vida.
--
-- `lida_em = criada_em`, e não `now()`: a linha guarda quando o aviso nasceu,
-- não quando esta migration rodou. Um `now()` diria que a pessoa leu tudo no
-- instante do deploy, o que é falso e apareceria em qualquer relatório futuro.
--
-- **O histórico não se perde:** as linhas continuam na caixa, legíveis, na
-- ordem certa. O que não acontece é o sino anunciar como novidade o que a
-- pessoa nunca teve como ver.
--
-- Antes do índice porque é um `UPDATE` em toda a tabela: criar o índice
-- primeiro faria o Postgres mantê-lo linha a linha durante a varredura.
UPDATE "notificacoes" SET "lida_em" = "criada_em" WHERE "lida_em" IS NULL;

-- 3) O índice da caixa (SPEC-065/D8) — e é UM só.
--
-- Os outros dois de `notificacoes` não servem a uma caixa de entrada: o da
-- fila começa por `estado`, e o do teste é `(destinatario_id, tipo,
-- criada_em)`, com `tipo` no meio. **Nenhum tinha `company_id`**, ao contrário
-- da convenção do resto do schema.
--
-- A contagem de não-lidas usa este mesmo índice: os dois primeiros campos vêm
-- dele, e `lida_em IS NULL AND tipo <> 'teste'` é filtro sobre as linhas de UMA
-- pessoa. Um índice parcial dedicado só se paga quando alguém acumular
-- milhares de avisos, e acrescentá-lo agora seria pagar escrita em toda a fila
-- por uma leitura que ainda não dói.
--
-- **`CREATE INDEX` comum, e não `CONCURRENTLY`:** o `CONCURRENTLY` não roda
-- dentro de transação, e migration do Prisma roda em transação. A tabela tem
-- um dia de vida (SPEC-062 subiu em 2026-09-19), então o lock é instantâneo.
-- Numa tabela grande, esta linha precisaria sair da migration e virar passo de
-- operação — fica dito para quem reencontrar isto com anos de histórico.
CREATE INDEX "notificacoes_caixa_idx"
  ON "notificacoes" ("company_id", "destinatario_id", "criada_em" DESC);
