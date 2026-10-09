/**
 * SPEC-083/TASK-005c, refeito para a SPEC-086 — **duas importações com os
 * mesmos e-mails em ordens opostas não se derrubam com `40P01`.**
 *
 * ## O defeito (SPEC-083)
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
 * A 083 consertou pela ordem do `INSERT` (contas em ordem de e-mail), e a
 * barreira deste arquivo era a de então: duas conexões X e Y inseriam, sem
 * `COMMIT`, o e-mail do meio de cada arquivo, e o teste via as duas
 * importações paradas NO MEIO do `INSERT`.
 *
 * ## Por que a SPEC-086 mudou a barreira
 *
 * Com a 086 ("A trava por e-mail"), a importação (E6) faz, como PRIMEIRA
 * instrução da transação, `travarEmailsParaCriarConta(tx, emails)`: um
 * `pg_advisory_xact_lock` por e-mail do arquivo, numa instrução só
 * (`travar_emails_para_criar_conta`), com as chaves ORDENADAS por
 * `ordenarChavesParaLock`. E só depois, sob a trava, confere se o e-mail já
 * tem conta (`RecusaSobATrava` → `422` refeito). Duas consequências:
 *
 * - **o desenho X/Y deixou de existir.** Quem segura um e-mail em comum é a
 *   outra importação, na trava — e não mais no índice. Uma importação que
 *   espera nunca chega ao `INSERT`; a que ganha insere sem ninguém no meio do
 *   caminho. O "meio do `INSERT`" não é mais alcançável por duas ao mesmo
 *   tempo com os mesmos e-mails;
 * - **o ciclo ficou impossível por construção.** A trava de e-mail é a
 *   primeira (nenhum caminho segura clube, turma ou linha e depois pede
 *   e-mail), e as chaves vão em ordem total. Duas importações pedem os
 *   e-mails comuns na mesma ordem: a que pegou o menor tem o caminho livre,
 *   e a outra espera nele, sem segurar nada que a primeira vá pedir.
 *
 * ## A barreira nova (o mesmo desenho do AC-025 da 086)
 *
 * Uma conexão adversária segura a trava de `a` e de `b` (só a trava, sem
 * escrever nada). As duas importações começam e ficam ESPERANDO na instrução
 * `travar_emails_para_criar_conta`, vistas em `pg_stat_activity` +
 * `pg_locks`, bloqueadas pelo adversário — e o teste registra EM QUAL CHAVE
 * cada uma espera. Então o adversário solta as duas chaves de uma vez (o fim
 * da transação dele), logo depois de ver as duas esperando, dentro do
 * orçamento de 2 s da trava.
 *
 * - **Correto (ordenado):** os e-mails próprios (`0-x1`, `0-x2`) ordenam
 *   antes de `a` e `b`, e cada importação pega o seu de graça; depois as
 *   DUAS esperam em `a` (a chave menor das disputadas). Soltas, uma pega `a` e
 *   `b`, grava e comita; a outra pega a trava em seguida, confere sob ela,
 *   acha `a` e `b` e responde o `422` refeito com o erro de e-mail.
 * - **Mutante S19 (ordem do arquivo, sem `ordenarChavesParaLock`):** a 1
 *   pede `a` primeiro e a 2 pede `b` primeiro — esperam em chaves
 *   DIFERENTES. Soltas, cada uma pega a sua e pede a da outra: `40P01`. A
 *   asserção "as duas esperam na chave de `a`" pega o mutante já na
 *   observação, sem depender de o detector de deadlock agir antes do prazo.
 *
 * Os arranjos da regra: clubes diferentes, e o mesmo clube sem turma — com a
 * chave `EMAIL_EM_VARIAS_EMPRESAS` desligada (o padrão: qualquer conta com o
 * e-mail é conflito, e a perdedora recebe o `422`). E, com a chave ligada,
 * os mesmos dois: no mesmo clube a perdedora continua recebendo o `422`; em
 * clubes diferentes o e-mail pode existir nas duas empresas, e as DUAS
 * concluem — a trava serializa, e nenhuma cai.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import {
  cliente,
  desconectarTodos,
  dormir,
  limparClube,
  montarClube,
  resposta,
  segurarComPid,
  urlDoCaminho,
  type Clube,
  type Resposta,
} from './spec-082-fixture';
import { AcessoService } from '../../src/acesso/acesso.service';
import { chaveDoEmail } from '../../src/acesso/trava-de-email';
import { ChaveDeLock } from '../../src/common/lock/chave-de-lock';
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

/**
 * O protocolo do AC-025 da 086: soltar em até 300 ms depois de ver as duas
 * esperando, para que tudo aconteça dentro do orçamento de 2 s da trava.
 */
const SOLTURA_MAXIMA_MS = 300;

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
// A trava de e-mail, do lado do teste
// ============================================================================

/**
 * O `bigint` da trava de um e-mail, montado pela MESMA função da produção
 * (`chaveDoEmail` — o prefixo não pode aparecer fora de `trava-de-email.ts`,
 * AC-026 da 086).
 */
const chaveDaTrava = (email: string) =>
  ChaveDeLock.deTexto(chaveDoEmail(email));

/**
 * O adversário: uma transação que segura a trava dos e-mails dados e nada
 * mais. Soltar é o fim da transação dele — as chaves saem juntas.
 */
async function segurarEmails(app: string, emails: readonly string[]) {
  return segurarComPid(conexao(app), async (t) => {
    for (const email of emails) {
      await t.$executeRaw`SELECT pg_advisory_xact_lock(${chaveDaTrava(email)}::bigint)`;
    }
  });
}

// ============================================================================
// O que o observador lê
// ============================================================================

interface Espera {
  pid: number;
  bloqueadores: number[];
  query: string;
  /** A chave `bigint` da trava pedida e ainda não concedida. */
  chave: bigint;
  /** Há quanto tempo a instrução de travas começou (relógio do banco). */
  esperandoMs: number;
}

/**
 * A conexão do caminho esperando uma trava ADVISORY que o `adversario`
 * segura. A chave vem de `pg_locks`: para o `pg_advisory_xact_lock(bigint)`,
 * `classid` é a metade alta e `objid` a baixa (os dois `oid`, sem sinal), e
 * `objsubid = 1`.
 */
async function esperandoNaTrava(
  app: string,
  adversario: number,
): Promise<Espera | null> {
  const linhas = await observador().$queryRaw<
    {
      pid: number;
      bloqueadores: number[];
      query: string;
      classid: string;
      objid: string;
      esperando_ms: number;
    }[]
  >`
    SELECT a.pid,
           coalesce(pg_blocking_pids(a.pid), '{}') AS bloqueadores,
           a.query,
           l.classid::text AS classid,
           l.objid::text AS objid,
           (extract(epoch FROM clock_timestamp() - a.query_start) * 1000)::float8
             AS esperando_ms
      FROM pg_stat_activity a
      JOIN pg_locks l ON l.pid = a.pid
     WHERE a.application_name = ${app}
       AND a.wait_event_type = 'Lock'
       AND l.locktype = 'advisory'
       AND l.objsubid = 1
       AND NOT l.granted`;
  const l = linhas.find((x) => x.bloqueadores.includes(adversario));
  if (!l) return null;
  return {
    pid: l.pid,
    bloqueadores: l.bloqueadores,
    query: l.query,
    chave: BigInt.asIntN(64, (BigInt(l.classid) << 32n) | BigInt(l.objid)),
    esperandoMs: l.esperando_ms,
  };
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
const CHAVE_ANTES = process.env.EMAIL_EM_VARIAS_EMPRESAS;

async function novoClube(): Promise<Clube> {
  const c = await montarClube(db);
  clubes.push(c);
  return c;
}

beforeAll(async () => {
  await aquecer(OBSERVADOR);
});

afterEach(() => {
  if (CHAVE_ANTES === undefined) delete process.env.EMAIL_EM_VARIAS_EMPRESAS;
  else process.env.EMAIL_EM_VARIAS_EMPRESAS = CHAVE_ANTES;
});

afterAll(async () => {
  for (const c of clubes) await limparClube(db, c);
  await desconectarTodos();
  await db.$disconnect();
});

// ============================================================================
// O caso
// ============================================================================

describe('SPEC-083/TASK-005c + SPEC-086 — importações concorrentes com os mesmos e-mails em ordens opostas', () => {
  it.each([
    { arranjo: 'clubes diferentes', mesmoClube: false, ligada: false },
    { arranjo: 'o mesmo clube, sem turma', mesmoClube: true, ligada: false },
    { arranjo: 'clubes diferentes', mesmoClube: false, ligada: true },
    { arranjo: 'o mesmo clube, sem turma', mesmoClube: true, ligada: true },
  ])(
    '$arranjo, chave ligada=$ligada: as duas esperam na trava do mesmo e-mail; nenhuma resposta 500, nenhum 40P01, nenhum 503',
    async ({ mesmoClube, ligada }) => {
      // A chave da 086 é lida a cada chamada: fixada aqui, devolvida no
      // `afterEach`.
      process.env.EMAIL_EM_VARIAS_EMPRESAS = ligada ? 'true' : 'false';

      const clube1 = await novoClube();
      const clube2 = mesmoClube ? clube1 : await novoClube();
      const sufixo = `${mesmoClube ? 'm' : 'd'}${ligada ? 'l' : 'x'}`;
      const [IMP1, IMP2, ADV] = ['imp1', 'imp2', 'adv'].map(
        (n) => `spec083k-${sufixo}-${n}`,
      );
      await aquecer(IMP1, IMP2, ADV);

      // Em ordem de chave: `0-x1` e `0-x2` antes de `1-a`, antes de `2-b`.
      // O prefixo da chave é o mesmo para todos, então a ordem das chaves é
      // a ordem dos e-mails.
      const r = Math.random().toString(16).slice(2, 10);
      const e = (s: string) => `c083k-${r}-${s}@teste.local`;
      const [a, b, x1, x2] = [e('1-a'), e('2-b'), e('0-x1'), e('0-x2')];
      // A ordem do arquivo é a que fecharia o ciclo sem a ordenação: `a`
      // antes de `b` no 1, `b` antes de `a` no 2. O e-mail do meio é só de
      // cada um, e não é disputado.
      const arquivo1 = [a, x1, b];
      const arquivo2 = [b, x2, a];

      const adv = await segurarEmails(ADV, [a, b]);
      const p1 = importar(IMP1, clube1, planilha(arquivo1));
      const p2 = importar(IMP2, clube2, planilha(arquivo2));
      let respostas: Resposta[];
      let esperas: Espera[];
      let solturaMs: number;
      try {
        // A precondição: as duas paradas NA TRAVA DE E-MAIL, esperando o
        // adversário — e não uma à outra.
        const esp1 = await ate(
          'a importação 1 esperando a trava de e-mail',
          () => esperandoNaTrava(IMP1, adv.pid),
        );
        const esp2 = await ate(
          'a importação 2 esperando a trava de e-mail',
          () => esperandoNaTrava(IMP2, adv.pid),
        );
        const visto = Date.now();
        // As duas soltas juntas (o fim da transação do adversário): daqui em
        // diante, só a ordem das chaves decide.
        await adv.soltar();
        solturaMs = Date.now() - visto;
        esperas = [esp1, esp2];
        respostas = await Promise.all([p1, p2]);
      } finally {
        await adv.soltar();
        await Promise.allSettled([p1, p2]);
      }

      const resumo = respostas.map((x) => ({
        status: x.status,
        code: x.code,
        sqlstate: x.status === 500 ? sqlstateDoErro(x.erro) : null,
        etapa: x.status === 500 ? etapaDaImportacao(x.erro) : null,
      }));
      const nomeDaChave = (k: bigint) =>
        [a, b, x1, x2].find((m) => chaveDaTrava(m) === k) ?? `? ${k}`;
      console.log(
        `SPEC083_005C_CONCORRENTE arranjo=${mesmoClube ? 'mesmo-clube' : 'clubes-diferentes'} chave=${ligada ? 'ligada' : 'desligada'} ` +
          `esperas=${JSON.stringify(
            esperas.map((x) => ({
              pid: x.pid,
              chave: nomeDaChave(x.chave),
              esperandoMs: Math.round(x.esperandoMs),
            })),
          )} adversario=${adv.pid} solturaMs=${solturaMs} respostas=${JSON.stringify(resumo)}`,
      );

      // 0. O protocolo: as duas na instrução de travas da 086, bloqueadas
      //    pelo adversário, soltas dentro da janela. A segunda a chegar
      //    também lista a primeira em `pg_blocking_pids`: o Postgres conta
      //    quem está NA FILA à frente na mesma chave (medido: `[adv, imp1]`).
      //    Isso é fila, não posse — e o item 1 confere que é a mesma chave.
      const pids = esperas.map((x) => x.pid);
      esperas.forEach((x, i) => {
        expect(x.query).toContain('travar_emails_para_criar_conta');
        expect(x.bloqueadores).toContain(adv.pid);
        expect(
          x.bloqueadores.filter((p) => p !== adv.pid && p !== pids[1 - i]),
        ).toEqual([]);
      });
      expect(solturaMs).toBeLessThan(SOLTURA_MAXIMA_MS);

      // 1. A ordem: as DUAS esperam na chave de `a`, a menor das disputadas.
      //    O mutante S19 (ordem do arquivo) deixa a 2 esperando em `b`.
      expect(esperas.map((x) => nomeDaChave(x.chave))).toEqual([a, a]);

      // 2. Nenhum 500, nenhum 40P01 (nem por baixo de outra resposta), e
      //    nenhum 503 (a espera da trava não estourou o orçamento).
      expect(resumo.filter((x) => x.status === 500)).toEqual([]);
      expect(
        respostas.filter((x) => sqlstateDoErro(x.erro) === '40P01'),
      ).toEqual([]);
      expect(resumo.filter((x) => x.status === 503)).toEqual([]);

      const contas = await db.usuario.findMany({
        where: { email: { in: [a, b, x1, x2] } },
        select: { email: true, companyId: true },
      });
      const alunos = await db.aluno.count({
        where: { usuario: { email: { in: [a, b, x1, x2] } } },
      });

      if (ligada && !mesmoClube) {
        // 3'. Chave ligada, clubes diferentes: o e-mail pode existir nas
        //     duas empresas (086, REQ-001). A trava só serializa: as duas
        //     concluem, cada uma com as suas três contas.
        expect(resumo.map((x) => x.status)).toEqual([200, 200]);
        const por = (clube: Clube) =>
          contas
            .filter((c) => c.companyId === clube.id)
            .map((c) => c.email)
            .sort();
        expect(por(clube1)).toEqual([a, b, x1].sort());
        expect(por(clube2)).toEqual([a, b, x2].sort());
        expect(alunos).toBe(6);
        return;
      }

      // 3. Uma conclui; a outra recebe o 422 refeito sob a trava (086, E6:
      //    `RecusaSobATrava`; a mesma resposta do AC-013 da 083).
      expect(resumo.map((x) => x.status).sort()).toEqual([200, 422]);
      const perdedora = respostas.find((x) => x.status === 422) as Resposta;
      expect(perdedora.code).toBe('PLANILHA_COM_ERROS');
      // Nos dois arquivos, os e-mails disputados estão nas linhas 2 e 4.
      expect(relatorioDo422(perdedora).erros).toEqual([
        { linha: 2, coluna: 'email', mensagem: MENSAGEM_EMAIL_JA_EXISTE },
        { linha: 4, coluna: 'email', mensagem: MENSAGEM_EMAIL_JA_EXISTE },
      ]);

      // 4. Gravado: as três contas da vencedora, nenhuma da perdedora.
      const ganhou1 = respostas[0].status === 200;
      expect(contas.map((c) => c.email).sort()).toEqual(
        [a, b, ganhou1 ? x1 : x2].sort(),
      );
      const daVencedora = ganhou1 ? clube1.id : clube2.id;
      expect(contas.every((c) => c.companyId === daVencedora)).toBe(true);
      expect(alunos).toBe(3);
    },
  );
});
