/**
 * SPEC-083/TASK-004 (parte B) — **a corrida do professor sem conta e o
 * tradutor por constraint, contra o Postgres de verdade** (AC-042, AC-043).
 *
 * ## AC-042 — a corrida, com barreira
 *
 * Dois `POST /teachers/:id/convite-de-acesso` ao mesmo tempo, para o mesmo
 * professor sem conta, ou para dois professores com o mesmo e-mail. Quem
 * decide é o `UNIQUE` de `usuarios.email` (D9): conta, vínculo e convite estão
 * numa transação só, e a perdedora recebe o `P2002`, que o tradutor faz
 * `409 EMAIL_EM_USO`.
 *
 * **Sem barreira, este teste provaria a coisa errada.** Se a segunda
 * requisição chegasse depois do commit da primeira, ela perderia na
 * conferência de antes da transação (o `findUnique` do e-mail), com o mesmo
 * `409` — e o `UNIQUE` e o tradutor nunca entrariam em julgamento. A barreira
 * garante que as duas passaram da conferência e estão **as duas** dentro do
 * `INSERT` de `usuarios`:
 *
 * 1. uma terceira conexão segura `FOR UPDATE` a linha da empresa;
 * 2. o `INSERT` que chega primeiro grava a entrada do índice único e para na
 *    checagem da FK `usuarios.company_id` (`FOR KEY SHARE` na empresa, que o
 *    `FOR UPDATE` bloqueia). No Postgres, a unicidade é conferida ao inserir
 *    no índice, e a FK só no fim da instrução — por isso a ordem é esta;
 * 3. o segundo `INSERT`, com o mesmo e-mail, acha a entrada do primeiro e
 *    espera a transação dele terminar.
 *
 * A precondição é lida em `pg_blocking_pids`, pelos pids: um `INSERT` de
 * `usuarios` bloqueado pela barreira, e o outro bloqueado **pelo primeiro**.
 * Só então a barreira solta. Sem a precondição, o caso reprova por ela, e
 * nunca com um resultado aparentemente bom.
 *
 * Cada requisição do par vai para um app diferente, cada um com a própria
 * pool (o motivo está em `test/fit/app-real.ts`).
 *
 * ## AC-043 — o tradutor, com erros reais
 *
 * Cada violação é provocada **pela API de modelo** (a forma que a ficha usa),
 * e o `meta` que o Prisma entrega fica registrado no próprio teste, como
 * literal. A mesma violação, repetida em SQL dentro de um bloco `DO`, devolve
 * o nome da constraint pelo diagnóstico do Postgres (`GET STACKED
 * DIAGNOSTICS`) — é isso que amarra cada `meta` à constraint que o produziu,
 * porque o `P2002` não traz o nome (achado DOR-083-R2-04).
 *
 * As violações que **não** traduzem são escolhidas para reprovar um tradutor
 * que leia um campo só: `professores_usuario_id_key` tem a coluna do índice de
 * convite, e `usuarios_pkey` e `convites_de_acesso_token_hash_key` têm o
 * modelo de uma das traduzidas.
 *
 * ## Por que em `test/banco`
 *
 * O `test:banco` roda no job `build` com o banco migrado, e esta suíte sobe o
 * app como os FITs (`subirAppReal`, que põe os placebos de JWT e Spaces). A
 * role da limpeza vem do `globalSetup` do `jest-banco.json`.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  CONVITE_EM_EMISSAO,
  EMAIL_EM_USO,
  traduzirViolacaoDeUnicidade,
} from '../../src/acesso/traduzir-violacao-de-unicidade';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import { PROVEDOR_DE_EMAIL } from '../../src/email/provedor-de-email';
import { subirAppReal } from '../fit/app-real';
import { bodyOf } from '../utils/http';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture } from './nivel-da-fixture';

exigirBancoLocal();
jest.setTimeout(180_000);

// Antes de o app subir: o `EmailModule` lê no boot. Memória, sempre: nenhum
// e-mail sai daqui, mesmo com um `.env` que diga outra coisa.
process.env.EMAIL_PROVEDOR = 'memoria';
process.env.EMAIL_REMETENTE = 'convites@remetente.teste.local';
process.env.EMAIL_RESPONDER_PARA = 'respostas@suporte.teste.local';
process.env.URL_CLIENTE = 'https://cliente.teste.local';

const base = 'c0830042-0000-4000-8000-0000000000';
const EMPRESA = `${base}0a`;
const GESTOR = `${base}1a`;
const GESTOR_EMAIL = 'spec083-corrida-gestor@teste.local';
const GESTOR_SENHA = 'senha-do-gestor-083-corrida';

const db = new PrismaClient();
/** A conexão que segura a linha da empresa (a barreira). */
const barreira = new PrismaClient();
/** Quem lê `pg_stat_activity`, fora das duas transações em julgamento. */
const observador = new PrismaClient();

const q = (sql: string, ...v: unknown[]) => db.$executeRawUnsafe(sql, ...v);
const ler = <T>(sql: string, ...v: unknown[]) =>
  db.$queryRawUnsafe<T[]>(sql, ...v);

let appA: INestApplication<App>;
let appB: INestApplication<App>;
let memorias: MemoriaProvedorDeEmail[];
let tokenDoGestor: string;

function enviarConvite(
  app: INestApplication<App>,
  professorId: string,
): Promise<Response> {
  return request(app.getHttpServer())
    .post(`/api/v1/teachers/${professorId}/convite-de-acesso`)
    .set('Authorization', `Bearer ${tokenDoGestor}`)
    .then((r) => r);
}

let seq = 0;
async function novoProfessor(email: string): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await q(
    `INSERT INTO professores (id, company_id, nome, telefone, email)
     VALUES ($1::uuid, $2::uuid, $3, '11988887777', $4)`,
    id,
    EMPRESA,
    `Professor${seq} Corrida`,
    email,
  );
  return id;
}

interface Bloqueado {
  pid: number;
  por: number[];
}

/** Os `INSERT` de `usuarios` parados numa trava, e quem os bloqueia. */
function insertsEsperando(): Promise<Bloqueado[]> {
  return observador.$queryRawUnsafe<Bloqueado[]>(
    `SELECT a.pid, pg_blocking_pids(a.pid) AS por
       FROM pg_stat_activity a
      WHERE a.datname = current_database()
        AND a.wait_event_type = 'Lock'
        AND a.query LIKE 'INSERT INTO "public"."usuarios"%'
      ORDER BY a.pid`,
  );
}

/**
 * O par de requisições, disparado com a barreira de pé, e solto só depois de
 * a precondição ser vista. Devolve as duas respostas e o que se viu.
 */
async function comBarreira(
  disparar: () => Promise<Response>[],
): Promise<{ respostas: Response[]; vista: string }> {
  let soltar!: () => void;
  const solta = new Promise<void>((r) => (soltar = r));
  let segurando!: () => void;
  const segura = new Promise<void>((r) => (segurando = r));
  let pidDaBarreira = 0;

  const dono = barreira.$transaction(
    async (tx) => {
      pidDaBarreira = (
        await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      )[0].pid;
      await tx.$queryRaw`SELECT id FROM empresas WHERE id = ${EMPRESA}::uuid FOR UPDATE`;
      segurando();
      await solta;
    },
    { timeout: 60_000 },
  );
  await segura;

  const respostas = Promise.all(disparar());
  let vista = 'nada visto';
  try {
    const limite = Date.now() + 20_000;
    while (Date.now() < limite) {
      const esperando = await insertsEsperando();
      vista = JSON.stringify(esperando);
      const [x, y] = esperando;
      const primeiro = [x, y].find((b) => b?.por.includes(pidDaBarreira));
      const segundo = [x, y].find((b) => b && b !== primeiro);
      if (
        esperando.length === 2 &&
        primeiro &&
        segundo?.por.includes(primeiro.pid)
      ) {
        vista = `precondição: o INSERT ${primeiro.pid} parado na barreira ${pidDaBarreira}, e o INSERT ${segundo.pid} parado nele`;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    // Solta sempre: uma precondição falha não pode deixar as requisições
    // penduradas até o timeout da transação.
    soltar();
    await dono;
  }
  return { respostas: await respostas, vista };
}

/** Os e-mails capturados pelos dois apps, para um destinatário. */
const emailsPara = (para: string) =>
  memorias.flatMap((m) => m.enviados).filter((m) => m.to === para);

async function estadoDoEmail(email: string) {
  const contas = await ler<{
    id: string;
    role: string;
    senha_temporaria: boolean;
  }>(
    `SELECT id, role::text AS role, senha_temporaria FROM usuarios WHERE email = $1`,
    email,
  );
  const ids = contas.map((c) => c.id);
  const [{ vinculos }] = await ler<{ vinculos: number }>(
    `SELECT count(*)::int AS vinculos FROM professores WHERE usuario_id = ANY($1::uuid[])`,
    ids,
  );
  const [{ total, vivos }] = await ler<{ total: number; vivos: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE usado_em IS NULL AND revogado_em IS NULL)::int AS vivos
       FROM convites_de_acesso WHERE usuario_id = ANY($1::uuid[])`,
    ids,
  );
  return { contas, vinculos, convites: total, vivos };
}

/** Uma resposta de sucesso e uma `409 EMAIL_EM_USO`; nenhuma `500`. */
function confereUmSucessoUmEmailEmUso(respostas: Response[]): void {
  // Os corpos vão junto na comparação: um 500 sem corpo custa um ciclo de CI.
  const detalhe = respostas.map((r) => `${r.status} ${r.text.slice(0, 300)}`);
  expect({ status: respostas.map((r) => r.status).sort(), detalhe }).toEqual({
    status: [200, 409],
    detalhe,
  });
  const perdedora = respostas.find((r) => r.status === 409) as Response;
  expect(bodyOf<object>(perdedora)).toEqual(EMAIL_EM_USO);
  const vencedora = respostas.find((r) => r.status === 200) as Response;
  expect(bodyOf<{ situacao: string }>(vencedora).situacao).toBe('enviado');
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube SPEC-083 Corrida','spec-083-corrida-${EMPRESA}',now())`,
    ),
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ($1::uuid,$2,$3,'Gestora 083 Corrida','company_admin',$4::uuid,now())`,
    GESTOR,
    GESTOR_EMAIL,
    await bcrypt.hash(GESTOR_SENHA, 4),
    EMPRESA,
  );

  [appA, appB] = await Promise.all([subirAppReal(), subirAppReal()]);
  memorias = [appA, appB].map((app) => {
    const provedor = app.get<unknown>(PROVEDOR_DE_EMAIL);
    // Se não for o de memória, esta suíte estaria mandando e-mail de verdade.
    expect(provedor).toBeInstanceOf(MemoriaProvedorDeEmail);
    return provedor as MemoriaProvedorDeEmail;
  });

  const login = await request(appA.getHttpServer())
    .post('/api/v1/auth/login')
    .set('do-connecting-ip', '10.83.42.1')
    .send({ email: GESTOR_EMAIL, senha: GESTOR_SENHA });
  expect(login.status).toBe(200);
  tokenDoGestor = bodyOf<{ accessToken: string }>(login).accessToken;
});

afterAll(async () => {
  await Promise.all([appA?.close(), appB?.close()]);
  await limparEmpresa(db, EMPRESA);
  await Promise.all([
    db.$disconnect(),
    barreira.$disconnect(),
    observador.$disconnect(),
  ]);
});

describe('AC-042 — a corrida do professor sem conta, com barreira', () => {
  it('dois POST para o MESMO professor: um 200, um 409 EMAIL_EM_USO, nenhum 500; uma conta, um vínculo, um convite vivo', async () => {
    const email = 'spec083-corrida-mesmo@teste.local';
    const professor = await novoProfessor(email);

    const { respostas, vista } = await comBarreira(() => [
      enviarConvite(appA, professor),
      enviarConvite(appB, professor),
    ]);
    expect(vista).toMatch(/^precondição:/);
    confereUmSucessoUmEmailEmUso(respostas);

    const estado = await estadoDoEmail(email);
    expect(estado.contas).toEqual([
      {
        id: expect.any(String) as string,
        role: 'professor',
        senha_temporaria: true,
      },
    ]);
    expect(estado).toMatchObject({ vinculos: 1, convites: 1, vivos: 1 });
    const [ficha] = await ler<{ usuario_id: string | null }>(
      `SELECT usuario_id FROM professores WHERE id = $1::uuid`,
      professor,
    );
    expect(ficha.usuario_id).toBe(estado.contas[0].id);
    // Um e-mail só: a perdedora desfez antes de enviar qualquer coisa.
    expect(emailsPara(email)).toHaveLength(1);
  });

  it('dois POST para DOIS professores com o mesmo e-mail: um 200, um 409 EMAIL_EM_USO, nenhum 500; uma conta, um vínculo, um convite vivo', async () => {
    const email = 'spec083-corrida-dois@teste.local';
    const p1 = await novoProfessor(email);
    const p2 = await novoProfessor(email);

    const { respostas, vista } = await comBarreira(() => [
      enviarConvite(appA, p1),
      enviarConvite(appB, p2),
    ]);
    expect(vista).toMatch(/^precondição:/);
    confereUmSucessoUmEmailEmUso(respostas);

    const estado = await estadoDoEmail(email);
    expect(estado.contas).toHaveLength(1);
    expect(estado).toMatchObject({ vinculos: 1, convites: 1, vivos: 1 });
    // A ficha de quem venceu ganhou o vínculo; a da perdedora continua sem
    // conta — nada gravado pela metade.
    const fichas = await ler<{ id: string; usuario_id: string | null }>(
      `SELECT id, usuario_id FROM professores WHERE id IN ($1::uuid, $2::uuid) ORDER BY id`,
      p1,
      p2,
    );
    const vinculadas = fichas.filter((f) => f.usuario_id !== null);
    expect(vinculadas).toHaveLength(1);
    expect(vinculadas[0].usuario_id).toBe(estado.contas[0].id);
    const vencedora = respostas[0].status === 200 ? p1 : p2;
    expect(vinculadas[0].id).toBe(vencedora);
    expect(emailsPara(email)).toHaveLength(1);
  });
});

describe('AC-043 — o tradutor distingue a constraint, com erros reais da API de modelo', () => {
  const U1 = `${base}2a`;
  const P1 = `${base}3a`;
  const P2 = `${base}3b`;
  const EMAIL_U1 = 'spec083-corrida-u1@teste.local';
  const TOKEN = 'spec083-corrida-token-1';

  /** O `P2002` que a API de modelo lança, com o `meta` cru. */
  async function p2002De(
    operacao: () => Promise<unknown>,
  ): Promise<Prisma.PrismaClientKnownRequestError> {
    const erro: unknown = await operacao().then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((erro as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    return erro as Prisma.PrismaClientKnownRequestError;
  }

  /**
   * A mesma violação em SQL, com o diagnóstico do Postgres relançado como
   * texto (o molde de `spec-083-convites-de-acesso.db-spec.ts`): o SQLSTATE e
   * o nome da constraint, que o `P2002` não traz.
   */
  async function constraintDe(sql: string): Promise<string> {
    const erro: unknown = await q(
      `DO $diag$
DECLARE s text; k text;
BEGIN
  ${sql};
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, k = CONSTRAINT_NAME;
  RAISE EXCEPTION 'recusado sqlstate=% constraint=%', s, k;
END $diag$`,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    const mensagem =
      (erro as { meta?: { message?: string } } | null)?.meta?.message ?? '';
    const achado = /recusado sqlstate=(\w+) constraint=(\S+)/.exec(mensagem);
    expect(achado === null ? `sem diagnóstico: ${mensagem}` : achado[1]).toBe(
      '23505',
    );
    return (achado as RegExpExecArray)[2];
  }

  const convite = (tokenHash: string) => ({
    companyId: EMPRESA,
    usuarioId: U1,
    criadoPorId: GESTOR,
    tokenHash,
    impressaoCredencial: 'impressao',
    expiraEm: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  beforeAll(async () => {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,senha_temporaria,updated_at)
       VALUES ($1::uuid,$2,'x','Professor U1','professor',$3::uuid,true,now())`,
      U1,
      EMAIL_U1,
      EMPRESA,
    );
    await q(
      `INSERT INTO professores (id, company_id, nome, email, usuario_id)
       VALUES ($1::uuid,$2::uuid,'P1',$3,$4::uuid), ($5::uuid,$2::uuid,'P2',NULL,NULL)`,
      P1,
      EMPRESA,
      EMAIL_U1,
      U1,
      P2,
    );
    // O convite VIVO de U1: o índice parcial morde o segundo.
    await db.conviteDeAcesso.create({ data: convite(TOKEN) });
  });

  /**
   * As cinco violações, cada uma: a operação pela API de modelo, o mesmo
   * conflito em SQL (para ler o nome da constraint), e o que o tradutor faz.
   */
  const casos: {
    nome: string;
    pelaApi: () => Promise<unknown>;
    emSql: string;
  }[] = [
    {
      nome: 'e-mail de outra conta',
      pelaApi: () =>
        db.usuario.create({
          data: {
            email: EMAIL_U1,
            senhaHash: 'x',
            nome: 'Outra',
            role: 'professor',
            companyId: EMPRESA,
          },
        }),
      emSql: `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
              VALUES (gen_random_uuid(),'${EMAIL_U1}','x','Outra','professor','${EMPRESA}',now())`,
    },
    {
      nome: 'segundo convite vivo',
      pelaApi: () =>
        db.conviteDeAcesso.create({
          data: convite('spec083-corrida-token-2'),
        }),
      emSql: `INSERT INTO convites_de_acesso (company_id,usuario_id,criado_por_id,token_hash,impressao_credencial,expira_em)
              VALUES ('${EMPRESA}','${U1}','${GESTOR}','spec083-corrida-token-3','impressao',now() + interval '7 days')`,
    },
    {
      nome: 'vínculo de uma conta que já tem ficha',
      pelaApi: () =>
        db.professor.update({ where: { id: P2 }, data: { usuarioId: U1 } }),
      emSql: `UPDATE professores SET usuario_id = '${U1}' WHERE id = '${P2}'`,
    },
    {
      nome: 'id de uma conta que já existe',
      pelaApi: () =>
        db.usuario.create({
          data: {
            id: U1,
            email: 'spec083-corrida-outro@teste.local',
            senhaHash: 'x',
            nome: 'Outra',
            role: 'professor',
            companyId: EMPRESA,
          },
        }),
      emSql: `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
              VALUES ('${U1}','spec083-corrida-outro@teste.local','x','Outra','professor','${EMPRESA}',now())`,
    },
    {
      nome: 'token repetido (noutra conta, para o índice parcial não morder antes)',
      pelaApi: () =>
        db.conviteDeAcesso.create({
          data: { ...convite(TOKEN), usuarioId: GESTOR },
        }),
      emSql: `INSERT INTO convites_de_acesso (company_id,usuario_id,criado_por_id,token_hash,impressao_credencial,expira_em)
              VALUES ('${EMPRESA}','${GESTOR}','${GESTOR}','${TOKEN}','impressao',now() + interval '7 days')`,
    },
  ];

  it('a medição: o meta real de cada violação, amarrado ao nome da constraint', async () => {
    const medido: {
      constraint: string;
      meta: unknown;
      traduzidoPara: string;
    }[] = [];
    for (const caso of casos) {
      const erro = await p2002De(caso.pelaApi);
      const traduzido = traduzirViolacaoDeUnicidade(erro);
      medido.push({
        constraint: await constraintDe(caso.emSql),
        meta: erro.meta,
        traduzidoPara:
          traduzido === erro
            ? 'sobe sem tradução'
            : (
                (traduzido as ConflictException).getResponse() as {
                  code: string;
                }
              ).code,
      });
    }

    // O registro (D9: "a forma exata de meta ... é medida pelo AC-043").
    // Se uma versão do Prisma mudar a forma, esta tabela fica vermelha antes
    // de qualquer tradução errada chegar à ficha.
    expect(medido).toEqual([
      {
        constraint: 'usuarios_email_key',
        meta: { modelName: 'Usuario', target: ['email'] },
        traduzidoPara: 'EMAIL_EM_USO',
      },
      {
        constraint: 'convites_de_acesso_um_vivo_por_usuario',
        meta: { modelName: 'ConviteDeAcesso', target: ['usuario_id'] },
        traduzidoPara: 'CONVITE_EM_EMISSAO',
      },
      {
        constraint: 'professores_usuario_id_key',
        meta: { modelName: 'Professor', target: ['usuario_id'] },
        traduzidoPara: 'sobe sem tradução',
      },
      {
        constraint: 'usuarios_pkey',
        meta: { modelName: 'Usuario', target: ['id'] },
        traduzidoPara: 'sobe sem tradução',
      },
      {
        constraint: 'convites_de_acesso_token_hash_key',
        meta: { modelName: 'ConviteDeAcesso', target: ['token_hash'] },
        traduzidoPara: 'sobe sem tradução',
      },
    ]);
  });

  it('usuarios_email_key → 409 com o corpo EMAIL_EM_USO, e nada gravado', async () => {
    const traduzido = traduzirViolacaoDeUnicidade(
      await p2002De(casos[0].pelaApi),
    );
    expect(traduzido).toBeInstanceOf(ConflictException);
    expect((traduzido as ConflictException).getResponse()).toBe(EMAIL_EM_USO);
    const [{ n }] = await ler<{ n: number }>(
      `SELECT count(*)::int AS n FROM usuarios WHERE email = $1`,
      EMAIL_U1,
    );
    expect(n).toBe(1);
  });

  it('convites_de_acesso_um_vivo_por_usuario → 409 com o corpo CONVITE_EM_EMISSAO, e o vivo continua um', async () => {
    const traduzido = traduzirViolacaoDeUnicidade(
      await p2002De(casos[1].pelaApi),
    );
    expect(traduzido).toBeInstanceOf(ConflictException);
    expect((traduzido as ConflictException).getResponse()).toBe(
      CONVITE_EM_EMISSAO,
    );
    const [{ n }] = await ler<{ n: number }>(
      `SELECT count(*)::int AS n FROM convites_de_acesso
        WHERE usuario_id = $1::uuid AND usado_em IS NULL AND revogado_em IS NULL`,
      U1,
    );
    expect(n).toBe(1);
  });

  it.each(casos.slice(2).map((caso) => [caso.nome, caso] as const))(
    'fora da tabela (%s) → sobe sem tradução: o tradutor devolve o PRÓPRIO erro',
    async (_nome, caso) => {
      const erro = await p2002De(caso.pelaApi);
      expect(traduzirViolacaoDeUnicidade(erro)).toBe(erro);
    },
  );
});
