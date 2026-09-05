/**
 * SPEC-034/AC-016 — **FIT-023: cancelar ocorrência × salvar chamada,
 * concorrentes, serializando em `turmas`.**
 *
 * ## A invariante que este teste existe para defender
 *
 * `presenca.service.ts:789` afirma, num comentário, que travar **só** `turmas`
 * basta *porque* todo caminho que cancela ocorrência de TURMA passa por esse
 * mesmo lock. É uma afirmação sobre o conjunto de caminhos, não sobre uma
 * linha de código — e por isso `grep` não a defende. A SPEC-034 criou um
 * caminho novo (`ClassesService.cancelarOcorrencia`) e o manteve verdadeiro
 * começando por `turmas FOR UPDATE`. **Este teste é o que quebra no dia em
 * que alguém tirar esse lock.**
 *
 * ## Por que o AC-016 precisou ser reescrito
 *
 * O AC original pedia as duas operações "concorrentes", e isso é
 * **irrealizável como estava escrito**: cancelar exige `!aulaJaComecou` e
 * registrar chamada exige `aulaJaComecou`. Os dois portões são
 * **complementares** — não existe instante em que ambos passem.
 *
 * A saída não é afrouxar a asserção, é **fazer da complementaridade o próprio
 * cronômetro**: o cancelamento entra ANTES do início e segura o lock; o
 * relógio vira; a chamada entra DEPOIS do início e encontra o lock tomado. A
 * janela deixa de ser obstáculo e vira o mecanismo.
 *
 * `aulaJaComecou` compara em **minutos** (`date-time.util.ts:182`), então "o
 * relógio virar" é a virada do minuto. A fixture ancora logo depois de uma
 * virada para ter ~55 s de folga, e marca o início no minuto seguinte.
 *
 * ## A barreira é observável, e é isso que dá dente ao teste
 *
 * Sem provar que a chamada **esperou**, o cancelamento terminaria antes de ela
 * começar, não haveria estado misto, e remover o `FOR UPDATE` passaria. A
 * espera é conferida numa TERCEIRA conexão, em `pg_locks`/`pg_stat_activity`.
 *
 * **Quatro conexões, não quatro chamadas** — a lição do FIT-010 e do FIT-022.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { PresencaService } from '../../src/classes/presenca.service';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';

jest.setTimeout(300_000);

exigirBancoLocal();

const EMPRESA = 'f0230000-0000-4000-8000-000000000001';
const QUADRA = 'f0230000-0000-4000-8000-000000000002';
const QUADRA2 = 'f0230000-0000-4000-8000-00000000000a';
const ESPORTE = 'f0230000-0000-4000-8000-000000000003';
const TURMA = 'f0230000-0000-4000-8000-000000000004';
const UPROF = 'f0230000-0000-4000-8000-000000000005';
const PROF = 'f0230000-0000-4000-8000-000000000006';
const UADMIN = 'f0230000-0000-4000-8000-000000000007';
const UALUNO = 'f0230000-0000-4000-8000-000000000008';
const ALUNO = 'f0230000-0000-4000-8000-000000000009';

/** Cancelamento, chamada, semeadura e o observador de locks. */
const dbCancel = new PrismaClient();
const dbChamada = new PrismaClient();
const semear = new PrismaClient();
const observador = new PrismaClient();

const q = (sql: string) => semear.$executeRawUnsafe(sql);

function courts(c: PrismaClient): CourtsService {
  return new CourtsService(
    c as unknown as PrismaService,
    {
      exigirVinculoAprovado: () => {
        throw new Error('cancelar ocorrencia nao consulta vinculo');
      },
    } as unknown as StudentsService,
    new HorarioFuncionamentoService(c as unknown as PrismaService),
    {
      resolver: () => {
        throw new Error('cancelar ocorrencia nao resolve imagem');
      },
    } as unknown as ImagemDaQuadraService,
  );
}

function classes(c: PrismaClient) {
  const cs = courts(c);
  const svc = new ClassesService(
    c as unknown as PrismaService,
    cs,
    {} as unknown as StudentsService,
    new ConfigOperacaoService(c as unknown as PrismaService),
  );
  return { svc, cs };
}

const presencas = new PresencaService(dbChamada as unknown as PrismaService);

/**
 * Espera até estarmos **logo ANTES** de uma virada de minuto.
 *
 * A primeira versão ancorava logo DEPOIS, para ter ~55 s de folga — e era o
 * contrário do que o teste precisa. **A transação interativa do Prisma expira
 * em 5 s por padrão**, então o cancelamento pausado morria de `P2028` muito
 * antes da virada, soltava o lock, e a chamada passava sem esperar por nada:
 * o teste falhava dizendo "ninguém bloqueou", quando o certo era "não havia
 * mais ninguém segurando".
 *
 * Ancorando perto da virada, a pausa dura ~8 s em vez de ~55 s. O timeout
 * generoso abaixo é o cinto; isto é o suspensório.
 */
async function ancorarPertoDaViradaDoMinuto(): Promise<void> {
  for (;;) {
    if (new Date().getSeconds() >= 50) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * `cancelarOcorrencia` abre `$transaction` sem opções, e o padrão de 5 s não
 * cabe uma pausa deliberada. Alargar aqui é decisão **do harness**: o serviço
 * continua com o padrão de produção, que é o certo para produção.
 */
function alargarTransacao(c: PrismaClient) {
  const orig = c.$transaction.bind(c) as (...a: unknown[]) => Promise<unknown>;
  (c as unknown as { $transaction: unknown }).$transaction = (
    fn: unknown,
    opcoes?: Record<string, unknown>,
  ) => orig(fn, { maxWait: 60_000, timeout: 120_000, ...(opcoes ?? {}) });
}

/** `HH:MM` do minuto atual no fuso do clube, deslocado de `n` minutos. */
async function minutoDoClube(n: number): Promise<string> {
  const [r] = await semear.$queryRawUnsafe<{ hhmm: string }[]>(
    `SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo') + INTERVAL '${n} minutes','HH24:MI') AS hhmm`,
  );
  return r.hhmm;
}

/** Já passamos do minuto `hhmm` no fuso do clube? */
async function jaPassouDe(hhmm: string): Promise<boolean> {
  const [r] = await observador.$queryRawUnsafe<{ passou: boolean }[]>(
    `SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo'),'HH24:MI') >= '${hhmm}' AS passou`,
  );
  return r.passou;
}

/**
 * Há alguma conexão **provadamente bloqueada** no `FOR UPDATE` de `turmas`?
 *
 * **A primeira versão disto media a coisa errada, e o teste passou a mão.**
 * Ela procurava `pg_locks.granted = false` com `relation = 'turmas'` — mas
 * lock de LINHA não aparece assim: quem espera por uma linha travada espera
 * num `transactionid`/`tuple`, não numa lock de relação. A consulta nunca
 * casava, e a barreira estourava por tempo.
 *
 * O que vale é o par: `pg_blocking_pids` **não vazio** (alguém está segurando
 * esta transação) e a consulta em curso sendo o `FOR UPDATE` de `turmas` —
 * que amarra a espera à raiz de lock certa (INV-029). Esperar em outra tabela
 * não provaria nada.
 */
async function alguemEsperandoLockDeTurmas(): Promise<boolean> {
  const [r] = await observador.$queryRawUnsafe<{ n: bigint }[]>(`
    SELECT count(*) AS n
      FROM pg_stat_activity a
     WHERE a.wait_event_type = 'Lock'
       AND cardinality(pg_blocking_pids(a.pid)) > 0
       AND a.query ILIKE '%turmas%'
       AND a.query ILIKE '%FOR UPDATE%'
  `);
  return Number(r.n) > 0;
}

async function esperarAte(
  cond: () => Promise<boolean>,
  limiteMs: number,
  oQue: string,
): Promise<void> {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`tempo esgotado esperando: ${oQue}`);
}

async function semearBase() {
  await limparEmpresa(semear, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-023','fit-023',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES
       ('${UPROF}','prof-fit023@x.test','x','Prof','professor','${EMPRESA}',now()),
       ('${UADMIN}','admin-fit023@x.test','x','Admin','company_admin','${EMPRESA}',now()),
       ('${UALUNO}','aluno-fit023@x.test','x','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF}','${EMPRESA}','Prof','${UPROF}')`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA}','aprovado')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES ('${ESPORTE}','${EMPRESA}','Tenis',0,now())`,
  );
  // Duas quadras: a `EXCLUDE no_overlap_por_quadra` recusaria a ocorrencia do
  // AC-016b se ela dividisse quadra E horario com a do AC-016 — e as duas sao
  // de HOJE, por construcao.
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES
       ('${QUADRA}','${EMPRESA}','Q1','${ESPORTE}',100),
       ('${QUADRA2}','${EMPRESA}','Q2','${ESPORTE}',100)`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade) VALUES ('${TURMA}','${EMPRESA}','Turma FIT-023','${QUADRA}','${PROF}',20)`,
  );
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id) VALUES (gen_random_uuid(),'${TURMA}','${ALUNO}')`,
  );
}

/** Uma ocorrência HOJE, começando em `hhmm` (fuso do clube). */
async function novaOcorrencia(hhmm: string, quadra = QUADRA): Promise<string> {
  const [r] = await semear.$queryRawUnsafe<{ id: string }[]>(`
    INSERT INTO ocupacoes_quadra
      (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
    VALUES (gen_random_uuid(),'${EMPRESA}','${quadra}',
            (now() AT TIME ZONE 'America/Sao_Paulo')::date,
            TIME '${hhmm}', TIME '${hhmm}' + INTERVAL '50 minutes',
            'TURMA','${TURMA}','pendente_pagamento',now())
    RETURNING id`);
  return r.id;
}

beforeAll(semearBase);

afterAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  await Promise.all([
    dbCancel.$disconnect(),
    dbChamada.$disconnect(),
    semear.$disconnect(),
    observador.$disconnect(),
  ]);
});

describe('FIT-023 — cancelar × chamada, serializando em `turmas` (AC-016)', () => {
  /**
   * O caminho completo, com a barreira observável entre as duas metades.
   */
  it('AC-016: a chamada ESPERA o lock e depois recusa com 422 AULA_CANCELADA', async () => {
    await ancorarPertoDaViradaDoMinuto();
    alargarTransacao(dbCancel);
    const inicio = await minutoDoClube(1);
    const aula = await novaOcorrencia(inicio);

    const { svc, cs } = classes(dbCancel);

    // A pausa fica no ÚLTIMO passo antes do UPDATE, e é dependência injetada
    // — o lock de `turmas` já está na mão e o corte temporal já passou.
    let chegou!: () => void;
    const chegouNoPonto = new Promise<void>((r) => (chegou = r));
    let liberar!: () => void;
    const liberado = new Promise<void>((r) => (liberar = r));

    // O tipo do metodo, explicito: `bind` sozinho devolve algo que o
    // `no-unsafe-*` do eslint nao consegue seguir.
    type CancelarUma = CourtsService['cancelOneClassOccurrence'];
    const real = cs.cancelOneClassOccurrence.bind(cs) as CancelarUma;
    const espiao = jest
      .spyOn(cs, 'cancelOneClassOccurrence')
      .mockImplementation(async (...args: Parameters<CancelarUma>) => {
        chegou();
        await liberado;
        return real(...args);
      });

    try {
      const pCancel = svc.cancelarOcorrencia(
        EMPRESA,
        TURMA,
        aula,
        'chuva',
        UADMIN,
      );
      await chegouNoPonto;

      // O relógio vira: a aula passa a ter começado. Só agora a chamada é
      // admissível — e é exatamente por isso que o AC original, pedindo as
      // duas "ao mesmo tempo", não podia ser satisfeito.
      await esperarAte(() => jaPassouDe(inicio), 90_000, 'a virada do minuto');

      const pChamada = presencas.salvarChamada(EMPRESA, UPROF, aula, '0', [
        { alunoId: ALUNO, status: 'presente' },
      ]);
      const capturado = pChamada.catch((e: unknown) => e);

      // **A barreira.** Sem esta prova o teste não vale nada.
      await esperarAte(
        alguemEsperandoLockDeTurmas,
        30_000,
        'a chamada bloquear no lock de `turmas`',
      );

      liberar();
      await pCancel;

      const erro = (await capturado) as {
        getStatus?: () => number;
        getResponse?: () => { code?: string };
      };
      expect(erro?.getStatus?.()).toBe(422);
      expect(erro?.getResponse?.()?.code).toBe('AULA_CANCELADA');

      // E nada foi gravado pela chamada perdida.
      expect(await semear.chamada.count({ where: { ocupacaoId: aula } })).toBe(
        0,
      );
      expect(await semear.presenca.count({ where: { ocupacaoId: aula } })).toBe(
        0,
      );
      const dep = await semear.ocupacaoQuadra.findUnique({
        where: { id: aula },
        select: { statusPagamento: true },
      });
      expect(dep?.statusPagamento).toBe('cancelado');
    } finally {
      liberar();
      espiao.mockRestore();
    }
  });

  /**
   * A ordem inversa, que o veredito da validação cruzada pediu: com a aula já
   * começada, quem chega para cancelar leva `409 PRAZO_DE_CANCELAMENTO` — o
   * caminho é a chamada, com "a aula não aconteceu".
   */
  it('AC-016b: aula ja comecada — cancelar recusa com 409 PRAZO_DE_CANCELAMENTO', async () => {
    const inicio = await minutoDoClube(-2);
    const aula = await novaOcorrencia(inicio, QUADRA2);
    const { svc } = classes(dbCancel);

    const erro = await svc
      .cancelarOcorrencia(EMPRESA, TURMA, aula, 'chuva', UADMIN)
      .then(() => null)
      .catch(
        (e: unknown) =>
          e as {
            getStatus?: () => number;
            getResponse?: () => { code?: string };
          },
      );

    expect(erro?.getStatus?.()).toBe(409);
    expect(erro?.getResponse?.()?.code).toBe('PRAZO_DE_CANCELAMENTO');

    // E a chamada, essa sim, é aceita.
    const g = await presencas.chamada(EMPRESA, UPROF, aula);
    await presencas.salvarChamada(EMPRESA, UPROF, aula, g.versao, [
      { alunoId: ALUNO, status: 'presente' },
    ]);
    expect(await semear.presenca.count({ where: { ocupacaoId: aula } })).toBe(
      1,
    );
  });
});
