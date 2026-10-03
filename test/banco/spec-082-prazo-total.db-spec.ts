/**
 * SPEC-082/REQ-002 e REQ-003 — **o prazo é da matrícula inteira** (I7).
 *
 * - **AC-005** — a instrução inicial grava o prazo absoluto e recalcula o
 *   `lock_timeout` entre as duas travas;
 * - **AC-015** — toda aquisição (advisory, linha, FK) usa o resto do prazo,
 *   recalculado imediatamente antes dela, pelo relógio do servidor;
 * - **AC-020** — o tempo-limite de 8 s é o que vale, e vira 503.
 *
 * **Como o "depois do prazo" é medido:** o prazo começa na instrução inicial,
 * logo depois do `BEGIN` — o teste lê o `xact_start` da conexão do caminho em
 * `pg_stat_activity` e soma 2 s; o fim é a primeira amostra de
 * `pg_stat_activity` em que a conexão deixou de esperar lock (`fimDaEspera`).
 * Os dois no relógio do servidor — medir o fim no cliente somaria o tempo de
 * montar o erro do Prisma, que na primeira vez passa de 100 ms e não é espera. A tolerância de 50 ms
 * é de execução no banco local, não de espera: as implementações erradas
 * ficam 1,5 s ou mais acima (LIM-082e). Um aquecimento no `beforeAll` reduz na
 * primeira medição o custo do código frio (ver o comentário dele).
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { abrirProxy, type ProxyDeLatencia } from './proxy-de-latencia';
import {
  type AlunoDaFixtura,
  type Clube,
  type DetalheDaEspera,
  I4,
  I5,
  I6,
  PRAZO_MS,
  TOLERANCIA_MS,
  type Resposta,
  ateOInstante,
  cliente,
  criarAluno,
  criarTurma,
  desconectarTodos,
  fimDaEspera,
  inicioDaTransacao,
  limparClube,
  linhaEmForUpdate,
  matriculasDaTurma,
  montarClube,
  resposta,
  rotas,
  segurar,
  segurarComPid,
  bloqueadoresDe,
  vistoEsperando,
  travaDoAluno,
  travaDoClube,
  urlDoCaminho,
} from './spec-082-fixture';
import { inserirMatriculaComPrazo } from '../../src/classes/matricula-com-prazo';
import {
  CTE_DO_PRAZO,
  DEPOIS_DO_PRAZO,
} from '../../src/common/lock/prazo-de-espera';

jest.setTimeout(300_000);
exigirBancoLocal();

const db = new PrismaClient();
let clube: Clube | null = null;

afterEach(async () => {
  await limparClube(db, clube);
  clube = null;
  await desconectarTodos();
});

afterAll(async () => {
  await db.$disconnect();
});

/**
 * **Aquecimento antes da primeira medição** (achado do CI, run 37158002173, PR
 * #163: o primeiro teste do arquivo mediu 87 ms depois do prazo; os outros
 * cinco do mesmo run, de 2 a 14 ms). A origem do "depois do prazo" é o
 * `xact_start` (o `BEGIN`), e o código grava o prazo na instrução inicial, um
 * pouco depois. No primeiro `entrar` do arquivo, com o código frio no processo,
 * essa distância passou de 40 ms (medido local); aquecida, fica em poucos ms.
 * O aquecimento **reduz** essa parcela, não a zera, e passa pelos dois
 * caminhos — o sucesso e o `409` — porque montar o erro a frio também atrasa o
 * amostrador, que roda neste mesmo processo. O log de `medirEntrar` separa as
 * parcelas, para o CI mostrar quanto do número é cada uma.
 *
 * **O teto continua conservador:** o `BEGIN` vem antes da instrução inicial,
 * então o número só pode exagerar o atraso, nunca escondê-lo, e a origem e os
 * 50 ms não mudam. O piso do primeiro teste fica mais rígido, não mais frouxo.
 */
beforeAll(async () => {
  const c = await montarClube(db);
  try {
    const turma = await criarTurma(db, c);
    const a = await criarAluno(db, c);
    const b = await criarAluno(db, c);
    const sucesso = await resposta(
      rotas(cliente(urlDoCaminho('spec082-aquecimento'))).entrar(c, a, turma),
    );
    if (sucesso.status !== 200) {
      throw new Error(
        `AQUECIMENTO: a matrícula sem disputa devia dar 200, deu ${sucesso.status} ${sucesso.code ?? ''}`,
      );
    }
    const soltar = await segurar(db, travaDoClube(c.id, 'exclusiva'));
    let recusa: Resposta = { status: 0 };
    try {
      recusa = await resposta(
        rotas(cliente(urlDoCaminho('spec082-aquecimento-erro'))).entrar(
          c,
          b,
          turma,
        ),
      );
    } finally {
      await soltar();
    }
    if (recusa.status !== 409) {
      throw new Error(
        `AQUECIMENTO: com a trava do clube segura devia dar 409, deu ${recusa.status} ${recusa.code ?? ''}`,
      );
    }
  } finally {
    await limparClube(db, c);
    await desconectarTodos();
  }
});

/**
 * Dispara `entrar` pela conexão `app`, deixa `durante` agir sobre o início da
 * transação (relógio do servidor), e devolve a resposta e quanto DEPOIS do
 * prazo ela veio (negativo = antes).
 */
async function medirEntrar(
  c: Clube,
  a: AlunoDaFixtura,
  turma: string,
  app: string,
  durante: (inicio: number) => Promise<void>,
): Promise<{ r: Resposta; depoisDoPrazoMs: number }> {
  const pedido = resposta(
    rotas(cliente(urlDoCaminho(app))).entrar(c, a, turma),
  );
  const detalhe: DetalheDaEspera = {
    inicioDaInstrucaoQueEspera: Number.NaN,
    ultimaComEspera: Number.NaN,
  };
  const vigia = fimDaEspera(db, app, pedido, detalhe);
  const inicio = await inicioDaTransacao(db, app);
  await durante(inicio);
  const r = await pedido;
  const fim = await vigia;
  const depoisDoPrazoMs = fim - (inicio + PRAZO_MS);
  // Só log. No AC-005 a instrução que espera é a inicial, e a primeira parcela
  // é a distância BEGIN → prazo; nos outros, é o início da instrução que
  // esperou. A segunda é o vão entre as duas amostras que cercam o fim.
  console.log(
    `${app}: DEPOIS_DO_PRAZO_MS=${Math.round(depoisDoPrazoMs)} status=${r.status} code=${r.code ?? ''}` +
      ` BEGIN_ATE_INSTRUCAO_QUE_ESPERA_MS=${(detalhe.inicioDaInstrucaoQueEspera - inicio).toFixed(1)}` +
      ` VAO_DA_AMOSTRAGEM_MS=${(fim - detalhe.ultimaComEspera).toFixed(1)}`,
  );
  return { r, depoisDoPrazoMs };
}

describe('SPEC-082/AC-005 — a instrução inicial: prazo absoluto, recálculo entre as travas', () => {
  it('a do clube segura em modo exclusivo o tempo todo → 55P03 até 50 ms depois do prazo', async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    const soltar = await segurar(db, travaDoClube(clube.id, 'exclusiva'));
    let m: { r: Resposta; depoisDoPrazoMs: number } = {
      r: { status: 0 },
      depoisDoPrazoMs: Number.NaN,
    };
    try {
      m = await medirEntrar(
        clube,
        a,
        turma,
        'spec082-ac005-clube',
        async () => {},
      );
    } finally {
      await soltar();
    }
    expect(m.r).toMatchObject({
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I6,
    });
    expect(m.depoisDoPrazoMs).toBeGreaterThanOrEqual(-TOLERANCIA_MS);
    expect(m.depoisDoPrazoMs).toBeLessThanOrEqual(TOLERANCIA_MS);
  });

  it('a do clube segura 1,5 s e a do aluno segura depois → 55P03 até 50 ms depois do prazo (e não 1,5 s depois)', async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    const soltarAluno = await segurar(db, travaDoAluno(a.alunoId));
    const soltarClube = await segurar(db, travaDoClube(clube.id, 'exclusiva'));
    let m: { r: Resposta; depoisDoPrazoMs: number } = {
      r: { status: 0 },
      depoisDoPrazoMs: Number.NaN,
    };
    try {
      m = await medirEntrar(
        clube,
        a,
        turma,
        'spec082-ac005-ordem',
        async (inicio) => {
          await ateOInstante(db, inicio + 1_500);
          await soltarClube();
        },
      );
    } finally {
      await soltarClube();
      await soltarAluno();
    }
    expect(m.r).toMatchObject({
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I6,
    });
    expect(m.depoisDoPrazoMs).toBeLessThanOrEqual(TOLERANCIA_MS);
    expect(await matriculasDaTurma(db, turma)).toBe(0);
  });
});

describe('SPEC-082/AC-015 — o prazo é da matrícula inteira, por aquisição', () => {
  it('(a) várias aquisições numa só instrução: gestor A solto em 1,5 s, gestor B preso → 55P03 até 50 ms depois do prazo', async () => {
    clube = await montarClube(db, { gestores: 2 });
    const turma = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    // v9 (achado 082-V8-01): A é o gestor de MENOR id — o aviso trava na
    // ordem do `id`, então é por A que a matrícula espera primeiro.
    const [gA, gB] = [...clube.gestores].sort();
    const B = await segurarComPid(db, linhaEmForUpdate('usuarios', gB));
    const A = await segurarComPid(db, linhaEmForUpdate('usuarios', gA));
    const soltarA = A.soltar;
    const soltarB = B.soltar;
    let m: { r: Resposta; depoisDoPrazoMs: number } = {
      r: { status: 0 },
      depoisDoPrazoMs: Number.NaN,
    };
    try {
      m = await medirEntrar(
        clube,
        a,
        turma,
        'spec082-ac015a',
        async (inicio) => {
          // Precondição, ANTES de soltar A: a matrícula espera a transação
          // que segura A (e não a de B). Senão, a prova não é esta.
          await vistoEsperando(db, 'spec082-ac015a', undefined, 1_400);
          const bloqueadores = await bloqueadoresDe(db, 'spec082-ac015a');
          if (!bloqueadores.includes(A.pid) || bloqueadores.includes(B.pid)) {
            throw new Error(
              `PRECONDICAO: a matrícula devia esperar a transação de A (pid ${A.pid}); espera ${JSON.stringify(bloqueadores)} (B = ${B.pid})`,
            );
          }
          await ateOInstante(db, inicio + 1_500);
          await soltarA();
        },
      );
    } finally {
      await soltarA();
      await soltarB();
    }
    expect(m.r).toMatchObject({
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I6,
    });
    expect(m.depoisDoPrazoMs).toBeLessThanOrEqual(TOLERANCIA_MS);
    expect(await matriculasDaTurma(db, turma)).toBe(0);
    expect(await db.notificacao.count({ where: { companyId: clube.id } })).toBe(
      0,
    );
  });

  it('(b) esperas em instruções diferentes: aluno 1,5 s, depois a linha da turma → 55P03 até 50 ms depois do prazo, com a I4', async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    const soltarTurma = await segurar(db, linhaEmForUpdate('turmas', turma));
    const soltarAluno = await segurar(db, travaDoAluno(a.alunoId));
    let m: { r: Resposta; depoisDoPrazoMs: number } = {
      r: { status: 0 },
      depoisDoPrazoMs: Number.NaN,
    };
    try {
      m = await medirEntrar(
        clube,
        a,
        turma,
        'spec082-ac015b',
        async (inicio) => {
          await ateOInstante(db, inicio + 1_500);
          await soltarAluno();
        },
      );
    } finally {
      await soltarAluno();
      await soltarTurma();
    }
    expect(m.r).toMatchObject({
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I4,
    });
    expect(m.depoisDoPrazoMs).toBeLessThanOrEqual(TOLERANCIA_MS);
  });

  it('(c) a FK tardia do INSERT: ~1,5 s de trabalho antes (a linha da turma), a linha do aluno presa → 55P03 até 50 ms depois do prazo', async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    const soltarAlunoLinha = await segurar(
      db,
      linhaEmForUpdate('alunos', a.alunoId),
    );
    const soltarTurma = await segurar(db, linhaEmForUpdate('turmas', turma));
    let m: { r: Resposta; depoisDoPrazoMs: number } = {
      r: { status: 0 },
      depoisDoPrazoMs: Number.NaN,
    };
    try {
      m = await medirEntrar(
        clube,
        a,
        turma,
        'spec082-ac015c',
        async (inicio) => {
          await ateOInstante(db, inicio + 1_500);
          await soltarTurma();
        },
      );
    } finally {
      await soltarTurma();
      await soltarAlunoLinha();
    }
    expect(m.r).toMatchObject({
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I6,
    });
    expect(m.depoisDoPrazoMs).toBeLessThanOrEqual(TOLERANCIA_MS);
    expect(await matriculasDaTurma(db, turma)).toBe(0);
  });

  /** Uma transação cujo prazo JÁ venceu, e a instrução em julgamento dentro dela. */
  async function comPrazoVencido<T>(
    instrucao: (t: Prisma.TransactionClient) => Promise<T>,
  ): Promise<{ valor?: T; erro?: unknown; ms: number; lockTimeout?: string }> {
    const inicio = Date.now();
    try {
      return await db.$transaction(async (t) => {
        await t.$queryRaw`SELECT set_config('playck.prazo', (clock_timestamp() - interval '1 second')::text, true)`;
        const valor = await instrucao(t);
        const lt = await t.$queryRaw<
          { lock_timeout: string }[]
        >`SHOW lock_timeout`;
        return {
          valor,
          ms: Date.now() - inicio,
          lockTimeout: lt[0].lock_timeout,
        };
      });
    } catch (erro) {
      return { erro, ms: Date.now() - inicio };
    }
  }

  it('(d) linha LIVRE com o prazo já vencido → a instrução conclui (o piso de 1 ms deixa passar)', async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    const r1 = await comPrazoVencido(
      (t) =>
        t.$queryRaw<
          { id: string }[]
        >`WITH ${CTE_DO_PRAZO} SELECT id FROM turmas WHERE id = ${turma}::uuid AND ${DEPOIS_DO_PRAZO} FOR UPDATE`,
    );
    expect(r1.erro).toBeUndefined();
    expect(r1.valor).toEqual([{ id: turma }]);
    expect(r1.lockTimeout).toBe('1ms');
    const r2 = await comPrazoVencido((t) =>
      inserirMatriculaComPrazo(t, turma, a.alunoId),
    );
    expect(r2.erro).toBeUndefined();
    expect(r2.valor).toMatchObject({ turmaId: turma, alunoId: a.alunoId });
    expect(await matriculasDaTurma(db, turma)).toBe(1);
  });

  it('(e) prazo vencido e linha SEGURA → 55P03 em até 50 ms (e não espera sem fim)', async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    const soltar = await segurar(db, linhaEmForUpdate('alunos', a.alunoId));
    let r;
    try {
      r = await Promise.race([
        comPrazoVencido((t) => inserirMatriculaComPrazo(t, turma, a.alunoId)),
        new Promise<'SEM_TETO'>((ok) =>
          setTimeout(() => ok('SEM_TETO'), 5_000),
        ),
      ]);
    } finally {
      await soltar();
    }
    expect(r).not.toBe('SEM_TETO');
    const e = (r as { erro?: { message?: string; meta?: unknown } }).erro;
    expect(`${e?.message ?? ''} ${JSON.stringify(e?.meta ?? {})}`).toContain(
      '55P03',
    );
    console.log(`AC-015(e): MS=${(r as { ms: number }).ms}`);
    // A transação inteira (BEGIN, o prazo, a instrução, ROLLBACK), no banco local.
    expect((r as { ms: number }).ms).toBeLessThanOrEqual(TOLERANCIA_MS * 4);
    expect(await matriculasDaTurma(db, turma)).toBe(0);
  });
});

/**
 * **AC-020 — o tempo-limite de 8 s é o que vale, e vira 503.** Toda espera por
 * lock termina pelo `lock_timeout` (AC-015, AC-019), então o `P2028` só nasce
 * de LENTIDÃO sem lock — latência. O proxy fica entre o serviço e o Postgres,
 * sem disputa nenhuma.
 *
 * **Calibração pelas voltas sequenciais (v8/v9, achados IMP-082-02 e
 * 082-V8-03).** O atraso do proxy multiplica as VOLTAS pela rede, e não os
 * comandos: o teto de 17 idas do AC-011 conta comandos, e o Prisma manda
 * algumas leituras juntas (as três do `Promise.all` de `carregarConjuntos`).
 * O teste conta as voltas da transação no próprio proxy, numa execução sem
 * atraso, e calcula o atraso por sentido para cada alvo. Folga:
 *
 * - (a) a duração **medida** da transação fica em ≤ 7,0 s;
 * - (b) a duração **projetada** (`VOLTAS × volta calibrada`, a volta medida
 *   por um `SELECT 1` no mesmo atraso) fica em ≥ 9,0 s; e a **observada**
 *   termina entre 8,0 e 8,5 s — é o tempo-limite que a encerra.
 *
 * Fora disso o teste falha **por calibração**, e não por resultado. A duração
 * é contada desde a chamada do `$transaction` até ele devolver.
 *
 * A conexão é UMA (`connection_limit=1`) e é aquecida sem latência por um
 * `entrar` anterior, para as instruções já estarem preparadas.
 */
describe('SPEC-082/AC-020 — o tempo-limite de 8 s é o que vale, e vira 503', () => {
  const CASO_A_MS = 6_500; // 1,5 s abaixo do limite
  const CASO_B_MS = 9_500; // 1,5 s acima do limite

  let proxy: ProxyDeLatencia | null = null;
  afterEach(async () => {
    await desconectarTodos();
    if (proxy) await proxy.fechar();
    proxy = null;
  });

  /** O cliente com a duração e as voltas de cada transação registradas. */
  function clienteCronometrado(url: string, p: ProxyDeLatencia) {
    const c = cliente(url);
    const medidas: { ms: number; voltas: number; msDoCallback: number }[] = [];
    const original = c.$transaction.bind(c) as (
      cb: (t: unknown) => Promise<unknown>,
      opcoes?: object,
    ) => Promise<unknown>;
    (c as unknown as { $transaction: unknown }).$transaction = (
      cb: (t: unknown) => Promise<unknown>,
      opcoes?: object,
    ) => {
      // Desde a CHAMADA: o tempo-limite do Prisma conta o `BEGIN` também
      // (medido: a 384 ms por sentido, o P2028 chega 8.695 ms depois da
      // chamada e 7.912 ms depois do começo do callback).
      const chamada = Date.now();
      const voltas0 = p.voltas();
      let inicio = 0;
      return original(async (t) => {
        inicio = Date.now();
        return cb(t);
      }, opcoes).finally(() =>
        medidas.push({
          ms: Date.now() - chamada,
          voltas: p.voltas() - voltas0,
          msDoCallback: Date.now() - inicio,
        }),
      );
    };
    return { c, medidas };
  }

  async function correr(alvoMs: number) {
    clube = await montarClube(db);
    const p = await abrirProxy(
      Number(new URL(process.env.DATABASE_URL as string).port),
    );
    proxy = p;
    const url = new URL(urlDoCaminho(`spec082-ac020-${alvoMs}`));
    url.port = String(p.porta);
    url.searchParams.set('connection_limit', '1');
    const { c, medidas } = clienteCronometrado(url.toString(), p);
    const r = rotas(c);
    const c1 = clube;
    const entrarNova = async () =>
      resposta(
        r.entrar(c1, await criarAluno(db, c1), await criarTurma(db, c1)),
      );

    expect(await entrarNova()).toMatchObject({ status: 200 }); // aquece
    // As voltas e a duração, sem atraso.
    expect(await entrarNova()).toMatchObject({ status: 200 });
    const { ms: semAtraso, voltas } = medidas[medidas.length - 1];
    const atraso = Math.round((alvoMs - semAtraso) / (2 * voltas));

    // A volta calibrada: um `SELECT 1` na mesma conexão, no atraso escolhido.
    p.definirAtraso(atraso);
    const amostras: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await c.$queryRaw`SELECT 1`;
      amostras.push(Date.now() - t0);
    }
    const volta = amostras.sort((x, y) => x - y)[1];
    const projetada = voltas * volta;

    // A prova: as opções do serviço, intactas.
    const turma = await criarTurma(db, c1);
    const a = await criarAluno(db, c1);
    const res = await resposta(r.entrar(c1, a, turma));
    p.definirAtraso(0);
    const prova = medidas[medidas.length - 1];
    console.log(
      `AC-020 alvo=${alvoMs}ms: VOLTAS=${voltas} SEM_ATRASO_MS=${semAtraso} ATRASO_POR_SENTIDO_MS=${atraso} VOLTA_CALIBRADA_MS=${volta} DURACAO_PROJETADA_MS=${projetada} DURACAO_OBSERVADA_MS=${prova.ms} (do callback: ${prova.msDoCallback}) status=${res.status} code=${res.code ?? ''}`,
    );
    return { res, turma, projetada, observada: prova.ms, volta };
  }

  it('(a) latência para a transação levar 6,5 s → 200, matrícula gravada', async () => {
    const { res, turma, observada } = await correr(CASO_A_MS);
    if (observada > 7_000) {
      throw new Error(`CALIBRACAO: (a) mediu ${observada} ms, acima de 7,0 s`);
    }
    expect(res).toMatchObject({ status: 200 });
    expect(await matriculasDaTurma(db, turma)).toBe(1);
    // Passou do limite padrão de 5 s: sem o `timeout: 8000`, seria P2028.
    expect(observada).toBeGreaterThan(5_000);
  });

  it('(b) latência para a transação levar 9,5 s → 503 SERVIDOR_OCUPADO com a I5, nada gravado', async () => {
    const { res, turma, projetada, observada, volta } = await correr(CASO_B_MS);
    if (projetada < 9_000) {
      throw new Error(
        `CALIBRACAO: (b) projetou ${projetada} ms, abaixo de 9,0 s`,
      );
    }
    expect(res).toMatchObject({
      status: 503,
      code: 'SERVIDOR_OCUPADO',
      message: I5,
    });
    expect(await matriculasDaTurma(db, turma)).toBe(0);
    // Encerrada pelo tempo-limite, e não pelo fim do trabalho (v10/v11): o
    // `P2028` só aparece quando a volta em curso termina, então a observada
    // fica entre 8,0 s e 8,0 s + uma volta calibrada + 50 ms de execução.
    expect(observada).toBeGreaterThanOrEqual(8_000);
    expect(observada).toBeLessThanOrEqual(8_000 + volta + 50);
  });
});
