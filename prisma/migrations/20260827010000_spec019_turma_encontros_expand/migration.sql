-- SPEC-019/TASK-001 — a fase EXPAND da turma em varios dias.
--
-- Cria `turma_encontros`, copia o encontro unico de cada turma existente, e
-- **deixa as tres colunas antigas de pe**. Elas continuam sendo a fonte ate a
-- TASK-002 passar a escrever aqui; so saem na TASK-003 (contract).
--
-- Esta migration e ADITIVA: nada e removido, nada muda de tipo. Rodar duas
-- vezes o mesmo backfill duplicaria encontros, e por isso ele e condicional.

-- ---------------------------------------------------------------------------
-- 1. A tabela
-- ---------------------------------------------------------------------------
CREATE TABLE "turma_encontros" (
    "id"          UUID         NOT NULL,
    "turma_id"    UUID         NOT NULL,
    "dia_semana"  INTEGER      NOT NULL,
    "hora_inicio" TIME         NOT NULL,
    "hora_fim"    TIME         NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "turma_encontros_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "turma_encontros_turma_id_idx" ON "turma_encontros"("turma_id");

-- **`ON DELETE CASCADE`, e a escolha e deliberada.** Encontro nao existe sem
-- turma: ele nao e entidade propria, e a recorrencia dela. Com `RESTRICT`,
-- apagar uma turma exigiria apagar os encontros antes — e toda limpeza
-- escrita a mao (fixtures, `limparEmpresa`) quebraria com erro de constraint
-- que nao tem nada a ver com o teste. Aconteceu tres vezes na SPEC-020.
--
-- E **sem `company_id`**, no mesmo padrao de `turma_alunos`: o escopo por
-- empresa vem da turma. Coluna de escopo redundante e uma segunda fonte para
-- a mesma pergunta, que e o que a SPEC-020 passou o dia desfazendo.
ALTER TABLE "turma_encontros"
    ADD CONSTRAINT "turma_encontros_turma_id_fkey"
    FOREIGN KEY ("turma_id") REFERENCES "turmas"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. O que o banco garante sobre um encontro
-- ---------------------------------------------------------------------------
--
-- `hora_fim > hora_inicio` — CHECK escrito a mao, porque o Prisma nao gera
-- CHECK. Sem ele, a AC-005 dependeria so da validacao em codigo, e "garantido
-- pela API" e exatamente o que a INV-051 teve de assumir por nao ter jeito.
-- Aqui tem jeito, entao e o banco que garante.
--
-- **Aberto as 00:00**: nao ha encontro que atravesse a meia-noite neste
-- produto, e o CHECK de desigualdade estrita ja recusa duracao zero.
ALTER TABLE "turma_encontros"
    ADD CONSTRAINT "turma_encontros_hora_check"
    CHECK ("hora_fim" > "hora_inicio");

-- `dia_semana` na convencao 0=domingo..6=sabado, igual a `turmas.dia_semana` e
-- a `horarios_funcionamento.dia_semana`. Sem o CHECK, um `7` entraria e
-- geraria zero ocupacoes em silencio — uma turma que existe e nunca acontece.
ALTER TABLE "turma_encontros"
    ADD CONSTRAINT "turma_encontros_dia_semana_check"
    CHECK ("dia_semana" BETWEEN 0 AND 6);

-- **NAO existe UNIQUE(turma_id, dia_semana), e isso e decisao, nao esquecimento.**
-- A AC-007 aceita dois encontros no MESMO dia sem sobreposicao (ex.: turma que
-- treina terca 07h-08h e terca 18h-19h). Uma UNIQUE aqui recusaria isso, e o
-- erro chegaria como violacao de constraint sem relacao com o que a pessoa
-- tentou fazer.
--
-- Quem impede sobreposicao e a AC-006 (mensagem honesta) mais o `EXCLUDE`
-- `no_overlap_por_quadra` de `ocupacoes_quadra`, que ja existe e nao sabe de
-- qual turma vem cada ocupacao — entao dois encontros sobrepostos da mesma
-- turma colidem de verdade la.

-- ---------------------------------------------------------------------------
-- 3. Backfill: cada turma existente vira uma turma de UM encontro
-- ---------------------------------------------------------------------------
--
-- `WHERE NOT EXISTS` para ser idempotente. Uma migration nao deveria rodar
-- duas vezes, mas backfill que duplica em silencio e pior que backfill que
-- nao roda: a turma passaria a ter dois encontros identicos e geraria o dobro
-- de ocupacoes na primeira edicao.
INSERT INTO "turma_encontros" ("id", "turma_id", "dia_semana", "hora_inicio", "hora_fim", "created_at")
SELECT
    gen_random_uuid(),
    t."id",
    t."dia_semana",
    t."hora_inicio",
    t."hora_fim",
    now()
FROM "turmas" t
WHERE NOT EXISTS (
    SELECT 1 FROM "turma_encontros" e WHERE e."turma_id" = t."id"
);

-- ---------------------------------------------------------------------------
-- 4. O backfill fechou?
-- ---------------------------------------------------------------------------
--
-- **Esta assertiva e a licao da SPEC-020/TASK-004, chegando uma fase antes.**
-- La ela ficou so na contract e abortou de verdade contra o harness. Aqui ela
-- roda ja na expand: descobrir agora que uma turma nao foi copiada custa um
-- deploy falho; descobrir na contract custa a unica fonte do horario dela.
--
-- Falhando, o deploy falha e a versao anterior continua ATIVA — a direcao
-- segura.
DO $$
DECLARE
  sem_encontro integer;
  exemplos     text;
BEGIN
  SELECT count(*) INTO sem_encontro
  FROM "turmas" t
  WHERE NOT EXISTS (SELECT 1 FROM "turma_encontros" e WHERE e."turma_id" = t."id");

  IF sem_encontro > 0 THEN
    -- O nome vai na mensagem de proposito: "3 turmas sem encontro" manda
    -- procurar; o nome manda consertar.
    SELECT string_agg(nome, ', ') INTO exemplos
    FROM (SELECT nome FROM "turmas" t
          WHERE NOT EXISTS (SELECT 1 FROM "turma_encontros" e WHERE e."turma_id" = t."id")
          ORDER BY nome LIMIT 10) AS amostra;

    RAISE EXCEPTION
      'SPEC-019/TASK-001: % turma(s) ficaram sem encontro apos o backfill. Turmas: %.',
      sem_encontro, exemplos;
  END IF;
END $$;
