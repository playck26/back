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
// SPEC-075/D13 — por caminho RELATIVO: o seed roda por `ts-node prisma/seed.ts`
// sem `tsconfig-paths` (package.json, `prisma.seed`). Por isso
// `nivel-efetivo.ts` e `chave-de-lock.ts` não importam Nest nem usam alias.
import {
  criarNiveisPadrao,
  recusaPorNivel,
  travarNivelDaEmpresa,
} from '../src/people/nivel-efetivo';

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
const SUPER_ADMIN_EMAIL = 'superadmin@playck.demo';

/**
 * SPEC-014:TASK-000 — a senha do seed sai do codigo.
 *
 * Ate 2026-08-22 este arquivo trazia `'trocar-em-producao-123'` literal, em
 * **duas** constantes, num repositorio **publico** — e era a senha viva das
 * duas contas de administracao em producao. O nome dizia o que fazer e
 * ninguem fez, porque nao havia tela de troca de senha no Admin nem no
 * SAdmin: a porta so foi aberta nesta mesma task.
 *
 * Agora vem de variavel de ambiente e **falha alto** se faltar. Um default
 * seria a mesma armadilha com outro nome: quem roda sem a variavel merece
 * um erro, nao uma conta previsivel.
 */
function senhaObrigatoria(variavel: string): string {
  const valor = process.env[variavel];
  if (!valor || valor.length < 12) {
    throw new Error(
      `${variavel} ausente ou curta demais (minimo 12 caracteres). ` +
        'O seed nao cria conta com senha embutida no codigo — defina a ' +
        'variavel de ambiente antes de rodar.',
    );
  }
  return valor;
}

async function seedEtapa1() {
  const empresa = await prisma.empresa.upsert({
    where: { slug: EMPRESA_QA_SLUG },
    update: {},
    create: {
      nome: EMPRESA_QA_NOME,
      slug: EMPRESA_QA_SLUG,
      // SPEC-020/TASK-004 — `esportes: ['tenis']` saiu: a coluna não existe
      // mais. O catálogo é a lista, e ele nasce junto (INV-057).
      esportesQuadra: { create: [{ nome: 'Tênis', ordem: 0 }] },
      status: 'ativa',
      // Empresa de QA não expõe link público de auto-cadastro: dado de
      // teste não deve ser alcançável por quem não conhece o ambiente.
      permiteAutoCadastro: false,
    },
  });

  /**
   * DEF-025 — **o horario padrao dos sete dias, que este seed nao criava.**
   *
   * `CompaniesService.create` semeia isto na criacao de toda empresa, e o
   * comentario de la ja dizia o que aconteceria sem: *"o admin abriria a tela
   * de configuracao vazia e nao entenderia de onde vem os horarios que o
   * aluno enxerga"*.
   *
   * **Este seed cria a empresa por `prisma.empresa.upsert`, direto** -- ele
   * pula o servico, e com ele a semeadura. Em 2026-09-10, testando local, o
   * Israel abriu a ficha de uma quadra e o bloco de horario nao tinha grade
   * nenhuma; "Salvar horarios" respondia `400 dias must contain at least 7
   * elements`, porque a tela mandava de volta a lista vazia que recebeu.
   *
   * O servico ganhou uma rede de seguranca para nunca mais devolver lista
   * vazia. **Esta linha continua sendo necessaria**: sem ela o banco de
   * demonstracao ficaria num estado que nenhuma empresa de producao tem, e o
   * proximo defeito encontrado aqui seria de novo do ambiente, nao do
   * produto.
   *
   * `skipDuplicates` porque o seed e idempotente por contrato -- rodar duas
   * vezes nao pode estourar com `23505`.
   */
  await prisma.horarioFuncionamento.createMany({
    data: Array.from({ length: 7 }, (_, diaSemana) => ({
      companyId: empresa.id,
      quadraId: null,
      diaSemana,
      horaInicio: new Date('1970-01-01T06:00:00.000Z'),
      horaFim: new Date('1970-01-01T22:00:00.000Z'),
      fechado: false,
    })),
    skipDuplicates: true,
  });

  const senhaHash = await bcrypt.hash(senhaObrigatoria('SEED_ADMIN_SENHA'), 12);
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

  const superAdminSenhaHash = await bcrypt.hash(
    senhaObrigatoria('SEED_SUPER_ADMIN_SENHA'),
    12,
  );
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

  console.log(
    `[seed] etapa 1 ok — empresa "${empresa.nome}" (${empresa.id}), admin ${ADMIN_DEMO_EMAIL}, super admin ${SUPER_ADMIN_EMAIL}`,
  );

  return empresa;
}

// Etapa 2 (SPEC-004:TASK-008): 2 quadras para a empresa demo. `quadras`
// não tem UNIQUE(company_id, nome) em DATA_MODEL.md — idempotência via
// find-then-create (não dá pra usar prisma.quadra.upsert sem uma chave
// única de verdade).
async function seedEtapa2(companyId: string) {
  // SPEC-020/TASK-004 — quadra sem esporte deixou de existir: `esporte_id` é
  // `NOT NULL` e aponta para o catálogo da própria empresa (FK composta).
  // O seed precisa da opção antes da quadra, e não de um texto.
  const esporte = await prisma.esporteDeQuadra.upsert({
    where: { companyId_nome: { companyId, nome: 'Tênis' } },
    update: {},
    create: { companyId, nome: 'Tênis', ordem: 0 },
  });

  const quadrasDemo = [
    { nome: 'Quadra 1', precoHora: 80 },
    { nome: 'Quadra 2', precoHora: 80 },
  ];

  for (const dadosQuadra of quadrasDemo) {
    const existente = await prisma.quadra.findFirst({
      where: { companyId, nome: dadosQuadra.nome },
    });
    if (!existente) {
      await prisma.quadra.create({
        data: { companyId, esporteId: esporte.id, ...dadosQuadra },
      });
    }
  }

  console.log(
    `[seed] etapa 2 ok — ${quadrasDemo.length} quadras para a empresa demo`,
  );
}

// Etapa 3 (SPEC-003, fatia de turmas): os niveis, 1 professor, 3
// usuarios+alunos e 1 turma (usando a quadra semeada pela etapa 2), com os
// 3 alunos alocados em turma_alunos. `niveis` tem UNIQUE(company_id, nome)
// -> upsert; `professores`/`turmas` não têm chave única de negócio própria
// -> find-then-create (mesmo padrão da etapa 2). Alunos seguem o mesmo
// caminho de StudentsService.create (usuario + aluno numa transação, senha
// aleatória nunca exposta/logada) para não duplicar regra de negócio fora
// da service layer.
async function seedEtapa3(companyId: string) {
  // SPEC-075/D13 + AC-030 — **o seed só cria níveis numa empresa SEM nível.**
  //
  // Antes ele fazia `upsert` de Iniciante e Intermediário. Numa empresa de QA
  // que só tivesse o Intermediário, recriar o Iniciante mudava QUEM É O
  // PRIMEIRO — e um aluno sem nível numa turma Intermediário ficava fora do
  // nível dela, em sequência, sem corrida nenhuma (5ª rodada, N5-02). Numa
  // empresa sem nível nenhum, nenhuma turma tem nível, e criar níveis ali não
  // pode quebrar par. E a lista criada é a MESMA da empresa nova (decisão 7),
  // pela mesma função — o seed não tem lista própria.
  //
  // Com nível, o seed não escreve nível nenhum e exige só o que ele usa: o
  // Iniciante, que é o dos alunos e da turma demo. Os bancos de QA de antes
  // (com Iniciante e Intermediário) seguem funcionando.
  //
  // **A trava só onde se escreve.** Numa empresa que já tem nível, o seed não
  // escreve nível nenhum — e não trava. Numa empresa sem nível, a escrita vai
  // numa transação cuja PRIMEIRA instrução é a trava de nível da empresa (D13),
  // e a contagem é refeita SOB ela: um gestor da empresa de QA criando nível no
  // mesmo instante não corre junto. (Travar sempre, como na primeira versão,
  // fazia o seed estourar na trava dos níveis antes de chegar às matrículas — e
  // a prova da trava das matrículas nunca as exercitava: a sabotagem L08
  // passava verde.)
  if ((await prisma.nivel.count({ where: { companyId } })) === 0) {
    await prisma.$transaction(async (tx) => {
      await travarNivelDaEmpresa(tx, companyId);
      if ((await tx.nivel.count({ where: { companyId } })) === 0) {
        await criarNiveisPadrao(tx, companyId);
      }
    });
  }
  const iniciante = await prisma.nivel.findUnique({
    where: { companyId_nome: { companyId, nome: 'Iniciante' } },
    select: { id: true },
  });
  if (!iniciante) {
    throw new Error(
      'seed: a empresa de QA já tem níveis, e falta o Iniciante. O seed não ' +
        'cria nível numa empresa que já tem nível (SPEC-075, AC-030) — crie o ' +
        'Iniciante pelo Admin, ou apague os níveis da empresa de QA.',
    );
  }
  const niveisIds = [iniciante.id];

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
        capacidade: 6,
        // SPEC-019/TASK-003 — a recorrência saiu de `turmas` e virou
        // `encontros`. **A turma demo nasce com DOIS dias**, de propósito:
        // uma turma de um dia só exercitaria o caso que já funcionava antes
        // desta spec, e o dado de demonstração deve mostrar o que o produto
        // faz de novo.
        encontros: {
          create: [
            {
              diaSemana: 2,
              horaInicio: new Date('1970-01-01T14:00:00.000Z'),
              horaFim: new Date('1970-01-01T15:00:00.000Z'),
            },
            {
              diaSemana: 5,
              horaInicio: new Date('1970-01-01T19:00:00.000Z'),
              horaFim: new Date('1970-01-01T20:00:00.000Z'),
            },
          ],
        },
      },
    });
  }

  // SPEC-075/D13 + INV-075a — **as matrículas demo, numa transação só, sob a
  // trava de nível da empresa (PRIMEIRA instrução), e cada par NOVO conferido
  // pelo mesmo predicado da API.** Um aluno demo que o gestor de QA tenha
  // mudado de nível, e tirado da turma, não volta para ela fora do nível: o
  // seed ABORTA, com o nome do aluno e da turma — abortar, e não pular, porque
  // pular deixaria a demo diferente do que o log diz (decisão operacional,
  // julgada na 5ª rodada, R5-03). Matrícula que já existe não é reescrita.
  const turmaDemo = turma;
  await prisma.$transaction(async (tx) => {
    await travarNivelDaEmpresa(tx, companyId);
    for (const alunoId of alunosIds) {
      const jaExiste = await tx.turmaAluno.findUnique({
        where: { turmaId_alunoId: { turmaId: turmaDemo.id, alunoId } },
        select: { id: true },
      });
      if (jaExiste) continue;
      const doAluno = await tx.aluno.findUniqueOrThrow({
        where: { id: alunoId },
        select: { nivelId: true, usuario: { select: { nome: true } } },
      });
      const recusa = await recusaPorNivel(
        tx,
        companyId,
        turmaDemo.nivelId,
        doAluno.nivelId,
        'gestor',
      );
      if (recusa) {
        throw new Error(
          `seed: ${doAluno.usuario.nome} não entra na turma "${turmaDemo.nome}" — ` +
            `${recusa.message} (SPEC-075, INV-075a)`,
        );
      }
      await tx.turmaAluno.upsert({
        where: { turmaId_alunoId: { turmaId: turmaDemo.id, alunoId } },
        update: {},
        create: { turmaId: turmaDemo.id, alunoId },
      });
    }
  });

  console.log(
    `[seed] etapa 3 ok — níveis da empresa de QA prontos, 1 professor, ${alunosIds.length} alunos, turma "${turma.nome}" (${alunosIds.length} alocações em turma_alunos)`,
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
