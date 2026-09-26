-- SPEC-075/TASK-001 (D9) — o nivel passa a decidir acesso, e por isso passa a
-- merecer a integridade que a DEF-024 deu as outras tabelas.
--
-- Tres trocas, todas de FK SIMPLES `(nivel_id) -> niveis(id)` para FK COMPOSTA
-- `(company_id, nivel_id) -> niveis(company_id, id)`: com a simples, o banco
-- aceitava o nivel de OUTRA empresa, e quem impedia era so o servico
-- (`students.service.ts`, `classes.service.ts`).
--
-- E a acao ao apagar o nivel muda em duas delas:
--
--   alunos          SET NULL -> RESTRICT  o servico ja recusava; o banco passa a garantir
--   turmas          SET NULL -> RESTRICT  SET NULL abriria a turma restrita a todos
--   convites_aluno  SET NULL -> SET NULL (nivel_id)
--                                         convite sem nivel vira aluno sem nivel, que
--                                         conta como o primeiro (D1) -- nao fica aberto
--
-- **A lista de colunas depois do SET NULL nao e enfeite** (a licao da SPEC-064,
-- `fila_falta_fkey`): numa FK composta, `SET NULL` sem lista anula TODAS as
-- colunas da chave, inclusive `company_id`, que e NOT NULL — o DELETE do nivel
-- morreria com 23502 (medido pelo validador na 1a rodada da SPEC-075).
-- `SET NULL (coluna)` existe do PostgreSQL 15; producao roda 18.6.
--
-- **O Prisma nao sabe escrever `SET NULL (coluna)`** — ver o comentario do
-- modelo `ConviteAluno` em `schema.prisma`. Esta migration e a fonte de verdade
-- da acao referencial dos convites.
--
-- MATCH SIMPLE (o padrao) e o que se quer: com `nivel_id` nulo a linha nao e
-- conferida, e aluno sem nivel e o estado normal.
--
-- **O `ADD CONSTRAINT` valida as linhas existentes.** Se alguma aponta para o
-- nivel de outra empresa, esta migration ABORTA e o deploy nao sobe (o app
-- antigo continua, pelo `migrate && start`). A consulta de conferencia que o
-- Israel roda em producao ANTES do merge esta na spec (secao "Modelo de
-- dados"): saida esperada `0 | 0 | 0`.
--
-- Os nomes das FKs antigas foram conferidos em `pg_constraint` num banco
-- migrado do zero (2026-09-25): alunos_nivel_id_fkey, turmas_nivel_id_fkey,
-- convites_aluno_nivel_id_fkey — os tres `ON UPDATE CASCADE ON DELETE SET NULL`.

-- o alvo das FKs compostas (redundante como chave: id ja e PK)
ALTER TABLE "niveis" ADD CONSTRAINT "niveis_company_id_id_key" UNIQUE ("company_id", "id");

ALTER TABLE "alunos" DROP CONSTRAINT "alunos_nivel_id_fkey";
ALTER TABLE "alunos" ADD CONSTRAINT "alunos_nivel_fkey"
  FOREIGN KEY ("company_id", "nivel_id") REFERENCES "niveis" ("company_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "turmas" DROP CONSTRAINT "turmas_nivel_id_fkey";
ALTER TABLE "turmas" ADD CONSTRAINT "turmas_nivel_fkey"
  FOREIGN KEY ("company_id", "nivel_id") REFERENCES "niveis" ("company_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "convites_aluno" DROP CONSTRAINT "convites_aluno_nivel_id_fkey";
ALTER TABLE "convites_aluno" ADD CONSTRAINT "convites_nivel_fkey"
  FOREIGN KEY ("company_id", "nivel_id") REFERENCES "niveis" ("company_id", "id")
  ON DELETE SET NULL ("nivel_id") ON UPDATE CASCADE;
