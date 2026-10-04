/**
 * SPEC-083/TASK-005c — **duas importações com os mesmos e-mails em ordens
 * opostas não se derrubam com `40P01`.**
 *
 * ## O defeito
 *
 * O `INSERT` em lote de `usuarios` toma as entradas de `usuarios_email_key`
 * uma a uma, e um e-mail que outra transação inseriu sem `COMMIT` faz esta
 * esperar por ela. Nenhuma trava serializa duas importações de clubes
 * diferentes — nem duas do mesmo clube sem turma em comum: a do clube é
 * COMPARTILHADA (INV-083i). Com o arquivo 1 dizendo `a, …, b` e o arquivo 2
 * `b, …, a`, a primeira segurava `a` e esperava `b`, a segunda segurava `b` e
 * esperava `a`: um ciclo, que o Postgres desfaz derrubando uma com `40P01`. O
 * `40P01` não tem tradução (D3, passo 5), e subia `500`.
 *
 * O conserto é a ordem: as contas entram em ordem de e-mail, as duas
 * importações tomam as entradas na mesma ordem total, e uma só espera a
 * outra. A perdedora recebe o `23505` na etapa de `usuarios`, e a D3 já diz o
 * que ele é: a conferência refeita acha o e-mail, e a resposta é o `422
 * PLANILHA_COM_ERROS` com o relatório refeito — a mesma da corrida legítima de
 * e-mail do AC-013.
 *
 * ## Por que a barreira segura as DUAS no meio do INSERT
 *
 * Uma barreira que segurasse só a primeira importação depois de inserir não
 * provaria nada: quem já inseriu tudo e só espera o `COMMIT` não espera
 * ninguém, e sem duas esperas não há ciclo — o caso ficaria verde com o
 * defeito no lugar. O ciclo exige as duas paradas **no meio** do `INSERT`,
 * cada uma já segurando um e-mail que a outra vai pedir. Daí X e Y: cada um
 * insere, sem `COMMIT`, o e-mail do meio de um dos arquivos (`x1` no 1, `x2`
 * no 2), e as duas importações param nele, vistas em `pg_blocking_pids`.
 *
 * - **Sem o conserto** (ordem do arquivo): a 1 já inseriu `a` e espera X; a 2
 *   já inseriu `b` e espera Y. X e Y desfazem: a 1 pede `b` (da 2), a 2 pede
 *   `a` (da 1) — o ciclo, determinístico. Resposta: `500` com `40P01` (ou,
 *   se o prazo vencer antes do detector, `409` nas duas — também vermelho).
 * - **Com o conserto** (ordem de e-mail): `x1` e `x2` ordenam antes de `a` e
 *   `b`, então as duas param em X e Y **sem** segurar nenhum e-mail do outro
 *   arquivo. X e Y desfazem, as duas correm para `a`, e quem chega depois
 *   espera quem chegou antes. Qual das duas ganha é corrida, e o teste aceita
 *   as duas: uma conclui, a outra responde o `422` refeito.
 *
 * Os dois arranjos da regra: clubes diferentes, e o mesmo clube sem turma.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import {
  cliente,
  desconectarTodos,
  dormir,
  limparClube,
  montarClube,
  resposta,
  urlDoCaminho,
  type Clube,
  type Resposta,
} from './spec-082-fixture';
import { AcessoService } from '../../src/acesso/acesso.service';
import type { AccessTokenPayload } from '../../src/common/types/jwt-payload.type';
import { sqlstateDoErro } from '../../src/courts/recusas-de-estoque';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import {
  etapaDaImportacao,
  ImportacaoDeAlunosService,
  MENSAGEM_EMAIL_JA_EXISTE,
} from '../../src/people/importacao/importacao-de-alunos.service';
import { ImportacaoController } from '../../src/people/importacao/importacao.controller';
import type { RelatorioDeImportacaoDto } from '../../src/people/importacao/dto/importacao-response.dto';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const MODELOS = {
  remetente: 'convites@spec083k.teste.local',
  responderPara: 'suporte@spec083k.teste.local',
  urlCliente: 'https://cliente.spec083k.teste.local',
};

const db = new PrismaClient();

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

/** A primeira ida de um cliente novo custa a conexão: paga antes do caso. */
async function aquecer(...apps: string[]): Promise<void> {
  for (const app of apps) await conexao(app).$queryRaw`SELECT 1`;
}

const OBSERVADOR = 'spec083k-observador';
const observador = () => conexao(OBSERVADOR);

// ============================================================================
// A importação, pelo controller (a tradução da borda junto)
// ============================================================================

function importar(
  app: string,
  clube: Clube,
  conteudo: string,
): Promise<Resposta> {
  const p = conexao(app) as unknown as PrismaService;
  const memoria = new MemoriaProvedorDeEmail();
  const controller = new ImportacaoController(
    new ImportacaoDeAlunosService(
      p,
      new AcessoService(p, memoria, MODELOS),
      memoria,
      MODELOS,
    ),
  );
  return resposta(
    controller.importar(
      {
        sub: clube.gestores[0],
        email: 'gestor@spec083k.teste.local',
        nome: 'Gestora',
        role: 'company_admin',
        companyId: clube.id,
      } as unknown as AccessTokenPayload,
      undefined,
      { buffer: Buffer.from(conteudo, 'utf8') } as Express.Multer.File,
      undefined,
    ),
  );
}

const planilha = (emails: readonly string[]) =>
  ['nome;email', ...emails.map((e, i) => `Aluno 083k ${i + 1};${e}`)].join(
    '\r\n',
  );

// ============================================================================
// A barreira: uma conta inserida sem COMMIT, solta com ROLLBACK
// ============================================================================

interface Barreira {
  pid: number;
  /** Desfaz a conta. Chamar de novo não faz nada. */
  soltar: () => Promise<void>;
}

const DESFAZER = new Error('spec-083k: desfazer a barreira');

async function contaSemCommit(
  c: PrismaClient,
  clube: Clube,
  emailDaConta: string,
): Promise<Barreira> {
  let liberar!: () => void;
  const liberado = new Promise<void>((r) => (liberar = r));
  let pronto!: (pid: number) => void;
  let falhou!: (e: unknown) => void;
  const travado = new Promise<number>((r, j) => {
    pronto = r;
    falhou = j;
  });
  const tx = c
    .$transaction(
      async (t: Prisma.TransactionClient) => {
        const [{ pid }] = await t.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        await t.$executeRawUnsafe(
          `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
           VALUES ($1::uuid,$2,'h','Barreira 083k','aluno',$3::uuid,now())`,
          randomUUID(),
          emailDaConta,
          clube.id,
        );
        pronto(pid);
        await liberado;
        throw DESFAZER;
      },
      { timeout: 120_000, maxWait: 20_000 },
    )
    .catch((e: unknown) => {
      if (e !== DESFAZER) falhou(e);
    });
  const pid = await travado;
  return {
    pid,
    soltar: async () => {
      liberar();
      await tx;
    },
  };
}

// ============================================================================
// O que o observador lê
// ============================================================================

interface Espera {
  pid: number;
  bloqueadores: number[];
  query: string;
}

/** A conexão do caminho esperando um lock de quem tem o `pid` dado. */
async function esperandoPor(app: string, quem: number): Promise<Espera | null> {
  const linhas = await observador().$queryRaw<Espera[]>`
    SELECT pid, coalesce(pg_blocking_pids(pid), '{}') AS bloqueadores, query
      FROM pg_stat_activity
     WHERE application_name = ${app} AND wait_event_type = 'Lock'`;
  return linhas.find((l) => l.bloqueadores.includes(quem)) ?? null;
}

async function ate<T>(
  descricao: string,
  ler: () => Promise<T | null>,
  limiteMs = 15_000,
): Promise<T> {
  const limite = Date.now() + limiteMs;
  for (;;) {
    const v = await ler();
    if (v) return v;
    if (Date.now() > limite) throw new Error(`precondição: ${descricao}`);
    await dormir(5);
  }
}

const relatorioDo422 = (r: Resposta) =>
  (r.erro as { getResponse(): RelatorioDeImportacaoDto }).getResponse();

// ============================================================================
// Ciclo de vida
// ============================================================================

const clubes: Clube[] = [];

async function novoClube(): Promise<Clube> {
  const c = await montarClube(db);
  clubes.push(c);
  return c;
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
// O caso
// ============================================================================

describe('SPEC-083/TASK-005c — importações concorrentes com os mesmos e-mails em ordens opostas', () => {
  it.each([
    { arranjo: 'clubes diferentes', mesmoClube: false },
    { arranjo: 'o mesmo clube, sem turma', mesmoClube: true },
  ])(
    '$arranjo: nenhuma resposta 500 e nenhum 40P01; uma conclui, a outra responde o 422 refeito com o erro de e-mail',
    async ({ mesmoClube }) => {
      const clube1 = await novoClube();
      const clube2 = mesmoClube ? clube1 : await novoClube();
      const sufixo = mesmoClube ? 'm' : 'd';
      const [IMP1, IMP2, X, Y] = ['imp1', 'imp2', 'x', 'y'].map(
        (n) => `spec083k-${sufixo}-${n}`,
      );
      await aquecer(IMP1, IMP2, X, Y);

      // Em ordem de e-mail: `0-x1` e `0-x2` antes de `1-a`, antes de `2-b`.
      const r = randomUUID().slice(0, 8);
      const e = (s: string) => `c083k-${r}-${s}@teste.local`;
      const [a, b, x1, x2] = [e('1-a'), e('2-b'), e('0-x1'), e('0-x2')];
      // A ordem do arquivo é a que fecharia o ciclo: `a` antes de `b` no 1,
      // `b` antes de `a` no 2, e o e-mail segurado no meio de cada um.
      const arquivo1 = [a, x1, b];
      const arquivo2 = [b, x2, a];

      const bx = await contaSemCommit(conexao(X), clube1, x1);
      const by = await contaSemCommit(conexao(Y), clube2, x2);
      const p1 = importar(IMP1, clube1, planilha(arquivo1));
      const p2 = importar(IMP2, clube2, planilha(arquivo2));
      let respostas: Resposta[];
      try {
        // A precondição: as duas paradas NO INSERT de usuários, cada uma
        // esperando a sua barreira — e não uma à outra.
        const esp1 = await ate('a importação 1 esperando X no INSERT', () =>
          esperandoPor(IMP1, bx.pid),
        );
        const esp2 = await ate('a importação 2 esperando Y no INSERT', () =>
          esperandoPor(IMP2, by.pid),
        );
        expect(esp1.query).toContain('INSERT INTO usuarios');
        expect(esp2.query).toContain('INSERT INTO usuarios');
        expect(esp1.bloqueadores).toEqual([bx.pid]);
        expect(esp2.bloqueadores).toEqual([by.pid]);

        // As duas soltas juntas: daqui em diante, só a ordem decide.
        await Promise.all([bx.soltar(), by.soltar()]);
        respostas = await Promise.all([p1, p2]);
      } finally {
        await bx.soltar();
        await by.soltar();
        await Promise.allSettled([p1, p2]);
      }

      const resumo = respostas.map((x) => ({
        status: x.status,
        code: x.code,
        sqlstate: x.status === 500 ? sqlstateDoErro(x.erro) : null,
        etapa: x.status === 500 ? etapaDaImportacao(x.erro) : null,
      }));
      console.log(
        `SPEC083_005C_CONCORRENTE arranjo=${mesmoClube ? 'mesmo-clube' : 'clubes-diferentes'} respostas=${JSON.stringify(resumo)}`,
      );

      // 1. Nenhum 500, e nenhum 40P01 (nem por baixo de outra resposta).
      expect(resumo.filter((x) => x.status === 500)).toEqual([]);
      expect(
        respostas.filter((x) => sqlstateDoErro(x.erro) === '40P01'),
      ).toEqual([]);

      // 2. Uma conclui; a outra recebe o 422 refeito (D3, passo 5; AC-013).
      expect(resumo.map((x) => x.status).sort()).toEqual([200, 422]);
      const perdedora = respostas.find((x) => x.status === 422) as Resposta;
      expect(perdedora.code).toBe('PLANILHA_COM_ERROS');
      // Nos dois arquivos, os e-mails disputados estão nas linhas 2 e 4.
      expect(relatorioDo422(perdedora).erros).toEqual([
        { linha: 2, coluna: 'email', mensagem: MENSAGEM_EMAIL_JA_EXISTE },
        { linha: 4, coluna: 'email', mensagem: MENSAGEM_EMAIL_JA_EXISTE },
      ]);

      // 3. Gravado: as três contas da vencedora, nenhuma da perdedora, e
      //    nada das barreiras (desfeitas).
      const ganhou1 = respostas[0].status === 200;
      const contas = await db.usuario.findMany({
        where: { email: { in: [a, b, x1, x2] } },
        select: { email: true, companyId: true },
      });
      expect(contas.map((c) => c.email).sort()).toEqual(
        [a, b, ganhou1 ? x1 : x2].sort(),
      );
      const daVencedora = ganhou1 ? clube1.id : clube2.id;
      expect(contas.every((c) => c.companyId === daVencedora)).toBe(true);
      expect(
        await db.aluno.count({
          where: { usuario: { email: { in: [a, b, x1, x2] } } },
        }),
      ).toBe(3);
    },
  );
});
