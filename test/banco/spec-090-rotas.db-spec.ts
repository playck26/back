/**
 * SPEC-090/TASK-002 — **as três rotas do "esqueci minha senha", pela HTTP real
 * e com banco real.** REQ-002 e REQ-003: AC-003, AC-005 a AC-017 (o que pede
 * banco), AC-022, AC-029 e AC-030.
 *
 * Por que HTTP real e não o serviço com dublê, pela razão do
 * `spec-086-login.db-spec.ts`: o que está em julgamento é o que sai pela rota
 * (status, corpo byte a byte) e o que fica no banco (o pedido, as contas, a
 * senha, os `refresh_tokens` por conta). O `test/redefinicao.e2e-spec.ts`
 * fica com o que a camada HTTP decide sozinha (o `202` sem esperar, o `400`, o
 * limite por IP), e o `redefinicao.service.spec.ts` com a regra pura.
 *
 * **O pedido roda DEPOIS da resposta** (D1). Para o teste saber quando ele
 * terminou, o `solicitar` do serviço é espionado (sem trocar o que ele faz) e
 * cada chamada espera as promessas que ele devolveu.
 *
 * **O limite de 10 por IP** vale para as três rotas e para o login: cada
 * requisição vai com um `do-connecting-ip` próprio (DEF-031). O limite tem
 * prova própria no e2e.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { RedefinicaoService } from '../../src/acesso/redefinicao.service';
import type { LogoDaEmpresaService } from '../../src/companies/logo-da-empresa.service';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import { PROVEDOR_DE_EMAIL } from '../../src/email/provedor-de-email';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { garantirAmbienteDeFit } from '../fit/app-real';
import { createTestApp } from '../utils/create-test-app';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture } from './nivel-da-fixture';

jest.setTimeout(120_000);
exigirBancoLocal();

// Antes de o app subir: o `EmailModule` lê no boot. Provedor memória (nada
// sai daqui) e as duas origens de teste, para o AC-008 provar que o link vem
// delas.
process.env.EMAIL_PROVEDOR = 'memoria';
const URL_CLIENTE = 'https://cliente.spec090.teste.local';
const URL_ADMIN = 'https://admin.spec090.teste.local';
process.env.URL_CLIENTE = URL_CLIENTE;
process.env.URL_ADMIN = URL_ADMIN;

/** O corpo do `410`, como a D4 o fixa — e como a rota tem de devolver. */
const REDEFINICAO_INVALIDA = {
  statusCode: 410,
  code: 'LINK_INVALIDO',
  message: 'Este link não vale mais. Peça outro em "Esqueceu a senha?".',
};
const CREDENCIAIS_INVALIDAS = {
  statusCode: 401,
  message: 'Credenciais inválidas',
  error: 'Unauthorized',
};
const ESCOLHA_EXPIRADA = {
  statusCode: 401,
  code: 'ESCOLHA_EXPIRADA',
  message: 'A escolha de empresa expirou. Entre de novo.',
};

const PREFIXO = 'spec090-rotas';
const SENHA = 'spec-090-rotas-senha';

const db = new PrismaClient();
const q = (sql: string, ...v: unknown[]) => db.$executeRawUnsafe(sql, ...v);
const ler = <T>(sql: string, ...v: unknown[]) =>
  db.$queryRawUnsafe<T[]>(sql, ...v);
const jwt = new JwtService();

let app: INestApplication<App>;
let memoria: MemoriaProvedorDeEmail;
let espiaoDoPedido: jest.SpyInstance;
let segredoDoAccess: string;
const empresasCriadas: string[] = [];
const usuariosSemEmpresa: string[] = [];

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let seq = 0;
function emailNovo(rotulo: string): string {
  seq += 1;
  return `${PREFIXO}-${rotulo}-${seq}@teste.local`;
}

async function empresa(
  opcoes: {
    nome?: string;
    status?: 'ativa' | 'inativa';
    logoUrl?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  empresasCriadas.push(id);
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,status,logo_url,updated_at)
       VALUES ('${id}',$1,'${PREFIXO}-${id}','${opcoes.status ?? 'ativa'}',$2,now())`,
    ),
    opcoes.nome ?? `SPEC-090 rotas ${id.slice(0, 8)}`,
    opcoes.logoUrl ?? null,
  );
  return id;
}

type Papel = 'aluno' | 'professor' | 'company_admin' | 'super_admin';

interface OpcoesDaConta {
  papel?: Papel;
  status?: 'ativo' | 'inativo';
  /** `vencida`: senha temporária vencida; `valendo`: ainda vale um dia. */
  temporaria?: 'vencida' | 'valendo';
  senha?: string;
  nome?: string;
}

/** Uma conta, por SQL (custo 4, fixture). `companyId` nulo é o super admin. */
async function conta(
  companyId: string | null,
  email: string,
  opcoes: OpcoesDaConta = {},
): Promise<string> {
  const id = randomUUID();
  if (companyId === null) usuariosSemEmpresa.push(id);
  const expira =
    opcoes.temporaria === 'vencida'
      ? "now() - interval '1 day'"
      : opcoes.temporaria === 'valendo'
        ? "now() + interval '1 day'"
        : 'NULL';
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,telefone,role,company_id,status,
                           senha_temporaria,senha_temporaria_expira_em,updated_at)
     VALUES ($1::uuid,$2,$3,$4,'11999990090','${opcoes.papel ?? 'aluno'}',$5::uuid,
             '${opcoes.status ?? 'ativo'}',${opcoes.temporaria !== undefined},${expira},now())`,
    id,
    email,
    await bcrypt.hash(opcoes.senha ?? SENHA, 4),
    opcoes.nome ?? 'Pessoa Spec Noventa',
    companyId,
  );
  return id;
}

async function sessoesVivas(usuarioId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await q(
      `INSERT INTO refresh_tokens (id,usuario_id,token_hash,expires_at)
       VALUES (gen_random_uuid(),$1::uuid,$2,now() + interval '1 day')`,
      usuarioId,
      `${PREFIXO}-${randomUUID()}`,
    );
  }
}

async function refreshVivos(usuarioId: string): Promise<number> {
  const [r] = await ler<{ n: number }>(
    `SELECT count(*)::int AS n FROM refresh_tokens
      WHERE usuario_id = $1::uuid AND revoked_at IS NULL`,
    usuarioId,
  );
  return r.n;
}

interface LinhaDoPedido {
  id: string;
  email: string;
  token_hash: string;
  expira_em: Date;
  usado_em: Date | null;
  email_resultado: string | null;
  email_motivo: string | null;
  email_em: Date | null;
  criado_em: Date;
}

async function pedidosDe(email: string): Promise<LinhaDoPedido[]> {
  return ler<LinhaDoPedido>(
    `SELECT id::text, email, token_hash, expira_em, usado_em,
            email_resultado::text AS email_resultado, email_motivo, email_em,
            criado_em
       FROM pedidos_de_redefinicao WHERE email = $1 ORDER BY criado_em, id`,
    email,
  );
}

async function pedidoPorToken(token: string): Promise<LinhaDoPedido> {
  const [linha] = await ler<LinhaDoPedido>(
    `SELECT id::text, email, token_hash, expira_em, usado_em,
            email_resultado::text AS email_resultado, email_motivo, email_em,
            criado_em
       FROM pedidos_de_redefinicao WHERE token_hash = $1`,
    sha256(token),
  );
  return linha;
}

async function contasDoPedido(pedidoId: string): Promise<string[]> {
  const linhas = await ler<{ usuario_id: string }>(
    `SELECT usuario_id::text FROM contas_da_redefinicao
      WHERE pedido_id = $1::uuid ORDER BY usuario_id`,
    pedidoId,
  );
  return linhas.map((l) => l.usuario_id);
}

async function senhaHashDe(usuarioId: string): Promise<string> {
  return (await db.usuario.findUniqueOrThrow({ where: { id: usuarioId } }))
    .senhaHash;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let ipSeq = 0;
function ipNovo(): string {
  ipSeq += 1;
  return `10.90.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

const http = () => request(app.getHttpServer());

/**
 * `POST /auth/esqueci-senha`, e espera o pedido terminar: a resposta sai
 * antes dele (D1), e o teste só pode olhar o banco e o provedor depois.
 */
async function pedir(
  email: string,
  cabecalhos: Record<string, string> = {},
): Promise<Response> {
  let req = http()
    .post('/api/v1/auth/esqueci-senha')
    .set('do-connecting-ip', ipNovo());
  for (const [nome, valor] of Object.entries(cabecalhos)) {
    req = req.set(nome, valor);
  }
  const res = await req.send({ email });
  await Promise.allSettled(
    espiaoDoPedido.mock.results.map((r) => r.value as Promise<void>),
  );
  return res;
}

function consultar(token: string): Promise<Response> {
  return http()
    .get(`/api/v1/public/redefinicao/${encodeURIComponent(token)}`)
    .set('do-connecting-ip', ipNovo())
    .then((r) => r);
}

function redefinir(
  token: string,
  usuarioId: string,
  senha: string,
): Promise<Response> {
  return http()
    .post('/api/v1/public/redefinicao')
    .set('do-connecting-ip', ipNovo())
    .send({ token, usuarioId, senha })
    .then((r) => r);
}

function login(email: string, senha: string): Promise<Response> {
  return http()
    .post('/api/v1/auth/login')
    .set('do-connecting-ip', ipNovo())
    .send({ email, senha })
    .then((r) => r);
}

/** Um access token assinado com o segredo do app, como o login emitiria. */
function sessaoDe(dados: {
  id: string;
  email: string;
  role: Papel;
  companyId: string | null;
}): string {
  return jwt.sign(
    {
      sub: dados.id,
      email: dados.email,
      nome: 'Pessoa Spec Noventa',
      role: dados.role,
      companyId: dados.companyId,
    },
    { secret: segredoDoAccess, expiresIn: '10m' },
  );
}

/** O link do último e-mail enviado para `para`, partido em origem e token. */
function linkPara(para: string): { origem: string; token: string } {
  const mensagem = [...memoria.enviados].reverse().find((m) => m.to === para);
  expect(mensagem).toBeDefined();
  const achado =
    /(https?:\/\/[^\s/]+)\/redefinir-senha\/([A-Za-z0-9_-]{43})/.exec(
      mensagem!.text,
    );
  expect(achado).not.toBeNull();
  return { origem: achado![1], token: achado![2] };
}

function enviadosPara(para: string): number {
  return memoria.enviados.filter((m) => m.to === para).length;
}

interface ContaDoCorpo {
  usuarioId: string;
  papel: string;
  empresa: { nome: string; logoUrl: string | null };
}

// ---------------------------------------------------------------------------

/** Tudo o que foi a log, para o AC-017. */
const METODOS_DO_LOGGER = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
let espioesDoLogger: jest.SpyInstance[] = [];

beforeAll(async () => {
  garantirAmbienteDeFit();
  app = await createTestApp(db);
  memoria = app.get(PROVEDOR_DE_EMAIL);
  expect(memoria).toBeInstanceOf(MemoriaProvedorDeEmail);
  espiaoDoPedido = jest.spyOn(app.get(RedefinicaoService), 'solicitar');
  segredoDoAccess = app
    .get(ConfigService)
    .getOrThrow<string>('JWT_ACCESS_SECRET');
  espioesDoLogger = METODOS_DO_LOGGER.map((metodo) =>
    jest.spyOn(Logger.prototype, metodo).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  memoria.falharCom(null);
});

afterAll(async () => {
  await app?.close();
  for (const id of empresasCriadas) {
    await limparEmpresa(db, id);
  }
  for (const id of usuariosSemEmpresa) {
    await q(`DELETE FROM usuarios WHERE id = $1::uuid`, id);
  }
  // Os pedidos que o teto semeou por SQL nunca tiveram conta: a limpeza da
  // empresa não os alcança (D2), e saem pelo prefixo do e-mail.
  await q(`DELETE FROM pedidos_de_redefinicao WHERE email LIKE '${PREFIXO}-%'`);
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// REQ-002 — pedir o link
// ---------------------------------------------------------------------------

describe('SPEC-090/AC-003 — o pedido responde igual para os sete casos; só a conta ativa e o gestor geram pedido e envio', () => {
  it('202, mesmo corpo e mesmos cabeçalhos de conteúdo; pedido e envio só para conta ativa e gestor (S2)', async () => {
    const ativa = emailNovo('ativa');
    await conta(await empresa(), ativa);

    const semConta = emailNovo('sem-conta');

    const inativa = emailNovo('inativa');
    await conta(await empresa(), inativa, { status: 'inativo' });

    const deEmpresaInativa = emailNovo('empresa-inativa');
    await conta(await empresa({ status: 'inativa' }), deEmpresaInativa);

    const superAdmin = emailNovo('super');
    await conta(null, superAdmin, { papel: 'super_admin' });

    const acimaDoTeto = emailNovo('teto');
    await conta(await empresa(), acimaDoTeto);
    for (let i = 0; i < 3; i++) {
      await q(
        `INSERT INTO pedidos_de_redefinicao (email,token_hash,expira_em)
         VALUES ($1,$2,now() + interval '1 hour')`,
        acimaDoTeto,
        `${PREFIXO}-teto-${randomUUID()}`,
      );
    }

    const gestor = emailNovo('gestor');
    await conta(await empresa(), gestor, { papel: 'company_admin' });

    const casos = [
      ativa,
      semConta,
      inativa,
      deEmpresaInativa,
      superAdmin,
      acimaDoTeto,
      gestor,
    ];
    const respostas: Response[] = [];
    for (const email of casos) {
      respostas.push(await pedir(email));
    }

    const assinatura = (r: Response) => ({
      status: r.status,
      corpo: r.text,
      tipo: r.headers['content-type'] as unknown,
      tamanho: r.headers['content-length'] as unknown,
      transferencia: r.headers['transfer-encoding'] as unknown,
    });
    expect(respostas[0].status).toBe(202);
    for (const r of respostas) {
      expect(assinatura(r)).toEqual(assinatura(respostas[0]));
    }

    // No banco e no provedor: só a conta ativa e o gestor.
    expect((await pedidosDe(ativa)).length).toBe(1);
    expect((await pedidosDe(gestor)).length).toBe(1);
    for (const email of [semConta, inativa, deEmpresaInativa, superAdmin]) {
      expect(await pedidosDe(email)).toEqual([]);
      expect(enviadosPara(email)).toBe(0);
    }
    expect((await pedidosDe(acimaDoTeto)).length).toBe(3); // os três semeados
    expect(enviadosPara(acimaDoTeto)).toBe(0);
    expect(enviadosPara(ativa)).toBe(1);
    expect(enviadosPara(gestor)).toBe(1);
  });
});

describe('SPEC-090/AC-005 — um e-mail em três clubes, um deles inativo: um pedido, duas contas, um envio', () => {
  it('aluno em A, professor em B, aluno inativo em C', async () => {
    const email = emailNovo('tres-clubes');
    const a = await conta(await empresa(), email);
    const b = await conta(await empresa(), email, { papel: 'professor' });
    await conta(await empresa(), email, { status: 'inativo' });

    expect((await pedir(email)).status).toBe(202);

    const pedidos = await pedidosDe(email);
    expect(pedidos).toHaveLength(1);
    expect(await contasDoPedido(pedidos[0].id)).toEqual([a, b].sort());
    expect(enviadosPara(email)).toBe(1);
    const mensagem = memoria.enviados.find((m) => m.to === email)!;
    expect(mensagem.text).toContain('Seu e-mail tem conta em 2 clubes.');
    expect(mensagem.html).toContain('Seu e-mail tem conta em 2 clubes.');
    // O pedido grava o resultado do envio (D3, passo 5).
    expect(pedidos[0].email_resultado).toBe('enviado');
    expect(pedidos[0].email_em).not.toBeNull();
    // Validade de 60 minutos, do mesmo `now()` que `criado_em`.
    expect(
      pedidos[0].expira_em.getTime() - pedidos[0].criado_em.getTime(),
    ).toBe(60 * 60 * 1000);
  });
});

describe('SPEC-090/AC-006 — senha temporária e convite pendente entram no pedido (I4, S10)', () => {
  it.each<[string, OpcoesDaConta['temporaria']]>([
    ['senha temporária vencida', 'vencida'],
    ['senha temporária ainda valendo', 'valendo'],
  ])('%s', async (_rotulo, temporaria) => {
    const email = emailNovo(`temporaria-${temporaria}`);
    const id = await conta(await empresa(), email, { temporaria });
    await pedir(email);
    const pedidos = await pedidosDe(email);
    expect(pedidos).toHaveLength(1);
    expect(await contasDoPedido(pedidos[0].id)).toEqual([id]);
    expect(enviadosPara(email)).toBe(1);
  });

  it('conta com convite da SPEC-083 pendente', async () => {
    const companyId = await empresa();
    const gestor = await conta(companyId, emailNovo('gestor-do-convite'), {
      papel: 'company_admin',
    });
    const email = emailNovo('convite-pendente');
    const id = await conta(companyId, email, { temporaria: 'valendo' });
    await q(
      `INSERT INTO convites_de_acesso
         (company_id,usuario_id,criado_por_id,token_hash,impressao_credencial,expira_em)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,now() + interval '7 days')`,
      companyId,
      id,
      gestor,
      `${PREFIXO}-convite-${randomUUID()}`,
      sha256(await senhaHashDe(id)),
    );
    await pedir(email);
    const pedidos = await pedidosDe(email);
    expect(pedidos).toHaveLength(1);
    expect(await contasDoPedido(pedidos[0].id)).toEqual([id]);
  });
});

describe('SPEC-090/AC-007 — o teto de 3 por e-mail por hora (S11)', () => {
  it('o 4º pedido na mesma hora responde 202 e não grava nem envia', async () => {
    const email = emailNovo('quarto');
    await conta(await empresa(), email);
    for (let i = 0; i < 3; i++) {
      expect((await pedir(email)).status).toBe(202);
    }
    expect(await pedidosDe(email)).toHaveLength(3);
    expect(enviadosPara(email)).toBe(3);

    const quarto = await pedir(email);
    expect(quarto.status).toBe(202);
    expect(quarto.text).toBe('');
    expect(await pedidosDe(email)).toHaveLength(3);
    expect(enviadosPara(email)).toBe(3);
  });

  it('o pedido de 61 minutos atrás não conta: com ele e mais dois, o próximo ainda sai', async () => {
    const email = emailNovo('janela');
    await conta(await empresa(), email);
    await q(
      `INSERT INTO pedidos_de_redefinicao (email,token_hash,expira_em,criado_em)
       VALUES ($1,$2,now(),now() - interval '61 minutes')`,
      email,
      `${PREFIXO}-velho-${randomUUID()}`,
    );
    await pedir(email);
    await pedir(email);
    expect(await pedidosDe(email)).toHaveLength(3);

    await pedir(email); // 3º da hora: sai
    expect(await pedidosDe(email)).toHaveLength(4);
    expect(enviadosPara(email)).toBe(3);

    await pedir(email); // 4º da hora: não sai
    expect(await pedidosDe(email)).toHaveLength(4);
    expect(enviadosPara(email)).toBe(3);
  });
});

describe('SPEC-090/AC-008 — o link pelo papel, nunca pela requisição (S3, S4)', () => {
  it('aluno recebe link de URL_CLIENTE; gestor, de URL_ADMIN', async () => {
    const aluno = emailNovo('link-aluno');
    await conta(await empresa(), aluno);
    const gestor = emailNovo('link-gestor');
    await conta(await empresa(), gestor, { papel: 'company_admin' });

    await pedir(aluno);
    await pedir(gestor);
    expect(linkPara(aluno).origem).toBe(URL_CLIENTE);
    expect(linkPara(gestor).origem).toBe(URL_ADMIN);
  });

  it('Host, Origin e Referer forjados produzem o mesmo link', async () => {
    const email = emailNovo('forjado');
    await conta(await empresa(), email);

    await pedir(email);
    const limpo = linkPara(email);
    await pedir(email, {
      Host: 'atacante.exemplo',
      Origin: 'https://atacante.exemplo',
      Referer: 'https://atacante.exemplo/esqueci-senha',
      'X-Forwarded-Host': 'atacante.exemplo',
    });
    const forjado = linkPara(email);

    expect(forjado.token).not.toBe(limpo.token); // é outro pedido
    expect(forjado.origem).toBe(limpo.origem);
    expect(forjado.origem).toBe(URL_CLIENTE);
    const mensagem = [...memoria.enviados]
      .reverse()
      .find((m) => m.to === email)!;
    expect(mensagem.html).not.toContain('atacante');
    expect(mensagem.text).not.toContain('atacante');
  });
});

describe('SPEC-090/AC-009 — papéis misturados (EXCLUDE desligado só nesta transação): não grava nem envia', () => {
  it('gestor e aluno com o mesmo e-mail, por escrita direta: nenhum pedido, nenhum envio, e o evento sem o e-mail', async () => {
    const email = emailNovo('misturado');
    const misturado = new MemoriaProvedorDeEmail();
    const espiaoWarn = jest.spyOn(Logger.prototype, 'warn');
    espiaoWarn.mockClear();
    let pedidosNaTransacao = -1;

    class Desfazer extends Error {}
    await db
      .$transaction(
        async (tx) => {
          // O EXCLUDE `usuarios_email_gestao_excl` cai e volta junto com o
          // ROLLBACK: nada disto sai desta transação.
          await tx.$executeRawUnsafe(
            'ALTER TABLE usuarios DROP CONSTRAINT usuarios_email_gestao_excl',
          );
          const ea = randomUUID();
          const eb = randomUUID();
          for (const id of [ea, eb]) {
            await tx.$executeRawUnsafe(
              comNivelDaFixture(
                `INSERT INTO empresas (id,nome,slug,status,updated_at)
                 VALUES ('${id}','SPEC-090 misturado ${id}','${PREFIXO}-mist-${id}','ativa',now())`,
              ),
            );
          }
          const hash = await bcrypt.hash(SENHA, 4);
          await tx.$executeRawUnsafe(
            `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
             VALUES (gen_random_uuid(),$1,$2,'G','company_admin',$3::uuid,now()),
                    (gen_random_uuid(),$1,$2,'A','aluno',$4::uuid,now())`,
            email,
            hash,
            ea,
            eb,
          );

          // O serviço real, com o Prisma da transação: ele vê as duas contas.
          const prismaNaTransacao = {
            $transaction: (cb: (t: unknown) => Promise<unknown>) => cb(tx),
            pedidoDeRedefinicao: tx.pedidoDeRedefinicao,
          } as unknown as PrismaService;
          const servico = new RedefinicaoService(
            prismaNaTransacao,
            misturado,
            {
              remetente: 'nao-responda@playck.com.br',
              responderPara: 'suporte@playck.com.br',
              urlCliente: URL_CLIENTE,
              urlAdmin: URL_ADMIN,
            },
            {
              resolver: () => ({ logoUrl: null }),
            } as unknown as LogoDaEmpresaService,
          );
          await servico.solicitar(email);

          const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM pedidos_de_redefinicao WHERE email = $1`,
            email,
          );
          pedidosNaTransacao = n;
          throw new Desfazer();
        },
        { timeout: 30_000 },
      )
      .catch((erro: unknown) => {
        if (!(erro instanceof Desfazer)) throw erro;
      });

    expect(pedidosNaTransacao).toBe(0);
    expect(misturado.blocos).toHaveLength(0);
    const avisos = JSON.stringify(espiaoWarn.mock.calls);
    expect(avisos).toContain('redefinicao_papeis_misturados');
    expect(avisos).not.toContain(email);

    // E o EXCLUDE voltou: o ROLLBACK desfez o DROP.
    const [{ existe }] = await ler<{ existe: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'usuarios_email_gestao_excl') AS existe`,
    );
    expect(existe).toBe(true);
  });
});

describe('SPEC-090/AC-022 — envio falhando: o pedido fica com falhou e o motivo; a resposta já tinha sido 202', () => {
  it.each(['cota', 'indisponivel', 'tempo_esgotado'] as const)(
    '%s',
    async (motivo) => {
      const email = emailNovo(`falha-${motivo}`);
      await conta(await empresa(), email);
      memoria.falharCom(motivo);

      const res = await pedir(email);
      expect(res.status).toBe(202);

      const [pedido] = await pedidosDe(email);
      expect(pedido.email_resultado).toBe('falhou');
      expect(pedido.email_motivo).toBe(motivo);
      expect(pedido.email_em).not.toBeNull();
      expect(enviadosPara(email)).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// REQ-003 — ver as contas e redefinir
// ---------------------------------------------------------------------------

describe('SPEC-090/AC-010 — o GET devolve as contas aceitas, na ordem, sem e-mail nem nome', () => {
  it('três clubes, em ordem de nome; papel e empresa (nome e logo); nenhuma outra chave', async () => {
    const email = emailNovo('lista');
    const zeta = await empresa({ nome: 'Zeta Tênis 090' });
    const alfa = await empresa({
      nome: 'Alfa Clube 090',
      logoUrl: 'https://cdn.exemplo.local/spec090-alfa.png',
    });
    const meio = await empresa({ nome: 'Meio Esportes 090' });
    const cz = await conta(zeta, email, { nome: 'Fulana de Tal' });
    const ca = await conta(alfa, email, {
      papel: 'professor',
      nome: 'Fulana de Tal',
    });
    const cm = await conta(meio, email, { nome: 'Fulana de Tal' });

    await pedir(email);
    const res = await consultar(linkPara(email).token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      contas: [
        {
          usuarioId: ca,
          papel: 'professor',
          empresa: {
            nome: 'Alfa Clube 090',
            logoUrl: 'https://cdn.exemplo.local/spec090-alfa.png',
          },
        },
        {
          usuarioId: cm,
          papel: 'aluno',
          empresa: { nome: 'Meio Esportes 090', logoUrl: null },
        },
        {
          usuarioId: cz,
          papel: 'aluno',
          empresa: { nome: 'Zeta Tênis 090', logoUrl: null },
        },
      ],
    });
    // Por chave do JSON, e não só por igualdade: nada além destas.
    const corpo = res.body as { contas: ContaDoCorpo[] };
    expect(Object.keys(corpo)).toEqual(['contas']);
    for (const c of corpo.contas) {
      expect(Object.keys(c).sort()).toEqual(['empresa', 'papel', 'usuarioId']);
      expect(Object.keys(c.empresa).sort()).toEqual(['logoUrl', 'nome']);
    }
    expect(res.text).not.toContain(email);
    expect(res.text).not.toContain('Fulana');

    // Não consome: o mesmo GET de novo, igual.
    const outra = await consultar(linkPara(email).token);
    expect(outra.status).toBe(200);
    expect(outra.body).toEqual(res.body);
  });
});

describe('SPEC-090/AC-011 — o GET responde 410 com o mesmo corpo, byte a byte, para todo link morto (S5, S12)', () => {
  /** Um pedido de uma conta, por HTTP: o token e o id da conta. */
  async function linkDeUmaConta(rotulo: string) {
    const email = emailNovo(rotulo);
    const companyId = await empresa();
    const id = await conta(companyId, email);
    await pedir(email);
    return { email, companyId, id, token: linkPara(email).token };
  }

  it('malformado, inexistente, usado, expirado, conta inativa, empresa inativa e senha trocada: o mesmo texto', async () => {
    const corpos: [string, Response][] = [];

    corpos.push(['malformado', await consultar('nao-e-um-token')]);
    corpos.push([
      'inexistente',
      await consultar(randomBytes(32).toString('base64url')),
    ]);

    const usado = await linkDeUmaConta('usado');
    expect(
      (await redefinir(usado.token, usado.id, 'spec-090-nova-usado')).status,
    ).toBe(204);
    corpos.push(['usado', await consultar(usado.token)]);

    const expirado = await linkDeUmaConta('expirado');
    await q(
      `UPDATE pedidos_de_redefinicao SET expira_em = now() - interval '1 second'
        WHERE token_hash = $1`,
      sha256(expirado.token),
    );
    corpos.push(['expirado', await consultar(expirado.token)]);

    const inativa = await linkDeUmaConta('conta-inativa');
    await q(
      `UPDATE usuarios SET status = 'inativo' WHERE id = $1::uuid`,
      inativa.id,
    );
    corpos.push(['conta inativa', await consultar(inativa.token)]);

    const empresaInativa = await linkDeUmaConta('empresa-inativa-get');
    await q(
      `UPDATE empresas SET status = 'inativa' WHERE id = $1::uuid`,
      empresaInativa.companyId,
    );
    corpos.push(['empresa inativa', await consultar(empresaInativa.token)]);

    const trocada = await linkDeUmaConta('senha-trocada');
    await q(
      `UPDATE usuarios SET senha_hash = $2 WHERE id = $1::uuid`,
      trocada.id,
      await bcrypt.hash('outra-senha-qualquer', 4),
    );
    corpos.push(['senha trocada', await consultar(trocada.token)]);

    expect(corpos).toHaveLength(7);
    const [, primeiro] = corpos[0];
    expect(primeiro.body).toEqual(REDEFINICAO_INVALIDA);
    for (const [rotulo, r] of corpos) {
      expect({ rotulo, status: r.status, texto: r.text }).toEqual({
        rotulo,
        status: 410,
        texto: primeiro.text,
      });
    }
  });

  it('duas contas, uma de senha trocada: o GET devolve só a outra', async () => {
    const email = emailNovo('uma-trocada');
    const a = await conta(await empresa({ nome: 'A uma-trocada 090' }), email);
    const b = await conta(await empresa({ nome: 'B uma-trocada 090' }), email);
    await pedir(email);
    const { token } = linkPara(email);
    await q(
      `UPDATE usuarios SET senha_hash = $2 WHERE id = $1::uuid`,
      a,
      await bcrypt.hash('outra-senha-qualquer', 4),
    );
    const res = await consultar(token);
    expect(res.status).toBe(200);
    expect(
      (res.body as { contas: ContaDoCorpo[] }).contas.map((c) => c.usuarioId),
    ).toEqual([b]);
  });
});

describe('SPEC-090/AC-012 — POST válido: 204, a senha nova entra, e só aquela conta perde as sessões (S9)', () => {
  it('uma conta: a senha antiga dá 401, a nova entra, senhaTemporaria = false', async () => {
    const email = emailNovo('valido');
    const id = await conta(await empresa(), email, { temporaria: 'valendo' });
    await pedir(email);
    const { token } = linkPara(email);

    const res = await redefinir(token, id, 'spec-090-a-senha-nova');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    expect((await login(email, SENHA)).body).toEqual(CREDENCIAIS_INVALIDAS);
    const nova = await login(email, 'spec-090-a-senha-nova');
    expect(nova.status).toBe(200);
    expect((nova.body as { usuario: { id: string } }).usuario.id).toBe(id);
    const depois = await db.usuario.findUniqueOrThrow({ where: { id } });
    expect(depois.senhaTemporaria).toBe(false);
    expect(depois.senhaTemporariaExpiraEm).toBeNull();
    expect((await pedidoPorToken(token)).usado_em).not.toBeNull();
  });

  it('duas contas do mesmo e-mail: os refresh da redefinida revogados, os da outra vivos (por usuario_id)', async () => {
    const email = emailNovo('sessoes');
    const a = await conta(await empresa(), email, {
      senha: 'spec-090-senha-de-a',
    });
    const b = await conta(await empresa(), email, {
      senha: 'spec-090-senha-de-b',
    });
    await sessoesVivas(a, 2);
    await sessoesVivas(b, 3);
    await pedir(email);

    expect(
      (await redefinir(linkPara(email).token, a, 'spec-090-a-nova-de-a'))
        .status,
    ).toBe(204);

    expect(await refreshVivos(a)).toBe(0);
    expect(await refreshVivos(b)).toBe(3);
    // A senha de B não mudou; a de A entra na conta A.
    const deB = await login(email, 'spec-090-senha-de-b');
    expect((deB.body as { usuario: { id: string } }).usuario.id).toBe(b);
    const deA = await login(email, 'spec-090-a-nova-de-a');
    expect((deA.body as { usuario: { id: string } }).usuario.id).toBe(a);
    expect((await login(email, 'spec-090-senha-de-a')).status).toBe(401);
  });
});

describe('SPEC-090/AC-013 — POST 410 com o mesmo corpo (S6)', () => {
  it('conta fora do pedido, conta do mesmo e-mail criada depois, link já usado por outra conta, expirado, conta e empresa inativadas', async () => {
    const respostas: [string, Response][] = [];

    // Conta de outro e-mail, que nunca esteve no pedido.
    const email = emailNovo('fora');
    const ea = await empresa();
    const a = await conta(ea, email);
    const b = await conta(await empresa(), email);
    const alheia = await conta(await empresa(), emailNovo('alheia'));
    await pedir(email);
    const { token } = linkPara(email);
    respostas.push([
      'conta alheia',
      await redefinir(token, alheia, 'spec-090-x-12345'),
    ]);

    // Uma conta real do MESMO e-mail, criada depois do pedido.
    const depois = await conta(await empresa(), email);
    respostas.push([
      'criada depois',
      await redefinir(token, depois, 'spec-090-x-12345'),
    ]);
    const hashDeDepois = await senhaHashDe(depois);

    // Usado por A: B não redefine mais (I6).
    expect((await redefinir(token, a, 'spec-090-nova-de-a')).status).toBe(204);
    respostas.push([
      'usado por outra conta',
      await redefinir(token, b, 'spec-090-x-12345'),
    ]);

    // Expirado.
    const ex = emailNovo('post-expirado');
    const cex = await conta(await empresa(), ex);
    await pedir(ex);
    const tex = linkPara(ex).token;
    await q(
      `UPDATE pedidos_de_redefinicao SET expira_em = now() - interval '1 second'
        WHERE token_hash = $1`,
      sha256(tex),
    );
    respostas.push(['expirado', await redefinir(tex, cex, 'spec-090-x-12345')]);

    // Conta inativada depois da emissão.
    const ci = emailNovo('post-conta-inativa');
    const cci = await conta(await empresa(), ci);
    await pedir(ci);
    const tci = linkPara(ci).token;
    await q(`UPDATE usuarios SET status = 'inativo' WHERE id = $1::uuid`, cci);
    respostas.push([
      'conta inativada',
      await redefinir(tci, cci, 'spec-090-x-12345'),
    ]);

    // Empresa inativada depois da emissão.
    const ei = emailNovo('post-empresa-inativa');
    const eei = await empresa();
    const cei = await conta(eei, ei);
    await pedir(ei);
    const tei = linkPara(ei).token;
    await q(`UPDATE empresas SET status = 'inativa' WHERE id = $1::uuid`, eei);
    respostas.push([
      'empresa inativada',
      await redefinir(tei, cei, 'spec-090-x-12345'),
    ]);

    expect(respostas).toHaveLength(6);
    for (const [rotulo, r] of respostas) {
      expect({ rotulo, status: r.status, corpo: r.body as unknown }).toEqual({
        rotulo,
        status: 410,
        corpo: REDEFINICAO_INVALIDA,
      });
      expect(r.text).toBe(respostas[0][1].text);
    }
    // A conta criada depois não teve a senha tocada.
    expect(await senhaHashDe(depois)).toBe(hashDeDepois);
    // Os links que só morreram por estado não foram consumidos.
    expect((await pedidoPorToken(tci)).usado_em).toBeNull();
    expect((await pedidoPorToken(tei)).usado_em).toBeNull();
  });
});

describe('SPEC-090/AC-014 — senha trocada por cada outro caminho depois da emissão: o link responde 410 para aquela conta', () => {
  /** Pede o link, roda o caminho, e confere GET e POST. */
  async function depoisDe(
    email: string,
    usuarioId: string,
    caminho: () => Promise<Response>,
    statusDoCaminho: number,
  ): Promise<void> {
    await pedir(email);
    const { token } = linkPara(email);
    expect((await consultar(token)).status).toBe(200); // controle: vivo antes

    const r = await caminho();
    expect(r.status).toBe(statusDoCaminho);

    const get = await consultar(token);
    expect(get.status).toBe(410);
    expect(get.body).toEqual(REDEFINICAO_INVALIDA);
    const post = await redefinir(
      token,
      usuarioId,
      'spec-090-depois-do-caminho',
    );
    expect(post.status).toBe(410);
    expect(post.body).toEqual(REDEFINICAO_INVALIDA);
    expect((await pedidoPorToken(token)).usado_em).toBeNull();
  }

  it('POST /auth/trocar-senha', async () => {
    const email = emailNovo('trocar-senha');
    const companyId = await empresa();
    const id = await conta(companyId, email);
    await depoisDe(
      email,
      id,
      () =>
        http()
          .post('/api/v1/auth/trocar-senha')
          .set(
            'Authorization',
            `Bearer ${sessaoDe({ id, email, role: 'aluno', companyId })}`,
          )
          .set('do-connecting-ip', ipNovo())
          .send({ senhaAtual: SENHA, novaSenha: 'spec-090-trocada-1' })
          .then((r) => r),
      200,
    );
  });

  it('POST /students/:id/senha-temporaria', async () => {
    const companyId = await empresa();
    const gestorEmail = emailNovo('gestor-aluno');
    const gestor = await conta(companyId, gestorEmail, {
      papel: 'company_admin',
    });
    const email = emailNovo('regenerar');
    const id = await conta(companyId, email);
    const alunoId = randomUUID();
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'aprovado')`,
      alunoId,
      id,
      companyId,
    );
    await depoisDe(
      email,
      id,
      () =>
        http()
          .post(`/api/v1/students/${alunoId}/senha-temporaria`)
          .set(
            'Authorization',
            `Bearer ${sessaoDe({ id: gestor, email: gestorEmail, role: 'company_admin', companyId })}`,
          )
          .then((r) => r),
      200,
    );
  });

  it('POST /teachers/:id/acesso', async () => {
    const companyId = await empresa();
    const gestorEmail = emailNovo('gestor-prof');
    const gestor = await conta(companyId, gestorEmail, {
      papel: 'company_admin',
    });
    const email = emailNovo('acesso-prof');
    const id = await conta(companyId, email, { papel: 'professor' });
    const professorId = randomUUID();
    await q(
      `INSERT INTO professores (id,company_id,nome,email,status,usuario_id)
       VALUES ($1::uuid,$2::uuid,'Professor 090',$3,'ativo',$4::uuid)`,
      professorId,
      companyId,
      email,
      id,
    );
    await depoisDe(
      email,
      id,
      () =>
        http()
          .post(`/api/v1/teachers/${professorId}/acesso`)
          .set(
            'Authorization',
            `Bearer ${sessaoDe({ id: gestor, email: gestorEmail, role: 'company_admin', companyId })}`,
          )
          .then((r) => r),
      201,
    );
  });

  it('POST /public/ativacao (o convite da SPEC-083)', async () => {
    const companyId = await empresa();
    const gestor = await conta(companyId, emailNovo('gestor-conv'), {
      papel: 'company_admin',
    });
    const email = emailNovo('ativacao');
    const id = await conta(companyId, email, { temporaria: 'valendo' });
    const tokenDoConvite = randomBytes(32).toString('base64url');
    await q(
      `INSERT INTO convites_de_acesso
         (company_id,usuario_id,criado_por_id,token_hash,impressao_credencial,expira_em)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,now() + interval '7 days')`,
      companyId,
      id,
      gestor,
      sha256(tokenDoConvite),
      sha256(await senhaHashDe(id)),
    );
    await depoisDe(
      email,
      id,
      () =>
        http()
          .post('/api/v1/public/ativacao')
          .set('do-connecting-ip', ipNovo())
          .send({ token: tokenDoConvite, senha: 'spec-090-pelo-convite' })
          .then((r) => r),
      204,
    );
  });

  it('SPEC-016: POST /companies/:id/admins/:usuarioId/senha-temporaria', async () => {
    const companyId = await empresa();
    const email = emailNovo('gestor-016');
    const id = await conta(companyId, email, { papel: 'company_admin' });
    const superEmail = emailNovo('super-016');
    const superAdmin = await conta(null, superEmail, { papel: 'super_admin' });
    await depoisDe(
      email,
      id,
      () =>
        http()
          .post(`/api/v1/companies/${companyId}/admins/${id}/senha-temporaria`)
          .set(
            'Authorization',
            `Bearer ${sessaoDe({ id: superAdmin, email: superEmail, role: 'super_admin', companyId: null })}`,
          )
          .then((r) => r),
      200,
    );
  });
});

describe('SPEC-090/AC-015 — senha com 7 caracteres: 400, e o link não é consumido', () => {
  it('400, pedido com usado_em nulo, e um POST válido em seguida dá 204', async () => {
    const email = emailNovo('sete');
    const id = await conta(await empresa(), email);
    await pedir(email);
    const { token } = linkPara(email);
    const hashAntes = await senhaHashDe(id);

    const curta = await redefinir(token, id, '1234567');
    expect(curta.status).toBe(400);
    expect((await pedidoPorToken(token)).usado_em).toBeNull();
    expect(await senhaHashDe(id)).toBe(hashAntes);

    expect((await redefinir(token, id, '12345678')).status).toBe(204);
  });
});

describe('SPEC-090/AC-016 — efeitos declarados: o convite vivo morre, e o token de escolha da 086 expira', () => {
  it('o convite vivo da SPEC-083 daquela conta responde 410', async () => {
    const companyId = await empresa();
    const gestor = await conta(companyId, emailNovo('gestor-016b'), {
      papel: 'company_admin',
    });
    const email = emailNovo('convite-vivo');
    const id = await conta(companyId, email, { temporaria: 'valendo' });
    const tokenDoConvite = randomBytes(32).toString('base64url');
    await q(
      `INSERT INTO convites_de_acesso
         (company_id,usuario_id,criado_por_id,token_hash,impressao_credencial,expira_em)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,now() + interval '7 days')`,
      companyId,
      id,
      gestor,
      sha256(tokenDoConvite),
      sha256(await senhaHashDe(id)),
    );
    const ativacao = () =>
      http()
        .get(`/api/v1/public/ativacao/${tokenDoConvite}`)
        .set('do-connecting-ip', ipNovo())
        .then((r) => r);
    expect((await ativacao()).status).toBe(200); // controle

    await pedir(email);
    expect(
      (await redefinir(linkPara(email).token, id, 'spec-090-nova-conv')).status,
    ).toBe(204);
    expect((await ativacao()).status).toBe(410);
  });

  it('um token de escolha da SPEC-086 emitido antes responde 401 ESCOLHA_EXPIRADA', async () => {
    const email = emailNovo('escolha');
    const a = await conta(await empresa(), email);
    await conta(await empresa(), email);
    const entrada = await login(email, SENHA);
    expect(entrada.status).toBe(409);
    const tokenDeEscolha = (entrada.body as { escolha: { token: string } })
      .escolha.token;

    await pedir(email);
    expect(
      (await redefinir(linkPara(email).token, a, 'spec-090-nova-esc')).status,
    ).toBe(204);

    const escolha = await http()
      .post('/api/v1/auth/login/escolher')
      .set('do-connecting-ip', ipNovo())
      .send({ token: tokenDeEscolha, usuarioId: a });
    expect(escolha.status).toBe(401);
    expect(escolha.body).toEqual(ESCOLHA_EXPIRADA);
  });
});

describe('SPEC-090/AC-017 — nenhum log com token, link, senha ou o e-mail pedido', () => {
  it('pedido (AC-003), redefinição (AC-012) e falha de envio: nada disso no Logger nem no console', async () => {
    const espioesDoConsole = (
      ['log', 'info', 'warn', 'error', 'debug'] as const
    ).map((metodo) =>
      jest.spyOn(console, metodo).mockImplementation(() => undefined),
    );
    for (const espiao of espioesDoLogger) espiao.mockClear();

    const email = emailNovo('log');
    const id = await conta(await empresa(), email);
    await pedir(email); // AC-003
    const { token, origem } = linkPara(email);
    const senha = 'spec-090-senha-que-nao-vai-a-log';
    expect((await redefinir(token, id, senha)).status).toBe(204); // AC-012

    memoria.falharCom('indisponivel'); // a falha de envio
    await pedir(email);

    const registrado = [...espioesDoLogger, ...espioesDoConsole]
      .flatMap((espiao) => espiao.mock.calls as unknown[][])
      .map((argumentos) => JSON.stringify(argumentos))
      .join('\n');
    // Não é vacuidade: a falha de envio foi registrada.
    expect(registrado).toContain('redefinicao_nao_enviada');
    expect(registrado).not.toContain(token);
    expect(registrado).not.toContain(`${origem}/redefinir-senha`);
    expect(registrado).not.toContain(senha);
    expect(registrado).not.toContain(email);
    for (const espiao of espioesDoConsole) espiao.mockRestore();
  });
});

describe('SPEC-090/AC-029 — dois pedidos vivos do mesmo e-mail valem os dois (I7, S19, S23)', () => {
  it('uma conta: P2 não escreve em P1; POST por P1 204; o GET de P2 dá 410 e a linha de P2 fica idêntica, com usado_em nulo', async () => {
    const email = emailNovo('i7-uma');
    const id = await conta(await empresa(), email);
    await pedir(email);
    const t1 = linkPara(email).token;
    const p1Antes = await pedidoPorToken(t1);

    await pedir(email);
    const t2 = linkPara(email).token;
    expect(t2).not.toBe(t1);
    expect(await pedidoPorToken(t1)).toEqual(p1Antes); // P1 campo a campo
    const g1 = await consultar(t1);
    const g2 = await consultar(t2);
    expect(g1.status).toBe(200);
    expect(g2.body).toEqual(g1.body);

    const p2Antes = await pedidoPorToken(t2);
    expect((await redefinir(t1, id, 'spec-090-por-p1')).status).toBe(204);

    const depois = await consultar(t2);
    expect(depois.status).toBe(410);
    expect(depois.body).toEqual(REDEFINICAO_INVALIDA);
    // O 410 vem da impressão, e não de revogação: P2 não foi tocado.
    expect(await pedidoPorToken(t2)).toEqual(p2Antes);
    expect(p2Antes.usado_em).toBeNull();
  });

  it('duas contas: depois do POST por P1 para A, o GET de P2 devolve só B, e o POST por P2 para B dá 204', async () => {
    const email = emailNovo('i7-duas');
    const a = await conta(await empresa({ nome: 'A i7 090' }), email);
    const b = await conta(await empresa({ nome: 'B i7 090' }), email);
    await pedir(email);
    const t1 = linkPara(email).token;
    await pedir(email);
    const t2 = linkPara(email).token;

    expect((await redefinir(t1, a, 'spec-090-a-por-p1')).status).toBe(204);
    // I6 vale para P1: morreu para B também.
    expect((await consultar(t1)).status).toBe(410);

    const g2 = await consultar(t2);
    expect(g2.status).toBe(200);
    expect(
      (g2.body as { contas: ContaDoCorpo[] }).contas.map((c) => c.usuarioId),
    ).toEqual([b]);
    expect((await redefinir(t2, b, 'spec-090-b-por-p2')).status).toBe(204);
  });
});

describe('SPEC-090/AC-030 — o link depois da limpeza da empresa A (a parte HTTP do AC-028)', () => {
  it('pedido A+B, limparEmpresa(A): o GET devolve só B, e o POST para B dá 204', async () => {
    const email = emailNovo('limpeza');
    const ea = await empresa({ nome: 'A limpeza 090' });
    await conta(ea, email);
    const b = await conta(await empresa({ nome: 'B limpeza 090' }), email);
    await pedir(email);
    const { token } = linkPara(email);
    expect(
      ((await consultar(token)).body as { contas: ContaDoCorpo[] }).contas,
    ).toHaveLength(2);

    await limparEmpresa(db, ea);

    const res = await consultar(token);
    expect(res.status).toBe(200);
    expect(
      (res.body as { contas: ContaDoCorpo[] }).contas.map((c) => c.usuarioId),
    ).toEqual([b]);
    expect(
      (await redefinir(token, b, 'spec-090-b-depois-da-limpeza')).status,
    ).toBe(204);
  });
});
