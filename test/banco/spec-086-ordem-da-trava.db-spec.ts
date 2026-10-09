/**
 * SPEC-086 — **a ordem da trava, observada, não lida** (spec, "A prova
 * estrutural da chave"; achado IMP-086-R1-04 da validação da implementação).
 *
 * A spec promete um cliente dublado que REGISTRA A ORDEM: em cada um dos oito
 * escritores, `travarEmailsParaCriarConta` é a PRIMEIRA operação no cliente da
 * transação que cria a conta. O `trava-de-email.estrutura.spec.ts` continua,
 * mas é regex sobre o texto: uma consulta por alias (`const cliente = tx`),
 * delegada a uma helper, ou feita no callback de `AcessoService.emitirEEnviar`
 * antes de `conta.criarConta(tx)` escapa dele. Aqui nada é lido — é executado.
 *
 * ## Como
 *
 * O app real sobe com `createTestApp(proxy)`: o `proxy` envolve um
 * `PrismaClient` real e só intercepta `$transaction(fn)`. Dentro dela o `tx`
 * que o código recebe é outro Proxy, que registra cada operação na ordem
 * (`modelo.método`, ou `$queryRaw`/`$executeRaw` com o texto SQL) e repassa ao
 * `tx` real. Como o registro é do OBJETO, e não do nome da variável, um alias
 * ou uma helper que recebe o `tx` passam pelo mesmo Proxy.
 *
 * Cada entrada é disparada pela HTTP. A transação que cria a conta é a que
 * contém `usuario.create` ou um `INSERT INTO usuarios` cru (a importação); a
 * primeira operação dela tem de ser o `$queryRaw` de
 * `travar_emails_para_criar_conta`. Conferimos também que houve exatamente
 * uma transação assim — sem ela, o teste julgaria nada.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { garantirAmbienteDeFit } from '../fit/app-real';
import {
  ChaveDeLock,
  ordenarChavesParaLock,
} from '../../src/common/lock/chave-de-lock';
import { createTestApp } from '../utils/create-test-app';
import { bodyOf } from '../utils/http';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture } from './nivel-da-fixture';

exigirBancoLocal();
jest.setTimeout(120_000);

// Antes de o app subir: o `EmailModule` lê no boot. A E5a envia convite.
process.env.EMAIL_PROVEDOR = 'memoria';
process.env.EMAIL_REMETENTE = 'convites@remetente.teste.local';
process.env.EMAIL_RESPONDER_PARA = 'respostas@suporte.teste.local';
process.env.URL_CLIENTE = 'https://cliente.teste.local';

const base = '0860f000-0000-4000-8000-0000000000';
const EMP = {
  id: `${base}a1`,
  nome: 'SPEC-086 Ordem A',
  slug: 'spec-086-ordem-a',
  gestorId: `${base}a2`,
  plano: `${base}a3`,
};
const SUPER = `${base}5a`;
const SUPER_EMAIL = 'spec086-ordem-super@teste.local';
const GESTOR_EMAIL = 'spec086-ordem-gestor@teste.local';
const SENHA = 'senha-da-ordem-086';
const PREFIXO_E7 = 'SPEC-086 Ordem E7';

/**
 * Achados IMP-086-R4-01 e R4-02: um registrador no lado do JavaScript vê a
 * CRIAÇÃO da promessa (o `$queryRaw` é preguiçoso: pode ser criado primeiro e
 * executado depois de outra instrução) e guarda a REFERÊNCIA das chaves (que
 * o escritor pode mudar depois de executar a chave errada). A fonte da
 * verdade passa a ser o evento `query` do Prisma: o SQL e os parâmetros como o
 * banco os recebeu, no momento da execução, já serializados em texto.
 */
const real = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });

/** Cada instrução que o banco executou, em ordem: o SQL e os parâmetros. */
let executadas: { query: string; params: string }[] = [];
real.$on('query', (e) => {
  executadas.push({ query: e.query, params: e.params });
});
const q = (sql: string, ...v: unknown[]) => real.$executeRawUnsafe(sql, ...v);

// ============================================================================
// O registrador
// ============================================================================

/** As operações de cada `$transaction(fn)`, na ordem em que foram chamadas. */
let transacoes: string[][] = [];

/**
 * Os VALORES de cada operação, paralelos ao texto (achado IMP-086-R3-02): o
 * texto troca cada valor por `?`, e uma trava chamada com a lista de chaves
 * VAZIA — que não trava nada — passava pela igualdade exata do texto.
 */
const valoresDe = new WeakMap<string[], unknown[][]>();

/** Os e-mails que a entrada em teste usou, na ordem em que foram gerados. */
let emailsUsados: string[] = [];

/** O texto SQL de um `$queryRaw`/`$executeRaw` (tagged, `Prisma.Sql` ou Unsafe). */
function textoSql(args: unknown[]): string {
  const a = args[0] as
    string | readonly string[] | { sql?: string; strings?: readonly string[] };
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) return a.join('?');
  const s = a as { sql?: string; strings?: readonly string[] };
  return s.sql ?? s.strings?.join('?') ?? JSON.stringify(a);
}

/** Chama a função real com o seu `this` (o tipo de volta é desconhecido). */
function chamar(f: unknown, este: unknown, args: unknown[]): unknown {
  return Reflect.apply(f as (...a: unknown[]) => unknown, este, args);
}

function txRegistrador(tx: object, log: string[]): object {
  return new Proxy(tx, {
    get(alvo, prop, recv) {
      const valor: unknown = Reflect.get(alvo, prop, recv);
      if (typeof prop !== 'string') return valor;
      if (typeof valor === 'function') {
        return (...args: unknown[]) => {
          log.push(
            prop.startsWith('$query') || prop.startsWith('$execute')
              ? `${prop}:${textoSql(args)}`
              : prop,
          );
          valoresDe.get(log)?.push(args.slice(1));
          return chamar(valor, alvo, args);
        };
      }
      // Um delegate de modelo (`tx.usuario`): cada método registra
      // `modelo.método`.
      if (valor && typeof valor === 'object' && !prop.startsWith('_')) {
        return new Proxy(valor, {
          get(m, metodo, r) {
            const f: unknown = Reflect.get(m, metodo, r);
            if (typeof f !== 'function' || typeof metodo !== 'string') return f;
            return (...args: unknown[]) => {
              log.push(`${prop}.${metodo}`);
              valoresDe.get(log)?.push(args);
              return chamar(f, m, args);
            };
          },
        });
      }
      return valor;
    },
  });
}

/** O `PrismaService` do app: o real, com `$transaction(fn)` registrada. */
const proxy = new Proxy(real, {
  get(alvo, prop, recv) {
    const valor: unknown = Reflect.get(alvo, prop, recv);
    if (prop === '$transaction') {
      return (arg: unknown, ...resto: unknown[]) => {
        if (typeof arg !== 'function') {
          return chamar(valor, alvo, [arg, ...resto]);
        }
        const log: string[] = [];
        transacoes.push(log);
        valoresDe.set(log, []);
        return chamar(valor, alvo, [
          (tx: object) =>
            (arg as (t: object) => unknown)(txRegistrador(tx, log)),
          ...resto,
        ]);
      };
    }
    if (typeof valor !== 'function') return valor;
    return (...args: unknown[]) => chamar(valor, alvo, args);
  },
});

const criaConta = (op: string) =>
  op === 'usuario.create' ||
  op === 'usuario.createMany' ||
  (op.startsWith('$') && /INSERT\s+INTO\s+"?usuarios"?/i.test(op));

/** A sequência da transação que criou a conta: tem de ser exatamente uma. */
function transacaoDaConta(): string[] {
  const daConta = transacoes.filter((t) => t.some(criaConta));
  expect({
    transacoesQueCriamConta: daConta.length,
    todas: transacoes,
  }).toMatchObject({ transacoesQueCriamConta: 1 });
  return daConta[0];
}

// ============================================================================
// Fixture
// ============================================================================

let app: INestApplication<App>;
let tokenGestor = '';
let tokenSuper = '';
let ipSeq = 0;
const ip = () => `10.87.0.${(ipSeq += 1)}`;
let seq = 0;
const novoEmail = (r: string) => {
  const email = `spec086-ordem-${r.toLowerCase()}-${(seq += 1)}@teste.local`;
  emailsUsados.push(email);
  return email;
};

async function limparTudo(): Promise<void> {
  const daE7 = await real.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM empresas WHERE nome LIKE $1`,
    `${PREFIXO_E7}%`,
  );
  for (const { id } of daE7) await limparEmpresa(real, id);
  await limparEmpresa(real, EMP.id);
  await q(`DELETE FROM refresh_tokens WHERE usuario_id = $1::uuid`, SUPER);
  await q(`DELETE FROM usuarios WHERE id = $1::uuid`, SUPER);
}

async function entrar(email: string): Promise<string> {
  const r = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('do-connecting-ip', ip())
    .send({ email, senha: SENHA });
  expect(r.status).toBe(200);
  return bodyOf<{ accessToken: string }>(r).accessToken;
}

async function novoProfessor(email: string): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO professores (id, company_id, nome, telefone, email)
     VALUES ($1::uuid, $2::uuid, 'Professor Ordem 086', '11988887777', $3)`,
    id,
    EMP.id,
    email,
  );
  return id;
}

beforeAll(async () => {
  garantirAmbienteDeFit();
  await limparTudo();
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id, nome, slug, updated_at) VALUES ('${EMP.id}', '${EMP.nome}', '${EMP.slug}', now())`,
    ),
  );
  await q(
    `INSERT INTO contratos_da_empresa (id, company_id, versao, texto) VALUES (gen_random_uuid(), $1::uuid, 1, 'Contrato da ordem 086')`,
    EMP.id,
  );
  await q(
    `UPDATE empresas SET contrato_versao_vigente = 1 WHERE id = $1::uuid`,
    EMP.id,
  );
  await q(
    `INSERT INTO planos (id, company_id, nome, valor_centavos, prazo_meses, ativo, updated_at)
     VALUES ($1::uuid, $2::uuid, 'Plano Ordem', 10000, 3, true, now())`,
    EMP.plano,
    EMP.id,
  );
  const hash = await bcrypt.hash(SENHA, 4);
  await q(
    `INSERT INTO usuarios (id, email, senha_hash, nome, role, company_id, updated_at)
     VALUES ($1::uuid, $2, $3, 'Gestora Ordem', 'company_admin', $4::uuid, now())`,
    EMP.gestorId,
    GESTOR_EMAIL,
    hash,
    EMP.id,
  );
  await q(
    `INSERT INTO usuarios (id, email, senha_hash, nome, role, company_id, updated_at)
     VALUES ($1::uuid, $2, $3, 'Super Ordem', 'super_admin', NULL, now())`,
    SUPER,
    SUPER_EMAIL,
    hash,
  );
  app = await createTestApp(proxy);
  tokenGestor = await entrar(GESTOR_EMAIL);
  tokenSuper = await entrar(SUPER_EMAIL);
});

afterAll(async () => {
  await app?.close();
  await limparTudo();
  await real.$disconnect();
});

// ============================================================================
// As oito entradas
// ============================================================================

const gestor = (r: request.Test) =>
  r.set('Authorization', `Bearer ${tokenGestor}`);
const sup = (r: request.Test) => r.set('Authorization', `Bearer ${tokenSuper}`);

const entradas: [string, number, () => Promise<Response>][] = [
  [
    'E1 register-aluno',
    201,
    () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/register-aluno')
        .set('do-connecting-ip', ip())
        .send({
          email: novoEmail('e1'),
          senha: SENHA,
          nome: 'Aluno E1 Ordem',
          empresaSlug: EMP.slug,
        })
        .then((r) => r),
  ],
  [
    'E2 aceitar-convite',
    201,
    async () => {
      const token = `spec086-ordem-convite-${randomUUID()}`;
      await q(
        `INSERT INTO convites_aluno (id, company_id, criado_por_id, email, nome, token_hash, expira_em, plano_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'Aluno E2 Ordem', $4, now() + interval '7 days', $5::uuid)`,
        EMP.id,
        EMP.gestorId,
        novoEmail('e2'),
        createHash('sha256').update(token).digest('hex'),
        EMP.plano,
      );
      return request(app.getHttpServer())
        .post('/api/v1/auth/aceitar-convite')
        .set('do-connecting-ip', ip())
        .send({ token, senha: SENHA, termoVersao: 1, contratoVersao: 1 })
        .then((r) => r);
    },
  ],
  [
    'E4 POST /students',
    201,
    () =>
      gestor(request(app.getHttpServer()).post('/api/v1/students'))
        .send({ nome: 'Aluno E4 Ordem', email: novoEmail('e4') })
        .then((r) => r),
  ],
  [
    'E5a convite de acesso do professor (AcessoService.emitirEEnviar)',
    200,
    async () => {
      const p = await novoProfessor(novoEmail('e5a'));
      return gestor(
        request(app.getHttpServer()).post(
          `/api/v1/teachers/${p}/convite-de-acesso`,
        ),
      ).then((r) => r);
    },
  ],
  [
    'E5b POST /teachers/:id/acesso',
    201,
    async () => {
      const p = await novoProfessor(novoEmail('e5b'));
      return gestor(
        request(app.getHttpServer()).post(`/api/v1/teachers/${p}/acesso`),
      ).then((r) => r);
    },
  ],
  [
    'E6 importação',
    201,
    () =>
      gestor(request(app.getHttpServer()).post('/api/v1/students/importar'))
        .attach(
          'arquivo',
          Buffer.from(
            `nome,email\nAluno E6 Ordem,${novoEmail('e6')}\nAluno E6 Dois,${novoEmail('e6')}\n`,
            'utf8',
          ),
          'alunos.csv',
        )
        .then((r) => r),
  ],
  [
    'E7 POST /companies',
    201,
    () =>
      sup(request(app.getHttpServer()).post('/api/v1/companies'))
        .send({
          nome: `${PREFIXO_E7} ${Date.now()}`,
          esportes: ['Tênis'],
          adminInicial: {
            nome: 'Gestora E7',
            email: novoEmail('e7'),
            senha: SENHA,
          },
        })
        .then((r) => r),
  ],
  [
    'E8 POST /companies/:id/admins',
    201,
    () =>
      sup(
        request(app.getHttpServer()).post(`/api/v1/companies/${EMP.id}/admins`),
      )
        .send({ nome: 'Gestora E8', email: novoEmail('e8'), senha: SENHA })
        .then((r) => r),
  ],
];

/**
 * A instrução de `travarEmailsParaCriarConta`, como o registrador a vê (os
 * pedaços do template unidos por `?`, espaços normalizados) — medida, não
 * suposta.
 */
const INSTRUCAO_DA_TRAVA =
  '$queryRaw: SELECT ordem, marcador FROM travar_emails_para_criar_conta( ?::bigint[], ?::integer )';

describe('SPEC-086 — a trava é a primeira operação da transação que cria a conta (sequência registrada)', () => {
  it.each(entradas)('%s', async (_nome, status, disparar) => {
    transacoes = [];
    emailsUsados = [];
    executadas = [];
    const r = await disparar();
    expect({ status: r.status, corpo: r.text.slice(0, 400) }).toMatchObject({
      status,
    });
    const ops = transacaoDaConta();
    // A primeira operação, inteira na mensagem: o vermelho mostra o que veio
    // antes da trava.
    // Achado IMP-086-R2-02: "contém o nome da função" aceitava o nome como
    // DADO (`SELECT 'travar_emails_para_criar_conta' AS marcador`), feito por
    // uma helper antes da trava. Agora a primeira operação tem de ser a
    // instrução EXATA da trava (`trava-de-email.ts`), com os espaços
    // normalizados: literal, comentário ou outra instrução antes não passam.
    const primeira = (ops[0] ?? '').replace(/\s+/g, ' ').trim();
    expect({ primeira, sequencia: ops.slice(0, 4) }).toMatchObject({
      primeira: INSTRUCAO_DA_TRAVA,
    });

    // O que o BANCO executou (R4-01, R4-02): na transação — de BEGIN a
    // COMMIT — que faz o INSERT em `usuarios`, a PRIMEIRA instrução executada
    // é a trava, com EXATAMENTE as chaves dos e-mails que a entrada usou
    // (o lote inteiro na E6, o do convite na E2), na ordem da trava.
    const blocos: { query: string; params: string }[][] = [];
    let atual: { query: string; params: string }[] | null = null;
    for (const ex of executadas) {
      const sql = ex.query.trim().toUpperCase();
      if (sql === 'BEGIN') {
        atual = [];
        continue;
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        if (atual) blocos.push(atual);
        atual = null;
        continue;
      }
      atual?.push(ex);
    }
    const criadoras = blocos.filter((b) =>
      b.some((ex) =>
        /INSERT\s+INTO\s+"public"\."usuarios"|INSERT\s+INTO\s+usuarios/i.test(
          ex.query,
        ),
      ),
    );
    expect({ transacoesCriadoras: criadoras.length }).toEqual({
      transacoesCriadoras: 1,
    });
    const [noBanco] = criadoras[0];
    const esperadas = ordenarChavesParaLock(
      emailsUsados.map((e) => `usuarios.email:${e}`),
    ).map((k) => ChaveDeLock.deTexto(k).toString());
    expect(esperadas.length).toBeGreaterThan(0);
    // Os parâmetros chegam como TEXTO (`[[k1,k2],2000]`); as chaves são
    // inteiros de 64 bits, e o `JSON.parse` os arredondaria — por isso o
    // primeiro arranjo é lido do texto, sem virar `number`.
    const arranjo = /^\[\[([^\]]*)\]/.exec(noBanco.params.trim());
    expect({
      primeiraExecutada: noBanco.query.replace(/\s+/g, ' ').trim(),
      chaves: arranjo
        ? arranjo[1]
            .split(',')
            .map((c) => c.trim().replace(/^"|"$/g, ''))
            .filter((c) => c !== '')
        : noBanco.params,
    }).toEqual({
      primeiraExecutada:
        'SELECT ordem, marcador FROM travar_emails_para_criar_conta( $1::bigint[], $2::integer )',
      chaves: esperadas,
    });
  });
});
