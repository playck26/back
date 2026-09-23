-- SPEC-069/TASK-001 — a acao passa a dizer O QUE tocou.
--
-- `turma_professor_alterado` e a unica acao do sistema sem evento nenhum: o
-- extrato guarda o autor e o instante, e nao diz QUAL turma mudou de
-- professor. A alternativa recusada (D1) era um `turma_id` anulavel em
-- `acoes_administrativas` — resolveria ESTE alvo e abriria precedente para
-- `quadra_id`, `aluno_id`, `professor_id`: um alvo polimorfico meia-boca, com
-- N colunas nulas por linha. `eventos_de_matricula` (SPEC-031/D18) e o
-- precedente exato, e e o molde literal desta tabela.
--
-- **Esta migration NAO cria o `acao_exige_alvo`, e isso e normativo.** O
-- trigger e o Deploy 2 (D6): producao migra no proprio deploy
-- (`deploy_on_push` + `db:migrate:deploy && start:prod`), entao `migrate
-- deploy` aplica TUDO o que estiver no commit. Com as duas migrations no mesmo
-- SHA, o trigger subiria junto com o binario anterior ainda no ar, e todo
-- `PATCH` que troca professor falharia com `23514` no commit — derrubando a
-- transacao inteira e devolvendo 500 ao gestor. A AC-014 le o CONTEUDO de
-- todas as migrations da arvore deste SHA, e nao o nome dos diretorios, porque
-- por nome bastaria esconder o `CREATE CONSTRAINT TRIGGER` aqui dentro.
--
-- Tudo o que sobe aqui e ADITIVO. Na janela de sobreposicao do deploy o
-- binario anterior continua criando acao nua (LIM-069b), e nao ha trigger para
-- reprova-la — e por isso esta ordem e a segura.

-- =========================================================================
-- 1. O tipo do evento
-- =========================================================================
--
-- Um valor so, e de proposito: o evento nomeia o GESTO que a acao ja nomeia
-- do outro lado (`turma_professor_alterado`). Os gestos de grade continuam em
-- `eventos_de_ocupacao` (LIM-069a) — esta tabela nao remonta a historia da
-- turma, e o Swagger do leitor dira isso com todas as letras.
CREATE TYPE "tipo_de_evento_de_turma" AS ENUM ('professor_alterado');

-- =========================================================================
-- 2. A tabela
-- =========================================================================
--
-- `id` sem DEFAULT no banco, como nas duas irmas: quem gera e o cliente
-- (`@default(uuid())` do Prisma). Trocar isso aqui criaria drift com o modelo.
CREATE TABLE "eventos_de_turma" (
  "id"         UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "acao_id"    UUID NOT NULL,
  "turma_id"   UUID NOT NULL,
  "tipo"       "tipo_de_evento_de_turma" NOT NULL,
  "criado_em"  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "eventos_de_turma_pkey" PRIMARY KEY ("id")
);

-- =========================================================================
-- 3. As duas FKs, e as duas carregam a EMPRESA
-- =========================================================================
--
-- Mesma regra do D18 da SPEC-031 e da INV-054: *"nao ha caminho hoje" nao e a
-- mesma coisa que "o banco nao deixa"*. Os dois alvos compostos ja existem —
-- `acoes_company_id_id_key` (SPEC-032) e `turmas_company_id_id_key`
-- (SPEC-025).
--
-- **As duas pernas importam, e provar uma nao prova a outra** (INV-069d): um
-- evento com o `company_id` da turma certa e a acao de OUTRA empresa e tao
-- cross-tenant quanto o inverso. A AC-011 falseia a perna da turma; a prova
-- irma, no mesmo arquivo, falseia a da acao.
ALTER TABLE "eventos_de_turma"
  ADD CONSTRAINT "eventos_turma_acao_fkey"
  FOREIGN KEY ("company_id", "acao_id")
  REFERENCES "acoes_administrativas"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "eventos_de_turma"
  ADD CONSTRAINT "eventos_turma_turma_fkey"
  FOREIGN KEY ("company_id", "turma_id")
  REFERENCES "turmas"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =========================================================================
-- 4. Append-only (INV-069c), pela funcao que ja existe
-- =========================================================================
--
-- **Nenhuma funcao nova.** A `append_only_com_valvula_de_teste()` da SPEC-032
-- ja e a mesma dos cinco irmaos, e criar outra aqui daria a AC-014 uma
-- pergunta a mais para responder ("esta funcao e a do trigger do Deploy 2?").
--
-- A valvula continua exigindo as DUAS coisas: o GUC de transacao E a role
-- `playck_test_cleanup`, que so existe no banco de testes. Sem a role,
-- `current_user` nunca bate — e e isso que a torna inexistente em producao.
--
-- Consequencia operacional, e ela ja custou caro duas vezes neste projeto:
-- `eventos_de_turma` tem de entrar TAMBEM no conjunto `APPEND_ONLY` de
-- `test/banco/limpar-empresa.ts`, que e outro conjunto da lista de tabelas.
CREATE TRIGGER "eventos_turma_append_only"
  BEFORE UPDATE OR DELETE ON "eventos_de_turma"
  FOR EACH ROW EXECUTE FUNCTION "append_only_com_valvula_de_teste"();

-- =========================================================================
-- 5. Os indices — tres de `(company_id, acao_id)`, e um de leitura
-- =========================================================================
--
-- Ate aqui existia UM indice com `acao_id` no banco inteiro: o
-- `eventos_acao_idx` de `eventos_de_ocupacao`. `eventos_de_matricula` tinha so
-- a PK; `movimentos_de_credito`, a PK, um parcial de `movimento_origem_id` e
-- um UNIQUE de seis colunas liderado por `id`.
--
-- O `acao_exige_alvo` do Deploy 2 fara QUATRO `EXISTS` por commit, cada um
-- filtrando `company_id = NEW.company_id AND acao_id = NEW.id`. `company_id`
-- LIDERA os quatro btrees: um `EXISTS` so por `acao_id` — como faz o
-- precedente da SPEC-032 — nao usaria indice nenhum, e cada commit pagaria
-- quatro varreduras. Eles entram no Deploy 1, e nao junto do trigger, para
-- que o trigger nunca exista sem eles.
--
-- **`CREATE INDEX` simples, nunca `CONCURRENTLY`**: o `migrate deploy` roda a
-- migration inteira numa transacao, e `CONCURRENTLY` e recusado la dentro.
CREATE INDEX "eventos_turma_acao_idx"
  ON "eventos_de_turma" ("company_id", "acao_id");

CREATE INDEX "eventos_matricula_acao_idx"
  ON "eventos_de_matricula" ("company_id", "acao_id");

CREATE INDEX "movimentos_acao_idx"
  ON "movimentos_de_credito" ("company_id", "acao_id");

-- O quarto e de LEITURA, espelhando o `eventos_ocupacao_idx` do irmao, e nao
-- estava no write-set da spec — entrou como delta da TASK-001, com duas
-- razoes medidas:
--
-- 1. FK NAO cria indice no Postgres. Sem ele, o leitor da TASK-003
--    (`GET /classes/:id/eventos`, que ordena por `criado_em` DESC) varre a
--    tabela;
-- 2. a FK `eventos_turma_turma_fkey` e RESTRICT, entao TODO `DELETE` de turma
--    — inclusive o de `limparEmpresa`, em toda suite — confere esta tabela
--    por `turma_id`, e sem indice cada delete paga varredura.
CREATE INDEX "eventos_turma_idx"
  ON "eventos_de_turma" ("company_id", "turma_id", "criado_em" DESC);
