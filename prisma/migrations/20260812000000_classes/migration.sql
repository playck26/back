-- CreateEnum
CREATE TYPE "turma_status" AS ENUM ('ativa', 'inativa');

-- CreateTable
CREATE TABLE "turmas" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "nivel_id" UUID,
    "professor_id" UUID,
    "quadra_id" UUID NOT NULL,
    "dia_semana" INTEGER NOT NULL,
    "hora_inicio" TIME NOT NULL,
    "hora_fim" TIME NOT NULL,
    "capacidade" INTEGER NOT NULL,
    "status" "turma_status" NOT NULL DEFAULT 'ativa',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "turmas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turma_alunos" (
    "id" UUID NOT NULL,
    "turma_id" UUID NOT NULL,
    "aluno_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "turma_alunos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "turmas_company_id_idx" ON "turmas"("company_id");

-- CreateIndex
CREATE INDEX "turmas_quadra_id_idx" ON "turmas"("quadra_id");

-- CreateIndex
CREATE INDEX "turma_alunos_turma_id_idx" ON "turma_alunos"("turma_id");

-- CreateIndex
CREATE INDEX "turma_alunos_aluno_id_idx" ON "turma_alunos"("aluno_id");

-- CreateIndex
CREATE UNIQUE INDEX "turma_alunos_turma_id_aluno_id_key" ON "turma_alunos"("turma_id", "aluno_id");

-- AddForeignKey
ALTER TABLE "turmas" ADD CONSTRAINT "turmas_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turmas" ADD CONSTRAINT "turmas_nivel_id_fkey" FOREIGN KEY ("nivel_id") REFERENCES "niveis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turmas" ADD CONSTRAINT "turmas_professor_id_fkey" FOREIGN KEY ("professor_id") REFERENCES "professores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turmas" ADD CONSTRAINT "turmas_quadra_id_fkey" FOREIGN KEY ("quadra_id") REFERENCES "quadras"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turma_alunos" ADD CONSTRAINT "turma_alunos_turma_id_fkey" FOREIGN KEY ("turma_id") REFERENCES "turmas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turma_alunos" ADD CONSTRAINT "turma_alunos_aluno_id_fkey" FOREIGN KEY ("aluno_id") REFERENCES "alunos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: origem_turma_id existe em ocupacoes_quadra desde
-- SPEC-004:TASK-001 (sem FK, `turmas` não existia ainda) — TASK-000b
-- fecha a referência agora que a tabela existe (DATA_MODEL.md).
ALTER TABLE "ocupacoes_quadra" ADD CONSTRAINT "ocupacoes_quadra_origem_turma_id_fkey" FOREIGN KEY ("origem_turma_id") REFERENCES "turmas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: hora_fim > hora_inicio (DATA_MODEL.md) — mesma convenção das
-- demais CHECK/EXCLUDE deste projeto: não expressável no schema.prisma,
-- escrita manualmente na migration.
ALTER TABLE "turmas" ADD CONSTRAINT "turmas_hora_fim_apos_hora_inicio" CHECK ("hora_fim" > "hora_inicio");

-- CHECK: capacidade > 0 (DATA_MODEL.md)
ALTER TABLE "turmas" ADD CONSTRAINT "turmas_capacidade_positiva" CHECK ("capacidade" > 0);
