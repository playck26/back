-- SPEC-034/TASK-001 — os valores de enum das duas rotas de escrita novas.
--
-- ESTA MIGRATION ABRE TRANSAÇÃO À MÃO, E É A PRIMEIRA DO PROJETO A FAZÊ-LO.
--
-- O Prisma Migrate **não** envolve migration do PostgreSQL em transação: é
-- opt-in, documentado por eles. Conferido aqui: das 29 migrations anteriores,
-- **nenhuma** abre `BEGIN` — os seis que um `grep` acha são blocos PL/pgSQL,
-- precedidos de declaração de variável ou de `CREATE FUNCTION … AS $$`.
--
-- Sem `BEGIN`, três `ALTER TYPE` são três statements independentes: se o
-- segundo falhar, o primeiro fica aplicado e a migration não tem volta. Com
-- ele, é tudo ou nada. (SPEC-034/D8, corrigida na v3 — a v2 justificava a
-- separação pelo motivo oposto, e o motivo estava errado.)
--
-- E os valores NÃO SÃO USADOS aqui, o que é exigência do Postgres e não
-- escolha: `ALTER TYPE … ADD VALUE` cria o rótulo, mas ele não pode ser
-- referenciado antes do COMMIT da transação que o criou. Quem os usa é o
-- código da TASK-003 e da TASK-004, depois desta migration estar aplicada.
BEGIN;

-- MOD-011 (SPEC-032): o GESTO humano. Mover é um comando lógico próprio, e
-- cancelar uma ocorrência de turma é outro — nenhum dos dois cabe em
-- `reserva_cancelada`, que descreve a reserva avulsa saindo da agenda.
ALTER TYPE "tipo_de_acao" ADD VALUE IF NOT EXISTS 'reserva_movida';
ALTER TYPE "tipo_de_acao" ADD VALUE IF NOT EXISTS 'aula_cancelada';

-- MOD-011: o ALVO técnico. `cancelada` já existe e serve para a ocorrência de
-- turma — a trigger `ocupacao_cancelada_exige_evento` não filtra por
-- `origem_tipo`, então ela já cobre o caminho novo. Mover não tem
-- equivalente: a ocupação não muda de status, muda de lugar.
ALTER TYPE "tipo_de_evento_de_ocupacao" ADD VALUE IF NOT EXISTS 'movida';

COMMIT;
