-- SPEC-031/TASK-002 — as três tabelas novas, e o valor de enum que a auditoria
-- da remoção administrativa precisa.
--
-- ## ABRE TRANSAÇÃO À MÃO, e o precedente é a `20260904140000_spec034_enums`
--
-- O Prisma Migrate **não** envolve migration do PostgreSQL em transação: é
-- opt-in, e das 30 migrations anteriores só a da SPEC-034 abre `BEGIN`. Sem
-- ele, esta migration não teria rollback atômico — um `ALTER TYPE … ADD VALUE`
-- que passasse ficaria aplicado se um `CREATE TABLE` posterior falhasse, e a
-- migration não teria volta.
--
-- **E o valor novo NÃO é usado aqui**, o que é exigência do Postgres e não
-- escolha: `ADD VALUE` cria o rótulo, mas ele não pode ser referenciado antes
-- do `COMMIT` da transação que o criou. Nenhuma das três tabelas cita
-- `'turma_aluno_removido'` em DDL — quem o usa é o código da TASK-005, depois
-- desta migration estar aplicada. (Duas migrations deste projeto já foram
-- governadas por essa restrição: `20260823000000_login_professor` e
-- `20260830100000_spec030_completude_nao_houve`, esta última partida em duas
-- porque um `CHECK` citava o literal.)
--
-- Expand puro: nenhuma coluna nova em tabela existente, nenhum `NOT NULL` sem
-- default sobre linha povoada. Seguro com o código antigo no ar.
-- ## Sem `DEFAULT gen_random_uuid()` nos `id`, e sem default no `updated_at`
--
-- A DDL escrita na spec os tinha. **Este projeto nao usa nenhum dos dois**: o
-- `id` e gerado pelo CLIENTE (`@default(uuid())`) e o `updated_at` pelo
-- `@updatedAt` — conferido em `config_pagamento_empresa` (o irmao desta
-- tabela) e em `eventos_de_ocupacao`. Copiar a DDL da spec deixaria o banco
-- com defaults que o `schema.prisma` nao descreve, e todo `prisma migrate
-- diff` futuro apontaria a divergencia como se fosse trabalho a fazer.
-- Conferido por `migrate diff` nos dois sentidos.
--
-- ## E `ON UPDATE CASCADE` em todas as oito FKs
--
-- E o default do Prisma para relacao, e a convencao deste repositorio —
-- `eventos_acao_fkey` e `eventos_ocupacao_fkey` (SPEC-032) sao as duas
-- assim. Escrever so `ON DELETE RESTRICT` deixa o Postgres em `NO ACTION`, e
-- o `migrate diff` acusa: foi assim que esta divergencia apareceu aqui, e ela
-- e invisivel a leitura porque a clausula ausente nao esta escrita em lugar
-- nenhum.
BEGIN;

-- ---------------------------------------------------------------------------
-- D21 — a remoção administrativa é um GESTO, e ele precisa de nome próprio.
-- `reserva_cancelada` não descreve "o gestor tirou o aluno da turma".
-- ---------------------------------------------------------------------------
ALTER TYPE "tipo_de_acao" ADD VALUE IF NOT EXISTS 'turma_aluno_removido';

-- ---------------------------------------------------------------------------
-- D3/D4 — a configuração de operação da empresa.
--
-- São DOIS prazos, uma coluna cada (REQ-001) — a primeira versão desta DDL
-- tinha um só, escrito pelo molde do irmão `config_pagamento_empresa` sem ler
-- o requisito que ela existe para satisfazer.
--
-- `UNIQUE (company_id)` é o que faz "uma configuração por empresa" ser
-- mecanismo e não convenção.
-- ---------------------------------------------------------------------------
CREATE TABLE "config_operacao_empresa" (
  "id"         UUID NOT NULL,
  "company_id" UUID NOT NULL,
  -- INV-065: NULO é a única ausência, e ZERO NÃO EXISTE. `>= 1` nos dois.
  -- A v9 escreveu `>= 0`, contradizendo a invariante três seções acima.
  "prazo_cancelamento_aula_horas"    INTEGER,
  "prazo_cancelamento_reserva_horas" INTEGER,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "config_operacao_empresa_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "config_operacao_prazo_aula_valido"
    CHECK ("prazo_cancelamento_aula_horas" IS NULL
           OR "prazo_cancelamento_aula_horas" >= 1),
  CONSTRAINT "config_operacao_prazo_reserva_valido"
    CHECK ("prazo_cancelamento_reserva_horas" IS NULL
           OR "prazo_cancelamento_reserva_horas" >= 1)
);

CREATE UNIQUE INDEX "config_operacao_empresa_company_id_key"
  ON "config_operacao_empresa"("company_id");

-- `ON DELETE RESTRICT` de propósito, e é o que obriga a tabela a entrar na
-- limpeza ANTES de `empresas` nos três caminhos (D22/1b). Omitir a FK para o
-- cleanup passar deixaria configuração órfã — a troca que o D14 já recusou.
ALTER TABLE "config_operacao_empresa"
  ADD CONSTRAINT "config_operacao_empresa_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- D13/D18 — a falta avisada.
--
-- **QUATRO FKs e TRÊS pais.** A contagem esteve em três versões ao mesmo tempo
-- (cinco somando D13+D18, três no D18, dois pais no D22/2b); a spec v13 a
-- fechou. As quatro são RESTRICT, e é isso que obriga `faltas_avisadas` a ser
-- apagada antes dos três pais.
--
-- Não há FK simples para `alunos(id)`: o D18 a substitui pela composta com
-- `company_id`. Declarar as duas manteria viva a forma que o próprio D18 chama
-- de "o molde com o buraco" — `presencas` a tem, em produção desde a SPEC-014,
-- e só não pôde ser diferente porque o `UNIQUE (company_id, id)` que torna a
-- composta possível chegou depois, com a SPEC-032.
-- ---------------------------------------------------------------------------
CREATE TABLE "faltas_avisadas" (
  "id"          UUID NOT NULL,
  "company_id"  UUID NOT NULL,
  "ocupacao_id" UUID NOT NULL,
  "origem_tipo" "origem_tipo" NOT NULL DEFAULT 'TURMA',
  "aluno_id"    UUID NOT NULL,
  "avisada_em"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL,

  CONSTRAINT "faltas_avisadas_pkey" PRIMARY KEY ("id"),
  -- INV-067: falta é de AULA DE TURMA. O DEFAULT sozinho não impede um
  -- `INSERT` explícito com 'AVULSO'; o CHECK impede.
  CONSTRAINT "faltas_origem_turma" CHECK ("origem_tipo" = 'TURMA')
);

-- AC-017: o mecanismo da idempotência é do BANCO. Dois `POST` simultâneos
-- produzem UMA linha, não duas — `createMany({ skipDuplicates })` do lado da
-- aplicação só funciona porque esta constraint existe.
CREATE UNIQUE INDEX "faltas_unica"
  ON "faltas_avisadas"("ocupacao_id", "aluno_id");

ALTER TABLE "faltas_avisadas"
  ADD CONSTRAINT "faltas_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Amarra a falta a ocorrência DE TURMA. Sem ela, avisar falta numa reserva
-- avulsa seria aceito pelo banco (mesmo desenho da SPEC-025 e da DEF-022).
ALTER TABLE "faltas_avisadas"
  ADD CONSTRAINT "faltas_ocupacao_fkey"
  FOREIGN KEY ("ocupacao_id", "origem_tipo")
  REFERENCES "ocupacoes_quadra"("id", "origem_tipo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- As duas de TENANT. `ocupacoes_quadra` não tem `UNIQUE (company_id, id,
-- origem_tipo)`, então as duas responsabilidades não cabem numa constraint só
-- — juntá-las por conveniência enfraqueceria uma delas.
ALTER TABLE "faltas_avisadas"
  ADD CONSTRAINT "faltas_ocupacao_empresa_fkey"
  FOREIGN KEY ("company_id", "ocupacao_id")
  REFERENCES "ocupacoes_quadra"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "faltas_avisadas"
  ADD CONSTRAINT "faltas_aluno_empresa_fkey"
  FOREIGN KEY ("company_id", "aluno_id")
  REFERENCES "alunos"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- D21 — o alvo técnico da remoção administrativa é uma MATRÍCULA.
--
-- `EventoDeOcupacao` não serve: remover um aluno de uma turma **não muda
-- ocupação nenhuma**, então não haveria `ocupacao_id` honesto para preencher —
-- e inventar um produziria auditoria semanticamente falsa, que é pior que
-- auditoria ausente. Segue a cisão que a SPEC-032 estabeleceu: a ação é o
-- gesto humano (uma), os eventos são os alvos técnicos (N).
-- ---------------------------------------------------------------------------
CREATE TABLE "eventos_de_matricula" (
  "id"         UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "acao_id"    UUID NOT NULL,
  "turma_id"   UUID NOT NULL,
  "aluno_id"   UUID NOT NULL,
  "criado_em"  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "eventos_de_matricula_pkey" PRIMARY KEY ("id")
);

-- As três carregam a EMPRESA, pela mesma regra do D18. Os três alvos já
-- existem: `acoes_company_id_id_key`, `turmas_company_id_id_key` (SPEC-025) e
-- `alunos_company_id_id_key` (DEF-024 fase 1, em produção desde 2026-09-04).
ALTER TABLE "eventos_de_matricula"
  ADD CONSTRAINT "eventos_matricula_acao_fkey"
  FOREIGN KEY ("company_id", "acao_id")
  REFERENCES "acoes_administrativas"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "eventos_de_matricula"
  ADD CONSTRAINT "eventos_matricula_turma_fkey"
  FOREIGN KEY ("company_id", "turma_id")
  REFERENCES "turmas"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "eventos_de_matricula"
  ADD CONSTRAINT "eventos_matricula_aluno_fkey"
  FOREIGN KEY ("company_id", "aluno_id")
  REFERENCES "alunos"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- D22/1 — `eventos_de_matricula` é APPEND-ONLY, como as duas da SPEC-032.
--
-- A função e a válvula já existem (`append_only_com_valvula_de_teste`,
-- `20260902100000_spec032_rastreabilidade_expand`): exigem o GUC **e** a role
-- `playck_test_cleanup`, que só existe no banco de testes. Esta é a TERCEIRA
-- trigger da família, e é ela que o `DISABLE`/`ENABLE` dos dois owner-paths do
-- `db-migrate.yml` passou a citar.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "eventos_matricula_append_only"
  BEFORE UPDATE OR DELETE ON "eventos_de_matricula"
  FOR EACH ROW EXECUTE FUNCTION "append_only_com_valvula_de_teste"();

COMMIT;
