/**
 * SPEC-083/TASK-009 (parte B) — **FIT-057: a importação com turma sob
 * corrida**, contra o Postgres de verdade (D3, INV-083g, INV-083i, INV-083j).
 *
 * - **(a) a ordem das travas (AC-047)**, vista em `pg_locks` e
 *   `pg_blocking_pids`: a do clube, compartilhada, primeiro; depois as linhas
 *   referenciadas; depois as turmas em ordem de `id`. Uma edição de nível
 *   concorrente espera a importação terminar.
 * - **(b) a matrícula dentro e fora do arquivo (AC-046)**: numa turma do
 *   arquivo, `409` com o texto I4 em até 2,3 s, sem `500`; numa turma fora
 *   dele, conclui sem esperar a importação (INV-083i — a S11 a faz esperar).
 * - **(c) o prazo absoluto nas turmas (AC-045)** e **(d) dentro de uma escrita
 *   em lote (AC-050)**: medidos por amostras, no relógio do servidor, com o
 *   classificador e o agregado do AC-056 (`classificar-amostras.ts`). Três
 *   tentativas, todas executadas.
 * - **a corrida com cadastro (AC-013)**: a conferência passa, outra conexão
 *   ocupa a última vaga ou cria a conta de um e-mail do arquivo, e a
 *   importação responde `422` com o relatório refeito — nada escrito.
 *
 * ## Por que barreira, e não duas requisições soltas
 *
 * Cada caso põe uma conexão segurando um recurso e só segue depois de VER, em
 * `pg_blocking_pids`, quem espera por quem. Sem a precondição vista, o caso
 * reprova por ela, e nunca com um resultado aparentemente bom — a lição do
 * FIT-049 e a regra da DoR desta spec (DOR-083-R2-02).
 *
 * ## A importação pelo controller, com os ganchos de teste
 *
 * As respostas passam pelo `ImportacaoController`: a tradução de `55P03` e
 * `57014` em `409` mora na borda (D3, passo 5), e uma prova que chamasse o
 * serviço direto ficaria verde com ela arrancada. O serviço é montado à mão
 * (o molde de `spec-083-importacao.db-spec.ts`) para receber o gancho
 * `aoTravar`, que devolve o `playck.prazo` e o `pg_backend_pid()` **lidos na
 * sessão da importação** — noutra conexão, `current_setting` devolve nulo
 * (4ª rodada da DoR). Cada caminho tem `application_name` próprio, e o
 * observador lê `pg_stat_activity` por ele.
 *
 * ## Tempo, e o que este arquivo NÃO conclui sozinho
 *
 * Os casos (c) e (d) medem prazo em milissegundos: rodam sozinhos na máquina,
 * nunca em paralelo com outra suíte. **Uma falha do harness (inconclusivo, ou
 * vão acima de 200 ms) não se resolve rodando de novo até passar**: toda
 * execução vai para o `CLI_AUDIT.md` com o agregado dela, e a seguinte só
 * depois de um diagnóstico escrito (AC-045). As linhas `FIT057_…` do log são
 * o que esse registro copia.
 *
 * ## O classificador roda no mesmo job, como arquivo próprio
 *
 * Os casos do AC-056 (e a S19, a S20 e a S21) moram em
 * `classificar-amostras.spec.ts`, e o `testRegex` do `jest-fit.json` acha esse
 * arquivo pelo nome (TASK-005c). Até ali ele vinha por um `import` daqui, e só
 * rodava porque este arquivo rodava — herdando o `exigirBancoLocal` de uma
 * unidade que não toca banco, e somando os casos dele aos deste.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { AcessoService } from '../../src/acesso/acesso.service';
import type { AccessTokenPayload } from '../../src/common/types/jwt-payload.type';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import {
  ImportacaoDeAlunosService,
  type GanchosDaImportacao,
} from '../../src/people/importacao/importacao-de-alunos.service';
import { ImportacaoController } from '../../src/people/importacao/importacao.controller';
import type { RelatorioDeImportacaoDto } from '../../src/people/importacao/dto/importacao-response.dto';
import { LevelsService } from '../../src/people/levels.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import {
  ateOInstante,
  chaveDoClube,
  cliente,
  criarAluno,
  criarTurma,
  desconectarTodos,
  dormir,
  fimDaEspera,
  I4,
  I6,
  inicioDaTransacao,
  limparClube,
  linhaEmForUpdate,
  matricularDireto,
  montarClube,
  PRAZO_MS,
  resposta,
  rotas,
  travaDoAluno,
  travaDoClube,
  urlDoCaminho,
  type Clube,
  type Resposta,
} from '../banco/spec-082-fixture';
import {
  CADENCIA_MS,
  classificarAmostras,
  concluirCaso,
  LIMITE_DE_DESISTENCIA_MS,
  TENTATIVAS,
  type Amostra,
  type Classificacao,
} from './classificar-amostras';

exigirBancoLocal();
jest.setTimeout(600_000);

const MODELOS = {
  remetente: 'convites@fit057.teste.local',
  responderPara: 'suporte@fit057.teste.local',
  urlCliente: 'https://cliente.fit057.teste.local',
};

/** Quem monta a fixtura e confere o que ficou gravado. */
const db = new PrismaClient();

/** Uma rodada por execução: os e-mails não colidem com os de outra. */
const RODADA = randomUUID().slice(0, 8);
let seq = 0;
const email = (rotulo: string) => {
  seq += 1;
  return `fit057-${RODADA}-${rotulo}-${seq}@teste.local`;
};

// ============================================================================
// Conexões: uma por caminho, com nome próprio em `pg_stat_activity`
// ============================================================================

const porApp = new Map<string, PrismaClient>();

function conexao(app: string): PrismaClient {
  let c = porApp.get(app);
  if (!c) {
    c = cliente(urlDoCaminho(app));
    porApp.set(app, c);
  }
  return c;
}

/**
 * Abre a conexão antes do caso: a primeira ida de um cliente novo custa a
 * conexão inteira (dezenas a centenas de ms nesta máquina), e esse tempo sairia
 * do prazo de 2 s da importação no meio das observações.
 */
async function aquecer(...apps: string[]): Promise<void> {
  for (const app of apps) await conexao(app).$queryRaw`SELECT 1`;
}

/** O observador: instruções autocommit, sem snapshot de transação longa. */
const OBSERVADOR = 'fit057-observador';
const observador = () => conexao(OBSERVADOR);

// ============================================================================
// A importação, pelo controller
// ============================================================================

function gestorDo(clube: Clube): AccessTokenPayload {
  return {
    sub: clube.gestores[0],
    email: 'gestor@fit057.teste.local',
    nome: 'Gestora',
    role: 'company_admin',
    companyId: clube.id,
  } as unknown as AccessTokenPayload;
}

function importar(
  app: string,
  clube: Clube,
  conteudo: string,
  ganchos: GanchosDaImportacao = {},
): Promise<Resposta> {
  const p = conexao(app) as unknown as PrismaService;
  const memoria = new MemoriaProvedorDeEmail();
  const controller = new ImportacaoController(
    new ImportacaoDeAlunosService(
      p,
      new AcessoService(p, memoria, MODELOS),
      memoria,
      MODELOS,
      ganchos,
    ),
  );
  return resposta(
    controller.importar(
      gestorDo(clube),
      undefined,
      { buffer: Buffer.from(conteudo, 'utf8') } as Express.Multer.File,
      undefined,
    ),
  );
}

interface Sessao {
  /** O `playck.prazo` que a importação fixou, como ela o leu. */
  prazo: string;
  pid: number;
}

/**
 * Dispara a importação com o gancho `aoTravar` e devolve, à parte, a sessão
 * dela (prazo e `pid`) assim que a trava do clube sai — antes das referenciadas
 * e das turmas.
 */
function importarComSessao(
  app: string,
  clube: Clube,
  conteudo: string,
): { pedido: Promise<Resposta>; sessao: Promise<Sessao> } {
  let avisar!: (s: Sessao) => void;
  const travou = new Promise<Sessao>((r) => (avisar = r));
  const pedido = importar(app, clube, conteudo, {
    aoTravar: ({ prazo, pid }) => avisar({ prazo, pid }),
  });
  const sessao = Promise.race([
    travou,
    pedido.then((r): never => {
      throw new Error(
        `a importação respondeu ${r.status} ${r.code ?? ''} antes de travar o clube`,
      );
    }),
  ]);
  return { pedido, sessao };
}

/** O início da medição: `playck.prazo − 2 s`, convertido pelo servidor. */
async function inicioDe(sessao: Sessao): Promise<number> {
  const [r] = await observador().$queryRaw<{ ms: number }[]>`
    SELECT (extract(epoch FROM ${sessao.prazo}::timestamptz) * 1000)::float8 AS ms`;
  return r.ms - PRAZO_MS;
}

interface Linha {
  email: string;
  turma?: string;
}

function planilha(linhas: readonly Linha[]): string {
  return [
    'nome;email;turma',
    ...linhas.map(
      (l, i) => `Aluno FIT057 ${i + 1};${l.email};${l.turma ?? ''}`,
    ),
  ].join('\n');
}

interface Turma {
  id: string;
  nome: string;
}

async function novaTurma(clube: Clube, capacidade = 8): Promise<Turma> {
  const id = await criarTurma(db, clube, capacidade);
  const { nome } = await db.turma.findUniqueOrThrow({
    where: { id },
    select: { nome: true },
  });
  return { id, nome };
}

/** Duas turmas, devolvidas em ordem de `id` (a ordem da D3, passo 3). */
async function duasTurmas(clube: Clube): Promise<[Turma, Turma]> {
  const t = [await novaTurma(clube), await novaTurma(clube)];
  t.sort((x, y) => (x.id < y.id ? -1 : 1));
  return [t[0], t[1]];
}

// ============================================================================
// Barreiras: uma transação que segura um recurso até ser solta
// ============================================================================

interface Barreira {
  pid: number;
  /** Solta, com `COMMIT` (padrão) ou `ROLLBACK`. Chamar de novo não faz nada. */
  soltar: (desfecho?: 'commit' | 'rollback') => Promise<void>;
}

const DESFAZER = new Error('fit-057: desfazer a barreira');

async function erguerBarreira(
  c: PrismaClient,
  passos: (t: Prisma.TransactionClient) => Promise<unknown>,
): Promise<Barreira> {
  let liberar!: (d: 'commit' | 'rollback') => void;
  const liberado = new Promise<'commit' | 'rollback'>((r) => (liberar = r));
  let pronto!: (pid: number) => void;
  let falhou!: (e: unknown) => void;
  const travado = new Promise<number>((r, j) => {
    pronto = r;
    falhou = j;
  });
  let erro: Error | null = null;
  const tx = c
    .$transaction(
      async (t) => {
        const [{ pid }] = await t.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        await passos(t);
        pronto(pid);
        if ((await liberado) === 'rollback') throw DESFAZER;
      },
      { timeout: 120_000, maxWait: 20_000 },
    )
    .catch((e: unknown) => {
      if (e === DESFAZER) return;
      erro = e instanceof Error ? e : new Error(String(e));
      falhou(e);
    });
  const pid = await travado;
  return {
    pid,
    soltar: async (desfecho = 'commit') => {
      liberar(desfecho);
      await tx;
      if (erro) throw erro;
    },
  };
}

/** Uma conta com um e-mail do arquivo, inserida pela barreira. */
const contaCom =
  (clube: Clube, emailDaConta: string) => (t: Prisma.TransactionClient) =>
    t.$executeRawUnsafe(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
       VALUES ($1::uuid,$2,'h','Concorrente FIT057','aluno',$3::uuid,now())`,
      randomUUID(),
      emailDaConta,
      clube.id,
    );

// ============================================================================
// O que o observador lê
// ============================================================================

interface Atividade {
  pid: number;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  bloqueadores: number[];
  query: string;
}

async function atividadeDoPid(pid: number): Promise<Atividade | null> {
  const [a] = await observador().$queryRaw<Atividade[]>`
    SELECT pid, state, wait_event_type, wait_event,
           coalesce(pg_blocking_pids(pid), '{}') AS bloqueadores, query
      FROM pg_stat_activity WHERE pid = ${pid}::int`;
  return a ?? null;
}

/** A conexão do caminho que está esperando um lock agora, se houver. */
async function esperandoNoApp(app: string): Promise<Atividade | null> {
  const [a] = await observador().$queryRaw<Atividade[]>`
    SELECT pid, state, wait_event_type, wait_event,
           coalesce(pg_blocking_pids(pid), '{}') AS bloqueadores, query
      FROM pg_stat_activity
     WHERE application_name = ${app} AND wait_event_type = 'Lock'`;
  return a ?? null;
}

/** O `pid` esperando um lock E bloqueado por `quem`. */
async function esperandoPor(pid: number, quem: number) {
  const a = await atividadeDoPid(pid);
  return a?.wait_event_type === 'Lock' && a.bloqueadores.includes(quem)
    ? a
    : null;
}

/** Repete `ler` até ela devolver algo; senão, a precondição falha com o nome. */
async function ate<T>(
  descricao: string,
  ler: () => Promise<T | null>,
  limiteMs = 5_000,
): Promise<T> {
  const limite = Date.now() + limiteMs;
  for (;;) {
    const v = await ler();
    if (v) return v;
    if (Date.now() > limite) throw new Error(`precondição: ${descricao}`);
    await dormir(5);
  }
}

interface TravaVista {
  locktype: string;
  rel: string | null;
  mode: string;
  granted: boolean;
  classid: string | null;
  objid: string | null;
}

const travasDoPid = (pid: number) =>
  observador().$queryRaw<TravaVista[]>`
    SELECT locktype, relation::regclass::text AS rel, mode, granted,
           classid::text AS classid, objid::text AS objid
      FROM pg_locks WHERE pid = ${pid}::int`;

/** A trava do clube nas linhas de `pg_locks` (a chave de 64 bits em duas metades). */
function travaDoClubeEm(travas: readonly TravaVista[], companyId: string) {
  const chave = BigInt.asUintN(64, chaveDoClube(companyId));
  const classid = String(chave >> 32n);
  const objid = String(chave & 0xffffffffn);
  return travas
    .filter(
      (t) =>
        t.locktype === 'advisory' && t.classid === classid && t.objid === objid,
    )
    .map((t) => ({ mode: t.mode, granted: t.granted }));
}

/** As quatro tabelas que a ordem da D3 distingue, como `pg_locks` as mostra. */
const TABELAS_DA_ORDEM = ['empresas', 'niveis', 'usuarios', 'turmas'];

function tabelasTravadas(travas: readonly TravaVista[]): string[] {
  return [
    ...new Set(
      travas
        .filter(
          (t) =>
            t.locktype === 'relation' &&
            t.granted &&
            TABELAS_DA_ORDEM.includes(t.rel ?? ''),
        )
        .map((t) => t.rel as string),
    ),
  ].sort();
}

// ============================================================================
// A amostragem (AC-045 e AC-050)
// ============================================================================

interface AmostraBruta {
  ms: number;
  state: string | null;
  waitEventType: string | null;
  bloqueadores: number[];
}

/**
 * Consulta `pg_stat_activity` **daquele `pid`** a cada 20 ms, em instruções
 * autocommit, até a importação responder e o backend estar fora de `active`.
 * Cada amostra leva o `clock_timestamp()` do servidor, o `state`, o
 * `wait_event_type` e os bloqueadores.
 */
async function amostrar(
  pid: number,
  enquanto: Promise<unknown>,
): Promise<AmostraBruta[]> {
  let terminou = false;
  void enquanto.then(
    () => (terminou = true),
    () => (terminou = true),
  );
  const amostras: AmostraBruta[] = [];
  const teto = Date.now() + 20_000;
  for (;;) {
    const t0 = Date.now();
    const [r] = await observador().$queryRaw<
      {
        ms: number;
        state: string | null;
        wet: string | null;
        b: number[] | null;
      }[]
    >`
      SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms,
             a.state, a.wait_event_type AS wet, pg_blocking_pids(a.pid) AS b
        FROM (SELECT 1) um
        LEFT JOIN pg_stat_activity a ON a.pid = ${pid}::int`;
    amostras.push({
      ms: r.ms,
      state: r.state,
      waitEventType: r.wet,
      bloqueadores: r.b ?? [],
    });
    if ((terminou && r.state !== 'active') || Date.now() > teto) {
      return amostras;
    }
    await dormir(Math.max(0, CADENCIA_MS - (Date.now() - t0)));
  }
}

/** Traduz os bloqueadores de cada amostra em "esperando X" ou "esperando Y". */
function rotular(
  brutas: readonly AmostraBruta[],
  inicio: number,
  x: number,
  y: number,
): Amostra[] {
  return brutas.map((a) => ({
    ms: a.ms - inicio,
    state: a.state,
    espera:
      a.waitEventType !== 'Lock'
        ? null
        : a.bloqueadores.includes(x)
          ? 'primeira'
          : a.bloqueadores.includes(y)
            ? 'segunda'
            : null,
  }));
}

// ============================================================================
// O que ficou gravado
// ============================================================================

interface Contagem {
  usuarios: number;
  alunos: number;
  matriculas: number;
  convites: number;
}

async function contar(companyId: string): Promise<Contagem> {
  const [r] = await db.$queryRawUnsafe<
    { usuarios: bigint; alunos: bigint; matriculas: bigint; convites: bigint }[]
  >(
    `SELECT (SELECT count(*) FROM usuarios WHERE company_id = $1::uuid AND role = 'aluno') AS usuarios,
            (SELECT count(*) FROM alunos WHERE company_id = $1::uuid) AS alunos,
            (SELECT count(*) FROM turma_alunos ta JOIN turmas t ON t.id = ta.turma_id WHERE t.company_id = $1::uuid) AS matriculas,
            (SELECT count(*) FROM convites_de_acesso WHERE company_id = $1::uuid) AS convites`,
    companyId,
  );
  return {
    usuarios: Number(r.usuarios),
    alunos: Number(r.alunos),
    matriculas: Number(r.matriculas),
    convites: Number(r.convites),
  };
}

/** O que mudou nas quatro tabelas, e quantas contas têm os e-mails do arquivo. */
async function mudancas(
  companyId: string,
  antes: Contagem,
  emails: readonly string[],
) {
  const agora = await contar(companyId);
  return {
    usuarios: agora.usuarios - antes.usuarios,
    alunos: agora.alunos - antes.alunos,
    matriculas: agora.matriculas - antes.matriculas,
    convites: agora.convites - antes.convites,
    contasDoArquivo: await db.usuario.count({
      where: { email: { in: [...emails] } },
    }),
  };
}

const NADA = {
  usuarios: 0,
  alunos: 0,
  matriculas: 0,
  convites: 0,
  contasDoArquivo: 0,
};

const resumoDa = (r: Resposta) => ({
  status: r.status,
  code: r.code,
  message: r.message,
  ...(r.status === 500 ? { erro: String(r.erro) } : {}),
});

const relatorioDo422 = (r: Resposta) =>
  (r.erro as { getResponse(): RelatorioDeImportacaoDto }).getResponse();

// ============================================================================
// Ciclo de vida
// ============================================================================

const clubes: Clube[] = [];

async function novoClube(): Promise<Clube> {
  const clube = await montarClube(db);
  clubes.push(clube);
  return clube;
}

beforeAll(async () => {
  await aquecer(OBSERVADOR);
});

afterAll(async () => {
  for (const c of clubes) await limparClube(db, c);
  await desconectarTodos();
  await db.$disconnect();
});

// ============================================================================
// (a) AC-047 — a ordem das travas
// ============================================================================

describe('SPEC-083/FIT-057 (a) AC-047 — a ordem das travas da importação', () => {
  it('clube compartilhado primeiro, depois as referenciadas, depois as turmas por id; a edição de nível espera a importação terminar', async () => {
    const clube = await novoClube();
    const [A, B] = await duasTurmas(clube);
    const IMP = 'fit057-a-imp';
    await aquecer(IMP, 'fit057-a-b1', 'fit057-a-b2', 'fit057-a-b3');
    await aquecer('fit057-a-sonda', 'fit057-a-nivel');

    // Três barreiras, uma por degrau da ordem, erguidas antes de a
    // importação começar e soltas uma de cada vez.
    const clubeExclusivo = await erguerBarreira(
      conexao('fit057-a-b1'),
      travaDoClube(clube.id, 'exclusiva'),
    );
    const empresa = await erguerBarreira(
      conexao('fit057-a-b2'),
      linhaEmForUpdate('empresas', clube.id),
    );
    const turmaB = await erguerBarreira(
      conexao('fit057-a-b3'),
      linhaEmForUpdate('turmas', B.id),
    );

    const emails = [email('a-1'), email('a-2')];
    const antes = await contar(clube.id);
    const terminou: string[] = [];
    const pedido = importar(
      IMP,
      clube,
      planilha([
        { email: emails[0], turma: A.nome },
        { email: emails[1], turma: B.nome },
      ]),
    ).then((r) => {
      terminou.push('importacao');
      return r;
    });

    let edicao: Promise<unknown> = Promise.resolve();
    let sonda: Promise<unknown> = Promise.resolve();
    try {
      // 1. A trava do clube vem antes de tudo: esperando por ela, a
      //    importação ainda não tocou nenhuma das quatro tabelas.
      const naTravaDoClube = await ate(
        'a importação esperando a trava do clube',
        () => esperandoNoApp(IMP),
        15_000,
      );
      const pid = naTravaDoClube.pid;
      expect(naTravaDoClube.wait_event).toBe('advisory');
      expect(naTravaDoClube.bloqueadores).toEqual([clubeExclusivo.pid]);
      const t1 = await travasDoPid(pid);
      expect(travaDoClubeEm(t1, clube.id)).toEqual([
        { mode: 'ShareLock', granted: false },
      ]);
      expect(tabelasTravadas(t1)).toEqual([]);
      await clubeExclusivo.soltar();

      // 2. As referenciadas, antes das turmas: esperando a linha da empresa,
      //    a trava do clube já é dela — COMPARTILHADA (a S11 mostraria
      //    ExclusiveLock) — e a tabela de turmas ainda não foi tocada.
      await ate('a importação esperando a linha da empresa', () =>
        esperandoPor(pid, empresa.pid),
      );
      const t2 = await travasDoPid(pid);
      expect(travaDoClubeEm(t2, clube.id)).toEqual([
        { mode: 'ShareLock', granted: true },
      ]);
      expect(tabelasTravadas(t2)).toEqual(['empresas', 'niveis', 'usuarios']);
      await empresa.soltar();

      // 3. As turmas, por id: esperando B, a importação já segura A — uma
      //    sonda que pede A espera por ELA, e não pela barreira.
      await ate('a importação esperando a turma B', () =>
        esperandoPor(pid, turmaB.pid),
      );
      expect(tabelasTravadas(await travasDoPid(pid))).toEqual([
        'empresas',
        'niveis',
        'turmas',
        'usuarios',
      ]);
      sonda = conexao('fit057-a-sonda')
        .$transaction(async (t) => {
          await t.$queryRawUnsafe(
            `SELECT id FROM turmas WHERE id = '${A.id}' FOR UPDATE`,
          );
          throw DESFAZER;
        })
        .catch((e: unknown) => {
          if (e !== DESFAZER) throw e;
        });
      const sondaEsperando = await ate('a sonda esperando a turma A', () =>
        esperandoNoApp('fit057-a-sonda'),
      );
      expect(sondaEsperando.bloqueadores).toEqual([pid]);

      // A edição de nível (trava exclusiva do clube) espera a importação.
      edicao = new LevelsService(
        conexao('fit057-a-nivel') as unknown as PrismaService,
      )
        .create(clube.id, { nome: `Avançado ${RODADA}`, ordem: 9 })
        .then((nivel) => {
          terminou.push('edicao-de-nivel');
          return nivel;
        });
      const edicaoEsperando = await ate('a edição de nível esperando', () =>
        esperandoNoApp('fit057-a-nivel'),
      );
      expect(edicaoEsperando.wait_event).toBe('advisory');
      expect(edicaoEsperando.bloqueadores).toEqual([pid]);

      await turmaB.soltar();
      const r = await pedido;
      await Promise.allSettled([edicao, sonda]);
      console.log(
        `FIT057_AC047 resposta=${r.status} ordem=${terminou.join('>')}`,
      );
      expect(resumoDa(r)).toEqual({
        status: 200,
        code: undefined,
        message: undefined,
      });
      await edicao;
      await sonda;
      expect(terminou).toEqual(['importacao', 'edicao-de-nivel']);
      expect(await mudancas(clube.id, antes, emails)).toEqual({
        usuarios: 2,
        alunos: 2,
        matriculas: 2,
        convites: 0,
        contasDoArquivo: 2,
      });
    } finally {
      await clubeExclusivo.soltar();
      await empresa.soltar();
      await turmaB.soltar();
      await pedido;
      await Promise.allSettled([edicao, sonda]);
    }
  });
});

// ============================================================================
// (b) AC-046 — a importação não serializa o clube
// ============================================================================

describe('SPEC-083/FIT-057 (b) AC-046 — a matrícula dentro e fora do arquivo', () => {
  /**
   * A importação fica presa no `INSERT` de usuários (X segura um e-mail do
   * arquivo, sem `COMMIT`): nesse ponto ela já tem a trava do clube e a turma
   * A. É a importação "segurando as travas" do AC-046, pelo caminho dela
   * mesma, sem gancho que trave por ela.
   */
  async function importacaoPresaNoInsert(
    clube: Clube,
    A: Turma,
    app: string,
    appX: string,
  ) {
    const emailPreso = email('b-preso');
    const x = await erguerBarreira(conexao(appX), contaCom(clube, emailPreso));
    const antes = await contar(clube.id);
    const { pedido, sessao } = importarComSessao(
      app,
      clube,
      planilha([{ email: emailPreso, turma: A.nome }]),
    );
    try {
      const s = await sessao;
      const presa = await ate(
        'a importação esperando X no INSERT de usuários',
        () => esperandoPor(s.pid, x.pid),
      );
      expect(presa.query).toContain('INSERT INTO usuarios');
      return { x, pedido, pid: s.pid, antes, emails: [emailPreso] };
    } catch (e) {
      // Sem isto, X ficaria aberto com a conta inserida, e a limpeza da
      // empresa esperaria por ele até o tempo-limite da transação.
      await x.soltar('rollback');
      await pedido;
      throw e;
    }
  }

  it('numa turma FORA do arquivo, a matrícula conclui sem esperar a importação (INV-083i; a S11 a faz esperar)', async () => {
    const clube = await novoClube();
    const A = await novaTurma(clube);
    const C = await novaTurma(clube);
    const aluno = await criarAluno(db, clube);
    await aquecer('fit057-b2-imp', 'fit057-b2-x', 'fit057-b2-fora');

    const imp = await importacaoPresaNoInsert(
      clube,
      A,
      'fit057-b2-imp',
      'fit057-b2-x',
    );
    try {
      let importacaoRespondeu = false;
      void imp.pedido.then(() => (importacaoRespondeu = true));

      const matricula = resposta(
        rotas(conexao('fit057-b2-fora')).alocar(clube, aluno, C.id),
      );
      // Amostra enquanto a matrícula corre: esperou um lock alguma vez?
      let esperou = false;
      let terminou = false;
      void matricula.then(() => (terminou = true));
      while (!terminou) {
        if (await esperandoNoApp('fit057-b2-fora')) esperou = true;
        await dormir(2);
      }
      const r = await matricula;
      const durante = !importacaoRespondeu;
      console.log(
        `FIT057_AC046_FORA resposta=${r.status} esperou=${esperou} antesDaImportacao=${durante}`,
      );
      expect(resumoDa(r)).toEqual({
        status: 200,
        code: undefined,
        message: undefined,
      });
      expect({ esperou, concluiuComAImportacaoAberta: durante }).toEqual({
        esperou: false,
        concluiuComAImportacaoAberta: true,
      });
      expect(
        await db.turmaAluno.count({
          where: { turmaId: C.id, alunoId: aluno.alunoId },
        }),
      ).toBe(1);

      // A importação desiste no prazo (X não solta), e nada escreve.
      const ri = await imp.pedido;
      expect(resumoDa(ri)).toEqual({
        status: 409,
        code: 'MATRICULA_EM_ANDAMENTO',
        message: I6,
      });
    } finally {
      await imp.x.soltar('rollback');
      await imp.pedido;
    }
    // A matrícula em C é a única mudança em `turma_alunos`.
    expect(await mudancas(clube.id, imp.antes, imp.emails)).toEqual({
      ...NADA,
      matriculas: 1,
    });
  });

  it('numa turma DO arquivo, a matrícula responde 409 com o texto I4 em até 2,3 s, sem 500', async () => {
    const clube = await novoClube();
    const A = await novaTurma(clube);
    const aluno = await criarAluno(db, clube);
    const MAT = 'fit057-b1-dentro';
    await aquecer('fit057-b1-imp', 'fit057-b1-x', 'fit057-b1-aluno', MAT);

    // O prazo da matrícula tem de acabar ANTES do da importação: senão a
    // importação desiste primeiro, solta A, e a matrícula entra. Por isso a
    // matrícula começa antes, e fica esperando a trava do próprio aluno
    // (segura por uma barreira) enquanto a importação trava A.
    const travaDoMeuAluno = await erguerBarreira(
      conexao('fit057-b1-aluno'),
      travaDoAluno(aluno.alunoId),
    );
    const matricula = resposta(rotas(conexao(MAT)).alocar(clube, aluno, A.id));
    const fim = fimDaEspera(observador(), MAT, matricula);
    let imp: Awaited<ReturnType<typeof importacaoPresaNoInsert>> | null = null;
    try {
      const naTravaDoAluno = await ate('a matrícula esperando o aluno', () =>
        esperandoNoApp(MAT),
      );
      expect(naTravaDoAluno.bloqueadores).toEqual([travaDoMeuAluno.pid]);
      const inicio = await inicioDaTransacao(observador(), MAT);
      // Folga entre os dois prazos, para a ordem acima não depender do bcrypt.
      await dormir(300);

      imp = await importacaoPresaNoInsert(
        clube,
        A,
        'fit057-b1-imp',
        'fit057-b1-x',
      );
      await travaDoMeuAluno.soltar();
      const naTurma = await ate('a matrícula esperando a importação em A', () =>
        esperandoPor(naTravaDoAluno.pid, imp!.pid),
      );
      expect(naTurma.bloqueadores).toEqual([imp.pid]);

      const r = await matricula;
      const duracao = (await fim) - inicio;
      console.log(
        `FIT057_AC046_DENTRO resposta=${r.status} ${r.code ?? ''} duracao_ms=${duracao.toFixed(0)}`,
      );
      expect(resumoDa(r)).toEqual({
        status: 409,
        code: 'MATRICULA_EM_ANDAMENTO',
        message: I4,
      });
      expect(duracao).toBeLessThanOrEqual(LIMITE_DE_DESISTENCIA_MS);

      const ri = await imp.pedido;
      expect(resumoDa(ri)).toEqual({
        status: 409,
        code: 'MATRICULA_EM_ANDAMENTO',
        message: I6,
      });
    } finally {
      await travaDoMeuAluno.soltar();
      if (imp) {
        await imp.x.soltar('rollback');
        await imp.pedido;
      }
      await matricula;
    }
    if (!imp) throw new Error('a importação nunca chegou a ficar presa');
    expect(await mudancas(clube.id, imp.antes, imp.emails)).toEqual(NADA);
  });
});

// ============================================================================
// (c) AC-045 e (d) AC-050 — o prazo absoluto, por amostras
// ============================================================================

interface Tentativa {
  n: number;
  resposta: ReturnType<typeof resumoDa>;
  /** A precondição observada antes de soltar X; nula quando cumprida. */
  precondicao: string | null;
  classificacao: Classificacao;
  escritas: Awaited<ReturnType<typeof mudancas>>;
}

function registrar(caso: string, t: Tentativa): void {
  const c = t.classificacao;
  const tempo =
    c.tipo === 'precondicao'
      ? `motivo="${c.motivo}"`
      : `L=${c.L.toFixed(0)} U=${c.U.toFixed(0)}` +
        (c.tipo === 'veredito'
          ? ` assinaturaTardia=${c.assinaturaTardia}`
          : ` motivo="${c.motivo}"`);
  console.log(
    `${caso} tentativa=${t.n} classificacao=${c.tipo === 'veredito' ? c.veredito : c.tipo} ${tempo} maiorVao=${c.maiorVao.toFixed(0)} amostras=${c.amostras} precondicaoAntesDeSoltarX=${t.precondicao ?? 'ok'} resposta=${t.resposta.status} ${t.resposta.code ?? ''}`,
  );
}

/**
 * O roteiro comum aos dois casos: X segura o primeiro recurso e Y o segundo;
 * a importação é disparada; X solta 1,5 s depois do início; Y segura até
 * `soltarY`. O veredito do tempo sai do classificador do AC-056.
 */
async function tentativaComDuasEsperas(opcoes: {
  n: number;
  clube: Clube;
  app: string;
  x: Barreira;
  y: Barreira;
  conteudo: string;
  emails: readonly string[];
  /** A precondição de antes de soltar X, além de "esperando X e não Y". */
  confereAntesDeSoltarX?: (a: Atividade) => string | null;
  desfechoDeX: 'commit' | 'rollback';
  soltarY: (inicio: number, pedido: Promise<Resposta>) => Promise<void>;
}): Promise<Tentativa> {
  const { clube, x, y } = opcoes;
  const antes = await contar(clube.id);
  const { pedido, sessao } = importarComSessao(
    opcoes.app,
    clube,
    opcoes.conteudo,
  );
  let ySolto: Promise<void> = Promise.resolve();
  try {
    const s = await sessao;
    const amostragem = amostrar(s.pid, pedido);
    const inicio = await inicioDe(s);
    ySolto = opcoes.soltarY(inicio, pedido);

    // A precondição é lida ANTES de soltar X: a importação espera X (quem
    // segura o primeiro recurso), e não Y. Falhando, o caso reprova por ela.
    await ateOInstante(observador(), inicio + 1_500);
    const a = await atividadeDoPid(s.pid);
    let precondicao: string | null = null;
    if (
      !a ||
      a.wait_event_type !== 'Lock' ||
      !a.bloqueadores.includes(x.pid) ||
      a.bloqueadores.includes(y.pid)
    ) {
      precondicao = `a importação não esperava X (pid ${x.pid}) a 1,5 s: wait_event_type=${a?.wait_event_type ?? 'nulo'}, bloqueadores=${JSON.stringify(a?.bloqueadores ?? [])}, Y=${y.pid}`;
    } else if (opcoes.confereAntesDeSoltarX) {
      precondicao = opcoes.confereAntesDeSoltarX(a);
    }
    await x.soltar(opcoes.desfechoDeX);

    const r = await pedido;
    const brutas = await amostragem;
    await ySolto;
    return {
      n: opcoes.n,
      resposta: resumoDa(r),
      precondicao,
      classificacao: classificarAmostras(rotular(brutas, inicio, x.pid, y.pid)),
      escritas: await mudancas(clube.id, antes, opcoes.emails),
    };
  } finally {
    await x.soltar(opcoes.desfechoDeX);
    await ySolto.catch(() => undefined);
    await y.soltar('rollback').catch(() => undefined);
    await pedido;
  }
}

/** O veredito de uma tentativa como o log o escreve. */
const vereditoDa = (c: Classificacao) =>
  c.tipo === 'veredito' ? c.veredito : c.tipo;

/** A assinatura tardia de uma tentativa; `-` quando não houve veredito. */
const tardiaDa = (c: Classificacao) =>
  c.tipo === 'veredito' ? String(c.assinaturaTardia) : '-';

/**
 * TASK-005c — **o agregado do caso, numa linha, passe ou falhe.** O
 * `CLI_AUDIT.md` copia as linhas `FIT057_…` de toda execução (AC-045), e o
 * agregado das três tentativas só aparecia na mensagem do `expect`, quando o
 * caso falhava. A ordem de decisão é a do `julgar`: a precondição de antes de
 * soltar X, depois a resposta e o "nada escrito", e só então o tempo.
 */
function agregadoDoCaso(
  caso: string,
  tentativas: readonly Tentativa[],
  respostaEsperada: ReturnType<typeof resumoDa>,
): { resultado: string; linha: string } {
  const classificacoes = tentativas.map((t) => t.classificacao);
  const semPrecondicao = tentativas.find((t) => t.precondicao !== null);
  const respostaErrada = tentativas.find(
    (t) =>
      JSON.stringify(t.resposta) !== JSON.stringify(respostaEsperada) ||
      JSON.stringify(t.escritas) !== JSON.stringify(NADA),
  );
  let resultado: string;
  let motivo: string;
  if (semPrecondicao) {
    resultado = 'reprova';
    motivo = `precondição antes de soltar X na tentativa ${semPrecondicao.n}: ${semPrecondicao.precondicao}`;
  } else if (respostaErrada) {
    resultado = 'reprova';
    motivo = `resposta ou escrita da tentativa ${respostaErrada.n}: ${JSON.stringify({ ...respostaErrada.resposta, escritas: respostaErrada.escritas })}`;
  } else if (classificacoes.length !== TENTATIVAS) {
    resultado = 'falha do harness';
    motivo = `${classificacoes.length} tentativa(s), e não ${TENTATIVAS}`;
  } else {
    const c = concluirCaso(classificacoes);
    resultado =
      c.agregado === 'falha_do_harness' ? 'falha do harness' : c.agregado;
    motivo = c.motivo;
  }
  const linha =
    `FIT057_AGREGADO caso=${caso} vereditos=${classificacoes.map(vereditoDa).join(',')}` +
    ` resultado=${resultado} motivo="${motivo}"` +
    ` assinaturaTardia=${classificacoes.map(tardiaDa).join(',')}`;
  return { resultado, linha };
}

/** As três tentativas já executadas: precondição, resposta, escrita, tempo. */
function julgar(
  caso: string,
  tentativas: readonly Tentativa[],
  respostaEsperada: ReturnType<typeof resumoDa>,
): void {
  // Antes de qualquer `expect`: a linha sai também quando o caso falha.
  console.log(agregadoDoCaso(caso, tentativas, respostaEsperada).linha);
  expect(tentativas).toHaveLength(TENTATIVAS);
  // 1. A precondição antes de soltar X — se falhar, o caso reprova por ela,
  //    e não pelo tempo (a S14 cai aqui).
  expect(tentativas.map((t) => t.precondicao)).toEqual(
    tentativas.map(() => null),
  );
  // 2. A desistência com o código e o texto certos, e nada escrito.
  for (const t of tentativas) {
    expect({ n: t.n, ...t.resposta }).toEqual({ n: t.n, ...respostaEsperada });
    expect({ n: t.n, ...t.escritas }).toEqual({ n: t.n, ...NADA });
  }
  // 3. O tempo: o agregado conservador das três (AC-056). A reprovação diz
  //    se houve assinatura tardia (L − início ≥ 3 s): é ela, e não um
  //    vermelho qualquer, que prova a S10 (AC-045) e a S12 (AC-050).
  const classificacoes = tentativas.map((t) => t.classificacao);
  const conclusao = concluirCaso(classificacoes);
  const tardias = classificacoes.map(tardiaDa);
  const comTardia = tardias.flatMap((t, i) => (t === 'true' ? [i + 1] : []));
  const motivo =
    `${conclusao.motivo}; assinatura tardia: ` +
    (comTardia.length > 0
      ? `SIM, na(s) tentativa(s) ${comTardia.join(', ')}`
      : 'não') +
    ` (${tardias.join(',')})`;
  expect({ agregado: conclusao.agregado, motivo }).toEqual({
    agregado: 'aprova',
    motivo,
  });
}

describe('SPEC-083/FIT-057 (c) AC-045 — o prazo da importação é absoluto nas turmas', () => {
  it('X segura A e Y segura B; X solta a 1,5 s; a importação desiste com 409 I4 — três verdes pelo classificador', async () => {
    const clube = await novoClube();
    await aquecer('fit057-c-imp', 'fit057-c-x', 'fit057-c-y');
    const tentativas: Tentativa[] = [];
    for (let n = 1; n <= TENTATIVAS; n++) {
      const [A, B] = await duasTurmas(clube);
      const emails = [email('c-a'), email('c-b')];
      const x = await erguerBarreira(
        conexao('fit057-c-x'),
        linhaEmForUpdate('turmas', A.id),
      );
      const y = await erguerBarreira(
        conexao('fit057-c-y'),
        linhaEmForUpdate('turmas', B.id),
      );
      const t = await tentativaComDuasEsperas({
        n,
        clube,
        app: 'fit057-c-imp',
        x,
        y,
        conteudo: planilha([
          { email: emails[0], turma: A.nome },
          { email: emails[1], turma: B.nome },
        ]),
        emails,
        desfechoDeX: 'commit',
        // Y segura B por 6 s contados do início.
        soltarY: async (inicio) => {
          await ateOInstante(observador(), inicio + 6_000);
          await y.soltar();
        },
      });
      registrar('FIT057_AC045', t);
      tentativas.push(t);
    }
    julgar('AC045', tentativas, {
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I4,
    });
  });
});

describe('SPEC-083/FIT-057 (d) AC-050 — o prazo absoluto dentro da escrita em lote', () => {
  it('X e Y inserem dois e-mails do arquivo sem COMMIT; X desfaz a 1,5 s; a importação desiste com 409 I6 — três verdes pelo classificador', async () => {
    const clube = await novoClube();
    await aquecer('fit057-d-imp', 'fit057-d-x', 'fit057-d-y');
    const tentativas: Tentativa[] = [];
    for (let n = 1; n <= TENTATIVAS; n++) {
      const emails = [email('d-1'), email('d-2')];
      const x = await erguerBarreira(
        conexao('fit057-d-x'),
        contaCom(clube, emails[0]),
      );
      const y = await erguerBarreira(
        conexao('fit057-d-y'),
        contaCom(clube, emails[1]),
      );
      const t = await tentativaComDuasEsperas({
        n,
        clube,
        app: 'fit057-d-imp',
        x,
        y,
        conteudo: planilha([{ email: emails[0] }, { email: emails[1] }]),
        emails,
        confereAntesDeSoltarX: (a) =>
          a.query.includes('INSERT INTO usuarios')
            ? null
            : `a espera por X não é o INSERT de usuários: ${a.query.slice(0, 120)}`,
        desfechoDeX: 'rollback',
        // Y continua segurando até o caso terminar — a resposta da
        // importação —, e então desfaz: a contagem do "nada escrito" vem
        // depois dela.
        soltarY: async (_inicio, pedido) => {
          await pedido;
          await y.soltar('rollback');
        },
      });
      registrar('FIT057_AC050', t);
      tentativas.push(t);
    }
    julgar('AC050', tentativas, {
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I6,
    });
  });
});

// ============================================================================
// AC-013 — a corrida com cadastro
// ============================================================================

describe('SPEC-083/FIT-057 AC-013 — a corrida: a conferência passa, e a importação responde 422 refeito', () => {
  it('outra conexão ocupa a última vaga da turma: 422 com o erro na linha, e nada escrito pela importação', async () => {
    const clube = await novoClube();
    const A = await novaTurma(clube, 2);
    await matricularDireto(db, A.id, (await criarAluno(db, clube)).alunoId);
    const quemOcupa = await criarAluno(db, clube);
    const IMP = 'fit057-13v-imp';
    await aquecer(IMP, 'fit057-13v-w');

    // A barreira trava A e ocupa a última vaga, sem COMMIT: a conferência da
    // importação (fora de transação) ainda vê uma vaga, e passa.
    const w = await erguerBarreira(conexao('fit057-13v-w'), async (t) => {
      await linhaEmForUpdate('turmas', A.id)(t);
      await t.$executeRawUnsafe(
        `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),$1::uuid,$2::uuid,now())`,
        A.id,
        quemOcupa.alunoId,
      );
    });
    const emails = [email('13v')];
    const antes = await contar(clube.id);
    const { pedido, sessao } = importarComSessao(
      IMP,
      clube,
      planilha([{ email: emails[0], turma: A.nome }]),
    );
    try {
      const s = await sessao;
      const naTurma = await ate('a importação esperando a barreira em A', () =>
        esperandoPor(s.pid, w.pid),
      );
      expect(naTurma.bloqueadores).toEqual([w.pid]);
      await w.soltar('commit');

      const r = await pedido;
      console.log(`FIT057_AC013_VAGA resposta=${r.status} ${r.code ?? ''}`);
      expect(resumoDa(r)).toMatchObject({
        status: 422,
        code: 'PLANILHA_COM_ERROS',
      });
      // A mensagem inteira, e não só linha e coluna: um erro na mesma célula
      // por outro motivo (a turma que "deixou de estar ativa depois da
      // conferência", por exemplo) passaria por `linha` e `coluna`, e não é
      // a corrida da vaga.
      expect(relatorioDo422(r).erros).toEqual([
        {
          linha: 2,
          coluna: 'turma',
          mensagem: `A turma "${A.nome}" já está cheia (capacidade 2).`,
        },
      ]);
    } finally {
      await w.soltar('commit');
      await pedido;
    }
    // A matrícula da barreira é a única mudança.
    expect(await mudancas(clube.id, antes, emails)).toEqual({
      ...NADA,
      matriculas: 1,
    });
  });

  it('outra conexão cria a conta de um e-mail do arquivo: 422 com o erro de e-mail, e nada escrito pela importação', async () => {
    const clube = await novoClube();
    const A = await novaTurma(clube);
    const IMP = 'fit057-13e-imp';
    await aquecer(IMP, 'fit057-13e-w');

    const emails = [email('13e-livre'), email('13e-disputado')];
    const w = await erguerBarreira(
      conexao('fit057-13e-w'),
      contaCom(clube, emails[1]),
    );
    const antes = await contar(clube.id);
    const { pedido, sessao } = importarComSessao(
      IMP,
      clube,
      planilha([
        { email: emails[0], turma: A.nome },
        { email: emails[1], turma: A.nome },
      ]),
    );
    try {
      const s = await sessao;
      const noInsert = await ate(
        'a importação esperando a barreira no INSERT de usuários',
        () => esperandoPor(s.pid, w.pid),
      );
      expect(noInsert.query).toContain('INSERT INTO usuarios');
      await w.soltar('commit');

      const r = await pedido;
      console.log(`FIT057_AC013_EMAIL resposta=${r.status} ${r.code ?? ''}`);
      expect(resumoDa(r)).toMatchObject({
        status: 422,
        code: 'PLANILHA_COM_ERROS',
      });
      expect(relatorioDo422(r).erros).toEqual([
        {
          linha: 3,
          coluna: 'email',
          mensagem: 'Já existe uma conta com este e-mail.',
        },
      ]);
    } finally {
      await w.soltar('commit');
      await pedido;
    }
    // A conta da barreira é a única mudança.
    expect(await mudancas(clube.id, antes, emails)).toEqual({
      ...NADA,
      usuarios: 1,
      contasDoArquivo: 1,
    });
  });
});
