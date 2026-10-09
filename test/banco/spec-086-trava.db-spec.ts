/**
 * SPEC-086 — **a trava por e-mail e a segunda linha, contra o Postgres de
 * verdade** (AC-020, AC-023, AC-024, AC-025 com LIM-086-04, AC-027, AC-028).
 *
 * A spec ("A trava por e-mail") diz que toda transação que cria conta toma,
 * como primeira instrução, `travar_emails_para_criar_conta` — um orçamento de
 * 2 s para todos os e-mails juntos, o `lock_timeout` de antes devolvido no
 * fim — e que a espera esgotada vira `503 SERVIDOR_OCUPADO`. As constraints e
 * o tradutor (`ehViolacaoDeEmail`) ficam como segunda linha, só alcançada se
 * a trava for contornada. Cada bloco abaixo prova um pedaço, e diz qual
 * sabotagem da tabela "Sabotagens" o deixaria vermelho.
 *
 * ## Como se observa a espera
 *
 * Nada aqui supõe que alguém está esperando: a espera é **vista** em
 * `pg_stat_activity` + `pg_locks` (`wait_event = 'advisory'`, `granted =
 * false`), com o `pid` de quem bloqueia (`pg_blocking_pids`) e a chave em que
 * se espera (`classid`/`objid` da trava de `bigint`). O início da espera é o
 * `query_start` da instrução de travas, medido pelo relógio do banco na
 * conexão observadora — e por isso "2 s ± 0,5 s desde o início da espera" não
 * inclui o bcrypt que algumas entradas fazem antes da transação.
 *
 * ## Duas conexões que não são a do app
 *
 * O adversário que segura a trava é um `PrismaClient` próprio, numa
 * `$transaction` que só termina quando o teste manda. O observador é outro,
 * fora de qualquer transação em julgamento (o molde é o
 * `spec-083-corrida-do-professor.db-spec.ts`).
 *
 * ## CPU disputada
 *
 * Os casos de tempo (AC-023, AC-024) têm folga de ± 0,5 s, e a máquina pode
 * estar rodando outras suítes. Um caso de tempo que falhe deve ser rodado de
 * novo antes de virar conclusão — e o relatório diz se precisou.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpException, type INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { AcessoService } from '../../src/acesso/acesso.service';
import {
  chaveDoEmail,
  EsperaPorEmailEsgotada,
  travarEmailsParaCriarConta,
} from '../../src/acesso/trava-de-email';
import {
  ehViolacaoDeEmail,
  traduzirViolacaoDeUnicidade,
} from '../../src/acesso/traduzir-violacao-de-unicidade';
import { AuthService } from '../../src/auth/auth.service';
import { InvitesService } from '../../src/auth/invites.service';
import { MENSAGEM_SERVIDOR_OCUPADO } from '../../src/common/erros/erro-transitorio';
import { ChaveDeLock } from '../../src/common/lock/chave-de-lock';
import type { AccessTokenPayload } from '../../src/common/types/jwt-payload.type';
import { CompaniesService } from '../../src/companies/companies.service';
import type { LogoDaEmpresaService } from '../../src/companies/logo-da-empresa.service';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import type { MatriculasService } from '../../src/matriculas/matriculas.service';
import type { FotoDeProfessorService } from '../../src/people/foto-de-professor.service';
import {
  ImportacaoDeAlunosService,
  MENSAGEM_EMAIL_JA_EXISTE,
} from '../../src/people/importacao/importacao-de-alunos.service';
import { ImportacaoController } from '../../src/people/importacao/importacao.controller';
import { LevelsService } from '../../src/people/levels.service';
import { StudentsService } from '../../src/people/students.service';
import { TeachersService } from '../../src/people/teachers.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { subirAppReal } from '../fit/app-real';
import { bodyOf } from '../utils/http';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture, primeiroNivelSql } from './nivel-da-fixture';

exigirBancoLocal();
jest.setTimeout(300_000);

// Antes de o app subir: o `EmailModule` lê no boot. Memória, sempre.
process.env.EMAIL_PROVEDOR = 'memoria';
process.env.EMAIL_REMETENTE = 'convites@spec086t.teste.local';
process.env.EMAIL_RESPONDER_PARA = 'respostas@spec086t.teste.local';
process.env.URL_CLIENTE = 'https://cliente.spec086t.teste.local';
// A chave do REQ-005 desligada, explícita: é o padrão de produção, e um
// `.env` local não decide o que esta suíte prova.
process.env.EMAIL_EM_VARIAS_EMPRESAS = 'false';

const base = '08607000-0000-4000-8000-0000000000';
const EMPRESA_A = `${base}a1`;
const EMPRESA_B = `${base}a2`;
const SLUG_A = 'spec086-trava-a';
const GESTOR = `${base}e1`;
const GESTOR_EMAIL = 'spec086-trava-gestor@teste.local';
const SUPER = `${base}f1`;
const SUPER_EMAIL = 'spec086-trava-super@teste.local';
const SENHA = 'spec-086-trava-senha-forte';
const QUADRA_A = `${base}d1`;
/** O prefixo do nome de toda empresa que a E7 tenta criar aqui. */
const PREFIXO_DE_EMPRESA_NOVA = 'Clube spec086-trava';

const MODELOS = {
  remetente: 'convites@spec086t.teste.local',
  responderPara: 'suporte@spec086t.teste.local',
  urlCliente: 'https://cliente.spec086t.teste.local',
};

const db = new PrismaClient();
/** Quem segura a trava (ou a linha) contra a transação em julgamento. */
const adversario = new PrismaClient();
/** O segundo adversário do AC-024 (cada chave numa conexão própria). */
const adversario2 = new PrismaClient();
/** Quem lê `pg_stat_activity`/`pg_locks`, fora de qualquer transação. */
const observador = new PrismaClient();

const q = (sql: string, ...v: unknown[]) => db.$executeRawUnsafe(sql, ...v);
const ler = <T>(sql: string, ...v: unknown[]) =>
  db.$queryRawUnsafe<T[]>(sql, ...v);
const dormir = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

let seq = 0;
/** Um e-mail novo por caso: nenhum caso colide com outro, nem com reruns. */
function emailNovo(rotulo: string): string {
  seq += 1;
  return `spec086-trava-${rotulo}-${seq}-${randomBytes(3).toString('hex')}@teste.local`;
}

let ipSeq = 0;
/** As rotas públicas contam por IP (10 em 15 min): um IP por requisição. */
function ipNovo(): string {
  ipSeq += 1;
  return `10.86.${Math.floor(ipSeq / 250) + 1}.${(ipSeq % 250) + 1}`;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

// ==========================================================================
// Fixtures
// ==========================================================================

async function professor(
  email: string,
  nome = 'Professor 086',
): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO professores (id, company_id, nome, telefone, email)
     VALUES ($1::uuid, $2::uuid, $3, '11988887777', $4)`,
    id,
    EMPRESA_A,
    nome,
    email,
  );
  return id;
}

async function conviteDeAluno(
  email: string,
  nome = 'Convidada 086',
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await q(
    `INSERT INTO convites_aluno (id, company_id, criado_por_id, email, nome, token_hash, expira_em)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now() + interval '7 days')`,
    id,
    EMPRESA_A,
    GESTOR,
    email,
    nome,
    sha256(token),
  );
  return { id, token };
}

async function turma(nome: string): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id)
     VALUES ($1::uuid,$2::uuid,$3,$4::uuid,20,'ativa'::turma_status,${primeiroNivelSql(`'${EMPRESA_A}'::uuid`)})`,
    id,
    EMPRESA_A,
    nome,
    QUADRA_A,
  );
  return id;
}

/** A conta conflitante, gravada por SQL direto — sem trava, como o SQL manual. */
function contaPorFora(
  email: string,
  role: 'aluno' | 'professor' | 'company_admin',
  empresa: string,
  nome = 'Conta por fora 086',
) {
  return adversario.$executeRawUnsafe(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES (gen_random_uuid(),$1,'h',$2,$3::usuario_role,$4::uuid,now())`,
    email,
    nome,
    role,
    empresa,
  );
}

/** As contas com o e-mail, como (papel, empresa) — o que sobra no banco. */
async function contasDoEmail(email: string) {
  return ler<{ role: string; company_id: string | null }>(
    `SELECT role::text AS role, company_id::text AS company_id
       FROM usuarios WHERE email = $1 ORDER BY role, company_id`,
    email,
  );
}

/** Perfis de aluno ligados a contas com o e-mail. */
async function alunosDoEmail(email: string): Promise<number> {
  const [r] = await ler<{ n: number }>(
    `SELECT count(*)::int AS n FROM alunos al
       JOIN usuarios u ON u.id = al.usuario_id WHERE u.email = $1`,
    email,
  );
  return r.n;
}

async function conviteUsado(id: string): Promise<boolean> {
  const [r] = await ler<{ usado: boolean }>(
    `SELECT usado_em IS NOT NULL AS usado FROM convites_aluno WHERE id = $1::uuid`,
    id,
  );
  return r.usado;
}

async function vinculoDoProfessor(id: string): Promise<string | null> {
  const [r] = await ler<{ usuario_id: string | null }>(
    `SELECT usuario_id::text AS usuario_id FROM professores WHERE id = $1::uuid`,
    id,
  );
  return r.usuario_id;
}

async function convitesDeAcessoDoEmail(email: string): Promise<number> {
  const [r] = await ler<{ n: number }>(
    `SELECT count(*)::int AS n FROM convites_de_acesso c
       JOIN usuarios u ON u.id = c.usuario_id WHERE u.email = $1`,
    email,
  );
  return r.n;
}

async function empresasComONome(nome: string): Promise<number> {
  const [r] = await ler<{ n: number }>(
    `SELECT count(*)::int AS n FROM empresas WHERE nome = $1`,
    nome,
  );
  return r.n;
}

// ==========================================================================
// A trava, segurada e observada
// ==========================================================================

/** A chave numérica do e-mail, pela mesma função que monta a de produção. */
const chaveNumerica = (email: string): bigint =>
  ChaveDeLock.deTexto(chaveDoEmail(email));

/**
 * Como a chave aparece em `pg_locks`: a trava de `bigint` guarda os 32 bits
 * altos em `classid` e os baixos em `objid` (com `objsubid = 1`).
 */
function chaveEmPgLocks(email: string): string {
  const k = BigInt.asUintN(64, chaveNumerica(email));
  return `${(k >> 32n).toString()}:${(k & 0xffffffffn).toString()}`;
}

interface Segura {
  pid: number;
  soltar: () => Promise<void>;
}

/**
 * Abre uma transação no `cliente`, roda `tomar` (que segura alguma coisa) e
 * só termina quando `soltar()` for chamado. Devolve depois de segurar.
 */
async function segurar(
  cliente: PrismaClient,
  tomar: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<Segura> {
  let liberar!: () => void;
  const liberada = new Promise<void>((r) => (liberar = r));
  let pronto!: (pid: number) => void;
  let falhou!: (e: unknown) => void;
  const pronta = new Promise<number>((r, f) => {
    pronto = r;
    falhou = f;
  });
  const dono = cliente.$transaction(
    async (tx) => {
      const [{ pid }] = await tx.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      await tomar(tx);
      pronto(pid);
      await liberada;
    },
    { maxWait: 15_000, timeout: 60_000 },
  );
  dono.catch(falhou);
  const pid = await pronta;
  let solta = false;
  return {
    pid,
    soltar: async () => {
      if (!solta) {
        solta = true;
        liberar();
      }
      await dono;
    },
  };
}

/**
 * Segura as travas dos e-mails **direto**, com `pg_advisory_xact_lock` — sem
 * passar pela função em julgamento, para que um defeito nela não segure
 * "certo" por acidente.
 */
const travasDosEmails =
  (emails: readonly string[]) => async (tx: Prisma.TransactionClient) => {
    for (const email of emails) {
      await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM (SELECT pg_advisory_xact_lock($1::bigint)) AS t`,
        chaveNumerica(email).toString(),
      );
    }
  };

interface EsperaPorEmail {
  pid: number;
  /** Há quanto tempo a instrução de travas começou, pelo relógio do banco. */
  ha_ms: number;
  inicio: string;
  chave: string;
  por: number[];
}

/** Quem está parado numa trava `advisory` neste banco, e em qual chave. */
function esperasPorEmail(): Promise<EsperaPorEmail[]> {
  return observador.$queryRawUnsafe<EsperaPorEmail[]>(
    `SELECT a.pid,
            floor(extract(epoch FROM clock_timestamp() - a.query_start) * 1000)::int AS ha_ms,
            a.query_start::text AS inicio,
            l.classid::text || ':' || l.objid::text AS chave,
            pg_blocking_pids(a.pid) AS por
       FROM pg_stat_activity a
       JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted AND l.locktype = 'advisory'
      WHERE a.datname = current_database()
        AND a.wait_event_type = 'Lock'
        AND a.wait_event = 'advisory'
      ORDER BY a.query_start, a.pid`,
  );
}

// ==========================================================================
// Os apps (HTTP real) e os tokens
// ==========================================================================

let appA: INestApplication<App>;
let appB: INestApplication<App>;
let tokenDoGestor: string;
let tokenDoSuper: string;

async function entrar(email: string): Promise<string> {
  const r = await request(appA.getHttpServer())
    .post('/api/v1/auth/login')
    .set('do-connecting-ip', ipNovo())
    .send({ email, senha: SENHA });
  expect(r.status).toBe(200);
  return bodyOf<{ accessToken: string }>(r).accessToken;
}

const http = (app: INestApplication<App> = appA) =>
  request(app.getHttpServer());

/** O corpo de `SERVIDOR_OCUPADO`, o mesmo de `erro-transitorio.ts`. */
const SERVIDOR_OCUPADO = {
  statusCode: 503,
  code: 'SERVIDOR_OCUPADO',
  message: MENSAGEM_SERVIDOR_OCUPADO,
};

function planilha(linhas: readonly [string, string, string?][]): string {
  const comTurma = linhas.some((l) => l[2] !== undefined);
  const cabecalho = comTurma ? 'nome;email;turma' : 'nome;email';
  return [
    cabecalho,
    ...linhas.map((l) => (comTurma ? l.join(';') : `${l[0]};${l[1]}`)),
  ].join('\r\n');
}

function importarPorHttp(
  conteudo: string,
  app: INestApplication<App> = appA,
): Promise<Response> {
  return http(app)
    .post('/api/v1/students/importar')
    .set('Authorization', `Bearer ${tokenDoGestor}`)
    .attach('arquivo', Buffer.from(conteudo, 'utf8'), 'alunos.csv')
    .then((r) => r);
}

// ==========================================================================
// Ciclo de vida
// ==========================================================================

async function limparEmpresasNovas(): Promise<void> {
  const novas = await ler<{ id: string }>(
    `SELECT id::text AS id FROM empresas WHERE nome LIKE $1`,
    `${PREFIXO_DE_EMPRESA_NOVA}%`,
  );
  for (const { id } of novas) await limparEmpresa(db, id);
}

async function limparSuper(): Promise<void> {
  await q(`DELETE FROM refresh_tokens WHERE usuario_id = $1::uuid`, SUPER);
  await q(`DELETE FROM usuarios WHERE id = $1::uuid`, SUPER);
}

beforeAll(async () => {
  await limparEmpresasNovas();
  await limparEmpresa(db, EMPRESA_A);
  await limparEmpresa(db, EMPRESA_B);
  await limparSuper();

  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,permite_auto_cadastro,updated_at) VALUES ('${EMPRESA_A}','Clube SPEC-086 Trava A','${SLUG_A}',true,now())`,
    ),
  );
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA_B}','Clube SPEC-086 Trava B','spec086-trava-b',now())`,
    ),
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),$1::uuid,'Tenis',0,now())`,
    EMPRESA_A,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status)
     VALUES ($1::uuid,$2::uuid,'Q',(SELECT id FROM esportes_de_quadra WHERE company_id=$2::uuid LIMIT 1),80,'ativa')`,
    QUADRA_A,
    EMPRESA_A,
  );
  const hash = await bcrypt.hash(SENHA, 4);
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ($1::uuid,$2,$3,'Gestora 086 Trava','company_admin',$4::uuid,now())`,
    GESTOR,
    GESTOR_EMAIL,
    hash,
    EMPRESA_A,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ($1::uuid,$2,$3,'Super 086 Trava','super_admin',NULL,now())`,
    SUPER,
    SUPER_EMAIL,
    hash,
  );

  [appA, appB] = await Promise.all([subirAppReal(), subirAppReal()]);
  tokenDoGestor = await entrar(GESTOR_EMAIL);
  tokenDoSuper = await entrar(SUPER_EMAIL);
});

afterAll(async () => {
  await Promise.all([appA?.close(), appB?.close()]);
  await limparEmpresasNovas();
  await limparEmpresa(db, EMPRESA_A);
  await limparEmpresa(db, EMPRESA_B);
  await limparSuper();
  await Promise.all([
    db.$disconnect(),
    adversario.$disconnect(),
    adversario2.$disconnect(),
    observador.$disconnect(),
  ]);
});

// ==========================================================================
// AC-028 — o marcador gravado uma vez
// ==========================================================================

/**
 * Com `a` e `b` livres, a instrução devolve, por chave, o `playck.prazo_email`
 * lido naquele ponto. Gravado uma vez, os dois são **iguais**. S24 (o
 * marcador regravado a cada chave) dá dois `clock_timestamp()` diferentes —
 * o texto tem microssegundos, e duas leituras nunca coincidem.
 */
describe('SPEC-086/AC-028 — o marcador do orçamento é gravado uma vez', () => {
  it('a e b livres: os marcadores da 1ª e da 2ª chave são iguais', async () => {
    const a = emailNovo('m-a');
    const b = emailNovo('m-b');
    const marcos = await db.$transaction((tx) =>
      travarEmailsParaCriarConta(tx, [b, a]),
    );
    expect(marcos.map((m) => m.ordem)).toEqual([1, 2]);
    expect(marcos[0].marcador).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(marcos[1].marcador).toBe(marcos[0].marcador);
  });
});

// ==========================================================================
// AC-027 — o orçamento não vaza para o resto da transação
// ==========================================================================

describe('SPEC-086/AC-027 — o orçamento do e-mail não vaza', () => {
  /**
   * (a) Com o e-mail livre, a trava ajusta o `lock_timeout` para o resto dos
   * 2 s. Se ela não o devolvesse (S27), o `UPDATE` da linha do convite, que
   * vem depois, herdaria os ~2 s e morreria com `55P03` antes de o
   * adversário soltar, aos 3 s. Devolvido, espera como sempre esperou.
   */
  it('(a) direto: trava, depois UPDATE numa linha de convites_aluno segura por 3 s — espera e conclui', async () => {
    const convite = await conviteDeAluno(emailNovo('a27-linha'));
    const adv = await segurar(adversario, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT id FROM convites_aluno WHERE id = $1::uuid FOR UPDATE`,
        convite.id,
      ),
    );
    const soltura = dormir(3_000).then(() => adv.soltar());
    const t0 = Date.now();
    try {
      await db.$transaction(
        async (tx) => {
          await travarEmailsParaCriarConta(tx, [emailNovo('a27-livre')]);
          await tx.$executeRawUnsafe(
            `UPDATE convites_aluno SET usado_em = now() WHERE id = $1::uuid`,
            convite.id,
          );
        },
        { timeout: 15_000 },
      );
    } finally {
      await soltura;
    }
    const decorrido = Date.now() - t0;
    // Esperou o adversário (3 s), e não desistiu aos 2 s.
    expect(decorrido).toBeGreaterThanOrEqual(2_700);
    expect(await conviteUsado(convite.id)).toBe(true);
  });

  /**
   * (a) pela rota da E2, que é o caso que a spec descreve: o e-mail é
   * travado, e a claim do convite (o `updateMany` com `usado_em IS NULL`)
   * espera a linha que o adversário segura por 3 s. Resultado de hoje: `201`.
   */
  it('(a) pela E2: a claim do convite espera a linha segura por 3 s e o aceite conclui com 201', async () => {
    const email = emailNovo('a27-e2');
    const convite = await conviteDeAluno(email);
    const adv = await segurar(adversario, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT id FROM convites_aluno WHERE id = $1::uuid FOR UPDATE`,
        convite.id,
      ),
    );
    const t0 = Date.now();
    const pedido = http()
      .post('/api/v1/auth/aceitar-convite')
      .set('do-connecting-ip', ipNovo())
      .send({ token: convite.token, senha: SENHA })
      .then((x) => x);
    await dormir(3_000);
    await adv.soltar();
    const r = await pedido;
    const detalhe = `${r.status} ${r.text.slice(0, 300)}`;
    expect({ status: r.status, detalhe }).toEqual({ status: 201, detalhe });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_700);
    expect(await contasDoEmail(email)).toHaveLength(1);
    expect(await conviteUsado(convite.id)).toBe(true);
  });

  /**
   * (b) O valor anterior volta, qualquer que seja. S28 (devolver sempre `0`)
   * deixa `0` no lugar de `7s`; S27 deixa o resto do orçamento (`…ms`).
   */
  it("(b) com SET LOCAL lock_timeout = '7s' antes, current_setting('lock_timeout') depois da trava é '7s'", async () => {
    const depois = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '7s'`);
      await travarEmailsParaCriarConta(tx, [emailNovo('b27')]);
      const [r] = await tx.$queryRaw<
        { lt: string }[]
      >`SELECT current_setting('lock_timeout') AS lt`;
      return r.lt;
    });
    expect(depois).toBe('7s');
  });

  it('(b) sem nada antes, o lock_timeout da sessão volta igual ao de antes', async () => {
    const [antes, depois] = await db.$transaction(async (tx) => {
      const [x] = await tx.$queryRaw<
        { lt: string }[]
      >`SELECT current_setting('lock_timeout') AS lt`;
      await travarEmailsParaCriarConta(tx, [emailNovo('b27-padrao')]);
      const [y] = await tx.$queryRaw<
        { lt: string }[]
      >`SELECT current_setting('lock_timeout') AS lt`;
      return [x.lt, y.lt];
    });
    expect(depois).toBe(antes);
  });
});

// ==========================================================================
// AC-024 — o orçamento é acumulado
// ==========================================================================

describe('SPEC-086/AC-024 — um orçamento de 2 s para todos os e-mails juntos', () => {
  /**
   * `a` segura 1,2 s, `b` segura 3 s. Com um orçamento só, a trava espera `a`
   * por 1,2 s e `b` pelo resto (~0,8 s): desiste aos ~2 s. S24 (marcador
   * regravado por chave) daria 2 s frescos a `b` — que o adversário solta aos
   * 3 s, antes de eles acabarem —, e a trava **concluiria**: o `rejects`
   * abaixo fica vermelho. E a observação prova que a espera passou de `a`
   * para `b`, e não que desistiu em `a`.
   */
  it('direto: a segura 1,2 s e b segura 3 s; a trava desiste em 2 s ± 0,5 s com EsperaPorEmailEsgotada', async () => {
    const a = emailNovo('o-a');
    const b = emailNovo('o-b');
    const advA = await segurar(adversario, travasDosEmails([a]));
    const advB = await segurar(adversario2, travasDosEmails([b]));
    const vistas = new Set<string>();
    let parar = false;
    const olhar = (async () => {
      while (!parar) {
        for (const e of await esperasPorEmail()) vistas.add(e.chave);
        await dormir(40);
      }
    })();
    const t0 = Date.now();
    const soltaA = dormir(1_200).then(() => advA.soltar());
    const soltaB = dormir(3_000).then(() => advB.soltar());
    let erro: unknown = null;
    try {
      await db.$transaction((tx) => travarEmailsParaCriarConta(tx, [b, a]), {
        timeout: 15_000,
      });
    } catch (e) {
      erro = e;
    }
    const decorrido = Date.now() - t0;
    parar = true;
    await Promise.all([olhar, soltaA, soltaB]);

    console.log(
      `AC-024 (direto): desistiu em ${decorrido} ms; chaves vistas em espera: ${[...vistas].join(', ')}`,
    );
    expect(erro).toBeInstanceOf(EsperaPorEmailEsgotada);
    expect(decorrido).toBeGreaterThanOrEqual(1_500);
    expect(decorrido).toBeLessThanOrEqual(2_500);
    expect(vistas.has(chaveEmPgLocks(a))).toBe(true);
    expect(vistas.has(chaveEmPgLocks(b))).toBe(true);
  });

  it('pela E6: a segura 1,2 s e b segura 3 s; 503 SERVIDOR_OCUPADO em 2 s ± 0,5 s desde o início da espera, sem resíduo', async () => {
    const a = emailNovo('o6-a');
    const b = emailNovo('o6-b');
    const advA = await segurar(adversario, travasDosEmails([a]));
    const advB = await segurar(adversario2, travasDosEmails([b]));
    let chegou = false;
    const pedido = importarPorHttp(
      planilha([
        ['Ana 086', a],
        ['Beto 086', b],
      ]),
    ).finally(() => {
      chegou = true;
    });
    let inicio: number | null = null;
    let soltaA: Promise<void> = Promise.resolve();
    try {
      const limite = Date.now() + 20_000;
      while (!chegou && Date.now() < limite) {
        const minha = (await esperasPorEmail()).find((e) =>
          e.por.includes(advA.pid),
        );
        if (minha) {
          inicio = Date.now() - minha.ha_ms;
          break;
        }
        await dormir(20);
      }
      if (inicio !== null) {
        soltaA = dormir(inicio + 1_200 - Date.now()).then(() => advA.soltar());
      }
      const r = await pedido;
      const fim = Date.now();
      await soltaA;
      await dormir((inicio ?? fim) + 3_000 - Date.now());

      expect(inicio).not.toBeNull();
      const espera = fim - (inicio as number);
      console.log(`AC-024 (E6): 503 em ${espera} ms desde o início da espera`);
      expect({ status: r.status, corpo: bodyOf<object>(r) }).toEqual({
        status: 503,
        corpo: SERVIDOR_OCUPADO,
      });
      expect(espera).toBeGreaterThanOrEqual(1_500);
      expect(espera).toBeLessThanOrEqual(2_500);
    } finally {
      await advA.soltar();
      await advB.soltar();
    }
    expect(await contasDoEmail(a)).toEqual([]);
    expect(await contasDoEmail(b)).toEqual([]);
  });
});

// ==========================================================================
// AC-023 — a espera esgotada, por entrada
// ==========================================================================

/**
 * O adversário segura a trava do `email` (direto, `pg_advisory_xact_lock`) e
 * o pedido é disparado. A espera é **vista** no banco, bloqueada pelo `pid`
 * do adversário — o que prova também que a entrada trava a chave certa — e o
 * adversário só solta 3 s depois de ela começar (ou depois da resposta, o
 * que vier por último).
 */
async function comEmailSeguro(
  email: string,
  disparar: () => Promise<Response>,
): Promise<{ r: Response; espera: number | null; vista: string }> {
  const adv = await segurar(adversario, travasDosEmails([email]));
  let chegou = false;
  const pedido = disparar().finally(() => {
    chegou = true;
  });
  let inicio: number | null = null;
  let vista = 'a espera nunca foi vista';
  try {
    const limite = Date.now() + 20_000;
    while (!chegou && Date.now() < limite) {
      const minha = (await esperasPorEmail()).find((e) =>
        e.por.includes(adv.pid),
      );
      if (minha) {
        inicio = Date.now() - minha.ha_ms;
        vista = `pid ${minha.pid} esperando a chave ${minha.chave} desde ${minha.inicio}, bloqueado por ${adv.pid}`;
        break;
      }
      await dormir(20);
    }
    const r = await pedido;
    const fim = Date.now();
    await dormir((inicio ?? fim) + 3_000 - Date.now());
    return { r, espera: inicio === null ? null : fim - inicio, vista };
  } finally {
    await adv.soltar();
  }
}

function confereOcupado(
  rotulo: string,
  { r, espera, vista }: { r: Response; espera: number | null; vista: string },
): void {
  console.log(`AC-023 ${rotulo}: ${r.status} em ${espera} ms — ${vista}`);
  const detalhe = `${r.status} ${r.text.slice(0, 300)}`;
  expect({ status: r.status, corpo: bodyOf<object>(r), detalhe }).toEqual({
    status: 503,
    corpo: SERVIDOR_OCUPADO,
    detalhe,
  });
  expect(espera).not.toBeNull();
  expect(espera).toBeGreaterThanOrEqual(1_500);
  expect(espera).toBeLessThanOrEqual(2_500);
}

/**
 * Cada um dos oito escritores, com a trava do e-mail segura por outra
 * conexão: `503 SERVIDOR_OCUPADO` com `MENSAGEM_SERVIDOR_OCUPADO`, e nada
 * gravado. S23 (a `EsperaPorEmailEsgotada` sem o envoltório numa entrada,
 * ex.: E7) faz aquela entrada responder `500` — o `toEqual` do status fica
 * vermelho.
 */
describe('SPEC-086/AC-023 — espera esgotada: 503 SERVIDOR_OCUPADO em 2 s ± 0,5 s, sem resíduo', () => {
  it('E1 — POST /auth/register-aluno', async () => {
    const email = emailNovo('e1-503');
    const res = await comEmailSeguro(email, () =>
      http()
        .post('/api/v1/auth/register-aluno')
        .set('do-connecting-ip', ipNovo())
        .send({ email, senha: SENHA, nome: 'Aluna E1', empresaSlug: SLUG_A })
        .then((x) => x),
    );
    confereOcupado('E1', res);
    expect(await contasDoEmail(email)).toEqual([]);
    expect(await alunosDoEmail(email)).toBe(0);
  });

  it('E2 — POST /auth/aceitar-convite', async () => {
    const email = emailNovo('e2-503');
    const convite = await conviteDeAluno(email);
    const res = await comEmailSeguro(email, () =>
      http()
        .post('/api/v1/auth/aceitar-convite')
        .set('do-connecting-ip', ipNovo())
        .send({ token: convite.token, senha: SENHA })
        .then((x) => x),
    );
    confereOcupado('E2', res);
    expect(await contasDoEmail(email)).toEqual([]);
    expect(await conviteUsado(convite.id)).toBe(false);
  });

  it('E4 — POST /students', async () => {
    const email = emailNovo('e4-503');
    const res = await comEmailSeguro(email, () =>
      http()
        .post('/api/v1/students')
        .set('Authorization', `Bearer ${tokenDoGestor}`)
        .send({ nome: 'Aluno E4', email })
        .then((x) => x),
    );
    confereOcupado('E4', res);
    expect(await contasDoEmail(email)).toEqual([]);
    expect(await alunosDoEmail(email)).toBe(0);
  });

  it('E5a — POST /teachers/:id/convite-de-acesso (professor sem conta)', async () => {
    const email = emailNovo('e5a-503');
    const id = await professor(email);
    const res = await comEmailSeguro(email, () =>
      http()
        .post(`/api/v1/teachers/${id}/convite-de-acesso`)
        .set('Authorization', `Bearer ${tokenDoGestor}`)
        .then((x) => x),
    );
    confereOcupado('E5a', res);
    expect(await contasDoEmail(email)).toEqual([]);
    expect(await vinculoDoProfessor(id)).toBeNull();
    expect(await convitesDeAcessoDoEmail(email)).toBe(0);
  });

  it('E5b — POST /teachers/:id/acesso (professor sem conta)', async () => {
    const email = emailNovo('e5b-503');
    const id = await professor(email);
    const res = await comEmailSeguro(email, () =>
      http()
        .post(`/api/v1/teachers/${id}/acesso`)
        .set('Authorization', `Bearer ${tokenDoGestor}`)
        .then((x) => x),
    );
    confereOcupado('E5b', res);
    expect(await contasDoEmail(email)).toEqual([]);
    expect(await vinculoDoProfessor(id)).toBeNull();
  });

  it('E6 — POST /students/importar', async () => {
    const email = emailNovo('e6-503');
    const res = await comEmailSeguro(email, () =>
      importarPorHttp(planilha([['Aluno E6', email]])),
    );
    confereOcupado('E6', res);
    expect(await contasDoEmail(email)).toEqual([]);
    expect(await alunosDoEmail(email)).toBe(0);
  });

  it('E7 — POST /companies (admin inicial): e nenhuma empresa órfã', async () => {
    const email = emailNovo('e7-503');
    const nome = `${PREFIXO_DE_EMPRESA_NOVA} E7 503 ${seq}`;
    const res = await comEmailSeguro(email, () =>
      http()
        .post('/api/v1/companies')
        .set('Authorization', `Bearer ${tokenDoSuper}`)
        .send({
          nome,
          esportes: ['Tenis'],
          adminInicial: { nome: 'Gestor E7', email, senha: SENHA },
        })
        .then((x) => x),
    );
    confereOcupado('E7', res);
    expect(await contasDoEmail(email)).toEqual([]);
    expect(await empresasComONome(nome)).toBe(0);
  });

  it('E8 — POST /companies/:id/admins', async () => {
    const email = emailNovo('e8-503');
    const res = await comEmailSeguro(email, () =>
      http()
        .post(`/api/v1/companies/${EMPRESA_A}/admins`)
        .set('Authorization', `Bearer ${tokenDoSuper}`)
        .send({ nome: 'Gestor E8', email, senha: SENHA })
        .then((x) => x),
    );
    confereOcupado('E8', res);
    expect(await contasDoEmail(email)).toEqual([]);
  });

  /**
   * O contrato da SPEC-083 continua: o `55P03` da trava de TURMA da E6 é
   * `409 MATRICULA_EM_ANDAMENTO`, e não o `503` do e-mail. S25 (todo `55P03`
   * da E6 traduzido para `503`) deixa este caso vermelho.
   */
  it('E6 — turma segura por FOR UPDATE em outra conexão continua 409 MATRICULA_EM_ANDAMENTO', async () => {
    const nomeDaTurma = `Turma 086 ${seq}`;
    const turmaId = await turma(nomeDaTurma);
    const email = emailNovo('e6-turma');
    const adv = await segurar(adversario, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT id FROM turmas WHERE id = $1::uuid FOR UPDATE`,
        turmaId,
      ),
    );
    let r: Response;
    try {
      r = await importarPorHttp(
        planilha([['Aluno Turma', email, nomeDaTurma]]),
      );
    } finally {
      await adv.soltar();
    }
    const detalhe = `${r.status} ${r.text.slice(0, 300)}`;
    expect({
      status: r.status,
      code: bodyOf<{ code?: string }>(r).code,
      detalhe,
    }).toEqual({ status: 409, code: 'MATRICULA_EM_ANDAMENTO', detalhe });
    expect(await contasDoEmail(email)).toEqual([]);
    expect(await alunosDoEmail(email)).toBe(0);
  });
});

// ==========================================================================
// AC-025 — sem ciclo entre importações (LIM-086-04)
// ==========================================================================

interface Ensaio {
  resultado: 'conclusivo' | 'inconclusivo';
  motivo?: string;
  registro: Record<string, unknown>;
  respostas: Response[];
  a: string;
  b: string;
  esperas: EsperaPorEmail[];
}

/**
 * Um ensaio: o adversário segura `a` e `b`; duas E6 (uma em cada app, cada
 * um com a pool própria), com `[a, b]` e `[b, a]` no arquivo. Quando as duas
 * forem vistas esperando, confere a precondição da LIM-086-04 e solta tudo de
 * uma vez.
 */
async function ensaioSemCiclo(
  tentativa: number,
  deadlockMs: number,
): Promise<Ensaio> {
  const a = emailNovo(`c${tentativa}-a`);
  const b = emailNovo(`c${tentativa}-b`);
  // `a` ordena antes de `b`: o prefixo da chave é o mesmo, e o rótulo decide.
  expect(chaveDoEmail(a) < chaveDoEmail(b)).toBe(true);
  const adv = await segurar(adversario, travasDosEmails([a, b]));

  const pedidos = Promise.all([
    importarPorHttp(
      planilha([
        ['Ana Ciclo', a],
        ['Beto Ciclo', b],
      ]),
      appA,
    ),
    importarPorHttp(
      planilha([
        ['Beto Ciclo', b],
        ['Ana Ciclo', a],
      ]),
      appB,
    ),
  ]);

  let esperas: EsperaPorEmail[] = [];
  let primeiraVistaEm: number | null = null;
  let vistasEm: number | null = null;
  let soltaEm = 0;
  let motivo: string | undefined;
  try {
    const limite = Date.now() + 30_000;
    while (Date.now() < limite) {
      esperas = (await esperasPorEmail()).filter((e) =>
        e.por.includes(adv.pid),
      );
      if (esperas.length > 0 && primeiraVistaEm === null) {
        primeiraVistaEm = Date.now();
      }
      if (esperas.length >= 2) {
        vistasEm = Date.now();
        break;
      }
      // O protocolo: as duas têm de estar esperando até 1 s depois da
      // primeira. Passou disso, o ensaio está travado, e não é resultado.
      if (primeiraVistaEm !== null && Date.now() - primeiraVistaEm > 1_000) {
        break;
      }
      await dormir(10);
    }
  } finally {
    await adv.soltar();
    soltaEm = Date.now();
  }
  const respostas = await pedidos;

  const maisAntiga = esperas[0];
  const restanteNaSoltura =
    maisAntiga && vistasEm !== null
      ? 2_000 - maisAntiga.ha_ms - (soltaEm - vistasEm)
      : null;
  const registro = {
    tentativa,
    deadlock_timeout_ms: deadlockMs,
    esperas: esperas.map((e) => ({
      pid: e.pid,
      inicio: e.inicio,
      chave:
        e.chave === chaveEmPgLocks(a)
          ? 'a'
          : e.chave === chaveEmPgLocks(b)
            ? 'b'
            : e.chave,
      ha_ms_quando_vista: e.ha_ms,
    })),
    soltura_ms_depois_de_ver_as_duas:
      vistasEm === null ? null : soltaEm - vistasEm,
    soltura_em: new Date(soltaEm).toISOString(),
    orcamento_restante_da_mais_antiga_na_soltura_ms: restanteNaSoltura,
    respostas: respostas.map((r) => r.status),
  };

  if (esperas.length < 2) {
    throw new Error(
      `AC-025: as duas importações não foram vistas esperando dentro de 1 s (protocolo travado): ${JSON.stringify(registro)}`,
    );
  }
  if (soltaEm - (vistasEm as number) > 300) {
    motivo = 'soltura passou de 300 ms depois de ver as duas';
  } else if (
    restanteNaSoltura === null ||
    restanteNaSoltura <= deadlockMs + 300
  ) {
    motivo = `orçamento restante da mais antiga (${restanteNaSoltura} ms) não supera deadlock_timeout + 300 ms (${deadlockMs + 300} ms)`;
  }
  return {
    resultado: motivo ? 'inconclusivo' : 'conclusivo',
    motivo,
    registro,
    respostas,
    a,
    b,
    esperas,
  };
}

/**
 * As duas importações, com o adversário segurando `a` e `b`, esperam **as
 * duas em `a`** — a trava ordena as chaves. Soltas juntas, uma pega `a` e
 * `b`, grava, e a outra pega as duas depois e recebe a recusa normal (`422`,
 * a conferência refeita sob a trava). Nenhuma termina em `40P01` (seria
 * `500`) nem `55P03` (seria `503`).
 *
 * S19 (e-mails travados na ordem do arquivo) faz uma esperar em `a` e a outra
 * em `b` — o `toEqual(['a', 'a'])` fica vermelho já na observação — e, soltas
 * ao mesmo tempo, cada uma pega a sua primeira e pede a da outra: o detector
 * de deadlock (1 s) derruba uma com `40P01`, e o `[201, 422]` também fica
 * vermelho. A LIM-086-04 garante que o detector tem tempo de agir antes de o
 * orçamento acabar; sem ela, o ensaio é inconclusivo e se repete — nunca
 * verde.
 */
describe('SPEC-086/AC-025 — duas importações com [a, b] e [b, a]: sem ciclo', () => {
  it('as duas esperam em a; soltas, uma grava e a outra recebe 422; nenhuma 40P01 nem 55P03', async () => {
    const [{ dt }] = await observador.$queryRawUnsafe<{ dt: number }[]>(
      `SELECT setting::int * CASE unit WHEN 's' THEN 1000 ELSE 1 END AS dt
         FROM pg_settings WHERE name = 'deadlock_timeout'`,
    );
    // A precondição da spec: o detector age antes do orçamento de 2 s.
    expect(dt).toBeLessThan(2_000);

    let ensaio: Ensaio | null = null;
    const registros: Record<string, unknown>[] = [];
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      const e = await ensaioSemCiclo(tentativa, dt);
      registros.push({
        ...e.registro,
        resultado: e.resultado,
        motivo: e.motivo,
      });
      console.log(`AC-025 ensaio: ${JSON.stringify(registros.at(-1))}`);
      if (e.resultado === 'conclusivo') {
        ensaio = e;
        break;
      }
    }
    // Três inconclusivos não são verde: o teste falha dizendo por quê.
    expect({ conclusivo: ensaio !== null, registros }).toEqual({
      conclusivo: true,
      registros,
    });
    const { respostas, a, b, esperas } = ensaio as Ensaio;

    expect(esperas.map((e) => e.chave)).toEqual([
      chaveEmPgLocks(a),
      chaveEmPgLocks(a),
    ]);
    const detalhe = respostas.map((r) => `${r.status} ${r.text.slice(0, 300)}`);
    expect({ status: respostas.map((r) => r.status).sort(), detalhe }).toEqual({
      status: [201, 422],
      detalhe,
    });
    const recusada = respostas.find((r) => r.status === 422) as Response;
    const erros = bodyOf<{ erros: { coluna: string; mensagem: string }[] }>(
      recusada,
    ).erros;
    expect(erros).toHaveLength(2);
    for (const e of erros) {
      expect(e).toMatchObject({
        coluna: 'email',
        mensagem: MENSAGEM_EMAIL_JA_EXISTE,
      });
    }
    expect(await contasDoEmail(a)).toHaveLength(1);
    expect(await contasDoEmail(b)).toHaveLength(1);
  });
});

// ==========================================================================
// AC-020 — a segunda linha (o tradutor), por entrada
// ==========================================================================

/**
 * O gancho do AC-020: depois que a pré-conferência **de dentro** da
 * transação devolve (a primeira `tx.usuario.findFirst`, ou a `findMany` da
 * E6), uma conexão adversária grava a conta conflitante por SQL direto — sem
 * trava, como um SQL manual — e comita. Só então a pré-conferência devolve o
 * resultado (vazio) para o serviço, que segue e bate na constraint.
 */
interface Gancho {
  metodo: 'findFirst' | 'findMany';
  acao: () => Promise<unknown>;
  disparou: boolean;
  /** O que a pré-conferência devolveu: tem de ser "nada". */
  devolvido?: unknown;
}
let gancho: Gancho | null = null;

type Funcao = (...args: unknown[]) => unknown;

function comMetodosLigados<T extends object>(
  alvo: T,
  trocar: (prop: string | symbol, valor: Funcao) => Funcao | undefined,
): T {
  return new Proxy(alvo, {
    get(t, prop) {
      const valor: unknown = Reflect.get(t, prop, t);
      if (typeof valor !== 'function') return valor;
      const fn = valor as Funcao;
      return (trocar(prop, fn) ?? fn.bind(t)) as unknown;
    },
  });
}

function envolverUsuario(delegate: object): object {
  return comMetodosLigados(delegate, (prop, fn) => {
    const g = gancho;
    if (!g || g.disparou || prop !== g.metodo) return undefined;
    return async (...args: unknown[]) => {
      const devolvido: unknown = await (fn.apply(
        delegate,
        args,
      ) as Promise<unknown>);
      if (!g.disparou) {
        g.disparou = true;
        g.devolvido = devolvido;
        await g.acao();
      }
      return devolvido;
    };
  });
}

function envolverTx(tx: object): object {
  return new Proxy(tx, {
    get(t, prop) {
      const valor: unknown = Reflect.get(t, prop, t);
      if (prop === 'usuario') return envolverUsuario(valor as object);
      return typeof valor === 'function'
        ? ((valor as Funcao).bind(t) as unknown)
        : valor;
    },
  });
}

/** O `PrismaService` dos serviços: o real, com a transação envolvida. */
const prismaComGancho = comMetodosLigados(db, (prop, fn) => {
  if (prop !== '$transaction') return undefined;
  return (arg: unknown, opcoes?: unknown): unknown =>
    typeof arg === 'function'
      ? fn.call(
          db,
          (tx: object) => (arg as (t: object) => unknown)(envolverTx(tx)),
          opcoes,
        )
      : fn.call(db, arg, opcoes);
}) as unknown as PrismaService;

const config = {
  get: (k: string, padrao?: string) =>
    ({ JWT_ACCESS_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d' })[k] ??
    padrao,
  getOrThrow: (k: string) =>
    ({
      JWT_ACCESS_SECRET: 'segredo-de-acesso-do-teste-086-trava',
      JWT_REFRESH_SECRET: 'segredo-de-refresh-do-teste-086-trava',
    })[k] as string,
} as unknown as ConfigService;
const logos = {
  resolver: () => ({ logoUrl: null }),
} as unknown as LogoDaEmpresaService;

const p = prismaComGancho;
const students = new StudentsService(p);
const auth = new AuthService(p, students, new JwtService(), config, logos);
const invites = new InvitesService(p, students, {} as MatriculasService);
const teachers = new TeachersService(p, {} as FotoDeProfessorService);
const memoria = new MemoriaProvedorDeEmail();
const acesso = new AcessoService(p, memoria, MODELOS);
const companies = new CompaniesService(
  p,
  {} as AuthService,
  logos,
  new LevelsService(p),
);
const importacao = new ImportacaoController(
  new ImportacaoDeAlunosService(p, acesso, memoria, MODELOS, {}),
);
const GESTOR_DO_TOKEN = {
  sub: GESTOR,
  email: GESTOR_EMAIL,
  nome: 'Gestora 086 Trava',
  role: 'company_admin',
  companyId: EMPRESA_A,
} as unknown as AccessTokenPayload;

type Escritor = 'E1' | 'E2' | 'E4' | 'E5a' | 'E5b' | 'E6' | 'E7' | 'E8';

interface Preparado {
  /** Chama a entrada (o mesmo pedido, quantas vezes for chamado). */
  executar: () => Promise<unknown>;
  /** O que não pode ter sobrado, além das contas do e-mail. */
  residuo: () => Promise<Record<string, unknown>>;
  residuoEsperado: Record<string, unknown>;
}

/** Monta a fixture e o pedido de cada entrada, com o `email` e o `nome`. */
async function preparar(
  escritor: Escritor,
  email: string,
  nome: string,
): Promise<Preparado> {
  const semResiduo = {
    residuo: async () => ({ alunos: await alunosDoEmail(email) }),
    residuoEsperado: { alunos: 0 },
  };
  switch (escritor) {
    case 'E1':
      return {
        executar: () =>
          auth.registerAluno({
            email,
            senha: SENHA,
            nome,
            empresaSlug: SLUG_A,
          }),
        ...semResiduo,
      };
    case 'E2': {
      const convite = await conviteDeAluno(email, nome);
      return {
        executar: () => invites.aceitar({ token: convite.token, senha: SENHA }),
        residuo: async () => ({
          alunos: await alunosDoEmail(email),
          conviteUsado: await conviteUsado(convite.id),
        }),
        // O convite volta a ser utilizável: o rollback desfez a claim.
        residuoEsperado: { alunos: 0, conviteUsado: false },
      };
    }
    case 'E4':
      return {
        executar: () => students.create(EMPRESA_A, { nome, email }),
        ...semResiduo,
      };
    case 'E5a':
    case 'E5b': {
      const id = await professor(email, nome);
      return {
        executar:
          escritor === 'E5b'
            ? () => teachers.gerarAcesso(EMPRESA_A, id)
            : async () =>
                acesso.enviarParaConta(
                  EMPRESA_A,
                  GESTOR,
                  await teachers.contaParaConvite(EMPRESA_A, id),
                ),
        residuo: async () => ({
          vinculo: await vinculoDoProfessor(id),
          convites: await convitesDeAcessoDoEmail(email),
        }),
        residuoEsperado: { vinculo: null, convites: 0 },
      };
    }
    case 'E6':
      return {
        executar: () =>
          importacao.importar(GESTOR_DO_TOKEN, undefined, {
            buffer: Buffer.from(planilha([[nome, email]]), 'utf8'),
          } as Express.Multer.File),
        ...semResiduo,
      };
    case 'E7': {
      const nomeDaEmpresa = `${PREFIXO_DE_EMPRESA_NOVA} ${randomBytes(4).toString('hex')}`;
      return {
        executar: () =>
          companies.create({
            nome: nomeDaEmpresa,
            esportes: ['Tenis'],
            adminInicial: { nome, email, senha: SENHA },
          }),
        residuo: async () => ({
          empresas: await empresasComONome(nomeDaEmpresa),
        }),
        // Nenhuma empresa órfã, nem o catálogo, horário e níveis dela.
        residuoEsperado: { empresas: 0 },
      };
    }
    case 'E8':
      return {
        executar: () =>
          companies.criarAdmin(EMPRESA_A, { nome, email, senha: SENHA }),
        residuo: () => Promise.resolve({}),
        residuoEsperado: {},
      };
  }
}

async function falhaDe(executar: () => Promise<unknown>): Promise<unknown> {
  try {
    const ok = await executar();
    return { naoFalhou: ok };
  } catch (erro) {
    return erro;
  }
}

function comoHttp(erro: unknown): { status: number; corpo: unknown } | string {
  if (erro instanceof HttpException) {
    return { status: erro.getStatus(), corpo: erro.getResponse() };
  }
  // Erro cru (seria 500): o nome e a mensagem, para o diff dizer o quê.
  const e = erro as { name?: string; code?: string; message?: string };
  return `cru: ${e?.name} ${e?.code ?? ''} ${String(e?.message)}`;
}

/** O status que a pré-conferência de cada entrada dá (tabela "A resposta por entrada"). */
const STATUS_DA_ENTRADA: Record<Escritor, number> = {
  E1: 422,
  E2: 422,
  E4: 409,
  E5a: 409,
  E5b: 409,
  E6: 422,
  E7: 422,
  E8: 409,
};

type Conflito = {
  rotulo: string;
  constraint: string;
  role: 'aluno' | 'company_admin';
  empresa: string;
};

const DE_ALUNO_OU_PROFESSOR: Conflito[] = [
  {
    rotulo: 'aluno na mesma empresa',
    constraint: 'usuarios_company_id_email_key',
    role: 'aluno',
    empresa: EMPRESA_A,
  },
  {
    rotulo: 'gestor em outra empresa',
    constraint: 'usuarios_email_gestao_excl',
    role: 'company_admin',
    empresa: EMPRESA_B,
  },
];
const DE_GESTOR: Conflito[] = [
  {
    rotulo: 'gestor em outra empresa',
    constraint: 'usuarios_email_gestao_key',
    role: 'company_admin',
    empresa: EMPRESA_B,
  },
  {
    rotulo: 'aluno em outra empresa',
    constraint: 'usuarios_email_gestao_excl',
    role: 'aluno',
    empresa: EMPRESA_B,
  },
];

const CASOS_DO_AC020: [Escritor, Conflito][] = [
  ...(['E1', 'E2', 'E4', 'E5a', 'E5b', 'E6'] as const).flatMap((x) =>
    DE_ALUNO_OU_PROFESSOR.map((c): [Escritor, Conflito] => [x, c]),
  ),
  ...(['E7', 'E8'] as const).flatMap((x) =>
    DE_GESTOR.map((c): [Escritor, Conflito] => [x, c]),
  ),
];

/** As violações alheias, de fixture (controle negativo). */
const CHECK_ALHEIO = 'spec086_trava_alheio_chk';
const EXCLUDE_ALHEIO = 'spec086_trava_alheio_excl';
const PREFIXO_CHECK = 'spec086-trava-chk-';
const PREFIXO_NOME_ALHEIO = 'Alheio086';

describe('SPEC-086/AC-020 — a segunda linha: conta gravada por fora depois da pré-conferência', () => {
  afterEach(() => {
    gancho = null;
  });

  /**
   * Para cada entrada e cada constraint aplicável, a resposta é a da
   * pré-conferência daquela rota — conferida chamando a mesma entrada de
   * novo, já com a conta comitada, que cai na pré-conferência — e nunca um
   * erro cru (`500`). E nada da transação perdedora sobra.
   *
   * - S3 (tradutor sem o `Unknown` da API de modelo): o `EXCLUDE` de gestão ×
   *   aluno chega como `PrismaClientUnknownRequestError` e sobe cru — os
   *   casos "gestor em outra empresa" (E1–E5b) e "aluno em outra empresa"
   *   (E7, E8) ficam vermelhos.
   * - S17 (sem o `catch` do E5b): os dois casos da E5b sobem crus.
   */
  it.each(CASOS_DO_AC020.map(([x, c]) => [x, c.rotulo, c] as const))(
    '%s × %s',
    async (escritor, _rotulo, conflito) => {
      const email = emailNovo(`ac20-${escritor.toLowerCase()}`);
      const nome = `Pessoa ${escritor}`;
      const preparado = await preparar(escritor, email, nome);
      gancho = {
        metodo: escritor === 'E6' ? 'findMany' : 'findFirst',
        acao: () => contaPorFora(email, conflito.role, conflito.empresa),
        disparou: false,
      };

      const erro = await falhaDe(preparado.executar);
      const g = gancho;
      gancho = null;

      // O gancho rodou, e depois de uma pré-conferência que não achou nada:
      // a conta nasceu na janela entre ela e o INSERT.
      expect(g.disparou).toBe(true);
      expect(
        g.devolvido === null ||
          (Array.isArray(g.devolvido) && g.devolvido.length === 0),
      ).toBe(true);

      const naCorrida = comoHttp(erro);
      // A pré-conferência da mesma rota, com a conta já comitada.
      const naPreconferencia = comoHttp(await falhaDe(preparado.executar));
      expect(naCorrida).toEqual(naPreconferencia);
      expect(naCorrida).toMatchObject({ status: STATUS_DA_ENTRADA[escritor] });

      // Só a conta de fora; nada da transação perdedora.
      expect(await contasDoEmail(email)).toEqual([
        { role: conflito.role, company_id: conflito.empresa },
      ]);
      expect(await preparado.residuo()).toEqual(preparado.residuoEsperado);
    },
  );

  describe('controle negativo: violação alheia continua subindo crua', () => {
    beforeAll(async () => {
      await q(`ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS ${CHECK_ALHEIO}`);
      await q(
        `ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS ${EXCLUDE_ALHEIO}`,
      );
      // Fixture: um CHECK e um EXCLUDE que nenhuma regra de e-mail conhece,
      // restritos a e-mails e nomes desta suíte.
      await q(
        `ALTER TABLE usuarios ADD CONSTRAINT ${CHECK_ALHEIO}
           CHECK (email NOT LIKE '${PREFIXO_CHECK}%') NOT VALID`,
      );
      await q(
        `ALTER TABLE usuarios ADD CONSTRAINT ${EXCLUDE_ALHEIO}
           EXCLUDE USING gist (nome WITH =) WHERE (nome LIKE '${PREFIXO_NOME_ALHEIO}%')`,
      );
    });
    afterAll(async () => {
      await q(`ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS ${CHECK_ALHEIO}`);
      await q(
        `ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS ${EXCLUDE_ALHEIO}`,
      );
    });

    /** O CHECK real de papel × empresa, pela API de modelo, não é de e-mail. */
    it('o CHECK usuarios_company_id_role_check (aluno sem empresa) não é reconhecido pelo tradutor', async () => {
      const erro = await falhaDe(() =>
        db.usuario.create({
          data: {
            email: emailNovo('chk-real'),
            senhaHash: 'h',
            nome: 'Sem empresa',
            role: 'aluno',
            companyId: null,
          },
        }),
      );
      expect(String((erro as Error).message)).toContain(
        'usuarios_company_id_role_check',
      );
      expect(ehViolacaoDeEmail(erro)).toBe(false);
      expect(traduzirViolacaoDeUnicidade(erro)).toBe(erro);
    });

    const ESCRITORES: Escritor[] = [
      'E1',
      'E2',
      'E4',
      'E5a',
      'E5b',
      'E6',
      'E7',
      'E8',
    ];

    /**
     * Pelo caminho de cada entrada: um `EXCLUDE` alheio (gravado pelo gancho
     * na mesma janela) e um `CHECK` alheio. S4 (tradutor que casa qualquer
     * `Unknown`) traduz o `EXCLUDE` alheio para a resposta da rota — e o
     * `not.toBeInstanceOf(HttpException)` fica vermelho.
     */
    it.each(ESCRITORES)(
      '%s: EXCLUDE alheio de fixture sobe cru, sem resíduo',
      async (escritor) => {
        const email = emailNovo(`ac20-excl-${escritor.toLowerCase()}`);
        const nome = `${PREFIXO_NOME_ALHEIO} ${escritor} ${seq}`;
        const preparado = await preparar(escritor, email, nome);
        gancho = {
          metodo: escritor === 'E6' ? 'findMany' : 'findFirst',
          // Outra pessoa, outro e-mail, o mesmo nome: só o EXCLUDE alheio.
          acao: () =>
            contaPorFora(emailNovo('alheio'), 'aluno', EMPRESA_B, nome),
          disparou: false,
        };
        const erro = await falhaDe(preparado.executar);
        expect(gancho.disparou).toBe(true);
        gancho = null;

        expect(erro).not.toBeInstanceOf(HttpException);
        expect(comoHttp(erro)).toContain(EXCLUDE_ALHEIO);
        expect(await contasDoEmail(email)).toEqual([]);
        expect(await preparado.residuo()).toEqual(preparado.residuoEsperado);
      },
    );

    it.each(ESCRITORES)(
      '%s: CHECK alheio de fixture sobe cru, sem resíduo',
      async (escritor) => {
        const email = `${PREFIXO_CHECK}${escritor.toLowerCase()}-${randomBytes(3).toString('hex')}@teste.local`;
        const preparado = await preparar(escritor, email, `Pessoa ${escritor}`);
        const erro = await falhaDe(preparado.executar);

        expect(erro).not.toBeInstanceOf(HttpException);
        expect(comoHttp(erro)).toContain(CHECK_ALHEIO);
        expect(await contasDoEmail(email)).toEqual([]);
        expect(await preparado.residuo()).toEqual(preparado.residuoEsperado);
      },
    );
  });
});
