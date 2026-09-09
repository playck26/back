-- SPEC-040 — disponibilidade do professor. TASK-001.
--
-- **Cópia fiel de `horarios_funcionamento`, e a fidelidade é o ponto.** Esta
-- spec não cria mecanismo inédito: as quatro garantias abaixo já existem em
-- produção desde a SPEC-010, com a mesma forma e os mesmos nomes de conceito.
-- Onde a SPEC-033 precisou de desenho, esta precisa de disciplina.

-- O alvo da FK composta, que NAO existia.
--
-- `alunos`, `usuarios`, `quadras` e `ocupacoes_quadra` ganharam o seu no
-- DEF-024/DEF-022; `professores` ficou de fora porque nenhuma tabela apontava
-- para ele com a empresa junto. Esta e a primeira -- e sem este indice a FK
-- abaixo morre com `42830` (no unique constraint matching given keys).
--
-- Medido antes de escrever: `grep` nas 32 migrations nao acha
-- `professores_company_id_id_key`.
CREATE UNIQUE INDEX "professores_company_id_id_key"
  ON "professores" ("company_id", "id");

CREATE TABLE "disponibilidades_professor" (
  "id"           UUID NOT NULL,
  "company_id"   UUID NOT NULL,
  "professor_id" UUID NOT NULL,
  -- 0 = domingo, mesma convenção de `Date.getDay()` e de
  -- `horarios_funcionamento` — tradução de índice entre banco e aplicação é
  -- erro que só aparece no domingo.
  "dia_semana"   SMALLINT NOT NULL,
  -- **NOT NULL, e sem coluna `indisponivel`.** O molde tem `fechado` porque
  -- la existe HERANCA: `quadra_id IS NULL` e o padrao do clube, e a quadra
  -- precisa poder dizer "fechado" para SOBREPOR um dia aberto herdado. A D3
  -- desta spec removeu a heranca -- ausencia de linha ja e "nao atende" --,
  -- e com ela some a razao da coluna. Mantida, "nao atende" teria DUAS
  -- representacoes, e a 039 teria de lembrar de filtrar `indisponivel =
  -- false` em toda consulta; esquecer oferece horario que o professor nao
  -- atende, sem erro nenhum. Linha existe = atende, destas horas a estas.
  "hora_inicio"  TIME(0) NOT NULL,
  "hora_fim"     TIME(0) NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ NOT NULL,
  CONSTRAINT "disponibilidades_professor_pkey" PRIMARY KEY ("id")
);

-- FK COMPOSTA (DEF-024): sem `company_id` na chave, a disponibilidade de um
-- professor da empresa A poderia apontar para a ficha da B. É o mesmo
-- vazamento que a SPEC-025 teve com avaliação de aula.
--
-- `CASCADE` de propósito: apagar o professor apaga a agenda dele. Não é
-- histórico, é configuração — e configuração órfã só atrapalha.
ALTER TABLE "disponibilidades_professor"
  ADD CONSTRAINT "disponibilidades_professor_fkey"
  FOREIGN KEY ("company_id", "professor_id")
  REFERENCES "professores" ("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "disponibilidades_professor"
  ADD CONSTRAINT "disponibilidades_empresa_fkey"
  FOREIGN KEY ("company_id") REFERENCES "empresas" ("id")
  -- Copia fiel do molde (`horarios_funcionamento_company_id_fkey`): apagar
  -- empresa com agenda de professor e recusado, e o `migrate diff` so fica
  -- limpo quando as ACOES batem, nao so as colunas.
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "disponibilidades_professor"
  ADD CONSTRAINT "disponibilidades_dia_valido"
  CHECK ("dia_semana" BETWEEN 0 AND 6);

-- Sem a flag, a coerencia do molde encolhe para o que dela sobrou de real:
-- fim depois do inicio. Sem isto o banco aceita "atende das 10h as 8h", e a
-- aplicacao passa a ter que desconfiar do proprio dado.
ALTER TABLE "disponibilidades_professor"
  ADD CONSTRAINT "disponibilidades_intervalo"
  CHECK ("hora_fim" > "hora_inicio");

-- Hora cheia, como o horário da quadra. A regra também vive na aplicação;
-- aqui é a rede de baixo.
ALTER TABLE "disponibilidades_professor"
  ADD CONSTRAINT "disponibilidades_hora_cheia"
  CHECK (
    EXTRACT(MINUTE FROM "hora_inicio") = 0
    AND EXTRACT(SECOND FROM "hora_inicio") = 0
    AND EXTRACT(MINUTE FROM "hora_fim") = 0
    AND EXTRACT(SECOND FROM "hora_fim") = 0
  );

-- INV-100: uma linha por professor por dia.
--
-- **Sem `NULLS NOT DISTINCT`**, ao contrário de `horarios_funcionamento`: lá
-- `quadra_id` é nulável (a linha da empresa inteira), aqui nenhuma coluna da
-- chave é. Copiar a cláusula sem precisar dela seria copiar sem entender.
CREATE UNIQUE INDEX "disponibilidades_professor_dia_key"
  ON "disponibilidades_professor" ("company_id", "professor_id", "dia_semana");

CREATE INDEX "disponibilidades_professor_idx"
  ON "disponibilidades_professor" ("company_id", "professor_id");
