/**
 * SPEC-083/TASK-009 (parte A) — **FIT-056: a ativação e a emissão sob
 * corrida**, pela HTTP, contra o Postgres de verdade (D7, D9, INV-083a,
 * INV-083b, INV-083c, AC-035).
 *
 * Três casos, um por linha da tabela de corridas da D7 e da D9:
 *
 * - **(a) o mesmo link ativado duas vezes ao mesmo tempo.** Um `204` e um
 *   `410`, e a senha final é a de quem ganhou (INV-083a).
 * - **(b) ativar × regenerar a senha temporária.** A senha do link nunca entra
 *   por cima de um hash que não era o da emissão (INV-083c). As duas ordens
 *   são válidas, e cada uma tem o seu estado final: regeneração primeiro → o
 *   link responde `410`; ativação primeiro → a regeneração sobrescreve depois,
 *   em sequência. O teste lê a ordem no `pg_stat_activity` e confere o estado
 *   coerente com ela.
 * - **(c) dois envios pela ficha ao mesmo tempo** para o mesmo aluno: um
 *   convite vivo no fim (INV-083b) e nenhuma resposta `500` (AC-035).
 *
 * ## Por que barreira, e não duas `Promise` disparadas juntas
 *
 * Disparadas juntas, duas requisições podem passar por acaso: o escalonador
 * roda a primeira inteira antes de a segunda ler, e uma ativação **sem** o
 * `FOR UPDATE` fica verde também (a lição do FIT-049, AC-018). Aqui uma
 * terceira conexão segura uma linha, e só solta depois de ver, em
 * `pg_blocking_pids`, quem está esperando por quem. Sem a precondição, o caso
 * reprova por ela, e nunca com um resultado aparentemente bom.
 *
 * Cada requisição do par vai para um app diferente, cada um com a própria
 * pool (o motivo está em `app-real.ts`).
 *
 * ## Onde fica cada barreira, e o que a S1 faz com cada caso
 *
 * A S1 tira o `FOR UPDATE` do passo 2 da ativação. A tabela da D7 diz o que
 * deve acontecer: **só o (b) fica vermelho**. Por isso as precondições dos
 * casos (a) e (c) leem só a *forma* da fila (dois esperando, encadeados a
 * partir da barreira), e não em qual instrução cada um parou: com ou sem o
 * `FOR UPDATE`, as duas ativações do (a) acabam numa fila, e um vermelho do
 * (a) sob a S1 tem de vir do resultado — que seria a D7 errada —, e não de
 * uma precondição escrita para o código de hoje.
 *
 * - **(a)** a barreira segura **o usuário**. Com o `FOR UPDATE`, as duas
 *   ativações param no passo 2. Sem ele, a primeira reivindica o convite e
 *   para no `UPDATE` do usuário, e a segunda para na trava de linha do
 *   convite, que a primeira segura. Nos dois desenhos, uma vence e a outra
 *   relê o estado e recebe `410` — é a trava de linha do passo 4.
 * - **(b), ativação primeiro:** a barreira segura **o convite**. A ativação
 *   passa do passo 2 (e, com o `FOR UPDATE`, fica com o usuário) e para na
 *   reivindicação. A regeneração disparada em seguida tem de esperar por ela.
 *   Sem o `FOR UPDATE`, a regeneração não espera: grava e termina, e a
 *   ativação, que já tinha lido a senha antiga, aplica a do link por cima —
 *   exatamente a corrida da D7.
 * - **(b), regeneração primeiro:** a barreira segura **uma sessão** do aluno.
 *   A regeneração grava o usuário (e fica com a trava dele) e para ao
 *   derrubar as sessões. A ativação disparada em seguida é vista esperando
 *   pela regeneração. Com o `FOR UPDATE`, ela espera no passo 2 e relê a senha
 *   nova (`410`); sem ele, leu a senha antiga sem trava, espera só no passo 5,
 *   e grava a do link por cima depois do commit da regeneração.
 * - **(c)** a barreira segura **o usuário**: os dois envios param no
 *   `FOR UPDATE` da emissão, e soltos, o segundo revoga o convite do primeiro.
 *
 * ## Por que em `test/fit`
 *
 * Precisa de `DATABASE_URL` local e migrado (`exigirBancoLocal`), e é prova
 * de concorrência: entra no `fit-critical`, o job obrigatório do PR, como o
 * `spec-083-acesso.fit-spec.ts`, de onde vêm os moldes do aluno e do e-mail.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { LINK_INVALIDO } from '../../src/acesso/acesso.service';
import { CONVITE_EM_EMISSAO } from '../../src/acesso/traduzir-violacao-de-unicidade';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import { PROVEDOR_DE_EMAIL } from '../../src/email/provedor-de-email';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { comNivelDaFixture } from '../banco/nivel-da-fixture';
import { bodyOf } from '../utils/http';
import { subirAppReal } from './app-real';

exigirBancoLocal();
jest.setTimeout(120_000);

// Antes de o app subir: o `EmailModule` lê no boot. Memória, sempre: nenhum
// e-mail sai daqui, mesmo com um `.env` que diga outra coisa.
process.env.EMAIL_PROVEDOR = 'memoria';
process.env.EMAIL_REMETENTE = 'convites@remetente.teste.local';
process.env.EMAIL_RESPONDER_PARA = 'respostas@suporte.teste.local';
process.env.URL_CLIENTE = 'https://cliente.teste.local';

const base = 'c0830056-0000-4000-8000-0000000000';
const EMPRESA = `${base}0a`;
const GESTOR = `${base}1a`;
const GESTOR_EMAIL = 'fit056-gestor@teste.local';
const GESTOR_SENHA = 'senha-do-gestor-fit-056';

const db = new PrismaClient();
/** A conexão que segura a linha (a barreira). */
const barreira = new PrismaClient();
/** Quem lê `pg_stat_activity`, fora das transações em julgamento. */
const observador = new PrismaClient();

const q = (sql: string, ...v: unknown[]) => db.$executeRawUnsafe(sql, ...v);
const ler = <T>(sql: string, ...v: unknown[]) =>
  db.$queryRawUnsafe<T[]>(sql, ...v);

const sha256 = (valor: string) =>
  createHash('sha256').update(valor).digest('hex');
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

let appA: INestApplication<App>;
let appB: INestApplication<App>;
let memorias: MemoriaProvedorDeEmail[];
let tokenDoGestor: string;

let ipSeq = 0;
/**
 * Um visitante novo por chamada pública: a rota conta 10 por IP a cada 15
 * min, e o limite tem prova própria (`throttle-por-usuario.e2e-spec.ts`).
 */
function ip(): string {
  ipSeq += 1;
  return `10.56.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

// `.then((r) => r)` dispara a requisição na hora: o supertest só envia quando
// alguém pede o resultado, e a barreira precisa delas já a caminho.
const ativar = (app: INestApplication<App>, token: string, senha: string) =>
  request(app.getHttpServer())
    .post('/api/v1/public/ativacao')
    .set('do-connecting-ip', ip())
    .send({ token, senha })
    .then((r) => r);

const consultar = (token: string) =>
  request(appA.getHttpServer())
    .get(`/api/v1/public/ativacao/${token}`)
    .set('do-connecting-ip', ip())
    .then((r) => r);

const enviar = (app: INestApplication<App>, alunoId: string) =>
  request(app.getHttpServer())
    .post(`/api/v1/students/${alunoId}/convite-de-acesso`)
    .set('Authorization', `Bearer ${tokenDoGestor}`)
    .then((r) => r);

const regenerar = (app: INestApplication<App>, alunoId: string) =>
  request(app.getHttpServer())
    .post(`/api/v1/students/${alunoId}/senha-temporaria`)
    .set('Authorization', `Bearer ${tokenDoGestor}`)
    .then((r) => r);

interface Aluno {
  alunoId: string;
  usuarioId: string;
  email: string;
}

let alunoSeq = 0;
/** Conta com senha temporária e ficha aprovada, por SQL (custo 4, fixture). */
async function novoAluno(): Promise<Aluno> {
  alunoSeq += 1;
  const usuarioId = randomUUID();
  const alunoId = randomUUID();
  const email = `fit056-aluno-${alunoSeq}@teste.local`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,senha_temporaria,senha_temporaria_expira_em,updated_at)
     VALUES ($1::uuid,$2,$3,$4,'aluno',$5::uuid,true,now() + interval '7 days',now())`,
    usuarioId,
    email,
    await bcrypt.hash(`pck-FIT056${alunoSeq}`, 4),
    `Aluna${alunoSeq} Concorrente`,
    EMPRESA,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ($1::uuid,$2::uuid,$3::uuid,'aprovado')`,
    alunoId,
    usuarioId,
    EMPRESA,
  );
  return { alunoId, usuarioId, email };
}

/**
 * Os tokens dos e-mails capturados pelos dois apps para um destinatário — o
 * único lugar onde o token cru existe (INV-083f).
 */
function tokensPara(email: string): string[] {
  return memorias
    .flatMap((m) => m.enviados)
    .filter((m) => m.to === email)
    .map((m) => {
      const achado =
        /https:\/\/cliente\.teste\.local\/ativar\/([A-Za-z0-9_-]{43})\n/.exec(
          m.text,
        );
      if (!achado) {
        throw new Error('e-mail capturado sem link de ativação');
      }
      return achado[1];
    });
}

/** Envia pela ficha, fora de corrida, e devolve o token do e-mail. */
async function emitirLink(aluno: Aluno): Promise<string> {
  const res = await enviar(appA, aluno.alunoId);
  expect(res.status).toBe(200);
  const tokens = tokensPara(aluno.email);
  expect(tokens).toHaveLength(1);
  return tokens[0];
}

async function contaDe(usuarioId: string) {
  const [linha] = await ler<{ senha_hash: string; senha_temporaria: boolean }>(
    `SELECT senha_hash, senha_temporaria FROM usuarios WHERE id = $1::uuid`,
    usuarioId,
  );
  return linha;
}

const convitesDe = (usuarioId: string) =>
  ler<{
    id: string;
    token_hash: string;
    usado_em: Date | null;
    revogado_em: Date | null;
  }>(
    `SELECT id, token_hash, usado_em, revogado_em FROM convites_de_acesso
      WHERE usuario_id = $1::uuid ORDER BY criado_em, id`,
    usuarioId,
  );

/** O `410` da D7, pelo corpo: um código só, para os oito motivos. */
function ehLinkInvalido(res: Response): boolean {
  return (
    res.status === 410 &&
    JSON.stringify(bodyOf<object>(res)) === JSON.stringify(LINK_INVALIDO)
  );
}

// ============================================================================
// A barreira e o observador
// ============================================================================

interface Barreira {
  pid: number;
  /** Solta a linha e espera a transação da barreira terminar. */
  soltar: () => Promise<void>;
}

/**
 * Abre uma transação que trava **uma** linha (`sql` com `FOR UPDATE`) e a
 * segura até `soltar()`. Devolve o pid dela, que é a raiz da fila.
 */
async function erguerBarreira(
  sql: string,
  ...valores: unknown[]
): Promise<Barreira> {
  let soltar!: () => void;
  const solta = new Promise<void>((r) => (soltar = r));
  let erguida!: (pid: number) => void;
  const pidDaBarreira = new Promise<number>((r) => (erguida = r));

  const dono = barreira.$transaction(
    async (tx) => {
      const [{ pid }] = await tx.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      const travadas = await tx.$queryRawUnsafe<unknown[]>(sql, ...valores);
      if (travadas.length !== 1) {
        throw new Error(`a barreira travou ${travadas.length} linhas: ${sql}`);
      }
      erguida(pid);
      await solta;
    },
    { timeout: 60_000 },
  );
  const pid = await Promise.race([
    pidDaBarreira,
    dono.then(() => {
      throw new Error('a barreira terminou antes de travar a linha');
    }),
  ]);
  return {
    pid,
    soltar: async () => {
      soltar();
      await dono;
    },
  };
}

interface Esperando {
  pid: number;
  /** `pg_blocking_pids`: quem segura a trava que ele espera. */
  por: number[];
  consulta: string;
}

/** Quem está parado numa trava agora, neste banco (o observador não conta). */
function esperandoTrava(): Promise<Esperando[]> {
  return observador.$queryRawUnsafe<Esperando[]>(
    `SELECT a.pid, pg_blocking_pids(a.pid) AS por,
            left(regexp_replace(a.query, '\\s+', ' ', 'g'), 100) AS consulta
       FROM pg_stat_activity a
      WHERE a.datname = current_database()
        AND a.wait_event_type = 'Lock'
        AND a.pid <> pg_backend_pid()
      ORDER BY a.pid`,
  );
}

/**
 * Lê a fila até `achar` reconhecer o que procura (ou o prazo acabar). Devolve
 * o achado e a última fila vista, que vai na mensagem quando a precondição
 * falha.
 */
async function aguardar<T>(
  achar: (fila: Esperando[]) => T | null,
): Promise<{ achado: T | null; vista: string }> {
  let vista = 'nada visto';
  const limite = Date.now() + 20_000;
  while (Date.now() < limite) {
    const fila = await esperandoTrava();
    vista = JSON.stringify(fila);
    const achado = achar(fila);
    if (achado !== null) {
      return { achado, vista };
    }
    await pausa(50);
  }
  return { achado: null, vista };
}

/**
 * A precondição dos casos (a) e (c), **neutra quanto ao desenho**: dois
 * esperando, cada um bloqueado só pela barreira ou pelo outro, e ao menos um
 * pela barreira. Não diz em qual instrução: é o que deixa a S1 julgar o (a)
 * pelo resultado.
 */
function doisNaFila(pidDaBarreira: number) {
  return (fila: Esperando[]): string | null => {
    if (fila.length !== 2) {
      return null;
    }
    const conhecidos = new Set([pidDaBarreira, ...fila.map((e) => e.pid)]);
    const encadeados = fila.every(
      (e) =>
        e.por.length > 0 &&
        e.por.every((p) => p !== e.pid && conhecidos.has(p)),
    );
    const ancorados = fila.some((e) => e.por.includes(pidDaBarreira));
    return encadeados && ancorados
      ? `precondição: barreira ${pidDaBarreira}; ${fila
          .map(
            (e) => `${e.pid} esperando ${e.por.join(',')} em "${e.consulta}"`,
          )
          .join('; ')}`
      : null;
  };
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube FIT-056','fit-056-${EMPRESA}',now())`,
    ),
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ($1::uuid,$2,$3,'Gestora FIT-056','company_admin',$4::uuid,now())`,
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
    .set('do-connecting-ip', ip())
    .send({ email: GESTOR_EMAIL, senha: GESTOR_SENHA });
  expect(login.status).toBe(200);
  tokenDoGestor = bodyOf<{ accessToken: string }>(login).accessToken;
});

beforeEach(() => {
  memorias.forEach((m) => m.limpar());
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

describe('FIT-056 (a) — o mesmo link ativado duas vezes ao mesmo tempo (INV-083a)', () => {
  it('um 204 e um 410, e a senha final é a de quem ganhou', async () => {
    const aluno = await novoAluno();
    const token = await emitirLink(aluno);

    const trava = await erguerBarreira(
      `SELECT id FROM usuarios WHERE id = $1::uuid FOR UPDATE`,
      aluno.usuarioId,
    );
    let respostas: Promise<Response[]>;
    let vista: string;
    try {
      respostas = Promise.all([
        ativar(appA, token, 'senha-da-requisicao-A'),
        ativar(appB, token, 'senha-da-requisicao-B'),
      ]);
      const visto = await aguardar(doisNaFila(trava.pid));
      vista = visto.achado ?? `precondição NÃO vista: ${visto.vista}`;
    } finally {
      // Solta sempre: uma precondição falha não pode deixar as requisições
      // penduradas até o timeout da transação.
      await trava.soltar();
    }
    const [a, b] = await respostas;
    expect(vista).toMatch(/^precondição:/);

    const detalhe = [a, b].map((r) => `${r.status} ${r.text.slice(0, 300)}`);
    expect({ status: [a.status, b.status].sort(), detalhe }).toEqual({
      status: [204, 410],
      detalhe,
    });
    const perdedora = a.status === 410 ? a : b;
    expect(ehLinkInvalido(perdedora)).toBe(true);

    const [senhaDaVencedora, senhaDaPerdedora] =
      a.status === 204
        ? ['senha-da-requisicao-A', 'senha-da-requisicao-B']
        : ['senha-da-requisicao-B', 'senha-da-requisicao-A'];
    const conta = await contaDe(aluno.usuarioId);
    expect(conta.senha_temporaria).toBe(false);
    expect(await bcrypt.compare(senhaDaVencedora, conta.senha_hash)).toBe(true);
    expect(await bcrypt.compare(senhaDaPerdedora, conta.senha_hash)).toBe(
      false,
    );
    const convites = await convitesDe(aluno.usuarioId);
    expect(convites).toHaveLength(1);
    expect(convites[0].usado_em).not.toBeNull();
  });
});

describe('FIT-056 (b) — ativar × regenerar a senha temporária (INV-083c)', () => {
  type Ordem = 'ativação primeiro' | 'regeneração primeiro';

  /**
   * O estado final coerente com cada ordem. Nos dois, a senha que vale no fim
   * é a da regeneração: ou porque ela matou o link antes (`410`, link não
   * usado), ou porque ela sobrescreveu a do link depois (`204`, link usado, e
   * a conta de volta à senha temporária).
   */
  const ESPERADO: Record<
    Ordem,
    {
      ativacao: number;
      regeneracao: number;
      senhaFinal: string;
      senhaTemporaria: boolean;
      linkUsado: boolean;
    }
  > = {
    'ativação primeiro': {
      ativacao: 204,
      regeneracao: 200,
      senhaFinal: 'a da regeneração',
      senhaTemporaria: true,
      linkUsado: true,
    },
    'regeneração primeiro': {
      ativacao: 410,
      regeneracao: 200,
      senhaFinal: 'a da regeneração',
      senhaTemporaria: true,
      linkUsado: false,
    },
  };

  const SENHA_DO_LINK = 'senha-escolhida-pelo-link';

  /** O que de fato ficou, nas mesmas chaves do `ESPERADO`. */
  async function estadoFinal(
    aluno: Aluno,
    ativacao: Response,
    regeneracao: Response,
  ) {
    const conta = await contaDe(aluno.usuarioId);
    const senhaRegenerada =
      regeneracao.status === 200
        ? bodyOf<{ senhaTemporaria: string }>(regeneracao).senhaTemporaria
        : '';
    const senhaFinal = (await bcrypt.compare(senhaRegenerada, conta.senha_hash))
      ? 'a da regeneração'
      : (await bcrypt.compare(SENHA_DO_LINK, conta.senha_hash))
        ? 'a do link'
        : 'nenhuma das duas';
    const [convite] = await convitesDe(aluno.usuarioId);
    if (ativacao.status === 410) {
      expect(ehLinkInvalido(ativacao)).toBe(true);
    }
    return {
      ativacao: ativacao.status,
      regeneracao: regeneracao.status,
      senhaFinal,
      senhaTemporaria: conta.senha_temporaria,
      linkUsado: convite.usado_em !== null,
    };
  }

  it('ativação primeiro: ela segura o usuário, a regeneração é vista esperando, e sobrescreve depois', async () => {
    const aluno = await novoAluno();
    const token = await emitirLink(aluno);
    const [convite] = await convitesDe(aluno.usuarioId);

    const trava = await erguerBarreira(
      `SELECT id FROM convites_de_acesso WHERE id = $1::uuid FOR UPDATE`,
      convite.id,
    );
    let ativacao: Promise<Response>;
    let regeneracao: Promise<Response> | undefined;
    let ordem: Ordem | null = null;
    let vista: string;
    try {
      ativacao = ativar(appB, token, SENHA_DO_LINK);
      // A ativação parada na reivindicação (passo 4): já passou da leitura do
      // usuário (passo 2).
      const naReivindicacao = await aguardar((fila) => {
        const e = fila.find(
          (x) =>
            x.por.includes(trava.pid) &&
            x.consulta.includes('UPDATE convites_de_acesso SET usado_em'),
        );
        return e ?? null;
      });
      vista = naReivindicacao.vista;
      if (naReivindicacao.achado) {
        const pidDaAtivacao = naReivindicacao.achado.pid;
        let regeneracaoVoltou = false;
        regeneracao = regenerar(appA, aluno.alunoId).then((r) => {
          regeneracaoVoltou = true;
          return r;
        });
        // A ordem é o que se vê: a regeneração esperando pela ativação, ou a
        // regeneração já de volta enquanto a ativação ainda está parada.
        const visto = await aguardar<Ordem>((fila) =>
          fila.some((x) => x.por.includes(pidDaAtivacao))
            ? 'ativação primeiro'
            : regeneracaoVoltou
              ? 'regeneração primeiro'
              : null,
        );
        ordem = visto.achado;
        vista = visto.vista;
      }
    } finally {
      await trava.soltar();
    }
    const [respostaDaAtivacao, respostaDaRegeneracao] = await Promise.all([
      ativacao,
      regeneracao ??
        Promise.reject(new Error(`precondição NÃO vista: ${vista}`)),
    ]);

    expect(ordem).not.toBeNull();
    const ordemVista = ordem as Ordem;
    const estado = await estadoFinal(
      aluno,
      respostaDaAtivacao,
      respostaDaRegeneracao,
    );
    // A `vista` vai dos dois lados: se reprovar, a mensagem mostra a fila.
    expect({ ordem: ordemVista, vista, ...estado }).toEqual({
      ordem: ordemVista,
      vista,
      ...ESPERADO[ordemVista],
    });
  });

  it('regeneração primeiro: ela segura o usuário, a ativação é vista esperando, e o link responde 410', async () => {
    const aluno = await novoAluno();
    const token = await emitirLink(aluno);
    // Uma sessão viva: é nela que a regeneração para, já com o usuário gravado.
    const [sessao] = await ler<{ id: string }>(
      `INSERT INTO refresh_tokens (id, usuario_id, token_hash, expires_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, now() + interval '1 day')
       RETURNING id`,
      aluno.usuarioId,
      `fit-056-${randomUUID()}`,
    );

    const trava = await erguerBarreira(
      `SELECT id FROM refresh_tokens WHERE id = $1::uuid FOR UPDATE`,
      sessao.id,
    );
    let regeneracao: Promise<Response>;
    let ativacao: Promise<Response> | undefined;
    let ordem: Ordem | null = null;
    let vista: string;
    try {
      regeneracao = regenerar(appA, aluno.alunoId);
      const nasSessoes = await aguardar((fila) => {
        const e = fila.find(
          (x) =>
            x.por.includes(trava.pid) && x.consulta.includes('refresh_tokens'),
        );
        return e ?? null;
      });
      vista = nasSessoes.vista;
      if (nasSessoes.achado) {
        const pidDaRegeneracao = nasSessoes.achado.pid;
        ativacao = ativar(appB, token, SENHA_DO_LINK);
        const visto = await aguardar<Ordem>((fila) =>
          fila.some((x) => x.por.includes(pidDaRegeneracao))
            ? 'regeneração primeiro'
            : null,
        );
        ordem = visto.achado;
        vista = visto.vista;
      }
    } finally {
      await trava.soltar();
    }
    const [respostaDaRegeneracao, respostaDaAtivacao] = await Promise.all([
      regeneracao,
      ativacao ?? Promise.reject(new Error(`precondição NÃO vista: ${vista}`)),
    ]);

    expect(ordem).not.toBeNull();
    const ordemVista = ordem as Ordem;
    const estado = await estadoFinal(
      aluno,
      respostaDaAtivacao,
      respostaDaRegeneracao,
    );
    expect({ ordem: ordemVista, vista, ...estado }).toEqual({
      ordem: ordemVista,
      vista,
      ...ESPERADO[ordemVista],
    });
  });
});

describe('FIT-056 (c) — dois envios simultâneos para o mesmo aluno (INV-083b, AC-035)', () => {
  it('um convite vivo no fim, e nenhuma resposta 500', async () => {
    const aluno = await novoAluno();

    const trava = await erguerBarreira(
      `SELECT id FROM usuarios WHERE id = $1::uuid FOR UPDATE`,
      aluno.usuarioId,
    );
    let respostas: Promise<Response[]>;
    let vista: string;
    try {
      respostas = Promise.all([
        enviar(appA, aluno.alunoId),
        enviar(appB, aluno.alunoId),
      ]);
      const visto = await aguardar(doisNaFila(trava.pid));
      vista = visto.achado ?? `precondição NÃO vista: ${visto.vista}`;
    } finally {
      await trava.soltar();
    }
    const resolvidas = await respostas;
    expect(vista).toMatch(/^precondição:/);

    // AC-035: nenhum 500. O único 409 aceitável é o do índice (D9).
    const detalhe = resolvidas.map(
      (r) => `${r.status} ${r.text.slice(0, 300)}`,
    );
    for (const r of resolvidas) {
      expect({ status: r.status, detalhe }).not.toMatchObject({ status: 500 });
      if (r.status === 409) {
        expect(bodyOf<object>(r)).toEqual(CONVITE_EM_EMISSAO);
      }
    }

    // INV-083b: um vivo, e só um.
    const convites = await convitesDe(aluno.usuarioId);
    const vivos = convites.filter(
      (c) => c.usado_em === null && c.revogado_em === null,
    );
    expect({ vivos: vivos.length, detalhe }).toEqual({ vivos: 1, detalhe });

    // D9: com a trava, os dois envios são serializados, e não colidem — os
    // dois emitem, e o segundo revoga o do primeiro. O 409 é para a corrida
    // que a trava não serializou.
    expect({ status: resolvidas.map((r) => r.status), detalhe }).toEqual({
      status: [200, 200],
      detalhe,
    });
    expect(convites).toHaveLength(2);
    const tokens = tokensPara(aluno.email);
    expect(tokens).toHaveLength(2);
    expect(convites.map((c) => c.token_hash).sort()).toEqual(
      tokens.map(sha256).sort(),
    );
    const tokenVivo = tokens.find((t) => sha256(t) === vivos[0].token_hash);
    const tokenRevogado = tokens.find((t) => t !== tokenVivo) as string;
    expect(ehLinkInvalido(await consultar(tokenRevogado))).toBe(true);
    expect((await consultar(tokenVivo as string)).status).toBe(200);
  });
});
