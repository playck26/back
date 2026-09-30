/**
 * SPEC-082/REQ-001 — **leitor e escritor, caminho a caminho** (AC-001, AC-002).
 *
 * A trava de teste é a do CLUBE, segura em modo **compartilhado** por uma
 * conexão do próprio teste:
 *
 * - **AC-001** — cada leitor (`entrar`, `allocateStudent`, `confirmar` de fila
 *   de turma) conclui **sem esperar**: compartilhada com compartilhada não
 *   conflita. Um leitor que voltasse ao exclusivo esperaria a trava de teste.
 * - **AC-002** — cada escritor (editar turma com `nivelId`, editar nível,
 *   remover nível, editar aluno com `nivelId`, e o seed) **espera** — visto em
 *   `pg_stat_activity` — e só conclui depois que o teste solta a trava.
 *
 * A prova de que nenhum caminho aparece nas duas listas (sem promoção, AC-003)
 * é a soma destas duas com a tabela de `escritores-de-matricula.spec.ts`.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import {
  type AlunoDaFixtura,
  BASE,
  type Clube,
  cliente,
  criarAluno,
  criarTurma,
  desconectarTodos,
  dormir,
  limparClube,
  linhaChamada,
  matriculasDaTurma,
  montarClube,
  resposta,
  rotas,
  segurar,
  servicos,
  travaDoClube,
  urlDoCaminho,
  vistoEsperando,
} from './spec-082-fixture';

jest.setTimeout(600_000);
exigirBancoLocal();

const RAIZ = join(__dirname, '..', '..');
const db = new PrismaClient();
let clube: Clube | null = null;

afterEach(async () => {
  await limparClube(db, clube);
  clube = null;
  await desconectarTodos();
});

afterAll(async () => {
  await limparQa();
  await db.$disconnect();
});

/** Quanto um leitor pode levar sem "esperar": a trava de teste segura mais. */
const SEM_ESPERAR_MS = 1_500;

describe('SPEC-082/AC-001 — cada leitor toma a do clube em modo compartilhado', () => {
  const leitores: [
    string,
    (
      r: ReturnType<typeof rotas>,
      c: Clube,
      a: AlunoDaFixtura,
      turma: string,
      linha: string,
    ) => Promise<unknown>,
  ][] = [
    ['entrar', (r, c, a, t) => r.entrar(c, a, t)],
    ['allocateStudent', (r, c, a, t) => r.alocar(c, a, t)],
    ['confirmar (fila de turma)', (r, c, a, _t, l) => r.confirmar(c, a, l)],
  ];

  it.each(leitores)(
    '%s: com a do clube segura em modo compartilhado, conclui sem esperar',
    async (_nome, chamar) => {
      clube = await montarClube(db);
      const turma = await criarTurma(db, clube);
      const a = await criarAluno(db, clube);
      const linha = await linhaChamada(db, clube, a.alunoId, turma);

      const soltar = await segurar(db, travaDoClube(clube.id, 'compartilhada'));
      let r;
      try {
        const caminho = resposta(
          chamar(rotas(cliente(BASE)), clube, a, turma, linha),
        );
        r = await Promise.race([
          caminho,
          dormir(SEM_ESPERAR_MS).then(() => 'ESPEROU' as const),
        ]);
        if (r === 'ESPEROU') {
          await soltar();
          await caminho;
        }
      } finally {
        await soltar();
      }
      expect(r).not.toBe('ESPEROU');
      expect(r).toMatchObject({ status: 200 });
      expect(await matriculasDaTurma(db, turma)).toBe(1);
    },
  );
});

describe('SPEC-082/AC-002 — cada escritor continua exclusivo', () => {
  let soltou = false;
  beforeEach(() => {
    soltou = false;
  });

  const escritores: [
    string,
    (
      s: ReturnType<typeof servicos>,
      c: Clube,
      ctx: { turma: string; outroNivel: string; aluno: AlunoDaFixtura },
    ) => Promise<unknown>,
  ][] = [
    [
      'editar turma com nivelId',
      (s, c, ctx) =>
        s.turmas.update(
          c.id,
          ctx.turma,
          { nivelId: ctx.outroNivel },
          c.gestores[0],
        ),
    ],
    [
      'editar nível',
      (s, c, ctx) => s.niveis.update(c.id, ctx.outroNivel, { ordem: 7 }),
    ],
    ['remover nível', (s, c, ctx) => s.niveis.remove(c.id, ctx.outroNivel)],
    [
      'editar aluno com nivelId',
      (s, c, ctx) =>
        s.alunos.update(c.id, ctx.aluno.alunoId, { nivelId: ctx.outroNivel }),
    ],
  ];

  it.each(escritores)(
    '%s: espera a compartilhada (pg_stat_activity) e só conclui depois de solta',
    async (nome, chamar) => {
      clube = await montarClube(db);
      const turma = await criarTurma(db, clube);
      const aluno = await criarAluno(db, clube);
      const outroNivel = (
        await db.nivel.create({
          data: { companyId: clube.id, nome: 'Avançado', ordem: 2 },
        })
      ).id;

      const app = `spec082-escritor-${nome.replace(/\W/g, '').toLowerCase()}`;
      const soltar = await segurar(db, travaDoClube(clube.id, 'compartilhada'));
      let concluiuAntes = false;
      let caminho: Promise<unknown> = Promise.resolve();
      try {
        caminho = chamar(servicos(cliente(urlDoCaminho(app))), clube, {
          turma,
          outroNivel,
          aluno,
        }).then(
          (v) => {
            concluiuAntes = !soltou;
            return v;
          },
          (e: unknown) => {
            concluiuAntes = !soltou;
            throw e;
          },
        );
        await vistoEsperando(db, app, 'advisory');
        // Mais meio segundo segurando: quem não espera já teria concluído.
        await dormir(500);
      } finally {
        soltou = true;
        await soltar();
      }
      await caminho;
      expect(concluiuAntes).toBe(false);
    },
  );

  it('o seed (como processo): espera a compartilhada e só conclui depois de solta', async () => {
    await limparQa();
    const qa = '08200000-0000-4000-8000-0000000000aa';
    await db.$executeRawUnsafe(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${qa}','PlayCK QA (demo)','${QA_SLUG}',now())`,
    );
    const app = 'spec082-escritor-seed';
    const soltar = await segurar(db, travaDoClube(qa, 'compartilhada'));
    let terminou = false;
    let seed: Promise<{ codigo: number | null; saida: string }> =
      Promise.resolve({ codigo: null, saida: '' });
    try {
      seed = rodarSeed(urlDoCaminho(app)).then((r) => {
        terminou = true;
        return r;
      });
      await vistoEsperando(db, app, 'advisory', 180_000);
      await dormir(500);
      expect(terminou).toBe(false);
    } finally {
      await soltar();
    }
    const r = await seed;
    expect(r.codigo).toBe(0);
    expect(await db.nivel.count({ where: { companyId: qa } })).toBe(3);
  });
});

const QA_SLUG = 'playck-qa-demo';

async function limparQa(): Promise<void> {
  const r = await db.empresa.findFirst({
    where: { slug: QA_SLUG },
    select: { id: true },
  });
  if (r) await limparEmpresa(db, r.id);
}

/** O seed de verdade, como processo, sem bloquear o laço (a amostragem roda). */
function rodarSeed(
  url: string,
): Promise<{ codigo: number | null; saida: string }> {
  return new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      [require.resolve('ts-node/dist/bin.js'), 'prisma/seed.ts'],
      {
        cwd: RAIZ,
        env: {
          ...process.env,
          DATABASE_URL: url,
          NODE_ENV: 'test',
          // Senhas artificiais: banco descartável, não credencial.
          SEED_ADMIN_SENHA: 'senha-de-teste-spec082-a',
          SEED_SUPER_ADMIN_SENHA: 'senha-de-teste-spec082-s',
        },
      },
    );
    let saida = '';
    p.stdout.on('data', (d: Buffer) => (saida += d.toString()));
    p.stderr.on('data', (d: Buffer) => (saida += d.toString()));
    p.on('close', (codigo) => resolve({ codigo, saida }));
  });
}
