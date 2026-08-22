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

// SPEC-009:TASK-000 — a empresa demo do seed deixou de ser a empresa do
// cliente-vitrine. Antes, o seed semeava dentro da mesma empresa que o
// cliente real usa, então qualquer disparo do workflow `db-migrate.yml`
// com `run_seed: true` repovoava a base do cliente com aluno falso, quadra
// falsa e link de pagamento `pay.example.com`. Agora o seed é dono de uma
// empresa própria, isolada, e nunca escreve em outra.
//
// A chave de upsert é o **slug**, não o nome: o nome é editável pelo
// SAdmin (o do cliente-vitrine foi renomeado em 2026-08-22, o que já teria
// feito o upsert por nome criar uma segunda empresa em vez de reaproveitar
// a existente). O slug do QA é fixo e não deve ser renomeado.
const EMPRESA_QA_SLUG = 'playck-qa-demo';
const EMPRESA_QA_NOME = 'PlayCK QA (demo)';
const ADMIN_DEMO_EMAIL = 'admin@playck-qa.demo';
const ADMIN_DEMO_SENHA = 'trocar-em-producao-123';
const SUPER_ADMIN_EMAIL = 'superadmin@playck.demo';
const SUPER_ADMIN_SENHA = 'trocar-em-producao-123';

async function seedEtapa1() {
  const empresa = await prisma.empresa.upsert({
    where: { slug: EMPRESA_QA_SLUG },
    update: {},
    create: {
      nome: EMPRESA_QA_NOME,
      slug: EMPRESA_QA_SLUG,
      esportes: ['tenis'],
      status: 'ativa',
      // Empresa de QA não expõe link público de auto-cadastro: dado de
      // teste não deve ser alcançável por quem não conhece o ambiente.
      permiteAutoCadastro: false,
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
        email: 'professor@playck-qa.demo',
      },
    });
  }

  const alunosDemo = [
    { nome: 'Aluno Demo 1', email: 'aluno1@playck-qa.demo' },
    { nome: 'Aluno Demo 2', email: 'aluno2@playck-qa.demo' },
    { nome: 'Aluno Demo 3', email: 'aluno3@playck-qa.demo' },
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
        data: {
          usuarioId: usuario.id,
          companyId,
          nivelId: niveisIds[0],
          // Aluno semeado pertence à empresa de QA e é criado pelo próprio
          // seed (equivalente a cadastro pelo admin), então nasce aprovado
          // — o default do banco é `pendente`, fail-closed (SPEC-009).
          vinculo: 'aprovado',
        },
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

// Etapa 4 (SPEC-006): 1 config_pagamento_empresa para a empresa demo.
// `company_id` é UNIQUE (DATA_MODEL.md) — upsert direto.
async function seedEtapa4(companyId: string) {
  await prisma.configPagamentoEmpresa.upsert({
    where: { companyId },
    update: {},
    create: {
      companyId,
      linkPagamentoUrl: 'https://pay.example.com/smart-tennis-demo',
      whatsappNumero: '+5511999999999',
    },
  });

  console.log('[seed] etapa 4 ok — config de pagamento da empresa demo');
}

// Guarda de produção: o seed nunca deve rodar sem alguém ter decidido que
// deve. Mesmo escrevendo só na empresa de QA, ele cria dado falso visível
// no SAdmin de produção. `db-migrate.yml` já exige `run_seed: true` para
// chamar este script; esta é a segunda tranca, do lado do código.
function assertPodeRodar() {
  const ehProducao = process.env.NODE_ENV === 'production';
  if (ehProducao && process.env.SEED_ALLOW_PRODUCTION !== '1') {
    throw new Error(
      'Seed bloqueado: NODE_ENV=production sem SEED_ALLOW_PRODUCTION=1. ' +
        'O seed cria dado de demonstração; rodá-lo em produção precisa ser ' +
        'decisão explícita, não efeito colateral de um workflow.',
    );
  }
}

async function main() {
  assertPodeRodar();
  const empresa = await seedEtapa1();
  await seedEtapa2(empresa.id);
  await seedEtapa3(empresa.id);
  await seedEtapa4(empresa.id);
}

main()
  .catch((error: unknown) => {
    console.error('[seed] falhou:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
