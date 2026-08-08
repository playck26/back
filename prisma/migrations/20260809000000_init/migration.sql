-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateEnum
CREATE TYPE "empresa_status" AS ENUM ('ativa', 'inativa');

-- CreateEnum
CREATE TYPE "usuario_role" AS ENUM ('super_admin', 'company_admin', 'aluno');

-- CreateEnum
CREATE TYPE "usuario_status" AS ENUM ('ativo', 'inativo');

-- CreateTable
CREATE TABLE "empresas" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "logo_url" TEXT,
    "esportes" TEXT[],
    "status" "empresa_status" NOT NULL DEFAULT 'ativa',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "empresas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuarios" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "senha_hash" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "telefone" TEXT,
    "role" "usuario_role" NOT NULL,
    "company_id" UUID,
    "status" "usuario_status" NOT NULL DEFAULT 'ativo',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "empresas_nome_key" ON "empresas"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

-- CreateIndex
CREATE INDEX "usuarios_company_id_idx" ON "usuarios"("company_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_usuario_id_idx" ON "refresh_tokens"("usuario_id");

-- AddForeignKey
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- INV-002 (DATA_MODEL.md): company_id é obrigatório para company_admin/aluno
-- e precisa ser NULL para super_admin. Não expressável no schema.prisma
-- (sem suporte nativo a CHECK multi-coluna condicional) — mantido só na
-- migration manual, nunca removido em `prisma migrate dev` subsequente.
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_company_id_role_check" CHECK (
    ("role" = 'super_admin' AND "company_id" IS NULL)
    OR ("role" IN ('company_admin', 'aluno') AND "company_id" IS NOT NULL)
);

