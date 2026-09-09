/**
 * SPEC-031 — **FIT-024: cancelar × mover, e a janela que existia entre ler e
 * escrever.**
 *
 * ## O defeito, reproduzido pela validação cruzada de 2026-09-05
 *
 * `cancelBooking` lia a ocupação com `findFirst` — **sem travá-la**. Com duas
 * conexões:
 *
 * 1. o cancelamento lê uma reserva **futura**, sem lock;
 * 2. `moveBooking` move a mesma reserva para uma data **passada** e commita
 *    — ele sempre travou;
 * 3. o cancelamento decide com o horário **velho**, passa no corte temporal e
 *    escreve. **Uma reserva já consumida termina cancelada** — exatamente o
 *    que o D5b existe para impedir, e com a SPEC-033 vindo isso é dinheiro de
 *    volta por quadra usada.
 *
 * **Em execução sequencial nada disso acontece**: mover primeiro faz o
 * cancelamento recusar; cancelar primeiro faz o movimento recusar. Os dois
 * controles passavam enquanto o defeito existia — é a corrida que abre a
 * janela, e é por isso que este arquivo precisa de duas conexões e de uma
 * barreira observável.
 *
 * ## O que o conserto faz, e o que este teste afere
 *
 * A leitura passou a ser `SELECT … FOR UPDATE`. Com ela, o `moveBooking`
 * **bloqueia** no próprio `FOR UPDATE` até o cancelamento commitar — a
 * interleaving do defeito deixa de ser construível. O teste prova o bloqueio
 * em `pg_blocking_pids`, e não pela ausência do sintoma: sem a barreira
 * observável, um cancelamento que simplesmente terminasse antes passaria.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { StudentsService } from '../../src/people/students.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import { CreditosService } from '../../src/creditos/creditos.service';

jest.setTimeout(180_000);

exigirBancoLocal();

const EMPRESA = 'f0240000-0000-4000-8000-000000000001';
const QUADRA = 'f0240000-0000-4000-8000-000000000002';
const ESPORTE = 'f0240000-0000-4000-8000-000000000003';
const USUARIO = 'f0240000-0000-4000-8000-000000000004';
const ALUNO = 'f0240000-0000-4000-8000-000000000005';
const ADMIN = 'f0240000-0000-4000-8000-000000000006';
const RESERVA = 'f0240000-0000-4000-8000-00000000000a';

/** Futura, para o cancelamento ser legítimo quando ele decide. */
const FUTURO = '2026-12-10';
/** Passada, para onde o `moveBooking` tenta empurrá-la. */
const PASSADO = '2026-01-05';

const dbCancel = new PrismaClient();
const dbMover = new PrismaClient();
const dbPagar = new PrismaClient();
/**
 * **Conexão própria para o caso do pagamento, e não é economia de linha — é
 * conserto.** Os dois casos espionam `$transaction` do MESMO cliente; rodando
 * juntos, o espião do segundo envolvia o do primeiro e os dois wrappers de
 * `tx.$queryRaw` ficavam ativos ao mesmo tempo. Isolado passava, em conjunto
 * quebrava — a assinatura de teste que depende de ordem de execução.
 */
const dbCancel2 = new PrismaClient();
const semear = new PrismaClient();
const observador = new PrismaClient();

const q = (sql: string) => semear.$executeRawUnsafe(sql);

function servico(c: PrismaClient): CourtsService {
  return new CourtsService(
    c as unknown as PrismaService,
    {} as unknown as StudentsService,
    new HorarioFuncionamentoService(c as unknown as PrismaService),
    {} as unknown as ImagemDaQuadraService,
    new ConfigOperacaoService(c as unknown as PrismaService),
    new CreditosService(),
    // SPEC-039: duble vazio -- estes testes nao criam aula particular, e o
    // gate so roda quando `professorId` vem no pedido.
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
}

const servicoCancel = servico(dbCancel);
const servicoMover = servico(dbMover);
const servicoPagar = servico(dbPagar);
const servicoCancel2 = servico(dbCancel2);

/**
 * A transação interativa do Prisma expira em 5 s, e a pausa deliberada aqui
 * dura mais. Alargar é decisão do harness — o serviço mantém o padrão de
 * produção. (Mesma lição do FIT-023.)
 */
function alargarTransacao(c: PrismaClient) {
  const orig = c.$transaction.bind(c) as (...a: unknown[]) => Promise<unknown>;
  (c as unknown as { $transaction: unknown }).$transaction = (
    fn: unknown,
    opcoes?: Record<string, unknown>,
  ) => orig(fn, { maxWait: 30_000, timeout: 60_000, ...(opcoes ?? {}) });
}

async function semearFixture() {
  await limparEmpresa(semear, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-024','fit-024',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES ('${ESPORTE}','${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q1','${ESPORTE}',100,'ativa')`,
  );
  await q(
    `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,fechado,hora_inicio,hora_fim,updated_at)
     SELECT gen_random_uuid(),'${EMPRESA}','${QUADRA}',d,false,'06:00','23:00',now() FROM generate_series(0,6) d`,
  );
  await q(
    `INSERT INTO usuarios (id,company_id,nome,email,senha_hash,role,status,updated_at) VALUES
       ('${USUARIO}','${EMPRESA}','Aluno','aluno-fit024@x.test','x','aluno','ativo',now()),
       ('${ADMIN}','${EMPRESA}','Admin','admin-fit024@x.test','x','company_admin','ativo',now())`,
  );
  await q(
    `INSERT INTO alunos (id,company_id,usuario_id,status,vinculo) VALUES ('${ALUNO}','${EMPRESA}','${USUARIO}','ativo','aprovado')`,
  );
}

async function semearReserva() {
  await semearFixture();
  await q(
    `INSERT INTO ocupacoes_quadra
       (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,status_pagamento,valor,updated_at)
     VALUES ('${RESERVA}','${EMPRESA}','${QUADRA}','${FUTURO}','09:00','10:00','AVULSO','${ALUNO}','pendente_pagamento',100,now())`,
  );
}

/**
 * Alguém esperando lock de linha — na ocupação **ou na carteira**?
 *
 * **A carteira entrou aqui na SPEC-033, e não por conveniência.** A ordem
 * global de travas (INV-029) põe `alunos` no nível 2 e `ocupacoes_quadra` no
 * nível 3, então os caminhos que mexem em crédito passaram a travar a carteira
 * **primeiro**. Consequência medida: o `updatePaymentStatus` que disputa uma
 * reserva com o `cancelBooking` agora bloqueia em `alunos`, antes de chegar à
 * ocupação — e um detector que só olhasse `ocupacoes_quadra` nunca o veria,
 * dando timeout e **acusando o serviço por um defeito do detector**.
 *
 * A condição continua NOMINAL, não frouxa: exige `wait_event_type = 'Lock'`,
 * `pg_blocking_pids` não vazio e um `FOR UPDATE` sobre uma das duas tabelas
 * deste cenário. Contenção alheia não satisfaz.
 */
async function alguemBloqueado(): Promise<boolean> {
  const [r] = await observador.$queryRawUnsafe<{ n: bigint }[]>(`
    SELECT count(*) AS n
      FROM pg_stat_activity a
     WHERE a.wait_event_type = 'Lock'
       AND cardinality(pg_blocking_pids(a.pid)) > 0
       AND a.query ILIKE '%FOR UPDATE%'
       AND (a.query ILIKE '%ocupacoes_quadra%'
            OR a.query ILIKE '%saldo_creditos%')
  `);
  return Number(r.n) > 0;
}

async function esperarAte(
  cond: () => Promise<boolean>,
  limiteMs: number,
  oQue: string,
) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`tempo esgotado esperando: ${oQue}`);
}

/** O que o espião precisa enxergar do cliente de transação. */
interface TxComRaw {
  $queryRaw: (...args: unknown[]) => Promise<unknown>;
}

const estadoFinal = () =>
  semear.ocupacaoQuadra.findUniqueOrThrow({
    where: { id: RESERVA },
    select: { data: true, statusPagamento: true },
  });

beforeAll(() => {
  alargarTransacao(dbCancel);
  alargarTransacao(dbCancel2);
});

afterAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  await Promise.all([
    dbCancel.$disconnect(),
    dbMover.$disconnect(),
    dbPagar.$disconnect(),
    dbCancel2.$disconnect(),
    semear.$disconnect(),
    observador.$disconnect(),
  ]);
});

describe('FIT-024 — cancelar x mover, sob concorrencia', () => {
  /**
   * Os dois controles **sequenciais**. Eles passavam com o defeito no ar, e
   * estão aqui para dizer isso: prova sequencial não fecha janela de corrida.
   */
  it('controle serial: mover para o passado primeiro faz o cancelamento recusar', async () => {
    await semearReserva();
    await servicoMover.moveBooking(EMPRESA, RESERVA, { data: PASSADO }, ADMIN);

    await expect(
      servicoCancel.cancelBooking(EMPRESA, RESERVA, ADMIN, 'company_admin'),
    ).rejects.toMatchObject({ response: { code: 'PRAZO_DE_CANCELAMENTO' } });
  });

  it('controle serial: cancelar primeiro faz o movimento recusar', async () => {
    await semearReserva();
    await servicoCancel.cancelBooking(EMPRESA, RESERVA, ADMIN, 'company_admin');

    await expect(
      servicoMover.moveBooking(EMPRESA, RESERVA, { data: PASSADO }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'OCUPACAO_CANCELADA' } });
  });

  /**
   * **A corrida.** A barreira pausa o cancelamento **depois** do
   * `SELECT … FOR UPDATE` e antes da escrita — exatamente a janela do defeito.
   */
  it('a leitura TRAVA: o movimento espera, e nao ha estado passado+cancelado', async () => {
    await semearReserva();

    let leu!: () => void;
    const jaLeu = new Promise<void>((r) => (leu = r));
    let liberar!: () => void;
    const liberado = new Promise<void>((r) => (liberar = r));

    const original = dbCancel.$transaction.bind(dbCancel) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    const espiao = jest
      .spyOn(dbCancel, '$transaction')
      .mockImplementation((fn: (tx: TxComRaw) => unknown) =>
        original((tx: TxComRaw) => {
          // `bind` devolve algo que o `no-unsafe-*` nao consegue seguir; o
          // cast e local e o runtime e o mesmo.
          const raw = tx.$queryRaw.bind(tx) as (
            ...a: unknown[]
          ) => Promise<unknown>;
          let pausou = false;
          /**
           * **A pausa é DEPOIS do `FOR UPDATE` da OCUPAÇÃO, e a barreira
           * identifica isso pela TABELA — não pela posição.**
           *
           * Ela dizia "o PRIMEIRO `$queryRaw` do `cancelBooking` é o
           * `FOR UPDATE`", e a SPEC-033 tornou isso falso: o primeiro passou a
           * ser a trava da CARTEIRA (`alunos`, nível 2 da INV-029), que vem
           * antes da ocupação por ordem de travas. A barreira então pausava
           * antes de a ocupação estar travada, o `moveBooking` não bloqueava,
           * e o teste morria em timeout — **acusando o serviço quando o
           * defeito era da barreira**.
           *
           * Identificar pela tabela é a mesma lição de
           * `test/utils/prisma-mock.ts`: critério que uma mudança legítima
           * move não é critério.
           */
          tx.$queryRaw = async (...args: unknown[]): Promise<unknown> => {
            const linhas: unknown = await raw(...args);
            const primeiro = args[0] as { raw?: string[] };
            const sql = Array.isArray(primeiro?.raw)
              ? primeiro.raw.join(' ')
              : String(args[0]);
            if (!pausou && sql.includes('ocupacoes_quadra')) {
              pausou = true;
              leu();
              await liberado;
            }
            return linhas;
          };
          return fn(tx);
        }),
      );

    try {
      const cancelamento = servicoCancel
        .cancelBooking(EMPRESA, RESERVA, ADMIN, 'company_admin')
        .then(
          () => ({ ok: true as const }),
          (e: { response?: { code?: string } }) => ({
            ok: false as const,
            code: e.response?.code,
          }),
        );

      await jaLeu;

      // O movimento sai por OUTRA conexão, pelo serviço de produção.
      const movimento = servicoMover
        .moveBooking(EMPRESA, RESERVA, { data: PASSADO }, ADMIN)
        .then(
          () => ({ ok: true as const }),
          (e: { response?: { code?: string } }) => ({
            ok: false as const,
            code: e.response?.code,
          }),
        );

      // **A prova.** Sem o `FOR UPDATE` no cancelamento, o movimento passaria
      // direto por aqui e commitaria a data passada antes da escrita.
      await esperarAte(
        alguemBloqueado,
        30_000,
        'o moveBooking bloquear no lock da ocupacao',
      );

      liberar();
      const [rc, rm] = await Promise.all([cancelamento, movimento]);
      const final = await estadoFinal();

      // O cancelamento decidiu sobre a linha travada, que era FUTURA: aceita.
      expect(rc.ok).toBe(true);
      // E o movimento, que só entrou depois, encontra a reserva cancelada.
      expect(rm).toEqual({ ok: false, code: 'OCUPACAO_CANCELADA' });

      // **A invariante que o defeito violava.** Nunca passado E cancelado.
      const passou = final.data.toISOString().slice(0, 10) === PASSADO;
      expect(passou && final.statusPagamento === 'cancelado').toBe(false);
    } finally {
      liberar();
      espiao.mockRestore();
    }
  });
  /**
   * **A MESMA corrida, com `updatePaymentStatus` no lugar do movimento.**
   *
   * Achado por auditoria adversarial em 2026-09-05, e reproduzido em banco
   * real antes de virar conserto: `updatePaymentStatus` lia a ocupação com
   * `this.prisma.ocupacaoQuadra.findFirst` **fora** de qualquer transação, e a
   * guarda do AC-012 decidia sobre essa leitura.
   *
   * O estado que saía: `{ meio: 'cancelado', fim: 'pago' }`. **A reserva
   * cancelada ressuscitava**, voltava ao índice `EXCLUDE` — porque ele tem
   * `WHERE status_pagamento <> 'cancelado'` — e o aluno que cancelou não
   * ficava sabendo.
   *
   * O comentário do AC-012 no serviço já descrevia esse dano exato como o
   * motivo de a guarda existir. Ela existia; só decidia sobre a linha errada.
   */
  it('pagar NAO ressuscita reserva cancelada por outra conexao (AC-012)', async () => {
    await semearReserva();

    let leu!: () => void;
    const jaLeu = new Promise<void>((r) => (leu = r));
    let liberar!: () => void;
    const liberado = new Promise<void>((r) => (liberar = r));

    const original = dbCancel2.$transaction.bind(dbCancel2) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    const espiao = jest
      .spyOn(dbCancel2, '$transaction')
      .mockImplementation((fn: (tx: TxComRaw) => unknown) =>
        original((tx: TxComRaw) => {
          const raw = tx.$queryRaw.bind(tx) as (
            ...a: unknown[]
          ) => Promise<unknown>;
          let pausou = false;
          /**
           * **A pausa é DEPOIS do `FOR UPDATE` da OCUPAÇÃO, e a barreira
           * identifica isso pela TABELA — não pela posição.**
           *
           * Ela dizia "o PRIMEIRO `$queryRaw` do `cancelBooking` é o
           * `FOR UPDATE`", e a SPEC-033 tornou isso falso: o primeiro passou a
           * ser a trava da CARTEIRA (`alunos`, nível 2 da INV-029), que vem
           * antes da ocupação por ordem de travas. A barreira então pausava
           * antes de a ocupação estar travada, o `moveBooking` não bloqueava,
           * e o teste morria em timeout — **acusando o serviço quando o
           * defeito era da barreira**.
           *
           * Identificar pela tabela é a mesma lição de
           * `test/utils/prisma-mock.ts`: critério que uma mudança legítima
           * move não é critério.
           */
          tx.$queryRaw = async (...args: unknown[]): Promise<unknown> => {
            const linhas: unknown = await raw(...args);
            const primeiro = args[0] as { raw?: string[] };
            const sql = Array.isArray(primeiro?.raw)
              ? primeiro.raw.join(' ')
              : String(args[0]);
            if (!pausou && sql.includes('ocupacoes_quadra')) {
              pausou = true;
              leu();
              await liberado;
            }
            return linhas;
          };
          return fn(tx);
        }),
      );

    try {
      const cancelamento = servicoCancel2
        .cancelBooking(EMPRESA, RESERVA, ADMIN, 'company_admin')
        .then(() => 'cancelou');

      // O cancelamento já segura o `FOR UPDATE` da linha.
      await jaLeu;

      const pagamento = servicoPagar
        .updatePaymentStatus(EMPRESA, RESERVA, 'pago', ADMIN)
        .then(
          () => 'pagou',
          (e: { response?: { code?: string } }) => e.response?.code ?? 'erro',
        );

      // **Sem o conserto ninguém espera aqui** — o `findFirst` de fora da
      // transação não pede lock nenhum, lê `pendente_pagamento` e passa reto.
      await esperarAte(
        alguemBloqueado,
        20_000,
        'o pagamento atras do lock do cancelamento',
      );

      liberar();
      await cancelamento;

      // Ele acorda vendo `cancelado`, e a guarda do AC-012 finalmente decide
      // sobre a linha que vale.
      expect(await pagamento).toBe('RESERVA_CANCELADA');

      const fim = await estadoFinal();
      expect(fim.statusPagamento).toBe('cancelado');
    } finally {
      espiao.mockRestore();
    }
  });
});
