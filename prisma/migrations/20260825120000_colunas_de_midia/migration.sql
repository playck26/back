-- SPEC-018:TASK-001 — as seis colunas de mídia. EXPAND PURO, sem backfill.
--
-- **Nada escreve nelas ainda.** As rotas são das TASK-003 a TASK-006, e o
-- `KeyReferenceChecker` que as lê é da TASK-007. Seis colunas nulas em
-- produção não mudam comportamento nenhum, e é por isso que elas podem ir
-- antes — mesmo raciocínio da migration da fila (SPEC-017:TASK-004).
--
-- **Por que são duas colunas de foto de pessoa e não uma** (decisão 2 da
-- spec): `professores.usuario_id` é NULÁVEL. Professor cadastrado sem conta
-- é o caso normal, e a foto dele não teria onde morar numa coluna só de
-- `usuarios`. A resolução na leitura é
-- `coalesce(usuarios.foto_key, professores.foto_key)` (INV-034): quem tem
-- conta manda na própria imagem.
--
-- CHECKLIST DA LIÇÃO DE 2026-08-22 (o 500 que chegou a produção):
-- constraint escrita à mão não aparece no `schema.prisma` e `migrate diff`
-- não a acusa. Esta migration **não** altera nenhum enum, **não** toca
-- `usuarios_company_id_role_check`, o CHECK de `valor` em `ocupacoes_quadra`,
-- `presencas_origem_tipo_check`, `chamadas_completude_esperados_check` nem
-- nenhum dos `arquivos_pendentes_*_check`. Só adiciona coluna e constraint
-- nova. Conferido antes de aplicar.

-- AlterTable
ALTER TABLE "usuarios" ADD COLUMN "foto_key" TEXT;
ALTER TABLE "professores" ADD COLUMN "foto_key" TEXT;
ALTER TABLE "empresas" ADD COLUMN "logo_key" TEXT;
ALTER TABLE "quadras" ADD COLUMN "imagem_key" TEXT;
ALTER TABLE "quadras" ADD COLUMN "imagem_confirmada_por" UUID;
ALTER TABLE "quadras" ADD COLUMN "imagem_confirmada_em" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "quadras_imagem_confirmada_por_idx" ON "quadras"("imagem_confirmada_por");

-- AddForeignKey
--
-- `Restrict`, igual a `chamadas.registrada_por`. A confirmação da AC-008 é
-- registro de quem garantiu o quê e quando (decisão 1, ponto 2) — vale
-- justamente por ter nome de gente. `SetNull` apagaria o nome e deixaria a
-- imagem pública no ar sem autor, que é o estado que a decisão 1 existe
-- para não permitir.
ALTER TABLE "quadras"
  ADD CONSTRAINT "quadras_imagem_confirmada_por_fkey"
  FOREIGN KEY ("imagem_confirmada_por") REFERENCES "usuarios"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- =========================================================================
-- As constraints que fazem o trabalho — nenhuma delas o Prisma expressa
-- =========================================================================

-- AC-008 imposta pelo BANCO: imagem de quadra e confirmação vivem e morrem
-- juntas. Sem isto, `imagem_key` gravada por um caminho que esqueceu a
-- confirmação é indistinguível de uma confirmada — e a AC-007 vira aviso de
-- tela, que é exatamente o que a decisão 1 recusa. O caso "trocar exige
-- confirmar de novo" também cai aqui: um UPDATE que troque só a chave
-- deixaria as três incoerentes se o serviço não regravasse as outras duas.
ALTER TABLE "quadras"
  ADD CONSTRAINT "quadras_imagem_confirmada_check"
  CHECK (
    ("imagem_key" IS NULL
      AND "imagem_confirmada_por" IS NULL
      AND "imagem_confirmada_em" IS NULL)
    OR
    ("imagem_key" IS NOT NULL
      AND "imagem_confirmada_por" IS NOT NULL
      AND "imagem_confirmada_em" IS NOT NULL)
  );

-- AC-014/INV-030 impostas pelo BANCO, uma por coluna de mídia: a chave
-- gravada tem de morar sob a empresa do próprio dono da linha. É a mesma
-- defesa que `arquivos_pendentes_key_da_empresa_check` dá à fila, e existe
-- pelo mesmo motivo: o prefixo e o escopo por token leem o mesmo token e
-- concordariam entre si. Só a comparação com a LINHA percebe chave de outra
-- empresa.
--
-- **O resto da gramática (`<tipo>/<recurso>/<sha256>.webp`) NÃO entra aqui,
-- de propósito** — a fonte única dela é `chave-de-midia.ts`, e duas
-- definições da mesma gramática é não ter nenhuma. O banco garante o que é
-- invariante de isolamento; a forma completa, e o casamento de `<tipo>` com
-- a coluna, ficam com `conferirChave()`.

ALTER TABLE "professores"
  ADD CONSTRAINT "professores_foto_da_empresa_check"
  CHECK (
    "foto_key" IS NULL
    OR ("foto_key" LIKE 'empresas/%'
        AND split_part("foto_key", '/', 2) = "company_id"::text)
  );

ALTER TABLE "quadras"
  ADD CONSTRAINT "quadras_imagem_da_empresa_check"
  CHECK (
    "imagem_key" IS NULL
    OR ("imagem_key" LIKE 'empresas/%'
        AND split_part("imagem_key", '/', 2) = "company_id"::text)
  );

-- Em `empresas` o dono é a própria linha, então a comparação é com o `id`.
ALTER TABLE "empresas"
  ADD CONSTRAINT "empresas_logo_da_empresa_check"
  CHECK (
    "logo_key" IS NULL
    OR ("logo_key" LIKE 'empresas/%'
        AND split_part("logo_key", '/', 2) = "id"::text)
  );

-- `usuarios` é o caso que não fecha sozinho, e o CHECK deixa isso explícito
-- em vez de esconder: **`usuarios.company_id` é NULÁVEL** — o `super_admin`
-- não tem empresa. A gramática da chave (INV-035) começa por
-- `empresas/<company_id>/` e **não tem como representar** foto de quem não
-- pertence a nenhuma empresa.
--
-- Então este CHECK decide, fail-closed: **quem não tem empresa não tem foto
-- de perfil.** Não é a decisão silenciosa — é a única que a gramática
-- permite hoje, e ela precisa de confirmação de produto (o contrato da
-- SPEC-018 diz `PUT /api/v1/me/foto` para "qualquer autenticado", o que
-- inclui o `super_admin`). Está registrado na spec como pergunta aberta da
-- TASK-003. A alternativa — um prefixo fora de `empresas/` — mexeria na
-- gramática da SPEC-017, e isso é decisão de arquitetura, não de migration.
ALTER TABLE "usuarios"
  ADD CONSTRAINT "usuarios_foto_da_empresa_check"
  CHECK (
    "foto_key" IS NULL
    OR ("company_id" IS NOT NULL
        AND "foto_key" LIKE 'empresas/%'
        AND split_part("foto_key", '/', 2) = "company_id"::text)
  );
