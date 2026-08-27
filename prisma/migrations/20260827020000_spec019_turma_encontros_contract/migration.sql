-- SPEC-019/TASK-003 — a fase CONTRACT da turma em varios dias.
--
-- Derruba `turmas.dia_semana`, `turmas.hora_inicio` e `turmas.hora_fim`. A
-- recorrencia passa a viver so em `turma_encontros`.
--
-- **DERRUBAR COLUNA E IRREVERSIVEL, e estas tres sao a UNICA fonte do horario
-- das turmas antigas.** Por isso a primeira coisa que acontece aqui e uma
-- pergunta ao banco, nao uma escrita.
--
-- O preflight abaixo foi exigido pela validacao cruzada da SPEC-019
-- (BLOQUEADOR 3): a 1a versao da task derrubava as colunas sem conferir nada.

-- ---------------------------------------------------------------------------
-- 1. O preflight — tres perguntas, e o nome da turma em cada resposta
-- ---------------------------------------------------------------------------
--
-- Falhando, a migration ABORTA: o container nao sobe, o deploy falha, e o
-- DigitalOcean mantem a versao anterior ATIVA. Producao continua no ar com o
-- codigo velho. E a direcao segura de falhar.
--
-- **O nome da turma vai na mensagem de proposito.** "3 turmas sem encontro"
-- manda alguem procurar; o nome manda alguem consertar. Foi a licao da
-- SPEC-020/TASK-004, que abortou de verdade contra o harness e so foi
-- destravavel porque dizia "Quadras: Q1".
DO $$
DECLARE
  sem_encontro   integer;
  hora_invalida  integer;
  nao_copiada    integer;
  exemplos       text;
BEGIN
  ---------------------------------------------------------------------------
  -- (a) Turma sem NENHUM encontro.
  --
  -- A INV-051 diz que nao existe, mas ela e garantida pela API e pela
  -- transacao — **nao pelo banco** (Postgres nao expressa "pai com >=1 filho"
  -- sem trigger, e este projeto tem zero). Uma escrita por fora, um backfill
  -- que nao fechou, ou uma linha criada antes da TASK-001 bastariam.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO sem_encontro
  FROM "turmas" t
  WHERE NOT EXISTS (SELECT 1 FROM "turma_encontros" e WHERE e."turma_id" = t."id");

  IF sem_encontro > 0 THEN
    SELECT string_agg(nome, ', ') INTO exemplos
    FROM (SELECT nome FROM "turmas" t
          WHERE NOT EXISTS (SELECT 1 FROM "turma_encontros" e WHERE e."turma_id" = t."id")
          ORDER BY nome LIMIT 10) AS amostra;

    RAISE EXCEPTION
      'SPEC-019/TASK-003: % turma(s) sem nenhum encontro — a contract nao pode rodar, o horario delas so existe nas colunas que este passo apagaria. Turmas: %.',
      sem_encontro, exemplos;
  END IF;

  ---------------------------------------------------------------------------
  -- (b) Encontro com horario invalido.
  --
  -- O CHECK `turma_encontros_hora_check` ja impede isso desde a TASK-001,
  -- entao esta pergunta so pode dar positivo se alguem tiver derrubado o
  -- CHECK. **E por isso ela fica:** o preflight nao confia no estado que ele
  -- proprio nao verificou, e o custo de perguntar e uma varredura.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO hora_invalida
  FROM "turma_encontros" WHERE "hora_fim" <= "hora_inicio";

  IF hora_invalida > 0 THEN
    RAISE EXCEPTION
      'SPEC-019/TASK-003: % encontro(s) com hora_fim <= hora_inicio. O CHECK turma_encontros_hora_check deveria impedir isto — confira se ele existe antes de seguir.',
      hora_invalida;
  END IF;

  ---------------------------------------------------------------------------
  -- (c) O horario ANTIGO nao foi copiado para nenhum encontro.
  --
  -- **Esta e a pergunta que as outras duas nao fazem**, e a que pega o
  -- backfill parcial: a turma TEM encontro, mas nenhum deles corresponde ao
  -- que esta nas colunas que vao cair. Sem isto, uma turma cujo encontro foi
  -- reescrito errado perderia o horario original em silencio.
  --
  -- Turma editada de proposito pelo gestor DEPOIS da TASK-002 nao cai aqui
  -- por acidente: ao editar, o codigo reescreve as tres colunas antigas com
  -- o primeiro encontro (escrita dupla da fase expand), entao elas continuam
  -- correspondendo.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO nao_copiada
  FROM "turmas" t
  WHERE NOT EXISTS (
    SELECT 1 FROM "turma_encontros" e
    WHERE e."turma_id" = t."id"
      AND e."dia_semana"  = t."dia_semana"
      AND e."hora_inicio" = t."hora_inicio"
      AND e."hora_fim"    = t."hora_fim"
  );

  IF nao_copiada > 0 THEN
    SELECT string_agg(nome, ', ') INTO exemplos
    FROM (
      SELECT nome FROM "turmas" t
      WHERE NOT EXISTS (
        SELECT 1 FROM "turma_encontros" e
        WHERE e."turma_id" = t."id"
          AND e."dia_semana"  = t."dia_semana"
          AND e."hora_inicio" = t."hora_inicio"
          AND e."hora_fim"    = t."hora_fim"
      )
      ORDER BY nome LIMIT 10
    ) AS amostra;

    RAISE EXCEPTION
      'SPEC-019/TASK-003: % turma(s) cujo horario antigo nao corresponde a nenhum encontro — backfill incompleto. Turmas: %.',
      nao_copiada, exemplos;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. So agora as colunas saem
-- ---------------------------------------------------------------------------
--
-- A ordem importa: qualquer `DROP` antes do bloco acima tornaria o preflight
-- inutil, porque ele consulta justamente as colunas que este passo remove.
ALTER TABLE "turmas" DROP COLUMN "dia_semana";
ALTER TABLE "turmas" DROP COLUMN "hora_inicio";
ALTER TABLE "turmas" DROP COLUMN "hora_fim";
