/**
 * SPEC-082 — **o que as provas de banco da matrícula concorrente têm em
 * comum**: o clube de fixtura, os serviços e controllers de verdade sobre um
 * cliente com `application_name` próprio, as travas de teste e a leitura de
 * `pg_stat_activity`.
 *
 * **A resposta é a do CONTROLLER**, não a do serviço: a tradução de `55P03`,
 * `P2028` e `P2024` em 409/503 mora na borda HTTP (D4), e uma prova que
 * chamasse o serviço direto veria o erro do banco — e ficaria verde com a
 * tradução arrancada.
 *
 * **"Espera" é vista em `pg_stat_activity`** (`wait_event_type = 'Lock'`),
 * nunca inferida por tempo. **E o prazo é medido no relógio do servidor**: o
 * início da transação é o `xact_start` da conexão do caminho, e o fim é um
 * `clock_timestamp()` pedido logo que a resposta chega.
 */
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { limparEmpresa } from './limpar-empresa';
import { ClassesService } from '../../src/classes/classes.service';
import { ClassesController } from '../../src/classes/classes.controller';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import { MeClassesController } from '../../src/classes/me-classes.controller';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { ChaveDeLock } from '../../src/common/lock/chave-de-lock';
import type { AccessTokenPayload } from '../../src/common/types/jwt-payload.type';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { FilaDeEsperaService } from '../../src/fila-de-espera/fila-de-espera.service';
import { MeFilaDeEsperaController } from '../../src/fila-de-espera/me-fila-de-espera.controller';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import { LevelsService } from '../../src/people/levels.service';
import { StudentsService } from '../../src/people/students.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

export const BASE = process.env.DATABASE_URL as string;

export const comOpcao = (opcao: string) =>
  `${BASE}${BASE.includes('?') ? '&' : '?'}options=${encodeURIComponent(opcao)}`;

/** A URL de um caminho, com nome próprio em `pg_stat_activity`. */
export const urlDoCaminho = (app: string) =>
  comOpcao(`-c application_name=${app}`);

export const dormir = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Clientes
// --------------------------------------------------------------------------

const clientes: PrismaClient[] = [];

export function cliente(url: string): PrismaClient {
  const c = new PrismaClient({ datasources: { db: { url } } });
  clientes.push(c);
  return c;
}

export async function desconectarTodos(): Promise<void> {
  for (const c of clientes.splice(0)) await c.$disconnect();
}

// --------------------------------------------------------------------------
// O clube de fixtura
// --------------------------------------------------------------------------

export interface Clube {
  id: string;
  quadra: string;
  nivel: string;
  gestores: string[];
}

export interface AlunoDaFixtura {
  alunoId: string;
  usuarioId: string;
}

const q = (db: PrismaClient, sql: string) => db.$executeRawUnsafe(sql);

export async function montarClube(
  db: PrismaClient,
  opcoes: { limite?: number | null; gestores?: number } = {},
): Promise<Clube> {
  const id = randomUUID();
  const quadra = randomUUID();
  const nivel = randomUUID();
  const limite = opcoes.limite ?? null;
  await q(
    db,
    `INSERT INTO empresas (id,nome,slug,updated_at,limite_turmas_por_aluno)
     VALUES ('${id}','SPEC-082 ${id.slice(0, 8)}','spec-082-${id}',now(),${limite === null ? 'NULL' : limite})`,
  );
  await q(
    db,
    `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${nivel}','${id}','Intermediário',1)`,
  );
  await q(
    db,
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${id}','Tenis',0,now())`,
  );
  await q(
    db,
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${quadra}','${id}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${id}' LIMIT 1),80,'ativa')`,
  );
  const gestores: string[] = [];
  for (let i = 0; i < (opcoes.gestores ?? 1); i++) {
    const g = randomUUID();
    await q(
      db,
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${g}','g-${g}@spec082.local','h','Gestor ${i + 1}','company_admin','${id}',now())`,
    );
    gestores.push(g);
  }
  return { id, quadra, nivel, gestores };
}

export async function criarTurma(
  db: PrismaClient,
  clube: Clube,
  capacidade = 8,
): Promise<string> {
  const turma = randomUUID();
  await q(
    db,
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ('${turma}','${clube.id}','Turma ${turma.slice(0, 6)}','${clube.quadra}',${capacidade},'ativa','${clube.nivel}')`,
  );
  return turma;
}

export async function criarAluno(
  db: PrismaClient,
  clube: Clube,
): Promise<AlunoDaFixtura> {
  const usuarioId = randomUUID();
  const alunoId = randomUUID();
  await q(
    db,
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','a-${usuarioId}@spec082.local','h','Aluno ${usuarioId.slice(0, 4)}','aluno','${clube.id}',now())`,
  );
  await q(
    db,
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status,nivel_id) VALUES ('${alunoId}','${usuarioId}','${clube.id}','aprovado','ativo','${clube.nivel}')`,
  );
  return { alunoId, usuarioId };
}

/** Matrícula direta, para encher turma (não é o caminho em julgamento). */
export async function matricularDireto(
  db: PrismaClient,
  turmaId: string,
  alunoId: string,
): Promise<void> {
  await q(
    db,
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${alunoId}',now())`,
  );
}

/** Uma linha da fila de TURMA em `chamado`, com a vez aberta. */
export async function linhaChamada(
  db: PrismaClient,
  clube: Clube,
  alunoId: string,
  turmaId: string,
): Promise<string> {
  const linha = randomUUID();
  await q(
    db,
    `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,estado,chamado_em,chamado_ate)
     VALUES ('${linha}','${clube.id}','${alunoId}','${turmaId}','chamado',now(),now() + interval '6 hours')`,
  );
  return linha;
}

export async function limparClube(db: PrismaClient, clube: Clube | null) {
  if (clube) await limparEmpresa(db, clube.id);
}

export const matriculasDaTurma = (db: PrismaClient, turmaId: string) =>
  db.turmaAluno.count({ where: { turmaId } });

export const turmasDoAluno = (db: PrismaClient, alunoId: string) =>
  db.turmaAluno.count({ where: { alunoId } });

// --------------------------------------------------------------------------
// Serviços e controllers de verdade
// --------------------------------------------------------------------------

export function servicos(c: PrismaClient) {
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
  const turmas = new ClassesService(
    p,
    courts,
    new StudentsService(p),
    operacao,
  );
  const fila = new FilaDeEsperaService(
    p,
    operacao,
    matricula,
    new ReposicaoService(p, operacao),
  );
  const nada = {} as never;
  return {
    matricula,
    turmas,
    fila,
    alunos: new StudentsService(p),
    niveis: new LevelsService(p),
    rotas: {
      meClasses: new MeClassesController(nada, matricula, nada, nada),
      classes: new ClassesController(turmas, nada, nada, nada),
      fila: new MeFilaDeEsperaController(fila),
    },
  };
}

function usuario(companyId: string, sub: string, role: string) {
  return {
    sub,
    email: 'x@spec082.local',
    nome: 'x',
    role,
    companyId,
  } as unknown as AccessTokenPayload;
}

/** As três rotas leitoras, pelo controller (com a tradução da D4). */
export function rotas(c: PrismaClient) {
  const s = servicos(c);
  return {
    entrar: (clube: Clube, a: AlunoDaFixtura, turmaId: string) =>
      s.rotas.meClasses.entrar(
        usuario(clube.id, a.usuarioId, 'aluno'),
        turmaId,
      ),
    alocar: (clube: Clube, a: AlunoDaFixtura, turmaId: string) =>
      s.rotas.classes.allocateStudent(
        usuario(clube.id, clube.gestores[0], 'company_admin'),
        turmaId,
        a.alunoId,
      ),
    confirmar: (clube: Clube, a: AlunoDaFixtura, linha: string) =>
      s.rotas.fila.confirmar(usuario(clube.id, a.usuarioId, 'aluno'), linha),
    servicos: s,
  };
}

export interface Resposta {
  /** 200 = sucesso (o HTTP é 200 ou 201); 500 = erro não traduzido. */
  status: number;
  code?: string;
  message?: string;
  corpo?: unknown;
  erro?: unknown;
}

export async function resposta(p: Promise<unknown>): Promise<Resposta> {
  try {
    return { status: 200, corpo: await p };
  } catch (erro) {
    if (erro instanceof HttpException) {
      const r = erro.getResponse() as
        string | { code?: string; message?: string };
      return {
        status: erro.getStatus(),
        code: typeof r === 'string' ? undefined : r.code,
        message: typeof r === 'string' ? r : r.message,
        erro,
      };
    }
    return { status: 500, erro };
  }
}

// --------------------------------------------------------------------------
// Travas de teste
// --------------------------------------------------------------------------

export const chaveDoClube = (companyId: string) =>
  ChaveDeLock.deTexto(`nivel-da-empresa:${companyId}`);

export const chaveDoAluno = (alunoId: string) =>
  ChaveDeLock.deTexto(`matricula-do-aluno:${alunoId}`);

/**
 * Uma transação do teste que faz `passos` e segura tudo o que eles travaram
 * até `soltar()`. `soltar(true)` comita o que ela escreveu; o padrão também
 * comita (a transação de teste só trava, a não ser quando escreve de
 * propósito — AC-013).
 */
export async function segurar(
  db: PrismaClient,
  passos: (t: Prisma.TransactionClient) => Promise<unknown>,
): Promise<() => Promise<void>> {
  let soltar!: () => void;
  const liberado = new Promise<void>((r) => (soltar = r));
  let pronto!: () => void;
  let falhou!: (e: unknown) => void;
  const travado = new Promise<void>((r, j) => {
    pronto = r;
    falhou = j;
  });
  const tx = db
    .$transaction(
      async (t) => {
        await passos(t);
        pronto();
        await liberado;
      },
      { timeout: 300_000, maxWait: 20_000 },
    )
    .catch((e: unknown) => falhou(e));
  await travado;
  return async () => {
    soltar();
    await tx;
  };
}

/**
 * Como `segurar`, e devolve também o `pid` da conexão que segura — para o
 * teste afirmar em `pg_locks` QUEM a matrícula está esperando (AC-015(a), v9).
 */
export async function segurarComPid(
  db: PrismaClient,
  passos: (t: Prisma.TransactionClient) => Promise<unknown>,
): Promise<{ soltar: () => Promise<void>; pid: number }> {
  let pid = 0;
  const soltar = await segurar(db, async (t) => {
    const r = await t.$queryRaw<
      { pid: number }[]
    >`SELECT pg_backend_pid() AS pid`;
    pid = r[0].pid;
    await passos(t);
  });
  return { soltar, pid };
}

/** Os `pid`s que bloqueiam a conexão do caminho que está esperando lock. */
export async function bloqueadoresDe(
  db: PrismaClient,
  app: string,
): Promise<number[]> {
  const r = await db.$queryRawUnsafe<{ b: number[] | null }[]>(
    `SELECT pg_blocking_pids(pid) AS b FROM pg_stat_activity
      WHERE application_name = '${app}' AND wait_event_type = 'Lock'`,
  );
  return r.flatMap((l) => l.b ?? []);
}

export const travaDoClube =
  (companyId: string, modo: 'compartilhada' | 'exclusiva') =>
  (t: Prisma.TransactionClient) =>
    modo === 'compartilhada'
      ? t.$executeRaw`SELECT pg_advisory_xact_lock_shared(${chaveDoClube(companyId)}::bigint)`
      : t.$executeRaw`SELECT pg_advisory_xact_lock(${chaveDoClube(companyId)}::bigint)`;

export const travaDoAluno =
  (alunoId: string) => (t: Prisma.TransactionClient) =>
    t.$executeRaw`SELECT pg_advisory_xact_lock(${chaveDoAluno(alunoId)}::bigint)`;

/** Uma linha em `FOR UPDATE` (a tabela e o id vêm do teste, nunca do usuário). */
export const linhaEmForUpdate =
  (tabela: string, id: string) => (t: Prisma.TransactionClient) =>
    t.$queryRawUnsafe(`SELECT id FROM ${tabela} WHERE id = '${id}' FOR UPDATE`);

// --------------------------------------------------------------------------
// pg_stat_activity e o relógio do servidor
// --------------------------------------------------------------------------

async function esperandoAgora(
  db: PrismaClient,
  app: string,
  evento?: string,
): Promise<boolean> {
  const r = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM pg_stat_activity
      WHERE application_name = '${app}' AND wait_event_type = 'Lock'
        ${evento ? `AND wait_event = '${evento}'` : ''}`,
  );
  return Number(r[0].n) > 0;
}

/** O handshake: VER a conexão do caminho esperando um lock. Nunca `sleep`. */
export async function vistoEsperando(
  db: PrismaClient,
  app: string,
  evento?: string,
  limiteMs = 20_000,
): Promise<void> {
  const limite = Date.now() + limiteMs;
  while (Date.now() < limite) {
    if (await esperandoAgora(db, app, evento)) return;
    await dormir(10);
  }
  throw new Error(
    `handshake: ${app} nunca foi visto esperando (${evento ?? 'Lock'})`,
  );
}

/** Amostra `pg_stat_activity` enquanto `enquanto` não termina: esperou alguma vez? */
export async function esperouEnquanto(
  db: PrismaClient,
  app: string,
  enquanto: Promise<unknown>,
): Promise<boolean> {
  let fim = false;
  void enquanto.then(
    () => (fim = true),
    () => (fim = true),
  );
  let viu = false;
  while (!fim) {
    if (await esperandoAgora(db, app)) viu = true;
    await dormir(5);
  }
  return viu;
}

/**
 * **Quando a espera do caminho TERMINOU**, no relógio do servidor: amostra
 * `pg_stat_activity` enquanto o pedido corre, e devolve a primeira amostra sem
 * espera depois da última com espera. Medir no cliente somaria o tempo de
 * montar o erro do Prisma (a primeira vez, >100 ms) — que não é espera.
 */
export async function fimDaEspera(
  db: PrismaClient,
  app: string,
  enquanto: Promise<unknown>,
): Promise<number> {
  let fim = false;
  void enquanto.then(
    () => (fim = true),
    () => (fim = true),
  );
  let ultimaComEspera = -1;
  let primeiraSemEsperaDepois = -1;
  while (!fim) {
    const r = await db.$queryRawUnsafe<{ n: bigint; ms: number }[]>(
      `SELECT count(*) FILTER (WHERE wait_event_type = 'Lock') AS n,
              (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms
         FROM pg_stat_activity WHERE application_name = '${app}'`,
    );
    if (Number(r[0].n) > 0) {
      ultimaComEspera = r[0].ms;
      primeiraSemEsperaDepois = -1;
    } else if (ultimaComEspera >= 0 && primeiraSemEsperaDepois < 0) {
      primeiraSemEsperaDepois = r[0].ms;
    }
    await dormir(2);
  }
  if (primeiraSemEsperaDepois < 0) return agoraNoServidor(db);
  return primeiraSemEsperaDepois;
}

/** O `xact_start` (relógio do servidor) da transação aberta do caminho. */
export async function inicioDaTransacao(
  db: PrismaClient,
  app: string,
  limiteMs = 20_000,
): Promise<number> {
  const limite = Date.now() + limiteMs;
  while (Date.now() < limite) {
    const r = await db.$queryRawUnsafe<{ ms: number }[]>(
      `SELECT (extract(epoch FROM xact_start) * 1000)::float8 AS ms
         FROM pg_stat_activity
        WHERE application_name = '${app}' AND xact_start IS NOT NULL
          AND state <> 'idle'
        ORDER BY xact_start DESC LIMIT 1`,
    );
    if (r[0]) return r[0].ms;
    await dormir(5);
  }
  throw new Error(`${app} nunca abriu transação`);
}

export async function agoraNoServidor(db: PrismaClient): Promise<number> {
  const r = await db.$queryRawUnsafe<{ ms: number }[]>(
    `SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`,
  );
  return r[0].ms;
}

/**
 * Quando `alvoNoServidorMs` chega, pelo relógio do servidor — convertido em
 * espera local pela diferença medida agora (Back e banco na mesma máquina).
 */
export async function ateOInstante(
  db: PrismaClient,
  alvoNoServidorMs: number,
): Promise<void> {
  const agora = await agoraNoServidor(db);
  await dormir(Math.max(0, alvoNoServidorMs - agora));
}

/** O texto exato das mensagens da spec (tabela de decisões). */
export const I4 =
  'Outra pessoa está entrando nesta turma agora. Tente de novo em alguns segundos.';
export const I5 =
  'O sistema está com muita procura agora. Tente de novo em alguns segundos.';
export const I6 =
  'Já existe uma alteração em andamento na sua matrícula ou no clube. Tente de novo em alguns segundos.';

export const PRAZO_MS = 2_000;
export const TOLERANCIA_MS = 50;
