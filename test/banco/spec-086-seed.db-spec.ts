/**
 * SPEC-086/AC-005 — **o seed (E9, E10) com o mesmo e-mail em outra empresa.**
 *
 * Sem `@unique` em `email`, o seed deixou de poder procurar o aluno demo só
 * pelo e-mail: `aluno1@playck-qa.demo` pode ter conta de aluno em OUTRA
 * empresa, e um `findFirst({ where: { email } })` acharia essa conta,
 * reaproveitaria o aluno dela e o matricularia na turma de QA (ou morreria na
 * FK composta). A spec manda buscar `{ email, companyId: empresaDeQa }`.
 *
 * A prova é a da spec, ao pé da letra: o seed **de verdade**, como processo
 * (`ts-node prisma/seed.ts`, o mesmo comando do `prisma.seed`), roda **duas
 * vezes seguidas** sobre um banco sem a empresa de QA e com
 * `aluno1@playck-qa.demo` já gravado como aluno de outra empresa — **gravado
 * antes**, para que uma busca sem empresa ache a linha errada. Ao fim:
 *
 * - os alunos ligados às turmas de QA são todos da empresa de QA, e são
 *   exatamente os três alunos demo;
 * - a conta da outra empresa continua como estava (nenhum campo mudou, e ela
 *   não entrou em turma de QA);
 * - a segunda rodada não cria nada (idempotência, E9 e E10).
 *
 * "Banco novo" aqui é: a empresa de QA não existe quando a primeira rodada
 * começa (`limparQa` antes). A suíte de banco do CI é um banco só, e a
 * `spec-082-leitor-escritor` já roda o seed nele do mesmo jeito.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture, nivelDaFixture } from './nivel-da-fixture';

jest.setTimeout(600_000);
exigirBancoLocal();

const RAIZ = join(__dirname, '..', '..');
const db = new PrismaClient();

const QA_SLUG = 'playck-qa-demo';
const OUTRA = '08600000-0000-4000-8005-000000000001';
const OUTRA_SLUG = 'spec086-seed-outra';
const EMAIL_REPETIDO = 'aluno1@playck-qa.demo';
const EMAILS_DEMO = [
  'aluno1@playck-qa.demo',
  'aluno2@playck-qa.demo',
  'aluno3@playck-qa.demo',
];

async function limparQa(): Promise<void> {
  const r = await db.empresa.findFirst({
    where: { slug: QA_SLUG },
    select: { id: true },
  });
  if (r) await limparEmpresa(db, r.id);
}

/**
 * O seed de verdade, como processo filho. `DATABASE_URL` é a desta suíte, já
 * conferida por `exigirBancoLocal()` no topo: o seed nunca vê outro banco.
 */
function rodarSeed(): Promise<{ codigo: number | null; saida: string }> {
  return new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      [require.resolve('ts-node/dist/bin.js'), 'prisma/seed.ts'],
      {
        cwd: RAIZ,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          // Senhas artificiais: banco descartável, não credencial.
          SEED_ADMIN_SENHA: 'senha-de-teste-spec086-a',
          SEED_SUPER_ADMIN_SENHA: 'senha-de-teste-spec086-s',
        },
      },
    );
    let saida = '';
    p.stdout.on('data', (d: Buffer) => (saida += d.toString()));
    p.stderr.on('data', (d: Buffer) => (saida += d.toString()));
    p.on('close', (codigo) => resolve({ codigo, saida }));
  });
}

/** Os alunos matriculados em turmas da empresa de QA, com a empresa de cada um. */
async function alunosDasTurmasDeQa(qa: string) {
  const vinculos = await db.turmaAluno.findMany({
    where: { turma: { companyId: qa } },
    select: {
      aluno: {
        select: {
          id: true,
          companyId: true,
          usuario: { select: { email: true, companyId: true } },
        },
      },
    },
  });
  return vinculos.map((v) => v.aluno);
}

let contaDeFora: { usuarioId: string; alunoId: string } | null = null;

beforeAll(async () => {
  await limparQa();
  await limparEmpresa(db, OUTRA);
  await db.$executeRawUnsafe(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${OUTRA}','${OUTRA_SLUG}','${OUTRA_SLUG}',now())`,
    ),
  );
  const nivel = await nivelDaFixture(db, OUTRA);
  // Criada ANTES da empresa de QA existir: é a primeira linha com o e-mail.
  const usuario = await db.usuario.create({
    data: {
      email: EMAIL_REPETIDO,
      senhaHash: 'hash-da-conta-de-fora',
      nome: 'Aluno de Outra Empresa',
      role: 'aluno',
      companyId: OUTRA,
      status: 'ativo',
    },
    select: { id: true },
  });
  const aluno = await db.aluno.create({
    data: {
      usuarioId: usuario.id,
      companyId: OUTRA,
      nivelId: nivel,
      vinculo: 'aprovado',
    },
    select: { id: true },
  });
  contaDeFora = { usuarioId: usuario.id, alunoId: aluno.id };
});

afterAll(async () => {
  await limparQa();
  await limparEmpresa(db, OUTRA);
  await db.$disconnect();
});

describe('SPEC-086/AC-005 — o seed com aluno1@playck-qa.demo em outra empresa', () => {
  it('roda duas vezes; os alunos das turmas de QA são os da empresa de QA, e a conta de fora fica intacta', async () => {
    const antes = await db.usuario.findUniqueOrThrow({
      where: { id: contaDeFora!.usuarioId },
    });
    const alunoAntes = await db.aluno.findUniqueOrThrow({
      where: { id: contaDeFora!.alunoId },
    });

    const primeira = await rodarSeed();
    expect({ codigo: primeira.codigo, saida: primeira.saida }).toMatchObject({
      codigo: 0,
    });
    expect(primeira.saida).toContain('[seed] etapa 3 ok');

    const qa = (
      await db.empresa.findUniqueOrThrow({
        where: { slug: QA_SLUG },
        select: { id: true },
      })
    ).id;

    const depoisDaPrimeira = await alunosDasTurmasDeQa(qa);
    const contas = await db.usuario.count();
    const alunos = await db.aluno.count();
    const vinculos = await db.turmaAluno.count();

    const segunda = await rodarSeed();
    expect({ codigo: segunda.codigo, saida: segunda.saida }).toMatchObject({
      codigo: 0,
    });

    // Idempotência: a segunda rodada não cria conta, aluno nem vínculo.
    expect(await db.usuario.count()).toBe(contas);
    expect(await db.aluno.count()).toBe(alunos);
    expect(await db.turmaAluno.count()).toBe(vinculos);

    const daTurma = await alunosDasTurmasDeQa(qa);
    expect(daTurma.map((a) => a.id).sort()).toEqual(
      depoisDaPrimeira.map((a) => a.id).sort(),
    );
    // Os três alunos demo, e só eles; todos — aluno e conta — da empresa de QA.
    expect(daTurma.map((a) => a.usuario.email).sort()).toEqual(EMAILS_DEMO);
    for (const a of daTurma) {
      expect(a.companyId).toBe(qa);
      expect(a.usuario.companyId).toBe(qa);
    }
    expect(daTurma.map((a) => a.id)).not.toContain(contaDeFora!.alunoId);

    // O e-mail repetido: uma conta em cada empresa, nenhuma a mais.
    const comOEmail = await db.usuario.findMany({
      where: { email: EMAIL_REPETIDO },
      select: { id: true, companyId: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(comOEmail.map((u) => u.companyId).sort()).toEqual(
      [OUTRA, qa].sort(),
    );

    // A conta de fora, campo a campo, e o aluno dela, sem turma de QA.
    expect(
      await db.usuario.findUniqueOrThrow({
        where: { id: contaDeFora!.usuarioId },
      }),
    ).toEqual(antes);
    expect(
      await db.aluno.findUniqueOrThrow({ where: { id: contaDeFora!.alunoId } }),
    ).toEqual(alunoAntes);
    expect(
      await db.turmaAluno.count({ where: { alunoId: contaDeFora!.alunoId } }),
    ).toBe(0);
  });
});
