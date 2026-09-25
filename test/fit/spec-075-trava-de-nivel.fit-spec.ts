/**
 * SPEC-075/TASK-007 — **FIT-055: a trava de nível da empresa (D13, INV-075h)**,
 * com conexões independentes contra o banco de verdade.
 *
 * O furo que ela fecha (3ª rodada, N3-02): um gestor com duas requisições —
 * mudar o nível do aluno e alocá-lo — criava o par que a decisão 6 proíbe,
 * porque os locks de linha não serializam as duas.
 *
 * - **AC-026 — PRESENÇA:** com a trava da empresa E segura por outra conexão,
 *   cada um dos oito caminhos, numa conexão com `lock_timeout = 1s`, falha com
 *   `55P03` e não grava nada; para OUTRA empresa, passa. O oitavo é o seed,
 *   rodado como processo.
 * - **AC-027 — ORDEM:** quem espera a trava não segura a turma. Com
 *   **handshake**: o `NOWAIT` só roda depois de o teste VER a conexão do
 *   caminho esperando `Lock/advisory` em `pg_stat_activity` — sem isso, o
 *   `NOWAIT` imediato passava até com a ordem invertida (4ª rodada, N4-02).
 * - **AC-028 — RESULTADO:** a corrida da 3ª rodada, fechada. Prova o
 *   resultado, não a presença (essa é a AC-026).
 * - **AC-030 — o seed só cria nível numa empresa sem nível.**
 * - **LIM-075k — a duração** da transação mais pesada sob a trava, medida e
 *   impressa (`DURACAO_TRAVA_MS=`), sem limite inventado.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { ClassesService } from '../../src/classes/classes.service';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { FilaDeEsperaService } from '../../src/fila-de-espera/fila-de-espera.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import { LevelsService } from '../../src/people/levels.service';
import { travarNivelDaEmpresa } from '../../src/people/nivel-efetivo';
import { StudentsService } from '../../src/people/students.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(900_000);
exigirBancoLocal();

const RAIZ = join(__dirname, '..', '..');
const BASE = process.env.DATABASE_URL as string;
const comOpcao = (opcao: string) =>
  `${BASE}${BASE.includes('?') ? '&' : '?'}options=${encodeURIComponent(opcao)}`;
/** A conexão do caminho, que desiste da espera em 1 s (o molde da SPEC-074). */
const URL_LENTA = comOpcao('-c lock_timeout=1s');

const E = '07550000-0000-4000-8000-000000000001';
const E2 = '07550000-0000-4000-8000-000000000002';
const GESTOR = '07550000-0000-4000-8000-000000000003';
const INI = '07550000-0000-4000-8000-000000000021';
const INT = '07550000-0000-4000-8000-000000000022';
const AVA = '07550000-0000-4000-8000-000000000023';
const E2_INT = '07550000-0000-4000-8000-000000000024';
const QUADRA = '07550000-0000-4000-8000-000000000011';
const QUADRA2 = '07550000-0000-4000-8000-000000000012';
const T_INT = '07550000-0000-4000-8000-000000000031';
const T_AVA = '07550000-0000-4000-8000-000000000032';
const T_E2 = '07550000-0000-4000-8000-000000000033';
const QA_SLUG = 'playck-qa-demo';
const QA = '07550000-0000-4000-8000-0000000000aa';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const clientes: PrismaClient[] = [];
function cliente(url: string): PrismaClient {
  const c = new PrismaClient({ datasources: { db: { url } } });
  clientes.push(c);
  return c;
}

/** Os serviços de verdade, sobre o cliente dado. */
function servicos(c: PrismaClient) {
  const p = c as unknown as PrismaService;
  const operacao = new ConfigOperacaoService(p);
  const matricula = new MatriculaDoAlunoService(p, operacao);
  const courts = new CourtsService(
    p,
    { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
    new HorarioFuncionamentoService(p),
    {} as unknown as ImagemDaQuadraService,
    operacao,
    new CreditosService(),
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
  return {
    matricula,
    fila: new FilaDeEsperaService(
      p,
      operacao,
      matricula,
      new ReposicaoService(p, operacao),
    ),
    turmas: new ClassesService(p, courts, new StudentsService(p), operacao),
    alunos: new StudentsService(p),
    niveis: new LevelsService(p),
  };
}

/** Segura a trava de nível da empresa por outra conexão, até soltar. */
async function segurarTrava(empresa: string): Promise<() => Promise<void>> {
  let soltar!: () => void;
  const liberado = new Promise<void>((r) => (soltar = r));
  let pronto!: () => void;
  const travado = new Promise<void>((r) => (pronto = r));
  const tx = db.$transaction(
    async (t) => {
      await travarNivelDaEmpresa(t, empresa);
      pronto();
      await liberado;
    },
    { timeout: 300_000, maxWait: 10_000 },
  );
  await travado;
  return async () => {
    soltar();
    await tx;
  };
}

/** O handshake da AC-027: VER a conexão esperando a advisory. Nunca `sleep`. */
async function esperaNaTrava(appName: string): Promise<void> {
  const limite = Date.now() + 20_000;
  while (Date.now() < limite) {
    const r = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE application_name = '${appName}'
          AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
    );
    if (Number(r[0].n) > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`handshake: ${appName} nunca foi visto esperando a trava`);
}

async function falhaPor55P03(promessa: Promise<unknown>): Promise<void> {
  const erro: unknown = await promessa.then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro).not.toBeNull();
  const e = erro as { message?: string; meta?: unknown };
  expect(`${e.message ?? ''} ${JSON.stringify(e.meta ?? {})}`).toContain(
    '55P03',
  );
}

let seq = 0;
async function aluno(
  empresa: string,
  nivelId: string | null,
): Promise<{ alunoId: string; usuarioId: string }> {
  seq += 1;
  const s = String(seq).padStart(3, '0');
  const usuarioId = `07550000-0000-4000-8000-100000000${s}`;
  const alunoId = `07550000-0000-4000-8000-200000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','f055.${seq}@x.com','h','Aluno ${seq}','aluno','${empresa}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status,nivel_id) VALUES ('${alunoId}','${usuarioId}','${empresa}','aprovado','ativo',${nivelId ? `'${nivelId}'` : 'NULL'})`,
  );
  return { alunoId, usuarioId };
}

const matriculas = (turmaId: string) =>
  db.turmaAluno.count({ where: { turmaId } });

async function montar(): Promise<void> {
  for (const [emp, quadra] of [
    [E, QUADRA],
    [E2, QUADRA2],
  ] as const) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${emp}','FIT-055 ${emp.slice(-1)}','fit-055-${emp}',now())`,
    );
    await q(
      `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${emp}','Tenis',0,now())`,
    );
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${quadra}','${emp}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${emp}' LIMIT 1),80,'ativa')`,
    );
    // O horário de funcionamento: a regeneração de ocorrências da medição
    // (LIM-075k) só cria ocorrência dentro dele.
    await q(
      `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,hora_inicio,hora_fim,fechado,updated_at)
       SELECT gen_random_uuid(),'${emp}',NULL,d,'06:00','22:00',false,now() FROM generate_series(0,6) d`,
    );
  }
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${GESTOR}','f055.gestor@x.com','h','Gestor','company_admin','${E}',now())`,
  );
  for (const [id, emp, nome, ordem] of [
    [INI, E, 'Iniciante', 1],
    [INT, E, 'Intermediário', 2],
    [AVA, E, 'Avançado', 3],
    [E2_INT, E2, 'Intermediário', 1],
  ] as const) {
    await q(
      `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${id}','${emp}','${nome}',${ordem})`,
    );
  }
  for (const [id, emp, quadra, nivel] of [
    [T_INT, E, QUADRA, INT],
    [T_AVA, E, QUADRA, AVA],
    [T_E2, E2, QUADRA2, E2_INT],
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ('${id}','${emp}','Turma ${id.slice(-2)}','${quadra}',8,'ativa','${nivel}')`,
    );
  }
}

async function empresaQa(): Promise<string | null> {
  const r = await db.empresa.findFirst({
    where: { slug: QA_SLUG },
    select: { id: true },
  });
  return r?.id ?? null;
}
async function limparQa(): Promise<void> {
  const id = await empresaQa();
  if (id) await limparEmpresa(db, id);
}

beforeEach(async () => {
  for (const emp of [E, E2]) await limparEmpresa(db, emp);
  await montar();
});

afterAll(async () => {
  for (const emp of [E, E2]) await limparEmpresa(db, emp);
  await limparQa();
  for (const c of clientes) await c.$disconnect();
  await db.$disconnect();
});

// ==========================================================================
// AC-026 — cada caminho da D13 espera a trava da SUA empresa, e só dela
// ==========================================================================

describe('AC-026 — a PRESENÇA da trava, caminho a caminho', () => {
  const casos: [
    string,
    (
      s: ReturnType<typeof servicos>,
      a: { alunoId: string; usuarioId: string },
    ) => Promise<unknown>,
  ][] = [
    ['entrar', (s, a) => s.matricula.entrar(E, a.usuarioId, T_INT)],
    [
      'allocateStudent',
      (s, a) => s.turmas.allocateStudent(E, T_INT, a.alunoId),
    ],
    [
      'StudentsService.update (nivelId)',
      (s, a) => s.alunos.update(E, a.alunoId, { nivelId: AVA }),
    ],
    [
      'ClassesService.update (nivelId)',
      (s) => s.turmas.update(E, T_INT, { nivelId: AVA }, GESTOR),
    ],
    [
      'LevelsService.create',
      (s) => s.niveis.create(E, { nome: 'Novo', ordem: 9 }),
    ],
    ['LevelsService.update', (s) => s.niveis.update(E, AVA, { ordem: 7 })],
  ];

  for (const [nome, chamar] of casos) {
    it(`${nome}: espera a trava de E → 55P03, e nada gravado`, async () => {
      const a = await aluno(E, INT);
      const antes = {
        matriculas: await matriculas(T_INT),
        nivelDoAluno: (
          await db.aluno.findUniqueOrThrow({ where: { id: a.alunoId } })
        ).nivelId,
        nivelDaTurma: (
          await db.turma.findUniqueOrThrow({ where: { id: T_INT } })
        ).nivelId,
        niveis: await db.nivel.findMany({
          where: { companyId: E },
          orderBy: { id: 'asc' },
        }),
      };
      const soltar = await segurarTrava(E);
      try {
        await falhaPor55P03(chamar(servicos(cliente(URL_LENTA)), a));
      } finally {
        await soltar();
      }
      expect(await matriculas(T_INT)).toBe(antes.matriculas);
      expect(
        (await db.aluno.findUniqueOrThrow({ where: { id: a.alunoId } }))
          .nivelId,
      ).toBe(antes.nivelDoAluno);
      expect(
        (await db.turma.findUniqueOrThrow({ where: { id: T_INT } })).nivelId,
      ).toBe(antes.nivelDaTurma);
      expect(
        await db.nivel.findMany({
          where: { companyId: E },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(antes.niveis);
    });
  }

  it('confirmar (fila de TURMA): espera a trava de E → 55P03, e a linha continua chamada', async () => {
    const a = await aluno(E, INT);
    const linha = '07550000-0000-4000-8000-5000000000aa';
    await q(
      `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,estado,chamado_em,chamado_ate)
       VALUES ('${linha}','${E}','${a.alunoId}','${T_INT}','chamado',now(),now() + interval '6 hours')`,
    );
    const soltar = await segurarTrava(E);
    try {
      await falhaPor55P03(
        servicos(cliente(URL_LENTA)).fila.confirmar(E, a.usuarioId, linha),
      );
    } finally {
      await soltar();
    }
    expect(
      (await db.listaDeEspera.findUniqueOrThrow({ where: { id: linha } }))
        .estado,
    ).toBe('chamado');
    expect(await matriculas(T_INT)).toBe(0);
  });

  it('a trava é DA EMPRESA: com a de E segura, OUTRA empresa passa', async () => {
    const b = await aluno(E2, E2_INT);
    const soltar = await segurarTrava(E);
    try {
      await servicos(cliente(URL_LENTA)).turmas.allocateStudent(
        E2,
        T_E2,
        b.alunoId,
      );
    } finally {
      await soltar();
    }
    expect(await matriculas(T_E2)).toBe(1);
  });
});

// ==========================================================================
// AC-027 — a trava é a PRIMEIRA instrução: quem espera não segura a turma
// ==========================================================================

describe('AC-027 — a ORDEM, com handshake', () => {
  const casos: [
    string,
    (
      s: ReturnType<typeof servicos>,
      a: { alunoId: string; usuarioId: string },
      linha: string,
    ) => Promise<unknown>,
  ][] = [
    ['entrar', (s, a) => s.matricula.entrar(E, a.usuarioId, T_INT)],
    [
      'allocateStudent',
      (s, a) => s.turmas.allocateStudent(E, T_INT, a.alunoId),
    ],
    ['confirmar', (s, a, linha) => s.fila.confirmar(E, a.usuarioId, linha)],
    [
      'ClassesService.update',
      (s) => s.turmas.update(E, T_INT, { nivelId: INT }, GESTOR),
    ],
  ];

  for (const [nome, chamar] of casos) {
    it(`${nome}: enquanto espera a trava, uma terceira conexão trava a turma com NOWAIT`, async () => {
      const a = await aluno(E, INT);
      const linha = `07550000-0000-4000-8000-6000000000${String(seq).padStart(2, '0')}`;
      await q(
        `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,estado,chamado_em,chamado_ate)
         VALUES ('${linha}','${E}','${a.alunoId}','${T_INT}','chamado',now(),now() + interval '6 hours')`,
      );
      const app = `fit055-${nome.replace(/\W/g, '').toLowerCase()}`;
      const soltar = await segurarTrava(E);
      const caminho = chamar(
        servicos(cliente(comOpcao(`-c application_name=${app}`))),
        a,
        linha,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      let nowait: unknown = null;
      try {
        await esperaNaTrava(app);
        nowait = await db
          .$transaction((t) =>
            t.$queryRawUnsafe(
              `SELECT id FROM turmas WHERE id = '${T_INT}' FOR UPDATE NOWAIT`,
            ),
          )
          .then(
            () => null,
            (e: unknown) => e,
          );
      } finally {
        await soltar();
      }
      // Quem espera a trava NÃO segura a turma: o NOWAIT passou.
      expect(nowait).toBeNull();
      const resultado = await caminho;
      if (resultado !== null && !(resultado instanceof HttpException)) {
        throw resultado instanceof Error
          ? resultado
          : new Error(JSON.stringify(resultado));
      }
    });
  }
});

// ==========================================================================
// AC-028 — a corrida da 3ª rodada, fechada (o RESULTADO)
// ==========================================================================

describe('AC-028 — mudar o nível × alocar, disparados juntos', () => {
  it('exatamente um é recusado, e não existe par incompatível ao fim — qualquer que seja a ordem', async () => {
    const a = await aluno(E, INT);
    const soltar = await segurarTrava(E);
    const edicao = servicos(
      cliente(comOpcao('-c application_name=fit055-corrida-edicao')),
    )
      .alunos.update(E, a.alunoId, { nivelId: AVA })
      .then(
        () => 'OK',
        (e: unknown) => e,
      );
    const alocacao = servicos(
      cliente(comOpcao('-c application_name=fit055-corrida-alocacao')),
    )
      .turmas.allocateStudent(E, T_INT, a.alunoId)
      .then(
        () => 'OK',
        (e: unknown) => e,
      );
    try {
      await esperaNaTrava('fit055-corrida-edicao');
      await esperaNaTrava('fit055-corrida-alocacao');
    } finally {
      await soltar();
    }
    const resultados = await Promise.all([edicao, alocacao]);
    const recusados = resultados.filter((r) => r instanceof HttpException);
    expect(recusados).toHaveLength(1);
    expect(resultados.filter((r) => r === 'OK')).toHaveLength(1);

    const nivel = (
      await db.aluno.findUniqueOrThrow({ where: { id: a.alunoId } })
    ).nivelId;
    const matriculado =
      (await db.turmaAluno.count({
        where: { alunoId: a.alunoId, turmaId: T_INT },
      })) === 1;
    // Nenhum par incompatível: se ele está na turma Intermediário, ele é Intermediário.
    if (matriculado) expect(nivel).toBe(INT);
    else expect(nivel).toBe(AVA);
  });
});

// ==========================================================================
// LIM-075k — a duração da transação mais pesada sob a trava
// ==========================================================================

describe('LIM-075k — quanto tempo a trava fica segura', () => {
  it('ClassesService.update com nível E encontros novos (regenera ocorrências): medido e impresso', async () => {
    const s = servicos(db);
    await s.turmas.update(
      E,
      T_AVA,
      {
        encontros: [{ diaSemana: 2, horaInicio: '08:00', horaFim: '09:00' }],
      },
      GESTOR,
    );
    const inicio = Date.now();
    await s.turmas.update(
      E,
      T_AVA,
      {
        nivelId: INT,
        encontros: [
          { diaSemana: 1, horaInicio: '08:00', horaFim: '09:00' },
          { diaSemana: 3, horaInicio: '08:00', horaFim: '09:00' },
          { diaSemana: 5, horaInicio: '08:00', horaFim: '09:00' },
        ],
      },
      GESTOR,
    );
    const ms = Date.now() - inicio;
    const ocorrencias = await db.ocupacaoQuadra.count({
      where: { origemTurmaId: T_AVA, statusPagamento: { not: 'cancelado' } },
    });
    console.log(
      `DURACAO_TRAVA_MS=${ms} OCORRENCIAS_REGENERADAS=${ocorrencias}`,
    );
    expect(ocorrencias).toBeGreaterThan(0);
  });
});

// ==========================================================================
// O seed — o oitavo caminho, rodado como PROCESSO (AC-026 e AC-030)
// ==========================================================================

function rodarSeed(url: string): { codigo: number | null; saida: string } {
  const r = spawnSync(
    process.execPath,
    [require.resolve('ts-node/dist/bin.js'), 'prisma/seed.ts'],
    {
      cwd: RAIZ,
      env: {
        ...process.env,
        DATABASE_URL: url,
        NODE_ENV: 'test',
        // Senhas artificiais: banco descartável, não credencial (R5-02).
        SEED_ADMIN_SENHA: 'senha-de-teste-fit055-a',
        SEED_SUPER_ADMIN_SENHA: 'senha-de-teste-fit055-s',
      },
      encoding: 'utf8',
      timeout: 300_000,
    },
  );
  return { codigo: r.status, saida: `${r.stdout}\n${r.stderr}` };
}

/** A empresa de QA pré-criada por SQL, com id conhecido e o slug do seed — o
 *  `seedEtapa1` faz `upsert` pelo slug e a reaproveita. */
async function qaPreCriada(): Promise<void> {
  await limparQa();
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${QA}','PlayCK QA (demo)','${QA_SLUG}',now())`,
  );
}

describe('AC-026 (seed) e AC-030 — o seed, o oitavo caminho', () => {
  it('AC-026 — os NÍVEIS: empresa de QA sem nível, trava segura → o seed sai ≠ 0 com 55P03, e ela continua sem nível e sem matrícula', async () => {
    await qaPreCriada();
    const soltar = await segurarTrava(QA);
    let r: { codigo: number | null; saida: string };
    try {
      r = rodarSeed(URL_LENTA);
    } finally {
      await soltar();
    }
    expect(r.codigo).not.toBe(0);
    expect(r.saida).toContain('55P03');
    expect(await db.nivel.count({ where: { companyId: QA } })).toBe(0);
    expect(
      await db.turmaAluno.count({ where: { turma: { companyId: QA } } }),
    ).toBe(0);
  });

  it('AC-026 — as MATRÍCULAS: seed inteiro, matrículas apagadas, trava segura → ≠ 0 com 55P03, sem matrícula, níveis iguais', async () => {
    await qaPreCriada();
    const ok = rodarSeed(BASE);
    expect(ok.codigo).toBe(0);
    await q(
      `DELETE FROM turma_alunos WHERE turma_id IN (SELECT id FROM turmas WHERE company_id = '${QA}')`,
    );
    const niveisAntes = await db.nivel.findMany({
      where: { companyId: QA },
      orderBy: { id: 'asc' },
    });

    const soltar = await segurarTrava(QA);
    let r: { codigo: number | null; saida: string };
    try {
      r = rodarSeed(URL_LENTA);
    } finally {
      await soltar();
    }
    expect(r.codigo).not.toBe(0);
    expect(r.saida).toContain('55P03');
    expect(
      await db.turmaAluno.count({ where: { turma: { companyId: QA } } }),
    ).toBe(0);
    expect(
      await db.nivel.findMany({
        where: { companyId: QA },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(niveisAntes);
  });

  it('AC-030 — empresa de QA SEM nível: o seed cria os da D7 (Iniciante 1, Intermediário 2, Avançado 3)', async () => {
    await qaPreCriada();
    expect(rodarSeed(BASE).codigo).toBe(0);
    const niveis = await db.nivel.findMany({
      where: { companyId: QA },
      orderBy: { ordem: 'asc' },
      select: { nome: true, ordem: true },
    });
    expect(niveis).toEqual([
      { nome: 'Iniciante', ordem: 1 },
      { nome: 'Intermediário', ordem: 2 },
      { nome: 'Avançado', ordem: 3 },
    ]);
  });

  it('AC-030 — empresa de QA com Iniciante e Intermediário (o banco de QA de hoje): o seed não escreve nível e segue', async () => {
    await qaPreCriada();
    await q(
      `INSERT INTO niveis (id,company_id,nome,ordem) VALUES (gen_random_uuid(),'${QA}','Iniciante',1),(gen_random_uuid(),'${QA}','Intermediário',2)`,
    );
    const antes = await db.nivel.findMany({
      where: { companyId: QA },
      orderBy: { id: 'asc' },
    });
    expect(rodarSeed(BASE).codigo).toBe(0);
    expect(
      await db.nivel.findMany({
        where: { companyId: QA },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(antes);
  });

  it('AC-030 — empresa de QA com SÓ o Intermediário e um aluno sem nível numa turma dele: o seed aborta, o Iniciante não nasce, e o par segue compatível', async () => {
    await qaPreCriada();
    const INT_QA = '07550000-0000-4000-8000-0000000000ab';
    const T_QA = '07550000-0000-4000-8000-0000000000ac';
    const Q_QA = '07550000-0000-4000-8000-0000000000ad';
    await q(
      `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${INT_QA}','${QA}','Intermediário',2)`,
    );
    await q(
      `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${QA}','Tenis',0,now())`,
    );
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${Q_QA}','${QA}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${QA}' LIMIT 1),80,'ativa')`,
    );
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ('${T_QA}','${QA}','Turma QA','${Q_QA}',8,'ativa','${INT_QA}')`,
    );
    const n = await aluno(QA, null);
    await q(
      `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${T_QA}','${n.alunoId}',now())`,
    );

    const r = rodarSeed(BASE);
    expect(r.codigo).not.toBe(0);
    expect(r.saida).toContain('falta o Iniciante');
    expect(
      await db.nivel.count({ where: { companyId: QA, nome: 'Iniciante' } }),
    ).toBe(0);
    // O primeiro continua sendo o Intermediário: o aluno sem nível, na turma
    // Intermediário, continua compatível.
    const primeiro = await db.nivel.findFirst({
      where: { companyId: QA },
      orderBy: [{ ordem: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(primeiro?.id).toBe(INT_QA);
  });
});
