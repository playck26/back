// Seed de desenvolvimento — incremental por spec dona (DATA_MODEL.md, seção
// Seeds/Fixtures). Etapa 1 (SPEC-001): 1 empresa demo + 1 usuário
// company_admin + 1 super_admin (adicionado na SPEC-002 — sem ele não há
// como usar nenhuma rota de /companies, já que toda criação de empresa
// exige já estar autenticado como super_admin; não existe endpoint público
// de bootstrap). Specs seguintes estendem este mesmo arquivo com suas
// próprias etapas — nunca criar um script de seed paralelo.
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const EMPRESA_DEMO_NOME = 'Smart Tennis (demo)';
const ADMIN_DEMO_EMAIL = 'admin@smarttennis.demo';
const ADMIN_DEMO_SENHA = 'trocar-em-producao-123';
const SUPER_ADMIN_EMAIL = 'superadmin@playck.demo';
const SUPER_ADMIN_SENHA = 'trocar-em-producao-123';

async function seedEtapa1() {
  const empresa = await prisma.empresa.upsert({
    where: { nome: EMPRESA_DEMO_NOME },
    update: {},
    create: {
      nome: EMPRESA_DEMO_NOME,
      esportes: ['tenis'],
      status: 'ativa',
    },
  });

  const senhaHash = await bcrypt.hash(ADMIN_DEMO_SENHA, 12);
  await prisma.usuario.upsert({
    where: { email: ADMIN_DEMO_EMAIL },
    update: {},
    create: {
      email: ADMIN_DEMO_EMAIL,
      senhaHash,
      nome: 'Admin Demo',
      role: 'company_admin',
      companyId: empresa.id,
      status: 'ativo',
    },
  });

  const superAdminSenhaHash = await bcrypt.hash(SUPER_ADMIN_SENHA, 12);
  await prisma.usuario.upsert({
    where: { email: SUPER_ADMIN_EMAIL },
    update: {},
    create: {
      email: SUPER_ADMIN_EMAIL,
      senhaHash: superAdminSenhaHash,
      nome: 'Super Admin Demo',
      role: 'super_admin',
      companyId: null,
      status: 'ativo',
    },
  });

  console.log(`[seed] etapa 1 ok — empresa "${empresa.nome}" (${empresa.id}), admin ${ADMIN_DEMO_EMAIL}, super admin ${SUPER_ADMIN_EMAIL}`);
}

async function main() {
  await seedEtapa1();
}

main()
  .catch((error: unknown) => {
    console.error('[seed] falhou:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
