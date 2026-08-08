-- CreateTable
CREATE TABLE "niveis" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "niveis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professores" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "telefone" TEXT,
    "email" TEXT,
    "status" "usuario_status" NOT NULL DEFAULT 'ativo',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "professores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alunos" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "nivel_id" UUID,
    "status" "usuario_status" NOT NULL DEFAULT 'ativo',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alunos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "niveis_company_id_idx" ON "niveis"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "niveis_company_id_nome_key" ON "niveis"("company_id", "nome");

-- CreateIndex
CREATE INDEX "professores_company_id_idx" ON "professores"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "alunos_usuario_id_key" ON "alunos"("usuario_id");

-- CreateIndex
CREATE INDEX "alunos_company_id_idx" ON "alunos"("company_id");

-- AddForeignKey
ALTER TABLE "niveis" ADD CONSTRAINT "niveis_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professores" ADD CONSTRAINT "professores_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alunos" ADD CONSTRAINT "alunos_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alunos" ADD CONSTRAINT "alunos_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alunos" ADD CONSTRAINT "alunos_nivel_id_fkey" FOREIGN KEY ("nivel_id") REFERENCES "niveis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

