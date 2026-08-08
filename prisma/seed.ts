// Seed de desenvolvimento — incremental por spec dona (DATA_MODEL.md, seção
// Seeds/Fixtures). Etapa 1 (SPEC-001): 1 empresa demo + 1 usuário
// company_admin + 1 super_admin (adicionado na SPEC-002 — sem ele não há
// como usar nenhuma rota de /companies, já que toda criação de empresa
// exige já estar autenticado como super_admin; não existe endpoint público
// de bootstrap). Specs seguintes estendem este mesmo arquivo com suas
// próprias etapas — nunca criar um script de seed paralelo.
import { randomBytes } from 'node:crypto';
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

  return empresa;
}

// Etapa 2 (SPEC-004:TASK-008): 2 quadras para a empresa demo. `quadras`
// não tem UNIQUE(company_id, nome) em DATA_MODEL.md — idempotência via
// find-then-create (não dá pra usar prisma.quadra.upsert sem uma chave
// única de verdade).
async function seedEtapa2(companyId: string) {
  const quadrasDemo = [
    { nome: 'Quadra 1', esporte: 'tenis', precoHora: 80 },
    { nome: 'Quadra 2', esporte: 'tenis', precoHora: 80 },
  ];

  for (const dadosQuadra of quadrasDemo) {
    const existente = await prisma.quadra.findFirst({
      where: { companyId, nome: dadosQuadra.nome },
    });
    if (!existente) {
      await prisma.quadra.create({ data: { companyId, ...dadosQuadra } });
    }
  }

  console.log(`[seed] etapa 2 ok — ${quadrasDemo.length} quadras para a empresa demo`);
}

// Etapa 3 (SPEC-003, fatia de turmas): 2 niveis, 1 professor, 3
// usuarios+alunos e 1 turma (usando a quadra semeada pela etapa 2), com os
// 3 alunos alocados em turma_alunos. `niveis` tem UNIQUE(company_id, nome)
// -> upsert; `professores`/`turmas` não têm chave única de negócio própria
// -> find-then-create (mesmo padrão da etapa 2). Alunos seguem o mesmo
// caminho de StudentsService.create (usuario + aluno numa transação, senha
// aleatória nunca exposta/logada) para não duplicar regra de negócio fora
// da service layer.
async function seedEtapa3(companyId: string) {
  const niveisDemo = [
    { nome: 'Iniciante', ordem: 1 },
    { nome: 'Intermediário', ordem: 2 },
  ];
  const niveisIds: string[] = [];
  for (const dadosNivel of niveisDemo) {
    const nivel = await prisma.nivel.upsert({
      where: { companyId_nome: { companyId, nome: dadosNivel.nome } },
      update: {},
      create: { companyId, ...dadosNivel },
    });
    niveisIds.push(nivel.id);
  }

  let professor = await prisma.professor.findFirst({
    where: { companyId, nome: 'Professor Demo' },
  });
  if (!professor) {
    professor = await prisma.professor.create({
      data: {
        companyId,
        nome: 'Professor Demo',
        email: 'professor@smarttennis.demo',
      },
    });
  }

  const alunosDemo = [
    { nome: 'Aluno Demo 1', email: 'aluno1@smarttennis.demo' },
    { nome: 'Aluno Demo 2', email: 'aluno2@smarttennis.demo' },
    { nome: 'Aluno Demo 3', email: 'aluno3@smarttennis.demo' },
  ];
  const alunosIds: string[] = [];
  for (const dadosAluno of alunosDemo) {
    const usuarioExistente = await prisma.usuario.findUnique({
      where: { email: dadosAluno.email },
    });
    if (usuarioExistente) {
      const alunoExistente = await prisma.aluno.findUnique({
        where: { usuarioId: usuarioExistente.id },
      });
      if (alunoExistente) {
        alunosIds.push(alunoExistente.id);
      }
      continue;
    }

    const senhaHash = await bcrypt.hash(randomBytes(24).toString('hex'), 12);
    const aluno = await prisma.$transaction(async (tx) => {
      const usuario = await tx.usuario.create({
        data: {
          email: dadosAluno.email,
          senhaHash,
          nome: dadosAluno.nome,
          role: 'aluno',
          companyId,
          status: 'ativo',
        },
      });
      return tx.aluno.create({
        data: { usuarioId: usuario.id, companyId, nivelId: niveisIds[0] },
      });
    });
    alunosIds.push(aluno.id);
  }

  const quadra = await prisma.quadra.findFirst({
    where: { companyId },
    orderBy: { createdAt: 'asc' },
  });
  if (!quadra) {
    console.log(
      '[seed] etapa 3 pulada (turma) — nenhuma quadra encontrada, rode a etapa 2 primeiro',
    );
    return;
  }

  const NOME_TURMA_DEMO = 'Turma Demo Terça 14h';
  let turma = await prisma.turma.findFirst({
    where: { companyId, nome: NOME_TURMA_DEMO },
  });
  if (!turma) {
    turma = await prisma.turma.create({
      data: {
        companyId,
        nome: NOME_TURMA_DEMO,
        nivelId: niveisIds[0],
        professorId: professor.id,
        quadraId: quadra.id,
        diaSemana: 2,
        horaInicio: new Date('1970-01-01T14:00:00.000Z'),
        horaFim: new Date('1970-01-01T15:00:00.000Z'),
        capacidade: 6,
      },
    });
  }

  for (const alunoId of alunosIds) {
    await prisma.turmaAluno.upsert({
      where: { turmaId_alunoId: { turmaId: turma.id, alunoId } },
      update: {},
      create: { turmaId: turma.id, alunoId },
    });
  }

  console.log(
    `[seed] etapa 3 ok — ${niveisDemo.length} níveis, 1 professor, ${alunosIds.length} alunos, turma "${turma.nome}" (${alunosIds.length} alocações em turma_alunos)`,
  );
}

async function main() {
  const empresa = await seedEtapa1();
  await seedEtapa2(empresa.id);
  await seedEtapa3(empresa.id);
}

main()
  .catch((error: unknown) => {
    console.error('[seed] falhou:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
