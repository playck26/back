/**
 * SPEC-086 — **a matriz de pares pela HTTP, contra o Postgres de verdade**
 * (AC-006), e as entradas uma a uma com a chave nos dois estados (AC-003,
 * AC-004, AC-017).
 *
 * ## O que a matriz prova (spec, "A matriz de pares", DOR-086-R2-04)
 *
 * A migration da 086 deixou o banco aceitar o mesmo e-mail em empresas
 * diferentes. Com a chave `EMAIL_EM_VARIAS_EMPRESAS` desligada, quem impede a
 * repetição é a pré-conferência — e ela só vale sob a trava por e-mail
 * (`travarEmailsParaCriarConta`), porque duas transações em empresas
 * diferentes conferem "ausente" ao mesmo tempo e gravam as duas. Cada prova é
 * um par de escritores, o mesmo e-mail, a chave no estado da linha, e **as duas
 * ordens de chegada**.
 *
 * Os pares que só passam se a trava for **comum** a escritores diferentes são
 * P2 (empresas diferentes, mesma rota), P6, P7 e P8 (rotas diferentes contra a
 * referência E4): um escritor com outro prefixo de chave, ou com a empresa na
 * chave, grava duas contas aqui (S14, S15, S21).
 *
 * ## A sobreposição é forçada, não esperada
 *
 * Sem controle, a segunda requisição chegaria depois do `COMMIT` da primeira e
 * perderia na conferência de **fora** da transação (o atalho) — e a trava
 * nunca entraria em julgamento. Por isso:
 *
 * 1. uma conexão adversária segura `pg_advisory_xact_lock` da chave do e-mail
 *    (`ChaveDeLock.deTexto('usuarios.email:' + email)`, o mesmo cálculo da
 *    produção), numa transação aberta;
 * 2. a primeira requisição é disparada, e só se segue quando ela é **vista**
 *    em `pg_stat_activity` esperando a trava (`wait_event = 'advisory'`,
 *    bloqueada pelo pid do adversário);
 * 3. a segunda é disparada, e também é vista esperando. As duas passaram da
 *    conferência de fora (a primeira ainda não gravou nada);
 * 4. o adversário solta. A fila da trava é FIFO: a primeira a chegar ganha a
 *    trava e grava; a segunda confere **sob a trava** e decide.
 *
 * O orçamento da trava é 5 s (`PRAZO_DA_TRAVA_DE_EMAIL_MS`), contado de quando
 * a primeira começou a esperar. A segunda tem até `JANELA_DA_SEGUNDA_MS` para
 * chegar; se não chegar (bcrypt de custo 12 antes da transação, CPU
 * disputada), a rodada é descartada sem julgamento e refeita com outro e-mail
 * — e o número de rodadas descartadas é impresso no fim. Sem a precondição
 * vista, o caso nunca é julgado por um resultado aparentemente bom.
 *
 * Cada requisição do par vai para um app diferente, cada um com a própria
 * pool (`test/fit/app-real.ts`).
 *
 * ## O que é conferido em cada prova
 *
 * O status e o corpo de **cada** resposta (o contrato da própria rota), as
 * contas com o e-mail (papel e empresa, exatas) e o resíduo proibido da tabela
 * "O que cada transação escreve": o convite da E2 volta a ser utilizável, a E5
 * deixa o professor sem conta, a E6 não deixa nenhuma linha do lote, a E7 não
 * deixa empresa órfã. Nenhum `500`.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { EMAIL_EM_USO } from '../../src/acesso/traduzir-violacao-de-unicidade';
import { ChaveDeLock } from '../../src/common/lock/chave-de-lock';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import { PROVEDOR_DE_EMAIL } from '../../src/email/provedor-de-email';
import { MENSAGEM_EMAIL_JA_EXISTE } from '../../src/people/importacao/importacao-de-alunos.service';
import { subirAppReal } from '../fit/app-real';
import { bodyOf } from '../utils/http';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture } from './nivel-da-fixture';

exigirBancoLocal();
jest.setTimeout(180_000);

// Antes de o app subir: o `EmailModule` lê no boot. Memória, sempre — a E5a
// envia convite por e-mail, e nada sai daqui.
process.env.EMAIL_PROVEDOR = 'memoria';
process.env.EMAIL_REMETENTE = 'convites@remetente.teste.local';
process.env.EMAIL_RESPONDER_PARA = 'respostas@suporte.teste.local';
process.env.URL_CLIENTE = 'https://cliente.teste.local';

const CHAVE = 'EMAIL_EM_VARIAS_EMPRESAS';
const chaveAntes = process.env[CHAVE];
/** A chave é lida a cada chamada (`emailEmVariasEmpresas`), nos dois apps. */
function chave(ligada: boolean): void {
  process.env[CHAVE] = ligada ? 'true' : 'false';
}

const base = '0860e000-0000-4000-8000-0000000000';
const SUPER = `${base}5a`;
const SUPER_EMAIL = 'spec086-matriz-super@teste.local';
const SENHA = 'senha-da-matriz-086';
/** O nome de toda empresa criada pela E7 começa assim (limpeza por prefixo). */
const PREFIXO_E7 = 'SPEC-086 Matriz E7';

/**
 * Quanto a segunda requisição tem para chegar à trava, contado de quando a
 * primeira foi vista esperando. Bem abaixo do orçamento da trava, com folga para a
 * primeira ainda pegar a trava viva depois de o adversário soltar.
 */
const JANELA_DA_SEGUNDA_MS = 1_300;
const RODADAS_POR_PROVA = 3;

const db = new PrismaClient();
/** Segura a trava do e-mail enquanto as duas requisições chegam. */
const adversario = new PrismaClient();
/** Lê `pg_stat_activity`, fora de tudo o que está em julgamento. */
const observador = new PrismaClient();

const q = (sql: string, ...v: unknown[]) => db.$executeRawUnsafe(sql, ...v);
const ler = <T>(sql: string, ...v: unknown[]) =>
  db.$queryRawUnsafe<T[]>(sql, ...v);

let appA: INestApplication<App>;
let appB: INestApplication<App>;
let memorias: MemoriaProvedorDeEmail[];
let tokenDoSuper: string;

interface Empresa {
  id: string;
  nome: string;
  slug: string;
  gestorId: string;
  plano: string;
  token: string;
}

function empresaDaFixture(letra: 'a' | 'b'): Empresa {
  return {
    id: `${base}${letra}1`,
    nome: `SPEC-086 Matriz ${letra.toUpperCase()}`,
    slug: `spec-086-matriz-${letra}`,
    gestorId: `${base}${letra}2`,
    plano: `${base}${letra}3`,
    token: '',
  };
}
const EMP_A = empresaDaFixture('a');
const EMP_B = empresaDaFixture('b');

// O limite de login/cadastro público é 10 por IP por rota (`LimiteDeLogin`):
// cada requisição pública sai de um IP próprio, ou a matriz estouraria o
// limite e mediria o throttle.
let ipSeq = 0;
function proximoIp(): string {
  ipSeq += 1;
  return `10.86.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

let seq = 0;
function novoEmail(rotulo: string): string {
  seq += 1;
  // Minúsculo: a importação grava o e-mail em minúsculas, e o mesmo texto
  // precisa ir para a coluna por todas as rotas.
  return `spec086-matriz-${rotulo.toLowerCase()}-${seq}@teste.local`;
}

// ============================================================================
// Os escritores
// ============================================================================

type Escritor = 'E1' | 'E2' | 'E4' | 'E5a' | 'E5b' | 'E6' | 'E7' | 'E8';
type Papel = 'aluno' | 'professor' | 'company_admin';

/** Uma requisição de um escritor, com a fixture dela já gravada. */
interface Tentativa {
  rotulo: string;
  escritor: Escritor;
  /** Onde a conta cai, se esta tentativa vencer. */
  empresaNome: string;
  papel: Papel;
  disparar(app: INestApplication<App>): Promise<Response>;
  confereSucesso(r: Response): void;
  /** O contrato da recusa da própria rota (spec, "A resposta por entrada"). */
  confereRecusa(r: Response): void;
  /**
   * Depois da corrida: o que a vencedora deixou, ou — se perdeu — que nada da
   * coluna "Resíduo proibido" ficou.
   */
  confereDepois(venceu: boolean): Promise<void>;
}

/** O status e o corpo juntos: um `500` sem corpo custaria um ciclo de CI. */
function statusECorpo(r: Response): { status: number; corpo: unknown } {
  return { status: r.status, corpo: bodyOf<unknown>(r) };
}

function confereStatus(r: Response, esperado: number): void {
  const detalhe = r.text.slice(0, 400);
  expect({ status: r.status, detalhe }).toEqual({ status: esperado, detalhe });
}

const recusaDoCadastroPublico = {
  statusCode: 422,
  message: 'Não foi possível concluir o cadastro com esses dados.',
  error: 'Unprocessable Entity',
};

async function novoProfessor(empresa: Empresa, email: string) {
  const id = randomUUID();
  await q(
    `INSERT INTO professores (id, company_id, nome, telefone, email)
     VALUES ($1::uuid, $2::uuid, 'Professor Matriz 086', '11988887777', $3)`,
    id,
    empresa.id,
    email,
  );
  return id;
}

async function professorSemConta(id: string): Promise<boolean> {
  const [p] = await ler<{ usuario_id: string | null }>(
    `SELECT usuario_id FROM professores WHERE id = $1::uuid`,
    id,
  );
  return p.usuario_id === null;
}

const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** Monta a tentativa de um escritor, gravando a fixture que ele exige. */
async function montar(
  escritor: Escritor,
  empresa: Empresa,
  email: string,
): Promise<Tentativa> {
  const rotulo = `${escritor}@${empresa.slug.slice(-1).toUpperCase()}`;
  const comGestor = (r: request.Test) =>
    r.set('Authorization', `Bearer ${empresa.token}`);

  switch (escritor) {
    case 'E1':
      return {
        rotulo,
        escritor,
        empresaNome: empresa.nome,
        papel: 'aluno',
        disparar: (app) =>
          request(app.getHttpServer())
            .post('/api/v1/auth/register-aluno')
            .set('do-connecting-ip', proximoIp())
            .send({
              email,
              senha: SENHA,
              nome: 'Aluno E1 Matriz',
              empresaSlug: empresa.slug,
            })
            .then((r) => r),
        confereSucesso: (r) => {
          confereStatus(r, 201);
          expect(bodyOf<{ usuario: { email: string } }>(r).usuario.email).toBe(
            email,
          );
        },
        confereRecusa: (r) =>
          expect(statusECorpo(r)).toEqual({
            status: 422,
            corpo: recusaDoCadastroPublico,
          }),
        confereDepois: () => Promise.resolve(),
      };

    case 'E2': {
      // Convite COM plano e contrato vigente: a perdedora reivindicaria o
      // convite, criaria aluno, aceites e matrícula — e tudo isso tem de
      // voltar (a tabela "O que cada transação escreve").
      const token = `spec086-matriz-convite-${randomUUID()}`;
      await q(
        `INSERT INTO convites_aluno (id, company_id, criado_por_id, email, nome, token_hash, expira_em, plano_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'Aluno E2 Matriz', $4, now() + interval '7 days', $5::uuid)`,
        empresa.id,
        empresa.gestorId,
        email,
        tokenHash(token),
        empresa.plano,
      );
      return {
        rotulo,
        escritor,
        empresaNome: empresa.nome,
        papel: 'aluno',
        disparar: (app) =>
          request(app.getHttpServer())
            .post('/api/v1/auth/aceitar-convite')
            .set('do-connecting-ip', proximoIp())
            .send({ token, senha: SENHA, termoVersao: 1, contratoVersao: 1 })
            .then((r) => r),
        confereSucesso: (r) => {
          confereStatus(r, 201);
          expect(
            bodyOf<{ usuario: { email: string }; planoAplicado: boolean }>(r),
          ).toMatchObject({ usuario: { email }, planoAplicado: true });
        },
        confereRecusa: (r) =>
          expect(statusECorpo(r)).toEqual({
            status: 422,
            corpo: recusaDoCadastroPublico,
          }),
        confereDepois: async (venceu) => {
          const [convite] = await ler<{ livre: boolean }>(
            `SELECT (usado_em IS NULL AND expira_em > now()) AS livre
               FROM convites_aluno WHERE token_hash = $1`,
            tokenHash(token),
          );
          // A perdedora: o convite volta a ser utilizável pela rota. A
          // matrícula e os aceites são conferidos por e-mail, no par inteiro
          // (`rastroDaE2`): na mesma empresa (P1) os da vencedora e os da
          // perdedora não se distinguem por empresa.
          expect({ conviteLivre: convite.livre }).toEqual({
            conviteLivre: !venceu,
          });
        },
      };
    }

    case 'E4':
      return {
        rotulo,
        escritor,
        empresaNome: empresa.nome,
        papel: 'aluno',
        disparar: (app) =>
          comGestor(request(app.getHttpServer()).post('/api/v1/students'))
            .send({ nome: 'Aluno E4 Matriz', email })
            .then((r) => r),
        confereSucesso: (r) => {
          confereStatus(r, 201);
          expect(
            typeof bodyOf<{ senhaTemporaria: unknown }>(r).senhaTemporaria,
          ).toBe('string');
        },
        confereRecusa: (r) =>
          expect(statusECorpo(r)).toEqual({
            status: 409,
            corpo: {
              statusCode: 409,
              message: 'Email já cadastrado',
              error: 'Conflict',
            },
          }),
        confereDepois: () => Promise.resolve(),
      };

    case 'E5a':
    case 'E5b': {
      const professor = await novoProfessor(empresa, email);
      const rota =
        escritor === 'E5a'
          ? `/api/v1/teachers/${professor}/convite-de-acesso`
          : `/api/v1/teachers/${professor}/acesso`;
      return {
        rotulo,
        escritor,
        empresaNome: empresa.nome,
        papel: 'professor',
        disparar: (app) =>
          comGestor(request(app.getHttpServer()).post(rota)).then((r) => r),
        confereSucesso: (r) => {
          if (escritor === 'E5a') {
            confereStatus(r, 200);
            expect(bodyOf<{ situacao: string }>(r).situacao).toBe('enviado');
          } else {
            confereStatus(r, 201);
            expect(
              typeof bodyOf<{ senhaTemporaria: unknown }>(r).senhaTemporaria,
            ).toBe('string');
          }
        },
        confereRecusa: (r) =>
          expect(statusECorpo(r)).toEqual({ status: 409, corpo: EMAIL_EM_USO }),
        confereDepois: async (venceu) => {
          // Perdedora: o professor continua sem conta (E5a e E5b), e a E5a
          // não deixou convite de acesso — sem conta não há a quem apontar.
          expect(await professorSemConta(professor)).toBe(!venceu);
          if (escritor === 'E5a') {
            const [{ vivos }] = await ler<{ vivos: number }>(
              `SELECT count(*)::int AS vivos FROM convites_de_acesso c
                 JOIN professores p ON p.usuario_id = c.usuario_id
                WHERE p.id = $1::uuid AND c.usado_em IS NULL AND c.revogado_em IS NULL`,
              professor,
            );
            expect(vivos).toBe(venceu ? 1 : 0);
          }
        },
      };
    }

    case 'E6': {
      // Duas linhas: a disputada e uma livre. Na recusa, a livre também não
      // pode ficar — "nenhuma linha do lote".
      const livre = novoEmail('e6-livre');
      const planilha = `nome,email\nAluno E6 Matriz,${email}\nAluno E6 Livre,${livre}\n`;
      return {
        rotulo,
        escritor,
        empresaNome: empresa.nome,
        papel: 'aluno',
        disparar: (app) =>
          comGestor(
            request(app.getHttpServer()).post('/api/v1/students/importar'),
          )
            .attach('arquivo', Buffer.from(planilha, 'utf8'), 'alunos.csv')
            .then((r) => r),
        confereSucesso: (r) => {
          confereStatus(r, 201);
          const criados = bodyOf<{ criados: { email: string }[] }>(r).criados;
          expect(criados.map((c) => c.email).sort()).toEqual(
            [email, livre].sort(),
          );
        },
        confereRecusa: (r) => {
          confereStatus(r, 422);
          expect(
            bodyOf<{ statusCode: number; code: string; erros: unknown[] }>(r),
          ).toMatchObject({
            statusCode: 422,
            code: 'PLANILHA_COM_ERROS',
            erros: [
              { linha: 2, coluna: 'email', mensagem: MENSAGEM_EMAIL_JA_EXISTE },
            ],
          });
        },
        confereDepois: async (venceu) => {
          const [{ n }] = await ler<{ n: number }>(
            `SELECT count(*)::int AS n FROM usuarios WHERE email = $1`,
            livre,
          );
          expect({ linhaLivre: n }).toEqual({ linhaLivre: venceu ? 1 : 0 });
        },
      };
    }

    case 'E7': {
      seq += 1;
      const nome = `${PREFIXO_E7} ${seq} ${Date.now()}`;
      return {
        rotulo: 'E7@nova',
        escritor,
        empresaNome: nome,
        papel: 'company_admin',
        disparar: (app) =>
          request(app.getHttpServer())
            .post('/api/v1/companies')
            .set('Authorization', `Bearer ${tokenDoSuper}`)
            .send({
              nome,
              esportes: ['Tênis'],
              adminInicial: { nome: 'Gestora E7', email, senha: SENHA },
            })
            .then((r) => r),
        confereSucesso: (r) => {
          confereStatus(r, 201);
          expect(
            bodyOf<{ adminUsuario: { email: string } }>(r).adminUsuario.email,
          ).toBe(email);
        },
        confereRecusa: (r) =>
          expect(statusECorpo(r)).toEqual({
            status: 422,
            corpo: {
              statusCode: 422,
              message: 'Email do admin inicial já cadastrado',
              error: 'Unprocessable Entity',
            },
          }),
        confereDepois: async (venceu) => {
          // Nenhuma empresa órfã: a trava vem antes da empresa, e a recusa
          // não deixa empresa, catálogo, horário nem nível.
          const [r] = await ler<{
            empresas: number;
            niveis: number;
            horarios: number;
            esportes: number;
          }>(
            `SELECT count(DISTINCT e.id)::int AS empresas,
                    (SELECT count(*)::int FROM niveis n JOIN empresas x ON x.id = n.company_id WHERE x.nome = $1) AS niveis,
                    (SELECT count(*)::int FROM horarios_funcionamento h JOIN empresas x ON x.id = h.company_id WHERE x.nome = $1) AS horarios,
                    (SELECT count(*)::int FROM esportes_de_quadra s JOIN empresas x ON x.id = s.company_id WHERE x.nome = $1) AS esportes
               FROM empresas e WHERE e.nome = $1`,
            nome,
          );
          expect(r.empresas).toBe(venceu ? 1 : 0);
          if (!venceu)
            expect(r).toEqual({
              empresas: 0,
              niveis: 0,
              horarios: 0,
              esportes: 0,
            });
        },
      };
    }

    case 'E8':
      return {
        rotulo,
        escritor,
        empresaNome: empresa.nome,
        papel: 'company_admin',
        disparar: (app) =>
          request(app.getHttpServer())
            .post(`/api/v1/companies/${empresa.id}/admins`)
            .set('Authorization', `Bearer ${tokenDoSuper}`)
            .send({ nome: 'Gestora E8', email, senha: SENHA })
            .then((r) => r),
        confereSucesso: (r) => {
          confereStatus(r, 201);
          expect(bodyOf<{ email: string }>(r).email).toBe(email);
        },
        confereRecusa: (r) =>
          expect(statusECorpo(r)).toEqual({ status: 409, corpo: EMAIL_EM_USO }),
        confereDepois: () => Promise.resolve(),
      };
  }
}

// ============================================================================
// O estado no banco
// ============================================================================

interface Conta {
  papel: string;
  empresa: string;
}

/** Todas as contas com o e-mail: papel e nome da empresa, em ordem. */
async function contasDoEmail(email: string): Promise<Conta[]> {
  return ler<Conta>(
    `SELECT u.role::text AS papel, e.nome AS empresa
       FROM usuarios u JOIN empresas e ON e.id = u.company_id
      WHERE u.email = $1
      ORDER BY e.nome, u.role::text`,
    email,
  );
}

const ordenar = (contas: Conta[]) =>
  [...contas].sort((x, y) =>
    `${x.empresa}|${x.papel}`.localeCompare(`${y.empresa}|${y.papel}`),
  );

/** Perfis de aluno ligados às contas do e-mail (nada solto da perdedora). */
async function alunosDoEmail(email: string): Promise<number> {
  const [{ n }] = await ler<{ n: number }>(
    `SELECT count(*)::int AS n FROM alunos a JOIN usuarios u ON u.id = a.usuario_id WHERE u.email = $1`,
    email,
  );
  return n;
}

/**
 * O rastro da E2 com o e-mail: matrículas contratuais e aceites. Cada E2 que
 * venceu deixa uma matrícula e dois aceites (termo e contrato); a perdedora,
 * nenhum — nem na mesma empresa da vencedora.
 */
async function rastroDaE2(
  email: string,
): Promise<{ matriculas: number; aceites: number }> {
  const [r] = await ler<{ matriculas: number; aceites: number }>(
    `SELECT (SELECT count(*)::int FROM matriculas m JOIN usuarios u ON u.id = m.usuario_id WHERE u.email = $1) AS matriculas,
            (SELECT count(*)::int FROM aceites a JOIN usuarios u ON u.id = a.usuario_id WHERE u.email = $1) AS aceites`,
    email,
  );
  return r;
}

const emailsPara = (para: string) =>
  memorias.flatMap((m) => m.enviados).filter((m) => m.to === para);

/** Uma conta gravada por fora (SQL direto), para as fixtures dos ACs. */
async function contaDireta(
  email: string,
  empresa: Empresa,
  papel: Papel,
  criadaHa = '0 seconds',
): Promise<void> {
  await q(
    `INSERT INTO usuarios (id, email, senha_hash, nome, role, company_id, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'Conta prévia 086', '${papel}', $3::uuid, now() - $4::interval, now())`,
    email,
    await bcrypt.hash(SENHA, 4),
    empresa.id,
    criadaHa,
  );
}

// ============================================================================
// A corrida
// ============================================================================

interface Esperando {
  pid: number;
  por: number[];
}

/** Quem está parado na trava de e-mail, e quem o bloqueia. */
function esperandoATrava(): Promise<Esperando[]> {
  return observador.$queryRawUnsafe<Esperando[]>(
    `SELECT a.pid, pg_blocking_pids(a.pid) AS por
       FROM pg_stat_activity a
      WHERE a.datname = current_database()
        AND a.wait_event_type = 'Lock'
        AND a.wait_event = 'advisory'
        AND a.query LIKE '%travar_emails_para_criar_conta%'
      ORDER BY a.pid`,
  );
}

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Lado {
  t: Tentativa;
  app: INestApplication<App>;
}

interface Rodada {
  primeira: Response;
  segunda: Response;
  precondicao: boolean;
  vista: string;
}

/**
 * Uma rodada: o adversário segura a trava do e-mail, a primeira é vista
 * esperando, a segunda é disparada e vista esperando, e o adversário solta.
 */
async function rodada(
  email: string,
  primeira: Lado,
  segunda: Lado,
): Promise<Rodada> {
  const chaveDoLock = ChaveDeLock.deTexto(`usuarios.email:${email}`);
  let soltar!: () => void;
  const solta = new Promise<void>((r) => (soltar = r));
  let segurando!: () => void;
  const segura = new Promise<void>((r) => (segurando = r));
  let pidAdversario = 0;

  const dono = adversario.$transaction(
    async (tx) => {
      pidAdversario = (
        await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      )[0].pid;
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(${chaveDoLock}::bigint)`;
      segurando();
      await solta;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  await segura;

  let vista = 'nada visto';
  let precondicao = false;
  let p2: Promise<Response> | null = null;
  let primeiraTerminou = false;
  const p1 = primeira.t.disparar(primeira.app).finally(() => {
    primeiraTerminou = true;
  });
  try {
    // 1. A primeira, parada na trava do adversário.
    let pidDaPrimeira = 0;
    const limite = Date.now() + 15_000;
    while (Date.now() < limite && !primeiraTerminou) {
      const parada = (await esperandoATrava()).find((e) =>
        e.por.includes(pidAdversario),
      );
      if (parada) {
        pidDaPrimeira = parada.pid;
        break;
      }
      await pausa(10);
    }
    if (pidDaPrimeira === 0) {
      vista = `a primeira (${primeira.t.rotulo}) não foi vista na trava`;
    } else {
      // 2. A segunda, parada atrás — com a primeira ainda dentro do orçamento.
      const desde = Date.now();
      p2 = segunda.t.disparar(segunda.app);
      while (Date.now() - desde < JANELA_DA_SEGUNDA_MS) {
        const esperando = await esperandoATrava();
        const atras = esperando.find(
          (e) =>
            e.pid !== pidDaPrimeira &&
            (e.por.includes(pidAdversario) || e.por.includes(pidDaPrimeira)),
        );
        if (atras && esperando.some((e) => e.pid === pidDaPrimeira)) {
          precondicao = true;
          vista = `precondição: ${primeira.t.rotulo} (pid ${pidDaPrimeira}) e ${segunda.t.rotulo} (pid ${atras.pid}) parados na trava do adversário ${pidAdversario}, a segunda ${Date.now() - desde} ms depois`;
          break;
        }
        await pausa(10);
      }
      if (!precondicao) {
        vista = `a segunda (${segunda.t.rotulo}) não chegou à trava em ${JANELA_DA_SEGUNDA_MS} ms`;
      }
    }
  } finally {
    // Solta sempre: uma precondição falha não pode deixar as requisições
    // penduradas até o timeout.
    soltar();
    await dono;
  }
  const r1 = await p1;
  const r2 = p2 ? await p2 : await segunda.t.disparar(segunda.app);
  return { primeira: r1, segunda: r2, precondicao, vista };
}

/** Rodadas descartadas (sem precondição), impressas no fim. */
const descartadas: string[] = [];
/** Rodadas julgadas (com a precondição vista), para o resumo do fim. */
const julgadas: string[] = [];

type Esperado = 'uma conta' | 'duas contas';

/**
 * Uma prova da matriz: até `RODADAS_POR_PROVA` rodadas, cada uma com e-mail e
 * fixture novos, até uma ter a precondição vista. Só essa é julgada.
 */
async function provar(
  nome: string,
  montarPar: (email: string) => Promise<[Lado, Lado]>,
  esperado: Esperado,
): Promise<void> {
  for (let i = 1; i <= RODADAS_POR_PROVA; i += 1) {
    const email = novoEmail('par');
    const [primeira, segunda] = await montarPar(email);
    const r = await rodada(email, primeira, segunda);
    if (!r.precondicao) {
      descartadas.push(
        `${nome} (rodada ${i}): ${r.vista}; respostas ${r.primeira.status}/${r.segunda.status}`,
      );
      continue;
    }

    julgadas.push(`${nome}: ${r.vista}`);
    // A primeira a chegar à trava ganha (fila FIFO); a segunda decide sob a
    // trava, depois do COMMIT da primeira.
    primeira.t.confereSucesso(r.primeira);
    if (esperado === 'uma conta') segunda.t.confereRecusa(r.segunda);
    else segunda.t.confereSucesso(r.segunda);

    const contas = [
      { papel: primeira.t.papel, empresa: primeira.t.empresaNome },
    ];
    if (esperado === 'duas contas') {
      contas.push({ papel: segunda.t.papel, empresa: segunda.t.empresaNome });
    }
    expect(ordenar(await contasDoEmail(email))).toEqual(ordenar(contas));
    expect(await alunosDoEmail(email)).toBe(
      contas.filter((c) => c.papel === 'aluno').length,
    );

    await primeira.t.confereDepois(true);
    await segunda.t.confereDepois(esperado === 'duas contas');

    const e2 = [primeira, segunda].filter(
      (l, k) =>
        l.t.escritor === 'E2' && (k === 0 || esperado === 'duas contas'),
    ).length;
    expect(await rastroDaE2(email)).toEqual({
      matriculas: e2,
      aceites: 2 * e2,
    });

    // A E5a envia o convite DEPOIS do COMMIT: só a vencedora manda e-mail.
    const e5a = [primeira, segunda].filter(
      (l, k) =>
        l.t.escritor === 'E5a' && (k === 0 || esperado === 'duas contas'),
    ).length;
    if ([primeira, segunda].some((l) => l.t.escritor === 'E5a')) {
      expect(emailsPara(email)).toHaveLength(e5a);
    }
    return;
  }
  throw new Error(
    `${nome}: nenhuma das ${RODADAS_POR_PROVA} rodadas viu a precondição — ${descartadas.slice(-RODADAS_POR_PROVA).join(' | ')}`,
  );
}

/**
 * Os dois lados de uma prova, nas duas ordens. `lado1` vai sempre pelo app A,
 * `lado2` pelo B; a ordem decide quem chega primeiro à trava.
 */
function casosNasDuasOrdens(
  lado1: [Escritor, Empresa],
  lado2: [Escritor, Empresa],
): [string, (email: string) => Promise<[Lado, Lado]>][] {
  const montarLados = async (email: string): Promise<[Lado, Lado]> => [
    { t: await montar(lado1[0], lado1[1], email), app: appA },
    { t: await montar(lado2[0], lado2[1], email), app: appB },
  ];
  const nome = (e: Escritor, emp: Empresa) =>
    e === 'E7' ? 'E7@nova' : `${e}@${emp.slug.slice(-1).toUpperCase()}`;
  return [
    [`${nome(...lado1)} chega primeiro`, async (email) => montarLados(email)],
    [
      `${nome(...lado2)} chega primeiro`,
      async (email) => {
        const [a, b] = await montarLados(email);
        return [b, a];
      },
    ],
  ];
}

// ============================================================================
// Fixture
// ============================================================================

async function limparTudo(): Promise<void> {
  const daE7 = await ler<{ id: string }>(
    `SELECT id FROM empresas WHERE nome LIKE $1`,
    `${PREFIXO_E7}%`,
  );
  for (const { id } of daE7) await limparEmpresa(db, id);
  await limparEmpresa(db, EMP_A.id);
  await limparEmpresa(db, EMP_B.id);
  // O super admin não tem empresa: `limparEmpresa` não o alcança.
  await q(`DELETE FROM refresh_tokens WHERE usuario_id = $1::uuid`, SUPER);
  await q(`DELETE FROM usuarios WHERE id = $1::uuid`, SUPER);
}

async function criarEmpresa(e: Empresa): Promise<void> {
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id, nome, slug, updated_at) VALUES ('${e.id}', '${e.nome}', '${e.slug}', now())`,
    ),
  );
  // O convite da E2 tem plano e contrato vigente: a perdedora chegaria até a
  // matrícula contratual, e é dela o resíduo mais fundo.
  await q(
    `INSERT INTO contratos_da_empresa (id, company_id, versao, texto) VALUES (gen_random_uuid(), $1::uuid, 1, 'Contrato da matriz 086')`,
    e.id,
  );
  await q(
    `UPDATE empresas SET contrato_versao_vigente = 1 WHERE id = $1::uuid`,
    e.id,
  );
  await q(
    `INSERT INTO planos (id, company_id, nome, valor_centavos, prazo_meses, ativo, updated_at)
     VALUES ($1::uuid, $2::uuid, 'Plano Matriz', 10000, 3, true, now())`,
    e.plano,
    e.id,
  );
  await q(
    `INSERT INTO usuarios (id, email, senha_hash, nome, role, company_id, updated_at)
     VALUES ($1::uuid, $2, $3, 'Gestora Matriz', 'company_admin', $4::uuid, now())`,
    e.gestorId,
    `spec086-matriz-gestor-${e.slug.slice(-1)}@teste.local`,
    await bcrypt.hash(SENHA, 4),
    e.id,
  );
}

async function entrar(email: string): Promise<string> {
  const r = await request(appA.getHttpServer())
    .post('/api/v1/auth/login')
    .set('do-connecting-ip', proximoIp())
    .send({ email, senha: SENHA });
  confereStatus(r, 200);
  return bodyOf<{ accessToken: string }>(r).accessToken;
}

beforeAll(async () => {
  await limparTudo();
  await criarEmpresa(EMP_A);
  await criarEmpresa(EMP_B);
  await q(
    `INSERT INTO usuarios (id, email, senha_hash, nome, role, company_id, updated_at)
     VALUES ($1::uuid, $2, $3, 'Super Matriz', 'super_admin', NULL, now())`,
    SUPER,
    SUPER_EMAIL,
    await bcrypt.hash(SENHA, 4),
  );

  [appA, appB] = await Promise.all([subirAppReal(), subirAppReal()]);
  memorias = [appA, appB].map((app) => {
    const provedor = app.get<unknown>(PROVEDOR_DE_EMAIL);
    expect(provedor).toBeInstanceOf(MemoriaProvedorDeEmail);
    return provedor as MemoriaProvedorDeEmail;
  });

  EMP_A.token = await entrar('spec086-matriz-gestor-a@teste.local');
  EMP_B.token = await entrar('spec086-matriz-gestor-b@teste.local');
  tokenDoSuper = await entrar(SUPER_EMAIL);
});

afterAll(async () => {
  // Sempre impresso: o número de rodadas julgadas é a prova de que a matriz
  // rodou com a precondição vista, e não só de que saiu verde.
  process.stdout.write(
    `\n[spec-086-corrida] rodadas julgadas com a precondição vista: ${julgadas.length}; descartadas sem ela: ${descartadas.length}\n  ${[...descartadas, ...julgadas].join('\n  ')}\n`,
  );
  if (chaveAntes === undefined) delete process.env[CHAVE];
  else process.env[CHAVE] = chaveAntes;
  await Promise.all([appA?.close(), appB?.close()]);
  await limparTudo();
  await Promise.all([
    db.$disconnect(),
    adversario.$disconnect(),
    observador.$disconnect(),
  ]);
});

// ============================================================================
// AC-006 — a matriz de pares
// ============================================================================

const X: Escritor[] = ['E1', 'E2', 'E4', 'E5a', 'E5b', 'E6'];
const Y: Escritor[] = ['E1', 'E2', 'E5a', 'E5b', 'E6'];

type Linha = [string, (email: string) => Promise<[Lado, Lado]>];

function linhas(
  rotulo: string,
  pares: [Escritor, Empresa, Escritor, Empresa][],
): [string, Linha[1]][] {
  return pares.flatMap(([e1, emp1, e2, emp2]) =>
    casosNasDuasOrdens([e1, emp1], [e2, emp2]).map(
      ([ordem, montarPar]) =>
        [`${rotulo} ${e1} × ${e2} — ${ordem}`, montarPar] as Linha,
    ),
  );
}

describe('AC-006 — P1: X × X na MESMA empresa, chave ligada → uma conta', () => {
  beforeEach(() => chave(true));
  it.each(
    linhas(
      'P1',
      X.map((x) => [x, EMP_A, x, EMP_A]),
    ),
  )('%s', (nome, montarPar) => provar(nome, montarPar, 'uma conta'));
});

describe('AC-006 — P2: X × X em empresas DIFERENTES, chave desligada → uma conta (R2-01)', () => {
  beforeEach(() => chave(false));
  it.each(
    linhas(
      'P2',
      X.map((x) => [x, EMP_A, x, EMP_B]),
    ),
  )('%s', (nome, montarPar) => provar(nome, montarPar, 'uma conta'));
});

describe('AC-006 — P3: X × X em empresas diferentes, chave ligada → duas contas', () => {
  beforeEach(() => chave(true));
  it.each(
    linhas(
      'P3',
      X.map((x) => [x, EMP_A, x, EMP_B]),
    ),
  )('%s', (nome, montarPar) => provar(nome, montarPar, 'duas contas'));
});

describe.each([
  ['ligada', true],
  ['desligada', false],
])(
  'AC-006 — P4: X × E8 (gestor) em outra empresa, chave %s → uma conta, a perdedora com a resposta da SUA rota',
  (_estado, ligada) => {
    beforeEach(() => chave(ligada));
    it.each(
      linhas(
        'P4',
        X.map((x) => [x, EMP_A, 'E8', EMP_B]),
      ),
    )('%s', (nome, montarPar) => provar(nome, montarPar, 'uma conta'));
  },
);

describe.each([
  ['ligada', true],
  ['desligada', false],
])(
  'AC-006 — P5: E7 × E8, chave %s → uma conta, nenhuma empresa órfã',
  (_estado, ligada) => {
    beforeEach(() => chave(ligada));
    it.each(linhas('P5', [['E7', EMP_A, 'E8', EMP_B]]))(
      '%s',
      (nome, montarPar) => provar(nome, montarPar, 'uma conta'),
    );
  },
);

describe('AC-006 — P6, P7, P8: escritores DIFERENTES em empresas diferentes, chave desligada → uma conta (a trava é comum)', () => {
  beforeEach(() => chave(false));
  it.each([
    ...linhas('P6', [['E1', EMP_A, 'E6', EMP_B]]),
    ...linhas('P7', [['E5b', EMP_A, 'E4', EMP_B]]),
    ...linhas(
      'P8',
      Y.map((y) => [y, EMP_A, 'E4', EMP_B]),
    ),
  ])('%s', (nome, montarPar) => provar(nome, montarPar, 'uma conta'));
});

// ============================================================================
// AC-017, AC-003, AC-004 — cada entrada, sem corrida
// ============================================================================

describe('AC-017 — chave DESLIGADA: E1 a E6 recusam um e-mail que já é aluno em OUTRA empresa, com a resposta de hoje', () => {
  beforeEach(() => chave(false));

  it.each(X)(
    '%s recusa, e a conta da outra empresa continua a única',
    async (x) => {
      const email = novoEmail(`ac017-${x}`);
      await contaDireta(email, EMP_B, 'aluno');
      const t = await montar(x, EMP_A, email);
      t.confereRecusa(await t.disparar(appA));
      expect(await contasDoEmail(email)).toEqual([
        { papel: 'aluno', empresa: EMP_B.nome },
      ]);
      await t.confereDepois(false);
      expect(await rastroDaE2(email)).toEqual({ matriculas: 0, aceites: 0 });
    },
  );

  it('o login de quem JÁ tem duas contas continua devolvendo a escolha (a chave não vale para o login)', async () => {
    const email = novoEmail('ac017-login');
    await contaDireta(email, EMP_A, 'aluno');
    await contaDireta(email, EMP_B, 'aluno');
    const r = await request(appA.getHttpServer())
      .post('/api/v1/auth/login')
      .set('do-connecting-ip', proximoIp())
      .send({ email, senha: SENHA });
    confereStatus(r, 409);
    const corpo = bodyOf<{
      code: string;
      escolha: { empresas: { situacao: string }[] };
    }>(r);
    expect(corpo.code).toBe('ESCOLHA_DE_EMPRESA');
    expect(corpo.escolha.empresas.map((e) => e.situacao)).toEqual([
      'disponivel',
      'disponivel',
    ]);
  });
});

describe('AC-003 — chave LIGADA: E1 a E6 aceitam o e-mail de outra empresa e recusam o da mesma empresa ou de gestão', () => {
  beforeEach(() => chave(true));

  it.each(X)('%s aceita um e-mail que é aluno em OUTRA empresa', async (x) => {
    const email = novoEmail(`ac003-aceita-${x}`);
    await contaDireta(email, EMP_B, 'aluno');
    const t = await montar(x, EMP_A, email);
    t.confereSucesso(await t.disparar(appA));
    expect(await contasDoEmail(email)).toEqual(
      ordenar([
        { papel: 'aluno', empresa: EMP_B.nome },
        { papel: t.papel, empresa: EMP_A.nome },
      ]),
    );
    await t.confereDepois(true);
    expect(await rastroDaE2(email)).toEqual(
      x === 'E2'
        ? { matriculas: 1, aceites: 2 }
        : { matriculas: 0, aceites: 0 },
    );
  });

  it.each(X)(
    '%s recusa um e-mail que já tem conta NA MESMA empresa — criada DEPOIS da de outra empresa, para um findFirst sem empresa achar a errada',
    async (x) => {
      const email = novoEmail(`ac003-mesma-${x}`);
      await contaDireta(email, EMP_B, 'aluno', '1 hour');
      await contaDireta(email, EMP_A, 'aluno');
      const t = await montar(x, EMP_A, email);
      t.confereRecusa(await t.disparar(appA));
      expect(await contasDoEmail(email)).toEqual([
        { papel: 'aluno', empresa: EMP_A.nome },
        { papel: 'aluno', empresa: EMP_B.nome },
      ]);
      await t.confereDepois(false);
      expect(await rastroDaE2(email)).toEqual({ matriculas: 0, aceites: 0 });
    },
  );

  it.each(X)('%s recusa um e-mail de GESTOR de outra empresa', async (x) => {
    const email = novoEmail(`ac003-gestor-${x}`);
    await contaDireta(email, EMP_B, 'company_admin');
    const t = await montar(x, EMP_A, email);
    t.confereRecusa(await t.disparar(appA));
    expect(await contasDoEmail(email)).toEqual([
      { papel: 'company_admin', empresa: EMP_B.nome },
    ]);
    await t.confereDepois(false);
    expect(await rastroDaE2(email)).toEqual({ matriculas: 0, aceites: 0 });
  });
});

describe.each([
  ['ligada', true],
  ['desligada', false],
])(
  'AC-004 — chave %s: E7 e E8 recusam o e-mail de QUALQUER conta, com a resposta de hoje',
  (_estado, ligada) => {
    beforeEach(() => chave(ligada));

    it.each([
      ['E7', 'aluno'],
      ['E7', 'company_admin'],
      ['E8', 'aluno'],
      ['E8', 'company_admin'],
    ] as [Escritor, Papel][])(
      '%s recusa um e-mail que já é %s em outra empresa',
      async (escritor, papel) => {
        const email = novoEmail(`ac004-${escritor}-${papel}`);
        await contaDireta(email, EMP_A, papel);
        const t = await montar(escritor, EMP_B, email);
        t.confereRecusa(await t.disparar(appA));
        expect(await contasDoEmail(email)).toEqual([
          { papel, empresa: EMP_A.nome },
        ]);
        await t.confereDepois(false);
        expect(await rastroDaE2(email)).toEqual({ matriculas: 0, aceites: 0 });
      },
    );
  },
);
