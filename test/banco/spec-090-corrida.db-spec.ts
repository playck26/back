/**
 * SPEC-090/TASK-002 — **AC-018: as corridas do link de redefinição, contra o
 * Postgres real**, em duas conexões (dois apps, cada um com a sua pool)
 * sincronizadas por barreira: um participante pausa a transação REAL num
 * ponto marcado, e o outro só é dado como "esperando" quando o
 * `pg_stat_activity` mostra a sessão dele em `wait_event_type = 'Lock'`,
 * bloqueada pelo `pid` de quem pausou — observado, não suposto.
 *
 * A técnica é a do AC-021 da SPEC-086 (`spec-086-login.db-spec.ts`): o
 * `PrismaService` do app pausável é o mesmo `PrismaClient` real com a
 * `$transaction` interativa envolvida por um `Proxy`, que pausa depois da
 * instrução marcada. Nada do serviço é trocado.
 *
 * | Caso | Quem pausa, e onde | Quem espera, e em quê | Sabotagem |
 * |---|---|---|---|
 * | (a) mesmo link, mesma conta | link 1, depois do passo 2 | link 2, no `FOR UPDATE` | — (a S8 não é pega aqui: o perdedor sai pela impressão, DOR-090-R2-02) |
 * | (b) mesmo link, contas diferentes | link A, depois do passo 4 | link B, no `UPDATE` do pedido | S8 |
 * | (c) dois pedidos, mesma conta | link P1, depois do passo 2 | link P2, no `FOR UPDATE` | S7 |
 * | (d) troca primeiro | a troca, depois do `UPDATE` de `usuarios` | o link, **no `FOR UPDATE` do passo 2** | S16 |
 * | (d') link primeiro | o link, depois do passo 5 | a troca, no `UPDATE` dela | — (registro, sem valor de proteção) |
 */
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { RedefinicaoService } from '../../src/acesso/redefinicao.service';
import type { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import { PROVEDOR_DE_EMAIL } from '../../src/email/provedor-de-email';
import { garantirAmbienteDeFit } from '../fit/app-real';
import { createTestApp } from '../utils/create-test-app';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture } from './nivel-da-fixture';

jest.setTimeout(120_000);
exigirBancoLocal();

process.env.EMAIL_PROVEDOR = 'memoria';

const PREFIXO = 'spec090-corrida';
const SENHA = 'spec-090-corrida-senha';

const REDEFINICAO_INVALIDA = {
  statusCode: 410,
  code: 'LINK_INVALIDO',
  message: 'Este link não vale mais. Peça outro em "Esqueceu a senha?".',
};

const db = new PrismaClient();
/** Quem lê `pg_stat_activity`, fora das transações em julgamento. */
const observador = new PrismaClient();
/** O cliente envolvido pelo `Proxy` que pausa a transação real. */
const pausavelReal = new PrismaClient();
const q = (sql: string, ...v: unknown[]) => db.$executeRawUnsafe(sql, ...v);
const ler = <T>(sql: string, ...v: unknown[]) =>
  db.$queryRawUnsafe<T[]>(sql, ...v);
const jwt = new JwtService();

let app: INestApplication<App>;
let appPausavel: INestApplication<App>;
let memoria: MemoriaProvedorDeEmail;
let espiaoDoPedido: jest.SpyInstance;
let segredoDoAccess: string;
const empresasCriadas: string[] = [];

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let seq = 0;
function emailNovo(rotulo: string): string {
  seq += 1;
  return `${PREFIXO}-${rotulo}-${seq}@teste.local`;
}

async function empresa(): Promise<string> {
  const id = randomUUID();
  empresasCriadas.push(id);
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,status,updated_at)
       VALUES ('${id}','SPEC-090 corrida ${id}','${PREFIXO}-${id}','ativa',now())`,
    ),
  );
  return id;
}

async function conta(companyId: string, email: string): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,status,updated_at)
     VALUES ($1::uuid,$2,$3,'Pessoa corrida 090','aluno',$4::uuid,'ativo',now())`,
    id,
    email,
    await bcrypt.hash(SENHA, 4),
    companyId,
  );
  return id;
}

async function senhaHashDe(usuarioId: string): Promise<string> {
  return (await db.usuario.findUniqueOrThrow({ where: { id: usuarioId } }))
    .senhaHash;
}

async function usadoEm(token: string): Promise<Date | null> {
  const [linha] = await ler<{ usado_em: Date | null }>(
    `SELECT usado_em FROM pedidos_de_redefinicao WHERE token_hash = $1`,
    sha256(token),
  );
  return linha.usado_em;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let ipSeq = 0;
function ipNovo(): string {
  ipSeq += 1;
  return `10.91.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

/** Pede o link pelo app comum, espera o pedido e devolve o token enviado. */
async function linkPara(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/esqueci-senha')
    .set('do-connecting-ip', ipNovo())
    .send({ email });
  expect(res.status).toBe(202);
  await Promise.allSettled(
    espiaoDoPedido.mock.results.map((r) => r.value as Promise<void>),
  );
  const mensagem = [...memoria.enviados].reverse().find((m) => m.to === email);
  const achado = /\/redefinir-senha\/([A-Za-z0-9_-]{43})/.exec(
    mensagem?.text ?? '',
  );
  expect(achado).not.toBeNull();
  return achado![1];
}

/** `.then` dispara a requisição já: o `supertest` é preguiçoso. */
function redefinir(
  token: string,
  usuarioId: string,
  senha: string,
  alvo: INestApplication<App> = app,
): Promise<Response> {
  return request(alvo.getHttpServer())
    .post('/api/v1/public/redefinicao')
    .set('do-connecting-ip', ipNovo())
    .send({ token, usuarioId, senha })
    .then((r) => r);
}

function trocarSenha(
  usuario: { id: string; email: string; companyId: string },
  senhaAtual: string,
  novaSenha: string,
  alvo: INestApplication<App> = app,
): Promise<Response> {
  const access = jwt.sign(
    {
      sub: usuario.id,
      email: usuario.email,
      nome: 'Pessoa corrida 090',
      role: 'aluno',
      companyId: usuario.companyId,
    },
    { secret: segredoDoAccess, expiresIn: '10m' },
  );
  return request(alvo.getHttpServer())
    .post('/api/v1/auth/trocar-senha')
    .set('Authorization', `Bearer ${access}`)
    .set('do-connecting-ip', ipNovo())
    .send({ senhaAtual, novaSenha })
    .then((r) => r);
}

function login(email: string, senha: string): Promise<Response> {
  return request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('do-connecting-ip', ipNovo())
    .send({ email, senha })
    .then((r) => r);
}

// ---------------------------------------------------------------------------
// O cliente que pausa a transação REAL num ponto marcado
// ---------------------------------------------------------------------------

type PontoDePausa =
  /** O link: logo depois da leitura do dono (passo 2), com ou sem trava. */
  | 'depois-da-leitura-do-dono'
  /** O link: logo depois do `UPDATE` do pedido (passo 4). */
  | 'depois-do-update-do-pedido'
  /** Link (passo 5) ou troca: logo depois do `UPDATE` de `usuarios`. */
  | 'depois-do-update-da-conta';

interface Pausa {
  ponto: PontoDePausa;
  chegou: (pid: number) => void;
  solta: Promise<void>;
}
let pausaArmada: Pausa | null = null;

type ClienteDaTx = {
  $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
  $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number>;
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
function ler2(alvo: object, prop: string | symbol): unknown {
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
          // O ponto é a leitura do dono, com ou sem `FOR UPDATE`: a sabotagem
          // S7 (tirar a trava) ainda passa por aqui, e o teste fica vermelho
          // pelo motivo certo — o outro participante NÃO bloqueia.
          const sql = s.join('?');
          if (/empresa_status/.test(sql) && /FROM\s+usuarios\s+u/.test(sql)) {
            await talvezPausar(alvo, 'depois-da-leitura-do-dono');
          }
          return r;
        };
      }
      if (prop === '$executeRaw') {
        return async (s: TemplateStringsArray, ...v: unknown[]) => {
          const r = await alvo.$executeRaw(s, ...v);
          if (/UPDATE\s+pedidos_de_redefinicao/.test(s.join('?'))) {
            await talvezPausar(alvo, 'depois-do-update-do-pedido');
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
            return ler2(d, p2);
          },
        });
      }
      return ler2(alvo, prop);
    },
  });
}

/**
 * O `PrismaService` do `appPausavel`: o mesmo `PrismaClient` real, com a
 * `$transaction` interativa envolvida. O único ajuste além da pausa é o
 * `timeout` (15 s): a pausa é do teste, e a transação não pode morrer
 * enquanto o teste observa o bloqueio.
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
    return ler2(alvo, prop);
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
 * A sessão que **espera trava** (`wait_event_type = 'Lock'`) bloqueada por
 * `pidDono`, **qualquer que seja a instrução**: quem chama confere a
 * instrução depois. Assim, uma espera na instrução errada aparece como
 * reprovação, e não como "não achei" (AC-018 d).
 */
async function esperaBloqueadaPor(
  pidDono: number,
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
          AND $1::int = ANY (pg_blocking_pids(a.pid))`,
      pidDono,
    );
    if (linhas.length > 0) return linhas[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  garantirAmbienteDeFit();
  app = await createTestApp(db);
  appPausavel = await createTestApp(prismaPausavel);
  memoria = app.get(PROVEDOR_DE_EMAIL);
  espiaoDoPedido = jest.spyOn(app.get(RedefinicaoService), 'solicitar');
  segredoDoAccess = app
    .get(ConfigService)
    .getOrThrow<string>('JWT_ACCESS_SECRET');
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

/** Os dois status, em ordem, para não depender de quem respondeu primeiro. */
function ordenados(...rs: Response[]): number[] {
  return rs.map((r) => r.status).sort((a, b) => a - b);
}

describe('SPEC-090/AC-018 — as corridas do link, com o bloqueio observado', () => {
  it('(a) mesmo link, mesma conta: um 204, um 410', async () => {
    const email = emailNovo('a');
    const id = await conta(await empresa(), email);
    const token = await linkPara(email);
    const { pidDaPausa, soltar } = armarPausa('depois-da-leitura-do-dono');

    const primeiro = redefinir(token, id, 'spec-090-a-primeiro', appPausavel);
    let segundo: Promise<Response> | null = null;
    let espera: { pid: number; query: string } | null = null;
    try {
      const pid = await ate(pidDaPausa, 15_000);
      expect(pid).not.toBeNull();
      segundo = redefinir(token, id, 'spec-090-a-segundo');
      espera = await esperaBloqueadaPor(pid!);
    } finally {
      soltar();
    }
    const [r1, r2] = [await primeiro, await segundo];

    expect(espera).not.toBeNull();
    expect(espera!.query).toMatch(/FOR UPDATE OF u/);
    expect(r1.status).toBe(204);
    expect(r2.status).toBe(410);
    expect(r2.body).toEqual(REDEFINICAO_INVALIDA);
    expect(
      await bcrypt.compare('spec-090-a-primeiro', await senhaHashDe(id)),
    ).toBe(true);
  });

  it('(b) mesmo link, contas diferentes: um 204, um 410, e só uma senha mudou (S8)', async () => {
    const email = emailNovo('b');
    const a = await conta(await empresa(), email);
    const b = await conta(await empresa(), email);
    const hashDeB = await senhaHashDe(b);
    const token = await linkPara(email);
    const { pidDaPausa, soltar } = armarPausa('depois-do-update-do-pedido');

    const deA = redefinir(token, a, 'spec-090-b-de-a', appPausavel);
    let deB: Promise<Response> | null = null;
    let espera: { pid: number; query: string } | null = null;
    try {
      const pid = await ate(pidDaPausa, 15_000);
      expect(pid).not.toBeNull();
      deB = redefinir(token, b, 'spec-090-b-de-b');
      espera = await esperaBloqueadaPor(pid!);
    } finally {
      soltar();
    }
    const [ra, rb] = [await deA, await deB];

    // Os FOR UPDATE são em linhas diferentes: quem serializa é a trava de
    // linha do UPDATE do pedido.
    expect(espera).not.toBeNull();
    expect(espera!.query).toMatch(/UPDATE pedidos_de_redefinicao/);
    expect(ordenados(ra, rb)).toEqual([204, 410]);
    expect(ra.status).toBe(204);
    expect(rb.body).toEqual(REDEFINICAO_INVALIDA);
    expect(await bcrypt.compare('spec-090-b-de-a', await senhaHashDe(a))).toBe(
      true,
    );
    expect(await senhaHashDe(b)).toBe(hashDeB);
  });

  it('(c) dois pedidos, mesma conta: um 204, um 410, e o hash final é o do vencedor (S7)', async () => {
    const email = emailNovo('c');
    const id = await conta(await empresa(), email);
    const p1 = await linkPara(email);
    const p2 = await linkPara(email);
    expect(p2).not.toBe(p1);
    const { pidDaPausa, soltar } = armarPausa('depois-da-leitura-do-dono');

    const porP1 = redefinir(p1, id, 'spec-090-c-por-p1', appPausavel);
    let porP2: Promise<Response> | null = null;
    let espera: { pid: number; query: string } | null = null;
    try {
      const pid = await ate(pidDaPausa, 15_000);
      expect(pid).not.toBeNull();
      porP2 = redefinir(p2, id, 'spec-090-c-por-p2');
      espera = await esperaBloqueadaPor(pid!);
    } finally {
      soltar();
    }
    const [r1, r2] = [await porP1, await porP2];

    expect(espera).not.toBeNull();
    expect(espera!.query).toMatch(/FOR UPDATE OF u/);
    expect(r1.status).toBe(204);
    expect(r2.status).toBe(410);
    expect(r2.body).toEqual(REDEFINICAO_INVALIDA);
    expect(
      await bcrypt.compare('spec-090-c-por-p1', await senhaHashDe(id)),
    ).toBe(true);
    expect(await usadoEm(p2)).toBeNull();
  });

  it('(d) troca primeiro: o link espera NO FOR UPDATE do passo 2, responde 410 sem consumir o pedido, e a senha da troca vale (S16)', async () => {
    const email = emailNovo('d');
    const companyId = await empresa();
    const id = await conta(companyId, email);
    const token = await linkPara(email);
    const { pidDaPausa, soltar } = armarPausa('depois-do-update-da-conta');

    // (1) a troca, pelo `trocarSenha` real, pausa depois do UPDATE de
    // `usuarios` e antes do COMMIT.
    const troca = trocarSenha(
      { id, email, companyId },
      SENHA,
      'spec-090-d-da-troca',
      appPausavel,
    );
    let link: Promise<Response> | null = null;
    let espera: { pid: number; query: string } | null = null;
    try {
      const pid = await ate(pidDaPausa, 15_000);
      expect(pid).not.toBeNull();
      // (2) o POST do link.
      link = redefinir(token, id, 'spec-090-d-do-link');
      // (3) o link está em Lock, bloqueado pela troca — e a instrução em
      // espera tem de ser a leitura com FOR UPDATE do passo 2.
      espera = await esperaBloqueadaPor(pid!);
    } finally {
      // (4) a troca comita.
      soltar();
    }
    const [rt, rl] = [await troca, await link];

    expect(espera).not.toBeNull();
    expect(espera!.query).toMatch(/FROM usuarios u/);
    expect(espera!.query).toMatch(/FOR UPDATE OF u/);
    expect(rt.status).toBe(200);
    expect(rl.status).toBe(410);
    expect(rl.body).toEqual(REDEFINICAO_INVALIDA);
    expect(await usadoEm(token)).toBeNull();
    expect(
      await bcrypt.compare('spec-090-d-da-troca', await senhaHashDe(id)),
    ).toBe(true);
    expect((await login(email, 'spec-090-d-da-troca')).status).toBe(200);
  });

  it("(d') link primeiro: a troca espera no UPDATE dela; 204 e troca bem-sucedida, pedido usado, hash final o da troca", async () => {
    const email = emailNovo('d-linha');
    const companyId = await empresa();
    const id = await conta(companyId, email);
    const token = await linkPara(email);
    const { pidDaPausa, soltar } = armarPausa('depois-do-update-da-conta');

    // O link pausa depois do passo 5 (a senha nova escrita, sem COMMIT).
    const link = redefinir(token, id, 'spec-090-dl-do-link', appPausavel);
    let troca: Promise<Response> | null = null;
    let espera: { pid: number; query: string } | null = null;
    try {
      const pid = await ate(pidDaPausa, 15_000);
      expect(pid).not.toBeNull();
      // A troca confere a senha atual ANTES da transação dela: lê a senha
      // de antes, porque o link ainda não comitou.
      troca = trocarSenha(
        { id, email, companyId },
        SENHA,
        'spec-090-dl-da-troca',
      );
      espera = await esperaBloqueadaPor(pid!);
    } finally {
      soltar();
    }
    const [rl, rt] = [await link, await troca];

    expect(espera).not.toBeNull();
    expect(espera!.query).toMatch(/^UPDATE "public"\."usuarios"/);
    expect(rl.status).toBe(204);
    expect(rt.status).toBe(200);
    expect(await usadoEm(token)).not.toBeNull();
    expect(
      await bcrypt.compare('spec-090-dl-da-troca', await senhaHashDe(id)),
    ).toBe(true);
  });
});
