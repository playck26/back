-- SPEC-017:TASK-004 (MOD-008) — a fila de exclusão de objeto de storage.
--
-- **Por que a fila existe.** A chave é derivada do conteúdo (AC-007), e isso
-- cria um caso que a lógica ingênua "troquei de imagem, enfileiro a
-- anterior" resolve errado: reenviar a mesma foto, ou trocar A -> B -> A,
-- apagaria o objeto que acabou de virar o atual. São três defesas, e esta
-- tabela é a segunda: não enfileirar chave igual (AC-013), reconferir antes
-- de apagar (AC-014), advisory lock por chave (INV-039).
--
-- **Esta migration é EXPAND PURO e não tem consumidor.** Nada escreve nesta
-- tabela ainda: a fila, o worker e o `KeyReferenceChecker` são a TASK-005.
-- Uma tabela vazia em produção não muda comportamento nenhum, e é
-- justamente por isso que ela pode ir antes.
--
-- CHECKLIST DA LIÇÃO DE 2026-08-22 (o 500 que chegou a produção):
-- constraint escrita à mão não aparece no `schema.prisma` e `migrate diff`
-- não a acusa. Esta migration **não** altera nenhum enum, **não** toca
-- `usuarios_company_id_role_check`, o CHECK de `valor` em
-- `ocupacoes_quadra`, `presencas_origem_tipo_check` nem
-- `chamadas_completude_esperados_check`. Só cria. Conferido antes de aplicar.

-- CreateTable
CREATE TABLE "arquivos_pendentes_exclusao" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "company_id" UUID NOT NULL,
    "motivo" TEXT NOT NULL,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "ultimo_erro" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lock_skip_count" INTEGER NOT NULL DEFAULT 0,
    "last_lock_conflict_at" TIMESTAMP(3),

    CONSTRAINT "arquivos_pendentes_exclusao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "arquivos_pendentes_exclusao_key_key" ON "arquivos_pendentes_exclusao"("key");

-- CreateIndex
CREATE INDEX "arquivos_pendentes_exclusao_criado_em_idx" ON "arquivos_pendentes_exclusao"("criado_em");

-- CreateIndex
CREATE INDEX "arquivos_pendentes_exclusao_company_id_idx" ON "arquivos_pendentes_exclusao"("company_id");

-- =========================================================================
-- As constraints que fazem o trabalho — nenhuma delas o Prisma expressa
-- =========================================================================

-- INV-030 imposta pelo BANCO, e é a razão de `company_id` existir numa
-- tabela que não tem FK para `empresas`. Sem este CHECK, a coluna seria uma
-- cópia do prefixo da chave que poderia discordar dele — e o teto por
-- empresa (AC-016c) passaria a contar pela cópia errada, o que é pior que
-- não ter teto: pararia a empresa errada e deixaria a certa esvaziar.
ALTER TABLE "arquivos_pendentes_exclusao"
  ADD CONSTRAINT "arquivos_pendentes_key_da_empresa_check"
  CHECK (
    "key" LIKE 'empresas/%'
    AND split_part("key", '/', 2) = "company_id"::text
  );

-- O resto da gramática da chave (`<tipo>/<recurso>/<sha256>.webp`, INV-035)
-- **não** entra aqui de propósito. Quem conhece a gramática é o parser da
-- TASK-003, e duas definições dela em lugares diferentes é o mesmo defeito
-- que a spec nomeia para o advisory lock: duas formas de calcular a mesma
-- coisa é não ter nenhuma. O banco garante o que é invariante de
-- isolamento; a forma completa fica com o parser, fonte única.

-- Contador negativo não é estado, é bug de UPDATE — e um `tentativas`
-- negativo faria o item nunca chegar às 5 falhas da AC-016, ficando na fila
-- para sempre sem sinalizar.
ALTER TABLE "arquivos_pendentes_exclusao"
  ADD CONSTRAINT "arquivos_pendentes_contadores_check"
  CHECK ("tentativas" >= 0 AND "lock_skip_count" >= 0);

-- Erro sem tentativa é afirmação sem lastro, no mesmo espírito do
-- `chamadas_completude_esperados_check`: se há `ultimo_erro`, alguma
-- tentativa falhou. Vale nos dois sentidos para o contador de lock, que a
-- AC-016d exige separado — misturar os dois é o que faria concorrência
-- normal parecer erro.
ALTER TABLE "arquivos_pendentes_exclusao"
  ADD CONSTRAINT "arquivos_pendentes_erro_com_tentativa_check"
  CHECK ("ultimo_erro" IS NULL OR "tentativas" > 0);

ALTER TABLE "arquivos_pendentes_exclusao"
  ADD CONSTRAINT "arquivos_pendentes_lock_com_conflito_check"
  CHECK (
    ("last_lock_conflict_at" IS NULL AND "lock_skip_count" = 0)
    OR
    ("last_lock_conflict_at" IS NOT NULL AND "lock_skip_count" > 0)
  );

-- `motivo` em branco derrota o propósito da coluna: ela existe para o
-- alerta de operação (AC-012/016) dizer POR QUE aquele arquivo ia sumir.
ALTER TABLE "arquivos_pendentes_exclusao"
  ADD CONSTRAINT "arquivos_pendentes_motivo_nao_vazio_check"
  CHECK (length(btrim("motivo")) > 0);
