/**
 * SPEC-086/TASK-003 — **o login de várias contas e o `escolher`, pela HTTP real
 * e com banco real.** AC-008 a AC-012 e AC-021.
 *
 * Por que HTTP real e não o serviço com dublê: o que está em julgamento aqui
 * é o que sai pela rota (status, corpo, cookie) e o que fica no banco
 * (`refresh_tokens`, por conta). Um dublê do Prisma provaria o `where` que o
 * código escreveu, não o efeito dele — e S6 (revogar por e-mail) só aparece
 * quando duas contas de verdade dividem o e-mail.
 *
 * **O limite de 10 logins por IP em 15 min (`@LimiteDeLogin`) vale para as
 * duas rotas.** O guard conta pelo `do-connecting-ip` quando ele é um IP
 * válido (DEF-031, `ip-do-visitante.ts`); cada requisição deste arquivo vai
 * com um IP próprio, para o limite nunca ser o que responde.
 *
 * Cada caso monta as próprias empresas e contas (ids aleatórios, e-mails com
 * o prefixo `spec086-w-login-`): nenhum depende do estado deixado por outro, e
 * os casos que inativam empresa não derrubam os vizinhos.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from '../../src/auth/auth.service';
import { createTestApp } from '../utils/create-test-app';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture } from './nivel-da-fixture';

jest.setTimeout(120_000);
exigirBancoLocal();

const SENHA = 'spec-086-w-login-senha';
const OUTRA_SENHA = 'spec-086-w-login-outra';
const LOGO_LEGADA = 'https://cdn.exemplo.local/spec086-w-login-logo.png';

const CREDENCIAIS_INVALIDAS = {
  statusCode: 401,
  message: 'Credenciais inválidas',
  error: 'Unauthorized',
};
const SENHA_TEMPORARIA_EXPIRADA = {
  statusCode: 401,
  code: 'SENHA_TEMPORARIA_EXPIRADA',
  message:
    'Senha temporária expirada. Peça ao administrador da sua empresa uma nova.',
};
const ESCOLHA_EXPIRADA = {
  statusCode: 401,
  code: 'ESCOLHA_EXPIRADA',
  message: 'A escolha de empresa expirou. Entre de novo.',
};
const MENSAGEM_ESCOLHA =
  'Este e-mail tem acesso a mais de uma empresa. Entre pelo app do aluno para escolher.';

const db = new PrismaClient();
/** Quem lê `pg_stat_activity`, fora das transações em julgamento (AC-021). */
const observador = new PrismaClient();
/** O cliente envolvido pelo `Proxy` que pausa a transação real (AC-021). */
const pausavelReal = new PrismaClient();
const q = (sql: string, ...v: unknown[]) => db.$executeRawUnsafe(sql, ...v);
const jwt = new JwtService();

let app: INestApplication<App>;
/** O mesmo `AppModule`, com o `PrismaService` pausável (AC-021). */
let appPausavel: INestApplication<App>;
let segredoDoAccess: string;
let segredoDaEscolha: string;

/**
 * Os refresh vivos do banco INTEIRO — e não só das contas deste arquivo: o
 * defeito do logout revogava os de todo mundo, e é isso que a conta pega.
 */
async function vivosNoBanco(): Promise<number> {
  const [r] = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM refresh_tokens WHERE revoked_at IS NULL`,
  );
  return r.n;
}
const empresasCriadas: string[] = [];

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let sequencia = 0;
function emailNovo(rotulo: string): string {
  sequencia += 1;
  return `spec086-w-login-${rotulo}-${sequencia}@teste.local`;
}

async function empresa(
  opcoes: { status?: 'ativa' | 'inativa'; logoUrl?: string } = {},
): Promise<string> {
  const id = randomUUID();
  empresasCriadas.push(id);
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,status,logo_url,updated_at)
       VALUES ('${id}','SPEC-086 login ${id.slice(0, 8)}','spec086-w-login-${id}',
               '${opcoes.status ?? 'ativa'}',${opcoes.logoUrl ? `'${opcoes.logoUrl}'` : 'NULL'},now())`,
    ),
  );
  return (await db.empresa.findUniqueOrThrow({ where: { id } })).id;
}

type Situacao = 'valida' | 'vencida' | 'temporaria' | 'inativa';

/**
 * Uma conta de aluno. `vencida`: senha temporária vencida há um dia;
 * `temporaria`: senha temporária que ainda vale um dia; `inativa`: conta com
 * `status = 'inativo'`.
 */
async function conta(
  companyId: string,
  email: string,
  situacao: Situacao = 'valida',
  senha = SENHA,
): Promise<string> {
  const id = randomUUID();
  const hash = await bcrypt.hash(senha, 4);
  const temporaria = situacao === 'vencida' || situacao === 'temporaria';
  const expira =
    situacao === 'vencida'
      ? "now() - interval '1 day'"
      : situacao === 'temporaria'
        ? "now() + interval '1 day'"
        : 'NULL';
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,telefone,role,company_id,status,
                           senha_temporaria,senha_temporaria_expira_em,updated_at)
     VALUES ($1::uuid,$2,$3,'Aluno 086 login','11999990000','aluno',$4::uuid,
             '${situacao === 'inativa' ? 'inativo' : 'ativo'}',${temporaria},${expira},now())`,
    id,
    email,
    hash,
    companyId,
  );
  return id;
}

/** Refresh tokens vivos já existentes de uma conta (a sessão de antes). */
async function sessoesVivas(usuarioId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await q(
      `INSERT INTO refresh_tokens (id,usuario_id,token_hash,expires_at)
       VALUES (gen_random_uuid(),$1::uuid,$2,now() + interval '1 day')`,
      usuarioId,
      `spec086-w-login-${randomUUID()}`,
    );
  }
}

async function refreshVivos(usuarioId: string): Promise<number> {
  const [r] = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM refresh_tokens
      WHERE usuario_id = $1::uuid AND revoked_at IS NULL`,
    usuarioId,
  );
  return r.n;
}

async function refreshTotal(usuarioId: string): Promise<number> {
  const [r] = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM refresh_tokens WHERE usuario_id = $1::uuid`,
    usuarioId,
  );
  return r.n;
}

async function refreshPorJti(jti: string) {
  return db.refreshToken.findUnique({ where: { id: jti } });
}

async function impressaoAtual(usuarioId: string): Promise<string> {
  const u = await db.usuario.findUniqueOrThrow({ where: { id: usuarioId } });
  return createHash('sha256').update(u.senhaHash, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Um IP de visitante novo por requisição: o limite por IP fica fora. */
let ipSeq = 0;
function ipNovo(): string {
  ipSeq += 1;
  return `10.86.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

/** `.then` dispara a requisição já: o `supertest` é preguiçoso. */
function login(
  email: string,
  senha = SENHA,
  alvo: INestApplication<App> = app,
): Promise<Response> {
  return request(alvo.getHttpServer())
    .post('/api/v1/auth/login')
    .set('do-connecting-ip', ipNovo())
    .send({ email, senha })
    .then((r) => r);
}

function escolher(
  token: string,
  usuarioId: string,
  alvo: INestApplication<App> = app,
): Promise<Response> {
  return request(alvo.getHttpServer())
    .post('/api/v1/auth/login/escolher')
    .set('do-connecting-ip', ipNovo())
    .send({ token, usuarioId })
    .then((r) => r);
}

function trocarSenha(
  accessToken: string,
  senhaAtual: string,
  novaSenha: string,
  alvo: INestApplication<App> = app,
): Promise<Response> {
  return request(alvo.getHttpServer())
    .post('/api/v1/auth/trocar-senha')
    .set('Authorization', `Bearer ${accessToken}`)
    .set('do-connecting-ip', ipNovo())
    .send({ senhaAtual, novaSenha })
    .then((r) => r);
}

interface OpcaoDoCorpo {
  usuarioId: string;
  empresaNome: string;
  logoUrl: string | null;
  papel: string;
  situacao: 'disponivel' | 'senha_expirada';
}
interface CorpoDaEscolha {
  statusCode: number;
  code: string;
  message: string;
  escolha: { token: string; empresas: OpcaoDoCorpo[] };
}
interface ConteudoDoToken {
  typ: string;
  contas: { id: string; impressao: string }[];
  iat: number;
  exp: number;
}

function cookies(res: Response): string[] {
  return ([] as string[]).concat(res.headers['set-cookie'] ?? []);
}

/**
 * O `jti` do refresh que a resposta gravou no cookie. A troca de senha só
 * devolve o refresh por cookie (o corpo traz só o `accessToken`).
 */
function jtiDoCookie(res: Response): string {
  const c = cookies(res).find((x) => x.startsWith('refresh_token='));
  expect(c).toBeDefined();
  const valor = c!.slice('refresh_token='.length).split(';')[0];
  return jwt.decode<{ jti: string }>(valor).jti;
}

/** Login que TEM de dar `409`: devolve o corpo e o token decodificado. */
async function loginComEscolha(email: string, senha = SENHA) {
  const res = await login(email, senha);
  expect(res.status).toBe(409);
  const corpo = res.body as CorpoDaEscolha;
  const token = jwt.decode<ConteudoDoToken>(corpo.escolha.token);
  return { res, corpo, token };
}

const porId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// AC-021 — o cliente que pausa a transação REAL num ponto marcado
// ---------------------------------------------------------------------------

type PontoDePausa =
  /** `escolher`: logo depois do `SELECT … FROM usuarios … FOR UPDATE`. */
  | 'depois-da-leitura-da-conta'
  /** troca de senha: logo depois do `UPDATE` da conta, antes de revogar. */
  | 'depois-do-update-da-conta';

interface Pausa {
  ponto: PontoDePausa;
  chegou: (pid: number) => void;
  solta: Promise<void>;
}
let pausaArmada: Pausa | null = null;

type ClienteDaTx = {
  $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
  usuario: { update: (args: unknown) => Promise<unknown> };
};

async function talvezPausar(tx: ClienteDaTx, ponto: PontoDePausa) {
  const p = pausaArmada;
  if (!p || p.ponto !== ponto) return;
  pausaArmada = null; // uma vez só
  const [{ pid }] =
    (await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`) as {
      pid: number;
    }[];
  p.chegou(pid);
  await p.solta;
}

/** Liga métodos ao alvo: o cliente do Prisma não aceita `this` emprestado. */
function ler(alvo: object, prop: string | symbol): unknown {
  const v: unknown = Reflect.get(alvo, prop);
  return typeof v === 'function' && prop !== 'constructor'
    ? (v as (...a: unknown[]) => unknown).bind(alvo)
    : v;
}

function envolverTx(tx: ClienteDaTx): ClienteDaTx {
  return new Proxy(tx, {
    get(alvo, prop) {
      if (prop === '$queryRaw') {
        return async (s: TemplateStringsArray, ...v: unknown[]) => {
          const r = await alvo.$queryRaw(s, ...v);
          // O ponto é a leitura da conta, com ou sem `FOR UPDATE`: assim a
          // sabotagem S20 (tirar o `FOR UPDATE`) ainda passa por aqui, e o
          // teste fica vermelho pelo motivo certo — a troca NÃO bloqueia.
          if (/FROM\s+usuarios\s+WHERE\s+id/i.test(s.join('?'))) {
            await talvezPausar(alvo, 'depois-da-leitura-da-conta');
          }
          return r;
        };
      }
      if (prop === 'usuario') {
        const delegado = alvo.usuario;
        return new Proxy(delegado, {
          get(d, p2) {
            if (p2 === 'update') {
              return async (args: unknown) => {
                const r = await d.update(args);
                await talvezPausar(alvo, 'depois-do-update-da-conta');
                return r;
              };
            }
            return ler(d, p2);
          },
        });
      }
      return ler(alvo, prop);
    },
  });
}

/**
 * O `PrismaService` do `appPausavel`: o mesmo `PrismaClient` real, com a
 * `$transaction` interativa envolvida. O único ajuste além da pausa é o
 * `timeout` da transação (15 s, contra os 5 s padrão): a pausa é do teste, e
 * a transação não pode morrer enquanto o teste observa o bloqueio.
 */
const prismaPausavel = new Proxy(pausavelReal, {
  get(alvo, prop) {
    if (prop === '$transaction') {
      return (arg: unknown, opcoes?: Record<string, unknown>) =>
        typeof arg === 'function'
          ? alvo.$transaction(
              (tx) =>
                (arg as (t: unknown) => Promise<unknown>)(
                  envolverTx(tx as unknown as ClienteDaTx),
                ),
              { ...opcoes, maxWait: 15_000, timeout: 15_000 },
            )
          : alvo.$transaction(arg as never);
    }
    return ler(alvo, prop);
  },
});

function armarPausa(ponto: PontoDePausa) {
  let chegou!: (pid: number) => void;
  const pidDaPausa = new Promise<number>((r) => (chegou = r));
  let soltar!: () => void;
  const solta = new Promise<void>((r) => (soltar = r));
  pausaArmada = { ponto, chegou, solta };
  return { pidDaPausa, soltar };
}

/** Espera uma promessa por `ms`; `null` se não chegou. */
async function ate<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: NodeJS.Timeout | undefined;
  const r = await Promise.race([
    p,
    new Promise<null>((res) => (t = setTimeout(() => res(null), ms))),
  ]);
  clearTimeout(t);
  return r;
}

/**
 * Procura, em `pg_stat_activity`, uma sessão **esperando trava**
 * (`wait_event_type = 'Lock'`) cuja instrução casa com `padrao` e que é
 * bloqueada por `pidDono`. Observado, não suposto (DOR-086-R3-04).
 */
async function observarBloqueio(
  pidDono: number,
  padrao: string,
  ms = 8_000,
): Promise<{ pid: number; query: string } | null> {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    const linhas = await observador.$queryRawUnsafe<
      { pid: number; query: string }[]
    >(
      `SELECT a.pid, a.query
         FROM pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.wait_event_type = 'Lock'
          AND a.query ILIKE $1
          AND $2::int = ANY (pg_blocking_pids(a.pid))`,
      padrao,
      pidDono,
    );
    if (linhas.length > 0) return linhas[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  app = await createTestApp(db);
  appPausavel = await createTestApp(prismaPausavel);
  // O token vencido é assinado com o MESMO segredo que o app usa — lido do
  // `ConfigService` dele, e não de um valor copiado para cá.
  segredoDoAccess = app
    .get(ConfigService)
    .getOrThrow<string>('JWT_ACCESS_SECRET');
  // O token de escolha é assinado com um segredo DERIVADO do de sessão
  // (`AuthService.segredoDaEscolha`): é o que o impede de valer como access
  // token no logout, na strategy e no limite de upload.
  segredoDaEscolha = `${segredoDoAccess}:escolha-de-empresa`;
});

afterAll(async () => {
  pausaArmada = null;
  await app?.close();
  await appPausavel?.close();
  for (const id of empresasCriadas) {
    await limparEmpresa(db, id);
  }
  await Promise.all([
    db.$disconnect(),
    observador.$disconnect(),
    pausavelReal.$disconnect(),
  ]);
});

// ---------------------------------------------------------------------------
// AC-008 — as cinco linhas da tabela
// ---------------------------------------------------------------------------

describe('SPEC-086/AC-008 — as cinco linhas da tabela do login', () => {
  it('0 válidas, 0 vencidas (só inativas e outra senha): 401 genérico, sem cookie', async () => {
    const email = emailNovo('l1');
    const e1 = await empresa();
    const e2 = await empresa({ status: 'inativa' });
    const e3 = await empresa();
    await conta(e1, email, 'inativa');
    await conta(e2, email, 'valida'); // empresa inativa
    await conta(e3, email, 'valida', OUTRA_SENHA);

    const res = await login(email);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(CREDENCIAIS_INVALIDAS);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('0 válidas, ≥ 1 vencida: 401 SENHA_TEMPORARIA_EXPIRADA', async () => {
    const email = emailNovo('l2');
    const a = await conta(await empresa(), email, 'vencida');
    const b = await conta(await empresa(), email, 'vencida');
    await conta(await empresa(), email, 'inativa');

    const res = await login(email);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(SENHA_TEMPORARIA_EXPIRADA);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await refreshTotal(a)).toBe(0);
    expect(await refreshTotal(b)).toBe(0);
  });

  it('1 válida, 0 vencidas (com outra senha e inativa ao lado): 200 da válida, igual a hoje', async () => {
    const email = emailNovo('l3');
    const e1 = await empresa();
    const valida = await conta(e1, email, 'valida');
    const outra = await conta(await empresa(), email, 'valida', OUTRA_SENHA);
    const inativa = await conta(await empresa(), email, 'inativa');

    const res = await login(email);
    expect(res.status).toBe(200);
    const corpo = res.body as {
      accessToken: string;
      refreshToken: string;
      usuario: Record<string, unknown>;
    };
    expect(corpo.usuario).toEqual({
      id: valida,
      email,
      nome: 'Aluno 086 login',
      role: 'aluno',
      companyId: e1,
      senhaTemporaria: false,
    });
    expect(
      jwt.decode<Record<string, unknown>>(corpo.accessToken),
    ).toMatchObject({ sub: valida, companyId: e1 });
    expect(cookies(res)).toHaveLength(1);
    expect(cookies(res)[0].startsWith('refresh_token=')).toBe(true);
    expect(await refreshVivos(valida)).toBe(1);
    expect(await refreshTotal(outra)).toBe(0);
    expect(await refreshTotal(inativa)).toBe(0);
  });

  it('1 válida + 1 vencida: 409 com as duas, situação certa, e o token SÓ com a válida', async () => {
    const email = emailNovo('l4');
    const eValida = await empresa({ logoUrl: LOGO_LEGADA });
    const eVencida = await empresa();
    const valida = await conta(eValida, email, 'valida');
    const vencida = await conta(eVencida, email, 'vencida');

    const { res, corpo, token } = await loginComEscolha(email);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(Object.keys(corpo).sort()).toEqual(
      ['code', 'escolha', 'message', 'statusCode'].sort(),
    );
    expect(corpo.statusCode).toBe(409);
    expect(corpo.code).toBe('ESCOLHA_DE_EMPRESA');
    expect(corpo.message).toBe(MENSAGEM_ESCOLHA);
    expect(Object.keys(corpo.escolha).sort()).toEqual(['empresas', 'token']);

    const nomeDe = async (id: string) =>
      (await db.empresa.findUniqueOrThrow({ where: { id } })).nome;
    expect(corpo.escolha.empresas).toEqual([
      {
        usuarioId: valida,
        empresaNome: await nomeDe(eValida),
        logoUrl: LOGO_LEGADA,
        papel: 'aluno',
        situacao: 'disponivel',
      },
      {
        usuarioId: vencida,
        empresaNome: await nomeDe(eVencida),
        logoUrl: null,
        papel: 'aluno',
        situacao: 'senha_expirada',
      },
    ]);

    // O token: `typ` certo, 5 minutos, sem `sub`, e só a válida — a vencida
    // aparece na tela (I6), mas não pode ser escolhida.
    expect(token.typ).toBe('escolha-de-empresa');
    expect(token.exp - token.iat).toBe(300);
    expect(token).not.toHaveProperty('sub');
    expect(token.contas).toEqual([
      { id: valida, impressao: await impressaoAtual(valida) },
    ]);
    expect(await refreshTotal(valida)).toBe(0);
  });

  it('≥ 2 válidas (+ 1 vencida): 409 com as válidas por id, depois a vencida; token com as válidas', async () => {
    const email = emailNovo('l5');
    const v1 = await conta(await empresa(), email, 'valida');
    const v2 = await conta(await empresa(), email, 'temporaria');
    const venc = await conta(await empresa(), email, 'vencida');

    const { res, corpo, token } = await loginComEscolha(email);
    expect(res.headers['set-cookie']).toBeUndefined();
    const validasPorId = [v1, v2].sort(porId);
    expect(
      corpo.escolha.empresas.map((e) => [e.usuarioId, e.situacao]),
    ).toEqual([
      [validasPorId[0], 'disponivel'],
      [validasPorId[1], 'disponivel'],
      [venc, 'senha_expirada'],
    ]);
    expect(token.contas.map((c) => c.id)).toEqual(validasPorId);
  });

  it('≥ 2 válidas e nenhuma vencida: 409 também', async () => {
    const email = emailNovo('l5b');
    const v1 = await conta(await empresa(), email, 'valida');
    const v2 = await conta(await empresa(), email, 'valida');
    const { corpo, token } = await loginComEscolha(email);
    expect(corpo.escolha.empresas.map((e) => e.situacao)).toEqual([
      'disponivel',
      'disponivel',
    ]);
    expect(token.contas.map((c) => c.id)).toEqual([v1, v2].sort(porId));
  });
});

// ---------------------------------------------------------------------------
// AC-009 — revogação por conta (S6, S7)
// ---------------------------------------------------------------------------

describe('SPEC-086/AC-009 — a vencida perde os refresh; a válida não', () => {
  /**
   * S6 (revogar por e-mail) mata os refresh de B em todos os casos abaixo.
   * S7 (revogar só sem válida) deixa os de A vivos no `200` e no `409`.
   */
  it('A vencida, B válida: 409; A revogada, B intocada', async () => {
    const email = emailNovo('r1');
    const a = await conta(await empresa(), email, 'vencida');
    const b = await conta(await empresa(), email, 'valida');
    await sessoesVivas(a, 2);
    await sessoesVivas(b, 2);

    // Com uma vencida aberta ao lado, uma válida dá `409` (a tabela não tem
    // `200` com vencida). A revogação vale "em qualquer resultado": aqui, o
    // `409`; o `401` está no caso de baixo.
    const { corpo } = await loginComEscolha(email);
    expect(corpo.escolha.empresas.map((e) => e.usuarioId)).toEqual([b, a]);
    expect(await refreshVivos(a)).toBe(0);
    expect(await refreshTotal(a)).toBe(2);
    expect(await refreshVivos(b)).toBe(2);
    expect(await refreshTotal(b)).toBe(2);
  });

  it('A vencida, B e C válidas: 409; só A revogada', async () => {
    const email = emailNovo('r2');
    const a = await conta(await empresa(), email, 'vencida');
    const b = await conta(await empresa(), email, 'valida');
    const c = await conta(await empresa(), email, 'valida');
    for (const id of [a, b, c]) await sessoesVivas(id, 2);

    await loginComEscolha(email);
    expect(await refreshVivos(a)).toBe(0);
    expect(await refreshVivos(b)).toBe(2);
    expect(await refreshVivos(c)).toBe(2);
  });

  it('A vencida, B com outra senha: 401 SENHA_TEMPORARIA_EXPIRADA; só A revogada', async () => {
    const email = emailNovo('r3');
    const a = await conta(await empresa(), email, 'vencida');
    const b = await conta(await empresa(), email, 'valida', OUTRA_SENHA);
    await sessoesVivas(a, 2);
    await sessoesVivas(b, 2);

    const res = await login(email);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(SENHA_TEMPORARIA_EXPIRADA);
    expect(await refreshVivos(a)).toBe(0);
    expect(await refreshVivos(b)).toBe(2);
  });

  it('A vencida e B válida, mas com a senha de B: 200 de B; A NÃO é aberta, e nada dela é revogado', async () => {
    // "Toda vencida ABERTA": a senha digitada não abre A, então A não é
    // tocada — revogar aqui seria deixar quem tem a senha de B derrubar a
    // sessão de outra conta.
    const email = emailNovo('r4');
    const a = await conta(await empresa(), email, 'vencida', OUTRA_SENHA);
    const b = await conta(await empresa(), email, 'valida');
    await sessoesVivas(a, 2);
    await sessoesVivas(b, 2);

    const res = await login(email);
    expect(res.status).toBe(200);
    expect((res.body as { usuario: { id: string } }).usuario.id).toBe(b);
    expect(await refreshVivos(a)).toBe(2);
    expect(await refreshVivos(b)).toBe(3);
  });

  it('senha errada para todas: 401 genérico, e nenhuma revogação', async () => {
    const email = emailNovo('r5');
    const a = await conta(await empresa(), email, 'vencida');
    const b = await conta(await empresa(), email, 'valida');
    await sessoesVivas(a, 1);
    await sessoesVivas(b, 1);

    const res = await login(email, 'nenhuma-das-duas');
    expect(res.status).toBe(401);
    expect(res.body).toEqual(CREDENCIAIS_INVALIDAS);
    expect(await refreshVivos(a)).toBe(1);
    expect(await refreshVivos(b)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-010 — o que o 409 não revela, e o que ele não grava
// ---------------------------------------------------------------------------

describe('SPEC-086/AC-010 — o 409 não revela nem grava', () => {
  it('sem conta de outra senha, inativa ou de empresa inativa; sem refresh e sem cookie', async () => {
    const email = emailNovo('n1');
    const v1 = await conta(await empresa(), email, 'valida');
    const v2 = await conta(await empresa(), email, 'valida');
    const outraSenha = await conta(
      await empresa(),
      email,
      'valida',
      OUTRA_SENHA,
    );
    const inativa = await conta(await empresa(), email, 'inativa');
    const daInativa = await conta(
      await empresa({ status: 'inativa' }),
      email,
      'valida',
    );
    // Vencida de empresa inativa e vencida inativa: também não aparecem
    // (a ordem é inativa → vencida → válida).
    const vencidaDeInativa = await conta(
      await empresa({ status: 'inativa' }),
      email,
      'vencida',
    );

    const { res, corpo, token } = await loginComEscolha(email);
    const listados = corpo.escolha.empresas.map((e) => e.usuarioId);
    expect(listados).toEqual([v1, v2].sort(porId));
    for (const escondida of [
      outraSenha,
      inativa,
      daInativa,
      vencidaDeInativa,
    ]) {
      expect(listados).not.toContain(escondida);
      expect(token.contas.map((c) => c.id)).not.toContain(escondida);
      expect(JSON.stringify(res.body)).not.toContain(escondida);
    }
    expect(res.headers['set-cookie']).toBeUndefined();
    for (const id of [v1, v2, outraSenha, inativa, daInativa]) {
      expect(await refreshTotal(id)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-011 — escolher válido
// ---------------------------------------------------------------------------

describe('SPEC-086/AC-011 — escolher devolve a sessão da conta escolhida', () => {
  it('claims com o companyId dela, cookie, linha em refresh_tokens; temporária não vencida → senhaTemporaria true', async () => {
    const email = emailNovo('e1');
    const eA = await empresa({ logoUrl: LOGO_LEGADA });
    const eB = await empresa();
    const a = await conta(eA, email, 'temporaria');
    const b = await conta(eB, email, 'valida');

    const { corpo } = await loginComEscolha(email);
    const opA = corpo.escolha.empresas.find((e) => e.usuarioId === a);
    const opB = corpo.escolha.empresas.find((e) => e.usuarioId === b);
    // A logo legada (`logo_url`, sem `logo_key`) é a que aparece.
    expect(opA?.logoUrl).toBe(LOGO_LEGADA);
    expect(opB?.logoUrl).toBeNull();

    for (const [id, companyId, temporaria] of [
      [a, eA, true],
      [b, eB, false],
    ] as const) {
      const antes = await refreshTotal(id);
      const res = await escolher(corpo.escolha.token, id);
      expect(res.status).toBe(200);
      const sessao = res.body as {
        accessToken: string;
        refreshToken: string;
        usuario: Record<string, unknown>;
      };
      expect(Object.keys(sessao).sort()).toEqual(
        ['accessToken', 'refreshToken', 'usuario'].sort(),
      );
      expect(sessao.usuario).toEqual({
        id,
        email,
        nome: 'Aluno 086 login',
        role: 'aluno',
        companyId,
        senhaTemporaria: temporaria,
      });
      const claims = jwt.decode<Record<string, unknown>>(sessao.accessToken);
      expect(Object.keys(claims).sort()).toEqual(
        ['companyId', 'email', 'exp', 'iat', 'nome', 'role', 'sub'].sort(),
      );
      expect(claims).toMatchObject({ sub: id, companyId, role: 'aluno' });

      const c = cookies(res);
      expect(c).toHaveLength(1);
      expect(c[0].startsWith(`refresh_token=${sessao.refreshToken};`)).toBe(
        true,
      );
      expect(c[0]).toMatch(/; Path=\/api\/v1\/auth(;|$)/);
      expect(c[0]).toMatch(/; HttpOnly(;|$)/);
      expect(c[0]).toMatch(/; SameSite=Strict(;|$)/);

      const { jti } = jwt.decode<{ jti: string }>(sessao.refreshToken);
      const linha = await refreshPorJti(jti);
      expect(linha?.usuarioId).toBe(id);
      expect(linha?.revokedAt).toBeNull();
      expect(await refreshTotal(id)).toBe(antes + 1);

      // A sessão é de verdade: abre uma rota autenticada.
      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${sessao.accessToken}`);
      expect(me.status).toBe(200);
      expect((me.body as { id: string }).id).toBe(id);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-012 — escolher recusa
// ---------------------------------------------------------------------------

describe('SPEC-086/AC-012 — escolher recusa', () => {
  /** Duas válidas do mesmo e-mail, e o 409 do login. */
  async function duasValidas(rotulo: string, situacaoDeA: Situacao = 'valida') {
    const email = emailNovo(rotulo);
    const eA = await empresa();
    const eB = await empresa();
    const a = await conta(eA, email, situacaoDeA);
    const b = await conta(eB, email, 'valida');
    const { corpo, token } = await loginComEscolha(email);
    return { email, eA, eB, a, b, token: corpo.escolha.token, conteudo: token };
  }

  async function recusa(
    token: string,
    usuarioId: string,
    esperado: object = ESCOLHA_EXPIRADA,
  ) {
    const antes = await refreshTotal(usuarioId);
    const res = await escolher(token, usuarioId);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(esperado);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await refreshTotal(usuarioId)).toBe(antes);
  }

  it('token vencido (as mesmas contas e impressões, assinado com o segredo do app, exp no passado)', async () => {
    const { a, conteudo } = await duasValidas('x1');
    const agora = Math.floor(Date.now() / 1000);
    const vencido = jwt.sign(
      {
        typ: 'escolha-de-empresa',
        contas: conteudo.contas,
        iat: agora - 600,
        exp: agora - 10,
      },
      { secret: segredoDaEscolha },
    );
    await recusa(vencido, a);

    // Controle: o MESMO conteúdo, ainda no prazo, é aceito — o que recusou
    // acima foi o vencimento, e não outra coisa no token.
    const vivo = jwt.sign(
      { typ: 'escolha-de-empresa', contas: conteudo.contas },
      { secret: segredoDaEscolha, expiresIn: 60 },
    );
    expect((await escolher(vivo, a)).status).toBe(200);

    // E o MESMO conteúdo assinado com o segredo de SESSÃO é recusado: o token
    // de escolha não é intercambiável com o access token, nos dois sentidos.
    const comSegredoDeSessao = jwt.sign(
      { typ: 'escolha-de-empresa', contas: conteudo.contas },
      { secret: segredoDoAccess, expiresIn: 60 },
    );
    await recusa(comSegredoDeSessao, a);
  });

  it('token adulterado (conteúdo trocado, assinatura velha) e assinado com outro segredo', async () => {
    const { a, b, token, conteudo } = await duasValidas('x2');
    const intrusa = await conta(await empresa(), emailNovo('x2-intrusa'));
    const [cab, , ass] = token.split('.');
    const conteudoForjado = Buffer.from(
      JSON.stringify({
        ...conteudo,
        contas: [
          ...conteudo.contas,
          { id: intrusa, impressao: await impressaoAtual(intrusa) },
        ],
      }),
    ).toString('base64url');
    await recusa(`${cab}.${conteudoForjado}.${ass}`, intrusa);
    await recusa(`${cab}.${conteudoForjado}.${ass}`, a);

    const outroSegredo = jwt.sign(
      { typ: 'escolha-de-empresa', contas: conteudo.contas },
      { secret: 'nao-e-o-segredo-do-app', expiresIn: 60 },
    );
    await recusa(outroSegredo, b);
  });

  it('access token de sessão no lugar do token de escolha', async () => {
    const { a, token } = await duasValidas('x3');
    const sessao = await escolher(token, a);
    expect(sessao.status).toBe(200);
    const accessToken = (sessao.body as { accessToken: string }).accessToken;
    await recusa(accessToken, a);

    // E um token com `typ` certo mas sem `contas` (forma errada).
    const semContas = jwt.sign(
      { typ: 'escolha-de-empresa' },
      { secret: segredoDaEscolha, expiresIn: 60 },
    );
    await recusa(semContas, a);
  });

  it('usuarioId fora da lista: um id qualquer, e uma conta do MESMO e-mail com outra senha', async () => {
    const { email, token } = await duasValidas('x4');
    const outraSenha = await conta(
      await empresa(),
      email,
      'valida',
      OUTRA_SENHA,
    );
    await recusa(token, outraSenha);
    await recusa(token, randomUUID());
  });

  it('usuarioId de uma vencida que está na lista do 409', async () => {
    const email = emailNovo('x5');
    const valida = await conta(await empresa(), email, 'valida');
    const vencida = await conta(await empresa(), email, 'vencida');
    const { corpo } = await loginComEscolha(email);
    expect(corpo.escolha.empresas.map((e) => e.usuarioId)).toContain(vencida);
    await recusa(corpo.escolha.token, vencida);
    expect((await escolher(corpo.escolha.token, valida)).status).toBe(200);
  });

  it('senha trocada definitiva → definitiva (pela rota trocar-senha) entre o login e a escolha', async () => {
    // S9 (invalidar só por `senhaTemporaria`) passa aqui: a conta não era
    // temporária antes nem depois. Só a impressão do hash pega.
    const { email, a, b, token } = await duasValidas('x6');
    const tokenDaVez2 = (await loginComEscolha(email)).corpo.escolha.token;

    const sessao = await escolher(token, a);
    expect(sessao.status).toBe(200);
    const troca = await trocarSenha(
      (sessao.body as { accessToken: string }).accessToken,
      SENHA,
      'spec-086-w-login-definitiva-nova',
    );
    expect(troca.status).toBe(200);
    const depois = await db.usuario.findUniqueOrThrow({ where: { id: a } });
    expect(depois.senhaTemporaria).toBe(false);

    await recusa(tokenDaVez2, a);
    // A outra conta do e-mail não mudou de senha: o mesmo token a abre.
    expect((await escolher(tokenDaVez2, b)).status).toBe(200);
  });

  it('senha resetada (nova temporária ainda válida, pelo serviço real) entre o login e a escolha', async () => {
    const { a, token } = await duasValidas('x7');
    await app.get(AuthService).gerarSenhaTemporariaParaUsuario({
      usuarioId: a,
      contaInativa: 'rejeitar',
    });
    const depois = await db.usuario.findUniqueOrThrow({ where: { id: a } });
    expect(depois.senhaTemporaria).toBe(true);
    expect(depois.senhaTemporariaExpiraEm!.getTime()).toBeGreaterThan(
      Date.now(),
    );
    await recusa(token, a);
  });

  it('conta inativada entre os passos: 401 genérico', async () => {
    const { a, token } = await duasValidas('x8');
    await q(`UPDATE usuarios SET status = 'inativo' WHERE id = $1::uuid`, a);
    await recusa(token, a, CREDENCIAIS_INVALIDAS);
  });

  it('empresa inativada entre os passos: 401 genérico', async () => {
    const { a, eA, token } = await duasValidas('x9');
    await q(`UPDATE empresas SET status = 'inativa' WHERE id = $1::uuid`, eA);
    await recusa(token, a, CREDENCIAIS_INVALIDAS);
  });

  it('senha temporária que venceu entre os passos: 401 SENHA_TEMPORARIA_EXPIRADA, revogando (e a revogação comita)', async () => {
    const { a, b, token } = await duasValidas('x10', 'temporaria');
    await q(
      `UPDATE usuarios SET senha_temporaria_expira_em = now() - interval '1 minute' WHERE id = $1::uuid`,
      a,
    );
    await sessoesVivas(a, 2);
    await sessoesVivas(b, 1);
    expect(await refreshVivos(a)).toBe(2);

    await recusa(token, a, SENHA_TEMPORARIA_EXPIRADA);
    expect(await refreshVivos(a)).toBe(0);
    expect(await refreshVivos(b)).toBe(1);
  });

  it('o token de escolha é recusado em GET /auth/me (S10)', async () => {
    const { token, conteudo } = await duasValidas('x11');
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);

    // A segunda linha: mesmo assinado com o segredo de SESSÃO, um payload com
    // `typ` é recusado pela strategy (INV-086b).
    const comSegredoDeSessao = jwt.sign(
      { typ: 'escolha-de-empresa', contas: conteudo.contas },
      { secret: segredoDoAccess, expiresIn: 60 },
    );
    const res2 = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${comSegredoDeSessao}`);
    expect(res2.status).toBe(401);
  });

  /**
   * Regressão do achado da validação da implementação (revisão adversarial,
   * 2026-10-08): o `POST /auth/logout`, público, revogava os refresh de
   * `payload.sub` do Bearer — e um token SEM `sub` virava `where` vazio, que
   * revogava as sessões de TODO MUNDO.
   */
  it('logout com o token de escolha no Bearer não revoga a sessão de ninguém', async () => {
    const { token } = await duasValidas('x12');
    const outra = await conta(await empresa(), emailNovo('x12-outra'));
    await q(
      `INSERT INTO refresh_tokens (id,usuario_id,token_hash,expires_at)
       VALUES (gen_random_uuid(),'${outra}','x',now() + interval '1 day')`,
    );
    const vivosAntes = await vivosNoBanco();
    expect(vivosAntes).toBeGreaterThan(0);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(await vivosNoBanco()).toBe(vivosAntes);
  });

  it('logout com um payload SEM `sub` assinado com o segredo de sessão também não revoga nada (segunda linha)', async () => {
    const outra = await conta(await empresa(), emailNovo('x13-outra'));
    await q(
      `INSERT INTO refresh_tokens (id,usuario_id,token_hash,expires_at)
       VALUES (gen_random_uuid(),'${outra}','x',now() + interval '1 day')`,
    );
    const vivosAntes = await vivosNoBanco();

    for (const payload of [
      { typ: 'escolha-de-empresa', contas: [] },
      { qualquer: 'coisa' },
    ]) {
      const semSub = jwt.sign(payload, {
        secret: segredoDoAccess,
        expiresIn: 60,
      });
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${semSub}`);
      expect(res.status).toBe(204);
    }
    expect(await vivosNoBanco()).toBe(vivosAntes);
  });
});

// ---------------------------------------------------------------------------
// AC-021 — escolher × troca de senha, sobrepostos
// ---------------------------------------------------------------------------

describe('SPEC-086/AC-021 — escolher × troca de senha sobrepostos, com o bloqueio observado', () => {
  /**
   * Uma conta com outra do mesmo e-mail (para o login dar 409), uma sessão
   * prévia dela (o access token que a troca de senha exige) e um token de
   * escolha emitido DEPOIS dessa sessão — impressão da senha atual.
   */
  async function cenario(rotulo: string) {
    const email = emailNovo(rotulo);
    const a = await conta(await empresa(), email, 'valida');
    await conta(await empresa(), email, 'valida');
    const primeiro = await loginComEscolha(email);
    const sessao = await escolher(primeiro.corpo.escolha.token, a);
    expect(sessao.status).toBe(200);
    const accessDeA = (sessao.body as { accessToken: string }).accessToken;
    const token = (await loginComEscolha(email)).corpo.escolha.token;
    return { a, accessDeA, token };
  }

  it('(a) o escolher já tem o FOR UPDATE e está pausado; a troca bloqueia; o refresh do escolher termina REVOGADO (S20, S22)', async () => {
    const { a, accessDeA, token } = await cenario('c1');
    const { pidDaPausa, soltar } = armarPausa('depois-da-leitura-da-conta');

    const escolhaHttp = escolher(token, a, appPausavel);
    let pid: number | null = null;
    let bloqueio: { pid: number; query: string } | null = null;
    let trocaHttp: Promise<Response> | null = null;
    try {
      pid = await ate(pidDaPausa, 10_000);
      expect(pid).not.toBeNull(); // o escolher chegou ao ponto marcado
      trocaHttp = trocarSenha(accessDeA, SENHA, 'spec-086-w-login-c1-nova');
      // A troca, na transação dela, faz o UPDATE da conta: tem de esperar a
      // trava que o escolher segura.
      bloqueio = await observarBloqueio(pid!, 'UPDATE "public"."usuarios"%');
    } finally {
      soltar();
    }
    const escolha = await escolhaHttp;
    const troca = await trocaHttp;

    expect(bloqueio).not.toBeNull();
    expect(escolha.status).toBe(200);
    expect(troca.status).toBe(200);

    const { jti } = jwt.decode<{ jti: string }>(
      (escolha.body as { refreshToken: string }).refreshToken,
    );
    const doEscolher = await refreshPorJti(jti);
    expect(doEscolher?.usuarioId).toBe(a);
    expect(doEscolher?.revokedAt).not.toBeNull();

    // À parte: a sessão que a própria troca devolve é legítima e fica viva.
    const jtiDaTroca = jtiDoCookie(troca);
    expect((await refreshPorJti(jtiDaTroca))?.revokedAt).toBeNull();
    expect(await refreshVivos(a)).toBe(1);
  });

  it('(b) a troca já fez o UPDATE e está pausada antes do COMMIT; o escolher bloqueia; 401 ESCOLHA_EXPIRADA e nenhum refresh dele', async () => {
    const { a, accessDeA, token } = await cenario('c2');
    const { pidDaPausa, soltar } = armarPausa('depois-do-update-da-conta');

    // A troca vai pelo app pausável: é ela que para no ponto marcado.
    const trocaHttp = trocarSenha(
      accessDeA,
      SENHA,
      'spec-086-w-login-c2-nova',
      appPausavel,
    );
    let bloqueio: { pid: number; query: string } | null = null;
    let escolhaHttp: Promise<Response> | null = null;
    let totalAntes = 0;
    try {
      const pid = await ate(pidDaPausa, 15_000);
      expect(pid).not.toBeNull();
      totalAntes = await refreshTotal(a);
      escolhaHttp = escolher(token, a);
      bloqueio = await observarBloqueio(pid!, '%FROM usuarios WHERE id%');
    } finally {
      soltar();
    }
    const troca = await trocaHttp;
    const escolha = await escolhaHttp;

    expect(bloqueio).not.toBeNull();
    expect(troca.status).toBe(200);
    expect(escolha.status).toBe(401);
    expect(escolha.body).toEqual(ESCOLHA_EXPIRADA);
    expect(escolha.headers['set-cookie']).toBeUndefined();

    // Nenhum refresh emitido pelo escolher: o único que nasceu depois do
    // "antes" é o da própria troca, conferido à parte.
    const jtiDaTroca = jtiDoCookie(troca);
    expect(await refreshTotal(a)).toBe(totalAntes + 1);
    expect((await refreshPorJti(jtiDaTroca))?.revokedAt).toBeNull();
    expect(await refreshVivos(a)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-011 — o PROFESSOR escolhido (IMP-086-R1-02)
// ---------------------------------------------------------------------------

/**
 * Uma conta de PROFESSOR, com a ficha em `professores` ligada a ela — o
 * caminho que o sistema cria quando o gestor dá acesso ao professor
 * (SPEC-013/INV-014).
 */
async function contaDeProfessor(
  companyId: string,
  email: string,
): Promise<string> {
  const id = randomUUID();
  const hash = await bcrypt.hash(SENHA, 4);
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,telefone,role,company_id,status,
                           senha_temporaria,senha_temporaria_expira_em,updated_at)
     VALUES ($1::uuid,$2,$3,'Professor 086 login','11999990001','professor',$4::uuid,
             'ativo',false,NULL,now())`,
    id,
    email,
    hash,
    companyId,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,email,status,usuario_id)
     VALUES (gen_random_uuid(),$1::uuid,'Professor 086 login',$2,'ativo',$3::uuid)`,
    companyId,
    email,
    id,
  );
  return id;
}

describe('SPEC-086/AC-011 — escolher o PROFESSOR devolve a sessão dele, na empresa dele', () => {
  // Achado IMP-086-R1-02: o AC-011 só provava contas de aluno. Um emissor que
  // zerasse o companyId do professor, ou que pusesse o da OUTRA conta da
  // lista, passava. Por isso duas empresas DISTINTAS, e cada camada da
  // sessão conferida em separado.
  it('aluno em A e professor em B, mesma senha: 409 → escolher o professor → 200 com companyId B em corpo, JWT, refresh e /me', async () => {
    const email = emailNovo('prof');
    const eA = await empresa();
    const eB = await empresa();
    expect(eA).not.toBe(eB);
    const aluno = await conta(eA, email, 'valida');
    const prof = await contaDeProfessor(eB, email);

    const { corpo, token } = await loginComEscolha(email);
    expect(token.contas.map((c) => c.id).sort(porId)).toEqual(
      [aluno, prof].sort(porId),
    );
    const opProf = corpo.escolha.empresas.find((e) => e.usuarioId === prof);
    expect(opProf?.situacao).toBe('disponivel');

    const antes = await refreshTotal(prof);
    const antesDoAluno = await refreshTotal(aluno);
    const res = await escolher(corpo.escolha.token, prof);
    expect(res.status).toBe(200);
    const sessao = res.body as {
      accessToken: string;
      refreshToken: string;
      usuario: Record<string, unknown>;
    };

    // 1. Corpo.
    expect(sessao.usuario).toEqual({
      id: prof,
      email,
      nome: 'Professor 086 login',
      role: 'professor',
      companyId: eB,
      senhaTemporaria: false,
    });

    // 2. JWT decodificado — é ele que as rotas da empresa leem.
    const claims = jwt.verify<Record<string, unknown>>(sessao.accessToken, {
      secret: segredoDoAccess,
    });
    expect(claims.sub).toBe(prof);
    expect(claims.role).toBe('professor');
    expect(claims.companyId).toBe(eB);
    expect(claims.companyId).not.toBe(eA);

    // 3. Cookie.
    const c = cookies(res);
    expect(c).toHaveLength(1);
    expect(c[0].startsWith(`refresh_token=${sessao.refreshToken};`)).toBe(true);
    expect(c[0]).toMatch(/; HttpOnly(;|$)/);

    // 4. Linha em refresh_tokens, do professor e só dele.
    const { jti } = jwt.decode<{ jti: string }>(sessao.refreshToken);
    const linha = await refreshPorJti(jti);
    expect(linha?.usuarioId).toBe(prof);
    expect(linha?.revokedAt).toBeNull();
    expect(await refreshTotal(prof)).toBe(antes + 1);
    expect(await refreshTotal(aluno)).toBe(antesDoAluno);

    // 5. O uso efetivo da sessão.
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${sessao.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      id: prof,
      role: 'professor',
      companyId: eB,
    });
  });
});

describe('SPEC-086/AC-012 — senha mudada entre o login e a escolha, para PROFESSOR e para ALUNO', () => {
  /**
   * Achado IMP-086-R2-01: os casos de senha mudada só usavam aluno, e um
   * `escolher` que dispensasse a impressão SÓ para professor passava. Aqui o
   * mesmo token anterior é usado depois de cada mudança, para os dois papéis,
   * e se confere o código (`ESCOLHA_EXPIRADA`) E o estado persistido: nenhum
   * refresh novo da conta — uma recusa tardia, depois de gravar a sessão,
   * também fica vermelha.
   *
   * - `definitiva`: senha definitiva → outra definitiva;
   * - `reset`: o gestor gera uma senha temporária nova (ainda válida);
   * - `ativacao`: a conta tinha senha temporária e a pessoa definiu a sua
   *   (o que a ativação da SPEC-083 e o primeiro acesso fazem com o hash).
   */
  type Mudanca = 'definitiva' | 'reset' | 'ativacao';
  const CASOS: ['aluno' | 'professor', Mudanca][] = [];
  for (const papel of ['aluno', 'professor'] as const) {
    for (const m of ['definitiva', 'reset', 'ativacao'] as const) {
      CASOS.push([papel, m]);
    }
  }

  it.each(CASOS)(
    '%s, %s: o token anterior não abre sessão',
    async (papel, mudanca) => {
      const email = emailNovo(`mudou-${papel}-${mudanca}`);
      const eA = await empresa();
      const eB = await empresa();
      const outra = await conta(eA, email, 'valida');
      const alvo =
        papel === 'professor'
          ? await contaDeProfessor(eB, email)
          : await conta(eB, email, 'valida');
      if (mudanca === 'ativacao') {
        // Começa com senha temporária ainda válida (a mesma senha do login).
        await q(
          `UPDATE usuarios SET senha_temporaria = true,
                senha_temporaria_expira_em = now() + interval '1 day'
          WHERE id = $1::uuid`,
          alvo,
        );
      }

      const { corpo } = await loginComEscolha(email);
      expect(
        corpo.escolha.empresas.map((e) => e.usuarioId).sort(porId),
      ).toEqual([outra, alvo].sort(porId));

      const novoHash = await bcrypt.hash(`outra-senha-${mudanca}-123`, 4);
      const temporaria = mudanca === 'reset';
      await q(
        `UPDATE usuarios SET senha_hash = $2,
              senha_temporaria = ${temporaria},
              senha_temporaria_expira_em = ${temporaria ? "now() + interval '1 day'" : 'NULL'}
        WHERE id = $1::uuid`,
        alvo,
        novoHash,
      );

      const antes = await refreshTotal(alvo);
      const res = await escolher(corpo.escolha.token, alvo);
      expect({ status: res.status, corpo: res.body as unknown }).toEqual({
        status: 401,
        corpo: ESCOLHA_EXPIRADA,
      });
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await refreshTotal(alvo)).toBe(antes);

      // Controle: a OUTRA conta da lista, cuja senha não mudou, continua
      // abrindo — o que recusou acima foi a mudança, e não o token.
      expect((await escolher(corpo.escolha.token, outra)).status).toBe(200);
    },
  );
});
