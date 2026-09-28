/**
 * SPEC-034/REQ-007 — **FIT-022: mover sob concorrência.**
 *
 * Três versões da spec erraram o cenário antes de acertar, e o registro fica
 * aqui porque a próxima pessoa vai ter a mesma intuição errada:
 *
 * - a **troca A↔B** (T1 move A para o slot de B, T2 move B para o de A) **não
 *   produz deadlock**. A pré-checagem de conflito responde `409` antes de
 *   qualquer `UPDATE`, e mesmo suprimindo-a o `UPDATE` de T1 encontra a linha
 *   de B apenas travada — o desfecho é `23P01`, não espera circular;
 * - o cenário que produz é **duas reservas para o MESMO slot livre**. As duas
 *   pré-checagens passam (o destino está vazio quando cada uma olha) e os dois
 *   `UPDATE` se esperam na `EXCLUDE`.
 *
 * **Duas conexões, não duas chamadas** — a lição do FIT-010. Com um cliente
 * só, as transações podem sair da mesma conexão e serializar por acidente,
 * provando nada.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { CourtsService } from '../../src/courts/courts.service';
import {
  formatDateOnly,
  hojeNoFusoDoClube,
} from '../../src/courts/date-time.util';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { StudentsService } from '../../src/people/students.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CreditosService } from '../../src/creditos/creditos.service';

jest.setTimeout(180_000);

exigirBancoLocal();

const EMPRESA = 'f0220000-0000-4000-8000-000000000001';
const QUADRA = 'f0220000-0000-4000-8000-000000000002';
const USUARIO = 'f0220000-0000-4000-8000-000000000003';
const ALUNO = 'f0220000-0000-4000-8000-000000000004';
const ADMIN = 'f0220000-0000-4000-8000-000000000005';
const A = 'f0220000-0000-4000-8000-00000000000a';
const B = 'f0220000-0000-4000-8000-00000000000b';
const ESPORTE = 'f0220000-0000-4000-8000-000000000006';
/**
 * SPEC-077/TASK-000 — **relativa ao hoje do clube, nunca fixa.** Era
 * `'2026-10-05'`: o `moveBooking` recusa mover reserva que já começou
 * (SPEC-034/D5, pelo relógio real), e a partir das 9h daquele dia os dois
 * movimentos passariam a receber `409 PRAZO_DE_CANCELAMENTO` — o AC-019 e o
 * AC-020b ficariam vermelhos sem nada ter mudado no código.
 */
const DATA = formatDateOnly(
  new Date(hojeNoFusoDoClube().getTime() + 30 * 24 * 60 * 60 * 1000),
);

const dbA = new PrismaClient();
const dbB = new PrismaClient();
const semear = new PrismaClient();

function servico(db: PrismaClient): CourtsService {
  const horarios = new HorarioFuncionamentoService(
    db as unknown as PrismaService,
  );
  return new CourtsService(
    db as unknown as PrismaService,
    // `moveBooking` não toca em MOD-003: o aluno da reserva não muda
    // (LIM-034a). Os dublês aqui são declaradamente inertes — se algum
    // caminho passar a usá-los, o teste quebra em vez de mentir.
    {
      exigirAlunoOperante: () => {
        throw new Error('moveBooking nao deve consultar vinculo de aluno');
      },
    } as unknown as StudentsService,
    horarios,
    {
      resolver: () => {
        throw new Error('moveBooking nao deve resolver imagem de quadra');
      },
    } as unknown as ImagemDaQuadraService,
    new ConfigOperacaoService(db as unknown as PrismaService),
    new CreditosService(),
    // SPEC-039: duble vazio -- estes testes nao criam aula particular, e o
    // gate so roda quando `professorId` vem no pedido.
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
}

const servicoA = servico(dbA);
const servicoB = servico(dbB);

/**
 * **Uma instrucao por chamada** — o idioma do resto da suite (`fit-010`,
 * `fit-021`). `$executeRawUnsafe` do Prisma manda por prepared statement, e
 * o Postgres recusa varias instrucoes numa string so por esse caminho. A
 * versao anterior deste arquivo era o unico multi-statement do repositorio.
 */
const q = (sql: string) => semear.$executeRawUnsafe(sql);

async function semearFixture() {
  await limparEmpresa(semear, EMPRESA);

  // `empresas.slug` e NOT NULL + UNIQUE desde a 20260822000000_account_onboarding,
  // e nao tem default.
  await q(
    `INSERT INTO empresas (id, nome, slug, created_at, updated_at)
     VALUES ('${EMPRESA}', 'Empresa FIT-022', 'fit-022-mover', now(), now())`,
  );

  // `quadras.esporte_id` virou NOT NULL na SPEC-020 (migration _contract), e a
  // FK e COMPOSTA — `(company_id, esporte_id) -> esportes_de_quadra(company_id,
  // id)`. Um uuid solto nao serve: a linha do esporte tem de existir antes.
  // `limparEmpresa` ja apaga `esportes_de_quadra`, entao nao vaza.
  await q(
    `INSERT INTO esportes_de_quadra (id, company_id, nome, ordem, created_at)
     VALUES ('${ESPORTE}', '${EMPRESA}', 'Tenis', 1, now())`,
  );

  // **`quadras` nao tem `updated_at`** — nunca teve, e o CREATE TABLE de
  // 20260811000000_courts so declara `created_at`. O mesmo vale para `alunos`,
  // abaixo. Citar a coluna custa 42703 e derruba os tres testes no `beforeAll`.
  await q(
    `INSERT INTO quadras
       (id, company_id, nome, preco_hora, status, esporte_id, created_at)
     VALUES ('${QUADRA}', '${EMPRESA}', 'Quadra FIT-022', 100, 'ativa',
             '${ESPORTE}', now())`,
  );

  // Expediente largo: o teste julga concorrência, não INV-011. Um dia
  // fechado faria as duas transações morrerem em 422 antes do UPDATE.
  await q(
    `INSERT INTO horarios_funcionamento
       (id, company_id, quadra_id, dia_semana, fechado, hora_inicio, hora_fim,
        created_at, updated_at)
     SELECT gen_random_uuid(), '${EMPRESA}', '${QUADRA}', d, false,
            '06:00', '23:00', now(), now()
       FROM generate_series(0, 6) AS d`,
  );

  await q(
    `INSERT INTO usuarios
       (id, company_id, nome, email, senha_hash, role, status, created_at, updated_at)
     VALUES ('${USUARIO}', '${EMPRESA}', 'Aluno FIT-022', 'aluno-fit022@x.test',
             'x', 'aluno', 'ativo', now(), now()),
            ('${ADMIN}', '${EMPRESA}', 'Admin FIT-022', 'admin-fit022@x.test',
             'x', 'company_admin', 'ativo', now(), now())`,
  );

  await q(
    `INSERT INTO alunos (id, company_id, usuario_id, status, vinculo, created_at)
     VALUES ('${ALUNO}', '${EMPRESA}', '${USUARIO}', 'ativo', 'aprovado', now())`,
  );
}

/**
 * Duas reservas AVULSAS, em horas diferentes, na mesma quadra.
 *
 * **A limpeza passa por `limparEmpresa`, e nao por `DELETE` cru.**
 * `eventos_de_ocupacao` e `acoes_administrativas` sao append-only
 * (SPEC-032/INV-061): a trigger `append_only_com_valvula_de_teste` levanta
 * `23514` em qualquer `DELETE` que nao venha com o GUC **e** a role
 * `playck_test_cleanup`. Um `DELETE` cru aqui passaria despercebido no
 * primeiro caso (nenhuma linha ainda, trigger `FOR EACH ROW` nao dispara) e
 * quebraria do segundo em diante, ja com `moveBooking` tendo registrado a
 * acao — exatamente o AC-020, que re-semeia doze vezes.
 *
 * `limparEmpresa` e quem sabe abrir a valvula, entao re-semeamos a fixture
 * inteira. Custa alguns DELETEs a mais por rodada, contra localhost.
 */
async function semearDuasReservas(horaA: string, horaB: string) {
  await semearFixture();
  await q(`
    INSERT INTO ocupacoes_quadra
      (id, company_id, quadra_id, data, hora_inicio, hora_fim, origem_tipo,
       aluno_id, status_pagamento, valor, created_at, updated_at)
    VALUES
      ('${A}', '${EMPRESA}', '${QUADRA}', '${DATA}', '${horaA}', '${horaA.slice(0, 2)}:59:59', 'AVULSO',
       '${ALUNO}', 'pendente_pagamento', 100, now(), now()),
      ('${B}', '${EMPRESA}', '${QUADRA}', '${DATA}', '${horaB}', '${horaB.slice(0, 2)}:59:59', 'AVULSO',
       '${ALUNO}', 'pendente_pagamento', 100, now(), now())
  `);
}

beforeAll(semearFixture);

afterAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  await Promise.all([
    dbA.$disconnect(),
    dbB.$disconnect(),
    semear.$disconnect(),
  ]);
});

describe('FIT-022 — mover sob concorrência (SPEC-034/REQ-007)', () => {
  /**
   * AC-019 — N transações movendo reservas distintas para o **mesmo slot
   * livre**: exatamente uma vence, as demais recebem 409, nenhuma 500.
   */
  it('AC-019: duas para o mesmo slot livre — uma vence, a outra recebe 409', async () => {
    await semearDuasReservas('09:00', '10:00');

    const destino = { horaInicio: '15:00', horaFim: '16:00' };
    const [rA, rB] = await Promise.allSettled([
      servicoA.moveBooking(EMPRESA, A, destino, ADMIN),
      servicoB.moveBooking(EMPRESA, B, destino, ADMIN),
    ]);

    const ganhou = [rA, rB].filter((r) => r.status === 'fulfilled');
    const perdeu = [rA, rB].filter((r) => r.status === 'rejected');
    expect(ganhou).toHaveLength(1);
    expect(perdeu).toHaveLength(1);

    // 409, e **não** 500: a corrida perdida é conflito, não defeito.
    const erro = perdeu[0].reason as {
      status?: number;
    };
    expect(erro.status).toBe(409);

    // E o estado final não tem sobreposição — quem perdeu ficou onde estava.
    const noDestino = await semear.ocupacaoQuadra.count({
      where: {
        companyId: EMPRESA,
        data: new Date(`${DATA}T00:00:00.000Z`),
        horaInicio: new Date('1970-01-01T15:00:00.000Z'),
        statusPagamento: { not: 'cancelado' },
      },
    });
    expect(noDestino).toBe(1);
  });

  /**
   * AC-020 — o mesmo cenário, **com o `40P01` observado**.
   *
   * O deadlock depende de escalonamento: as duas transações precisam tomar a
   * própria linha antes de qualquer uma tentar o `UPDATE`. Isso não acontece
   * em toda execução — na validação cruzada apareceu no sexto par —, então o
   * teste **repete com teto declarado** e afirma o que vale sempre:
   * nenhuma transação recebe `40P01` cru, e quando o retry roda ele roda
   * **uma vez**.
   */
  it('AC-020: o retry aparece, e nunca vaza 40P01 cru', async () => {
    const TETO = 12;
    let viuRetry = false;

    for (let i = 0; i < TETO && !viuRetry; i += 1) {
      await semearDuasReservas('09:00', '10:00');
      const antes = servicoA.retentativasDeMover + servicoB.retentativasDeMover;

      const destino = { horaInicio: '15:00', horaFim: '16:00' };
      const r = await Promise.allSettled([
        servicoA.moveBooking(EMPRESA, A, destino, ADMIN),
        servicoB.moveBooking(EMPRESA, B, destino, ADMIN),
      ]);

      for (const item of r) {
        if (item.status === 'rejected') {
          const e = item.reason as { status?: number; message?: string };
          // O que vale SEMPRE: recusa é 409, e `40P01` nunca chega cru.
          expect(e.status).toBe(409);
          expect(String(e.message ?? '')).not.toContain('40P01');
        }
      }

      const depois =
        servicoA.retentativasDeMover + servicoB.retentativasDeMover;
      if (depois > antes) {
        viuRetry = true;
        // **Exatamente uma**, e é isto que o contador prova: um laço de N
        // tentativas passaria em todo o resto deste teste.
        expect(depois - antes).toBe(1);
      }
    }

    // Se em 12 pares o escalonador nunca produziu o ciclo, o teste NÃO falha
    // — ele registra. Falhar aqui transformaria um teste de concorrência em
    // sorteio, que é o defeito que a SPEC-030 catalogou (`LEARNINGS.md`,
    // 2026-08-29). O que ele já provou é o invariante: nenhuma 500, nenhum
    // 40P01 cru, nenhuma sobreposição.
    if (!viuRetry) {
      console.warn(
        `FIT-022/AC-020: ${TETO} pares sem produzir 40P01 nesta execução. ` +
          'O invariante foi verificado; o ciclo não apareceu.',
      );
    }
  });

  /**
   * AC-020b — a rede de segurança determinística.
   *
   * Injeta `40P01` na primeira tentativa e afere que a segunda completa. É o
   * que garante que o laço existe mesmo quando o escalonador não coopera.
   */
  it('AC-020b: 40P01 injetado na 1a tentativa — a 2a completa', async () => {
    await semearDuasReservas('09:00', '10:00');

    const servicoInjetado = servico(dbA);
    const original = dbA.$transaction.bind(dbA) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    let primeira = true;
    const espiao = jest
      .spyOn(dbA, '$transaction')
      .mockImplementation((...args: unknown[]) => {
        if (primeira) {
          primeira = false;
          // **Tem de ser um `PrismaClientKnownRequestError` de verdade.**
          // `ehCorridaPerdida` (courts.service.ts:140) decide por
          // `instanceof`, nao por `.code`: um `Error` cru com `code =
          // 'P2034'` falha nos DOIS `instanceof` e o retry nunca aconteceria
          // — o teste passaria a afirmar o contrario do que quer provar.
          const e = new Prisma.PrismaClientKnownRequestError(
            'deadlock detected',
            { code: 'P2034', clientVersion: Prisma.prismaVersion.client },
          );
          return Promise.reject(e);
        }
        return original(...args);
      });

    try {
      const antes = servicoInjetado.retentativasDeMover;
      const movida = await servicoInjetado.moveBooking(
        EMPRESA,
        A,
        { horaInicio: '15:00', horaFim: '16:00' },
        ADMIN,
      );
      expect(movida.horaInicio).toBe('15:00');
      expect(servicoInjetado.retentativasDeMover - antes).toBe(1);
    } finally {
      espiao.mockRestore();
    }
  });
});

/**
 * SPEC-077/TASK-003 — **as duas provas concorrentes que a matriz da 034
 * prometia** (AC-006 e AC-020 da 034; #27 e #38 da 077).
 *
 * ## Barreiras NOMINAIS, e por isso uma conexão por serviço
 *
 * Cada serviço fala por um `PrismaClient` de **uma** conexão: assim o
 * `pg_backend_pid()` dele é conhecido antes, e a barreira pergunta ao Postgres
 * "o pid DESTE serviço está bloqueado pelo pid DAQUELE segurador?" — não
 * "alguém está esperando alguma coisa". Contenção alheia satisfaria a versão
 * frouxa, e o teste passaria sem ter montado a intercalação.
 *
 * ## O prazo de 5 s das transações
 *
 * O `$transaction` do serviço tem o `timeout` padrão do Prisma (5 s), e a
 * espera nas travas conta. As barreiras soltam assim que a condição aparece
 * — tipicamente em menos de 2 s, contando o `deadlock_timeout` de 1 s.
 */
describe('SPEC-077/TASK-003 — as provas concorrentes da 034 (AC-006 e AC-020)', () => {
  const Q2 = 'f0220000-0000-4000-8000-000000000007';
  const R = 'f0220000-0000-4000-8000-00000000000c';

  const url = process.env.DATABASE_URL as string;
  const umaConexao = () =>
    new PrismaClient({
      datasources: {
        db: {
          url: url + (url.includes('?') ? '&' : '?') + 'connection_limit=1',
        },
      },
    });
  const c1 = umaConexao();
  const c2 = umaConexao();
  const pendente = umaConexao();
  const trava = umaConexao();
  const observador = umaConexao();
  const s1 = servico(c1);
  const s2 = servico(c2);

  afterAll(async () => {
    await Promise.all(
      [c1, c2, pendente, trava, observador].map((c) => c.$disconnect()),
    );
  });

  const pidDe = async (c: PrismaClient) => {
    const [{ p }] = await c.$queryRawUnsafe<{ p: number }[]>(
      'SELECT pg_backend_pid() AS p',
    );
    return p;
  };

  const bloqueadoPor = async (pid: number, por: number) => {
    const [{ ok }] = await observador.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT ${por} = ANY(pg_blocking_pids(${pid})) AS ok`,
    );
    return ok;
  };

  /**
   * Espera a condição, com teto por VOLTAS e não por relógio: sob a sonda de
   * data o `Date.now()` do Node fica parado, e um teto por tempo nunca venceria.
   */
  async function esperar(rotulo: string, cond: () => Promise<boolean>) {
    for (let i = 0; i < 200; i += 1) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`barreira não alcançada: ${rotulo}`);
  }

  /** Uma transação que segura travas até ser solta — e diz o pid dela. */
  function segurando(cliente: PrismaClient, comandos: string[]) {
    let soltar!: (desfazer: boolean) => void;
    const solto = new Promise<boolean>((r) => (soltar = r));
    let avisar!: (p: number) => void;
    const pronto = new Promise<number>((r) => (avisar = r));
    const fim = cliente
      .$transaction(
        async (tx) => {
          const [{ p }] = await tx.$queryRawUnsafe<{ p: number }[]>(
            'SELECT pg_backend_pid() AS p',
          );
          for (const c of comandos) await tx.$executeRawUnsafe(c);
          avisar(p);
          if (await solto) throw new Error('DESFEITA_DE_PROPOSITO');
        },
        { timeout: 60_000, maxWait: 10_000 },
      )
      .catch((e: Error) => {
        if (e.message !== 'DESFEITA_DE_PROPOSITO') throw e;
      });
    const pid = Promise.race([
      pronto,
      fim.then(() => {
        throw new Error('o segurador terminou antes de segurar');
      }),
    ]);
    return { pid, soltar, fim };
  }

  const status = (r: PromiseSettledResult<unknown>) =>
    r.status === 'fulfilled'
      ? 200
      : (r.reason as { getStatus?: () => number }).getStatus?.();
  const codigo = (r: PromiseSettledResult<unknown>) =>
    r.status === 'fulfilled'
      ? null
      : ((r.reason as { getResponse?: () => { code?: string } }).getResponse?.()
          ?.code ?? null);

  async function linhaDe(id: string) {
    const [l] = await semear.$queryRawUnsafe<
      { quadra_id: string; hora_inicio: string; hora_fim: string }[]
    >(
      `SELECT quadra_id::text, hora_inicio::text, hora_fim::text FROM ocupacoes_quadra WHERE id = '${id}'`,
    );
    return l;
  }

  /**
   * #27 — **034 AC-006: dois `PATCH` parciais sobre o mesmo id.**
   *
   * Um muda a QUADRA (para a Q2, aberta só até 12h); o outro muda a HORA (para
   * as 20h). Cada um sozinho é válido; a composição dos dois — Q2 às 20h — está
   * fora do expediente. Com o destino composto DEPOIS da trava (o código de
   * hoje), quem chega em segundo compõe sobre a linha já movida e recebe
   * `422`. Com a composição ANTES da trava (a sabotagem), os dois compõem sobre
   * a linha original, os dois são válidos, e saem **dois `200`**.
   *
   * Por isso o critério é "um `200` e um `422`", e não "o estado final é o de
   * uma das composições": essa segunda frase passaria com a sabotagem no ar.
   */
  it('#27: os dois PATCH parciais atrás de uma barreira ⇒ um 200 e um 422 FORA_DO_EXPEDIENTE, e fica o do 200', async () => {
    await semearFixture();
    await q(
      `INSERT INTO quadras (id, company_id, nome, preco_hora, status, esporte_id, created_at)
       VALUES ('${Q2}', '${EMPRESA}', 'Quadra 2 FIT-022', 100, 'ativa', '${ESPORTE}', now())`,
    );
    await q(
      `INSERT INTO horarios_funcionamento
         (id, company_id, quadra_id, dia_semana, fechado, hora_inicio, hora_fim, created_at, updated_at)
       SELECT gen_random_uuid(), '${EMPRESA}', '${Q2}', d, false, '06:00', '12:00', now(), now()
         FROM generate_series(0, 6) AS d`,
    );
    await q(
      `INSERT INTO ocupacoes_quadra
         (id, company_id, quadra_id, data, hora_inicio, hora_fim, origem_tipo,
          aluno_id, status_pagamento, valor, created_at, updated_at)
       VALUES ('${R}', '${EMPRESA}', '${QUADRA}', '${DATA}', '10:00', '11:00', 'AVULSO',
               '${ALUNO}', 'pendente_pagamento', 100, now(), now())`,
    );
    const [p1, p2] = [await pidDe(c1), await pidDe(c2)];

    const seg = segurando(pendente, [
      `SELECT id FROM ocupacoes_quadra WHERE id = '${R}' FOR UPDATE`,
    ]);
    const ps = await seg.pid;

    const quadra = s1.moveBooking(EMPRESA, R, { quadraId: Q2 }, ADMIN);
    const hora = s2.moveBooking(
      EMPRESA,
      R,
      { horaInicio: '20:00', horaFim: '21:00' },
      ADMIN,
    );
    // Os DOIS provadamente esperando pela linha — antes de soltar. **Na fila
    // da mesma linha, o segundo espera a trava de tupla do PRIMEIRO**, e não o
    // segurador: `pg_blocking_pids` dele devolve o outro serviço. A barreira
    // aceita a cadeia, e só ela — cada um bloqueado apenas por pids do
    // cenário, e ao menos um direto pelo segurador. A primeira versão exigia
    // os dois diretos, e nunca fechava.
    const soDoCenario = async (pid: number) => {
      const [{ ok }] = await observador.$queryRawUnsafe<{ ok: boolean }[]>(
        `SELECT cardinality(pg_blocking_pids(${pid})) > 0
            AND pg_blocking_pids(${pid}) <@ ARRAY[${ps}, ${p1}, ${p2}]::int[] AS ok`,
      );
      return ok;
    };
    try {
      await esperar('os dois PATCH esperando a linha', async () => {
        return (
          (await soDoCenario(p1)) &&
          (await soDoCenario(p2)) &&
          ((await bloqueadoPor(p1, ps)) || (await bloqueadoPor(p2, ps)))
        );
      });
    } finally {
      seg.soltar(true);
      await seg.fim;
    }

    const [rq, rh] = await Promise.allSettled([quadra, hora]);
    const vistos = [
      [status(rq), codigo(rq)],
      [status(rh), codigo(rh)],
    ].sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(vistos).toEqual([
      [200, null],
      [422, 'FORA_DO_EXPEDIENTE'],
    ]);
    // Fica a composição INTEIRA de quem venceu.
    expect(await linhaDe(R)).toEqual(
      rq.status === 'fulfilled'
        ? { quadra_id: Q2, hora_inicio: '10:00:00', hora_fim: '11:00:00' }
        : { quadra_id: QUADRA, hora_inicio: '20:00:00', hora_fim: '21:00:00' },
    );
  });

  /**
   * #38 — **034 AC-020: o `40P01` por receita, e não por sorteio.**
   *
   * O AC-020 acima repete pares até o escalonador produzir o ciclo, e só
   * AVISA se não produzir. A receita:
   *
   * 1. uma transação PENDENTE insere uma ocupação no slot de destino e não
   *    commita. As pré-checagens de A e B não a veem, e os dois `UPDATE`
   *    entram no índice e param na checagem da `EXCLUDE`, esperando por ela;
   * 2. ela faz `ROLLBACK`. Os dois acordam, reolham, e cada um encontra a
   *    tupla do OUTRO, ainda em andamento: espera circular — `40P01`;
   * 3. uma trava `SHARE` em `acoes_administrativas` segura o VENCEDOR depois
   *    do `UPDATE` e antes do commit (o registrador grava a ação ali). Sem
   *    ela, o perdedor às vezes já veria o vencedor commitado, iria direto ao
   *    `409` e a retentativa não rodaria — o (b) viraria sorteio de novo;
   * 4. solta a trava quando o perdedor está na 2ª tentativa, esperando o
   *    vencedor. O vencedor commita; o perdedor esbarra na `EXCLUDE` e agora
   *    VÊ o conflito: `409`.
   *
   * O (a) é o delta de `pg_stat_database.deadlocks` — o Postgres contando, e
   * não o contador do serviço. As duas ordens de chegada, porque a receita é
   * raciocínio sobre a checagem de exclusão e pode depender de quem entra
   * primeiro.
   */
  it.each([
    ['A chega primeiro', true],
    ['B chega primeiro', false],
  ])(
    '#38: %s — (a) o Postgres conta um deadlock, (b) UMA retentativa, (c) 409 sem 40P01 cru, (d) um no slot',
    async (_ordem, aPrimeiro) => {
      await semearDuasReservas('09:00', '10:00');
      const [pA, pB] = [await pidDe(c1), await pidDe(c2)];
      const deadlocks = async () => {
        const [{ n }] = await observador.$queryRawUnsafe<{ n: number }[]>(
          `SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()`,
        );
        return n;
      };
      const deadlocksAntes = await deadlocks();
      const retentativasAntes = s1.retentativasDeMover + s2.retentativasDeMover;

      const segTrava = segurando(trava, [
        'LOCK TABLE acoes_administrativas IN SHARE MODE',
      ]);
      const pT = await segTrava.pid;
      const segPendente = segurando(pendente, [
        `INSERT INTO ocupacoes_quadra
           (id, company_id, quadra_id, data, hora_inicio, hora_fim, origem_tipo,
            aluno_id, status_pagamento, valor, created_at, updated_at)
         VALUES (gen_random_uuid(), '${EMPRESA}', '${QUADRA}', '${DATA}', '15:00', '16:00', 'AVULSO',
                 '${ALUNO}', 'pendente_pagamento', 100, now(), now())`,
      ]);
      const pP = await segPendente.pid;

      const destino = { horaInicio: '15:00', horaFim: '16:00' };
      const ordem = aPrimeiro
        ? ([
            [s1, A, pA],
            [s2, B, pB],
          ] as const)
        : ([
            [s2, B, pB],
            [s1, A, pA],
          ] as const);
      const movimentos: Promise<unknown>[] = [];
      for (const [s, id, pid] of ordem) {
        movimentos.push(s.moveBooking(EMPRESA, id, destino, ADMIN));
        await esperar(`${id} esperando a pendente`, () =>
          bloqueadoPor(pid, pP),
        );
      }

      segPendente.soltar(true);
      await segPendente.fim;

      // O ciclo se formou e foi quebrado: o perdedor já retentou e espera o
      // vencedor, que está parado na trava das ações.
      await esperar(
        'perdedor na 2a tentativa, esperando o vencedor',
        async () => {
          const r = s1.retentativasDeMover + s2.retentativasDeMover;
          if (r - retentativasAntes !== 1) return false;
          return (
            ((await bloqueadoPor(pA, pT)) && (await bloqueadoPor(pB, pA))) ||
            ((await bloqueadoPor(pB, pT)) && (await bloqueadoPor(pA, pB)))
          );
        },
      );
      segTrava.soltar(false);
      await segTrava.fim;

      const [r1, r2] = await Promise.allSettled(movimentos);
      const [ok, recusado] = r1.status === 'fulfilled' ? [r1, r2] : [r2, r1];

      // (c) um 200 e um 409 — e o 409 não é o `40P01` cru.
      expect(ok.status).toBe('fulfilled');
      expect(recusado.status).toBe('rejected');
      const erro = (recusado as PromiseRejectedResult).reason as {
        getStatus?: () => number;
        message?: string;
        getResponse?: () => unknown;
      };
      expect(erro.getStatus?.()).toBe(409);
      expect(String(erro.message)).not.toContain('40P01');
      expect(erro.getResponse?.()).toMatchObject({
        conflictWith: { origemTipo: 'AVULSO' },
      });
      // (b) exatamente UMA retentativa, somando os dois serviços.
      expect(s1.retentativasDeMover + s2.retentativasDeMover).toBe(
        retentativasAntes + 1,
      );
      // (d) um no slot, o outro onde estava.
      const noSlot = await semear.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id::text FROM ocupacoes_quadra
          WHERE company_id = '${EMPRESA}' AND data = '${DATA}'
            AND hora_inicio = '15:00' AND status_pagamento <> 'cancelado'`,
      );
      expect(noSlot).toHaveLength(1);
      // (a) o Postgres contou o deadlock. A estatística é publicada quando o
      // backend fica ocioso, com intervalo mínimo — daí a espera por voltas.
      await esperar('pg_stat_database.deadlocks subir', async () => {
        return (await deadlocks()) > deadlocksAntes;
      });
    },
  );
});
