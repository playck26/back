/**
 * SPEC-033/TASK-009 — **as provas CONCORRENTES da carteira.**
 *
 * FIT-025 (dois pedidos, saldo para um), FIT-027 (as duas camadas, com
 * sabotagem), FIT-028 (criar × cancelar sem `40P01`) e FIT-029 (idempotência
 * **financeira**).
 *
 * ## Por que nada aqui vale sequencial
 *
 * *"Dois pedidos com saldo para um"* rodado em sequência é trivial: o primeiro
 * debita, o segundo não tem saldo. O defeito mora na **janela** entre ler o
 * saldo e escrever o movimento, e essa janela só existe com duas conexões. É a
 * mesma razão do FIT-001 — e este projeto já teve um defeito reproduzido
 * exatamente assim, com `moveBooking` contra `cancelBooking`.
 *
 * ## As barreiras são NOMINAIS
 *
 * `pg_blocking_pids` não vazio **sobre a linha do cenário**, não "alguém
 * esperando alguma coisa". Contenção alheia satisfaria a versão frouxa, e o
 * teste ficaria verde sem nunca alcançar a janela perigosa.
 */
import { PrismaClient } from '@prisma/client';
import { CourtsService } from '../../src/courts/courts.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { StudentsService } from '../../src/people/students.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(180_000);

exigirBancoLocal();

const semear = new PrismaClient();
const dbA = new PrismaClient();
const dbB = new PrismaClient();
/**
 * **Conexão própria para o caso que ESPIONA `$transaction`, e não é economia
 * de linha — é conserto que o FIT-024 já pagou.**
 *
 * Espiar o `$transaction` de um cliente compartilhado deixa o wrapper vivo
 * para o teste seguinte: isolado passa, em conjunto quebra com "Transaction
 * already closed". Aconteceu aqui na primeira execução, e a lição estava
 * escrita no arquivo ao lado.
 */
const dbEspiao = new PrismaClient();
const observador = new PrismaClient();

const q = (sql: string) => semear.$executeRawUnsafe(sql);

const E = 'f0330000-0000-4000-8000-000000000001';
const UADMIN = 'f0330000-0000-4000-8000-000000000002';
const UALUNO = 'f0330000-0000-4000-8000-000000000003';
const ALUNO = 'f0330000-0000-4000-8000-000000000004';
const ESPORTE = 'f0330000-0000-4000-8000-000000000005';
const QUADRA = 'f0330000-0000-4000-8000-000000000006';
const ACAO = 'f0330000-0000-4000-8000-000000000007';

function servico(c: PrismaClient): CourtsService {
  return new CourtsService(
    c as unknown as PrismaService,
    { exigirVinculoAprovado: () => undefined } as unknown as StudentsService,
    new HorarioFuncionamentoService(c as unknown as PrismaService),
    {} as unknown as ImagemDaQuadraService,
    new ConfigOperacaoService(c as unknown as PrismaService),
    new CreditosService(),
    // SPEC-039: duble vazio -- estes testes nao criam aula particular, e o
    // gate so roda quando `professorId` vem no pedido.
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
}
const servicoA = servico(dbA);
const servicoB = servico(dbB);
const servicoEspiao = servico(dbEspiao);
const creditos = new CreditosService();

/** Alguém bloqueado esperando a linha da CARTEIRA deste cenário? */
async function esperandoACarteira(): Promise<boolean> {
  const [r] = await observador.$queryRawUnsafe<{ n: bigint }[]>(`
    SELECT count(*) AS n
      FROM pg_stat_activity a
     WHERE a.wait_event_type = 'Lock'
       AND cardinality(pg_blocking_pids(a.pid)) > 0
       AND a.query ILIKE '%saldo_creditos%'
       AND a.query ILIKE '%FOR UPDATE%'
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

const saldo = async () => {
  const [l] = await semear.$queryRawUnsafe<{ saldo_creditos: number }[]>(
    `SELECT saldo_creditos FROM alunos WHERE id = '${ALUNO}'`,
  );
  return l.saldo_creditos;
};

const contar = async (sql: string) => {
  const [l] = await semear.$queryRawUnsafe<{ n: bigint }[]>(sql);
  return Number(l.n);
};

/**
 * Leva o saldo ATÉ `centavos`, pela porta do ledger.
 *
 * **Sai cedo quando não há delta**, porque `valor_centavos > 0` é `CHECK` e
 * lançar zero é recusado — corretamente: zero não move saldo e sujaria o
 * extrato (PA-07). Foi o próprio banco que pegou este erro do harness.
 */
async function levarSaldoA(alvo: number) {
  const atual = await saldo();
  if (atual === alvo) return;
  if (atual < alvo) return creditar(alvo - atual);
  const [acao] = await semear.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
     VALUES (gen_random_uuid(),'${E}','credito_retirado','${UADMIN}') RETURNING id`,
  );
  await semear.$transaction((tx) =>
    creditos.retirar(tx, {
      companyId: E,
      alunoId: ALUNO,
      valorCentavos: atual - alvo,
      motivo: 'ajuste do FIT',
      autorId: UADMIN,
      acaoId: acao.id,
    }),
  );
}

async function creditar(centavos: number) {
  const [acao] = await semear.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
     VALUES (gen_random_uuid(),'${E}','credito_lancado','${UADMIN}') RETURNING id`,
  );
  await semear.$transaction((tx) =>
    creditos.lancar(tx, {
      companyId: E,
      alunoId: ALUNO,
      valorCentavos: centavos,
      motivo: 'aporte do FIT',
      autorId: UADMIN,
      acaoId: acao.id,
    }),
  );
}

let dia = 0;
function proximaData() {
  dia += 1;
  return new Date(Date.UTC(2033, 0, dia)).toISOString().slice(0, 10);
}

function pedido(data: string, hora = '10:00') {
  return {
    quadraId: QUADRA,
    data,
    slots: [{ horaInicio: hora, horaFim: '11:00' }],
    alunoId: ALUNO,
  } as never;
}

const codigoDe = (e: unknown) =>
  (e as { response?: { code?: string } }).response?.code;

beforeAll(async () => {
  await limparEmpresa(semear, E);
  await q(`INSERT INTO empresas (id,nome,updated_at,slug)
           VALUES ('${E}','FIT conc 033',now(),'fit-conc-033')`);
  await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,updated_at,company_id)
           VALUES ('${UADMIN}','admin@fitc.test','x','Admin','company_admin',now(),'${E}')`);
  await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,updated_at,company_id)
           VALUES ('${UALUNO}','aluno@fitc.test','x','Aluno','aluno',now(),'${E}')`);
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO}','${UALUNO}','${E}')`,
  );
  await q(`INSERT INTO esportes_de_quadra (id,company_id,nome,ordem)
           VALUES ('${ESPORTE}','${E}','Tenis',1)`);
  await q(`INSERT INTO quadras (id,company_id,nome,preco_hora,esporte_id)
           VALUES ('${QUADRA}','${E}','Q1',80,'${ESPORTE}')`);
  await q(`INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
           VALUES ('${ACAO}','${E}','reserva_criada','${UADMIN}')`);
});

afterAll(async () => {
  await limparEmpresa(semear, E);
  await Promise.all([
    semear.$disconnect(),
    dbA.$disconnect(),
    dbB.$disconnect(),
    dbEspiao.$disconnect(),
    observador.$disconnect(),
  ]);
});

// ---------------------------------------------------------------------------
describe('FIT-025 — dois pedidos, saldo para um: exatamente um passa', () => {
  it('o segundo recebe SALDO_INSUFICIENTE, e o saldo nunca fica negativo', async () => {
    // Saldo para UMA reserva de 8000. Duas quadras-hora diferentes, para a
    // disputa ser pela CARTEIRA e não pela `EXCLUDE` — se as duas brigassem
    // pelo mesmo horário, o teste passaria pelo motivo errado.
    await levarSaldoA(8000);
    expect(await saldo()).toBe(8000);

    const [rA, rB] = await Promise.allSettled([
      servicoA.createBooking(
        E,
        pedido(proximaData()),
        UADMIN,
        undefined,
        'aluno',
      ),
      servicoB.createBooking(
        E,
        pedido(proximaData()),
        UADMIN,
        undefined,
        'aluno',
      ),
    ]);

    const passaram = [rA, rB].filter((r) => r.status === 'fulfilled');
    const falharam = [rA, rB].filter((r) => r.status === 'rejected');
    expect(passaram).toHaveLength(1);
    expect(falharam).toHaveLength(1);
    expect(codigoDe(falharam[0].reason)).toBe('SALDO_INSUFICIENTE');

    expect(await saldo()).toBe(0);
    expect(
      await contar(
        `SELECT count(*) AS n FROM movimentos_de_credito
          WHERE company_id='${E}' AND tipo='consumo'`,
      ),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('FIT-027 — as duas camadas, e a sabotagem que prova a de baixo', () => {
  it('SABOTAGEM: sem a trava, duas transações debitam além do saldo — e o CHECK recusa', async () => {
    // A camada 1 é a pré-checagem sob `FOR UPDATE`; a camada 2 é o
    // `CHECK (saldo_creditos >= 0)`. Este caso **remove a camada 1 de
    // propósito**, inserindo o consumo direto pelas duas conexões, e afirma
    // que a de baixo segura. Sem esta prova, "há duas camadas" seria
    // afirmação — e a segunda só age quando a primeira falha.
    await levarSaldoA(8000);
    const ocA = await ocupacaoAvulsa('2033-06-01');
    const ocB = await ocupacaoAvulsa('2033-06-02');

    const [rA, rB] = await Promise.allSettled([
      dbA.$executeRawUnsafe(consumoSql(ocA)),
      dbB.$executeRawUnsafe(consumoSql(ocB)),
    ]);

    // Um passa, o outro morre no CHECK — não no serviço, que nem foi
    // consultado. É o banco, e é o ponto.
    const ok = [rA, rB].filter((r) => r.status === 'fulfilled');
    const erro = [rA, rB].find((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(String((erro as PromiseRejectedResult).reason)).toMatch(
      /alunos_saldo_nao_negativo|23514/,
    );
    expect(await saldo()).toBe(0);
  });

  it('SABOTAGEM (b): sem o INDICE, o mesmo consumo e estornado DUAS vezes', async () => {
    /**
     * A spec pede DUAS sabotagens para o FIT-027, e so a (a) existia. Esta e a
     * (b): *"tirar o indice E a trava e a prova cai com saldo dobrado"*.
     *
     * **A (a) e a (b) provam camadas diferentes.** A (a) tira a trava e mostra
     * o `CHECK` do saldo segurando um debito a mais. Esta tira o INDICE
     * PARCIAL e mostra o que so ele impede: o mesmo consumo estornado duas
     * vezes, creditando o dobro. O `CHECK` nao alcanca — somar credito nunca
     * viola `saldo >= 0`.
     *
     * **Dentro de uma transacao que sempre volta atras**, pela mesma razao da
     * sabotagem do FIT-030: as linhas indevidas nao podem ser apagadas (o
     * ledger e append-only), entao limpar no `finally` nao funciona. DDL no
     * Postgres e transacional; o `ROLLBACK` devolve o indice E some com as
     * linhas.
     */
    await levarSaldoA(30_000);
    const oc = await ocupacaoAvulsa('2033-06-10');
    const consumo = await consumirEm(oc, 8000);
    const antes = await saldo();

    const VOLTA = 'rollback-da-sabotagem';
    let saldoSemOIndice = -1;
    await semear
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'DROP INDEX ux_movimentos_devolucao_por_consumo',
        );
        for (let i = 0; i < 2; i++) {
          await tx.$executeRawUnsafe(
            `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,autor_id,acao_id,ocupacao_id,movimento_origem_id)
             VALUES (gen_random_uuid(),'${E}','${ALUNO}','devolucao',8000,'${UADMIN}','${ACAO}','${oc}','${consumo}')`,
          );
        }
        const [l] = await tx.$queryRawUnsafe<{ saldo_creditos: number }[]>(
          `SELECT saldo_creditos FROM alunos WHERE id = '${ALUNO}'`,
        );
        saldoSemOIndice = l.saldo_creditos;
        throw new Error(VOLTA);
      })
      .catch((e: Error) => {
        if (e.message !== VOLTA) throw e;
      });

    // **O dano que so o indice impede, medido:** um consumo de 8000 e DOIS
    // estornos de 8000 -- o saldo sobe 16000 sobre o de depois da reserva, e
    // fica 8000 acima do que era ANTES dela. Ou seja: quadra usada, credito
    // devolvido, e mais um de brinde.
    expect(saldoSemOIndice).toBe(antes + 2 * 8000);
    expect(saldoSemOIndice).toBe(30_000 + 8000);
    // E o rollback devolveu tudo: indice de pe, saldo intacto.
    expect(await saldo()).toBe(antes);

    // Com o indice de volta, a segunda devolucao e recusada.
    const dev = () =>
      semear.$executeRawUnsafe(
        `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,autor_id,acao_id,ocupacao_id,movimento_origem_id)
         VALUES (gen_random_uuid(),'${E}','${ALUNO}','devolucao',8000,'${UADMIN}','${ACAO}','${oc}','${consumo}')`,
      );
    await dev();
    await expect(dev()).rejects.toThrow(
      /ux_movimentos_devolucao_por_consumo|23505/,
    );
  });
});

// ---------------------------------------------------------------------------
describe('FIT-028 — criar × cancelar concorrentes: nenhum aborta com 40P01', () => {
  it('a segunda transação ESPERA na carteira, e as duas terminam', async () => {
    await levarSaldoA(30_000);
    const alvo = await ocupacaoAvulsa('2033-07-01');
    const consumo = await consumirEm(alvo, 8000);

    // Barreira: a criação para logo DEPOIS de travar a carteira, e o
    // cancelamento entra atrás dela.
    let liberar!: () => void;
    const liberado = new Promise<void>((r) => (liberar = r));
    let travou!: () => void;
    const jaTravou = new Promise<void>((r) => (travou = r));

    const original = dbEspiao.$transaction.bind(dbEspiao) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    const espiao = jest
      .spyOn(dbEspiao, '$transaction')
      .mockImplementation((fn: (tx: TxComRaw) => unknown, opcoes?: unknown) =>
        original(
          (tx: TxComRaw) => {
            const raw = tx.$queryRaw.bind(tx) as (
              ...a: unknown[]
            ) => Promise<unknown>;
            let pausou = false;
            tx.$queryRaw = async (...args: unknown[]): Promise<unknown> => {
              const linhas: unknown = await raw(...args);
              const p = args[0] as { raw?: string[] };
              const sql = Array.isArray(p?.raw)
                ? p.raw.join(' ')
                : String(args[0]);
              // Pela TABELA, nunca pela posição — foi assim que o FIT-024
              // quebrou quando a ordem de travas mudou.
              if (!pausou && sql.includes('saldo_creditos')) {
                pausou = true;
                travou();
                await liberado;
              }
              return linhas;
            };
            return fn(tx);
          },
          { maxWait: 60_000, timeout: 120_000, ...(opcoes ?? {}) },
        ),
      );

    try {
      const criacao = servicoEspiao
        .createBooking(E, pedido('2033-07-02'), UADMIN, undefined, 'aluno')
        .then(
          () => 'criou',
          (e: unknown) => `erro:${String(codigoDe(e) ?? e)}`,
        );

      await jaTravou;

      const cancelamento = servicoB
        .cancelBooking(E, alvo, UADMIN, 'company_admin')
        .then(
          () => 'cancelou',
          (e: unknown) => `erro:${String(codigoDe(e) ?? e)}`,
        );

      await esperarAte(
        esperandoACarteira,
        60_000,
        'o cancelamento esperar a carteira travada pela criação',
      );

      liberar();
      const [rc, rm] = await Promise.all([criacao, cancelamento]);

      // **A invariante:** nenhuma das duas morre por deadlock. As duas tocam
      // `alunos` e `ocupacoes_quadra`, e é a ORDEM comum (nível 2 antes de
      // nível 3) que faz a segunda esperar em vez de cruzar com a primeira.
      expect(rc).toBe('criou');
      expect(rm).toBe('cancelou');
      expect(String(rc) + String(rm)).not.toMatch(/40P01/);

      // E o dinheiro fecha: um consumo novo, uma devolução do antigo.
      expect(
        await contar(
          `SELECT count(*) AS n FROM movimentos_de_credito
            WHERE company_id='${E}' AND tipo='devolucao'
              AND movimento_origem_id='${consumo}'`,
        ),
      ).toBe(1);
    } finally {
      liberar();
      espiao.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
describe('FIT-029 — idempotência FINANCEIRA', () => {
  it('mesma Idempotency-Key duas vezes: um pedido, N ocupações, N consumos, UM débito', async () => {
    // A deduplicação de hoje (`pedidoJaAtendido`) protege a OCUPAÇÃO. Nada
    // garantia que o dinheiro estivesse dentro dela — e um consumo fora da
    // deduplicação debita duas vezes **sem duplicar reserva nenhuma**, que é
    // um defeito invisível na agenda e visível no extrato.
    await levarSaldoA(50_000);
    const antes = await saldo();
    const chave = 'idem-fit-029';
    const dto = {
      quadraId: QUADRA,
      data: '2033-08-01',
      // **Slots NÃO contíguos, de propósito.** `agruparEmBlocos` funde
      // 10–11 com 11–12 num bloco único de duas horas (SPEC-011) — o que é
      // certo para o produto e faria este teste medir UMA ocupação onde ele
      // quer medir a correspondência 1 consumo por ocupação (D4). A primeira
      // versão caiu exatamente aí.
      slots: [
        { horaInicio: '10:00', horaFim: '11:00' },
        { horaInicio: '14:00', horaFim: '15:00' },
      ],
      alunoId: ALUNO,
    } as never;

    await servicoA.createBooking(E, dto, UADMIN, chave, 'aluno');
    await servicoA.createBooking(E, dto, UADMIN, chave, 'aluno');

    const ocupacoes = await contar(
      `SELECT count(*) AS n FROM ocupacoes_quadra
        WHERE company_id='${E}' AND data='2033-08-01'`,
    );
    const consumos = await contar(
      `SELECT count(*) AS n FROM movimentos_de_credito m
        JOIN ocupacoes_quadra o ON o.id = m.ocupacao_id
       WHERE m.company_id='${E}' AND m.tipo='consumo' AND o.data='2033-08-01'`,
    );
    expect(ocupacoes).toBe(2);
    expect(consumos).toBe(2);
    // **Um débito total**, não dois: 2 × 8000.
    expect(await saldo()).toBe(antes - 16_000);
  });

  it('e concorrente: as duas chamadas juntas debitam UMA vez só', async () => {
    await levarSaldoA(50_000);
    const antes = await saldo();
    const chave = 'idem-fit-029-concorrente';
    const dto = {
      quadraId: QUADRA,
      data: '2033-08-05',
      slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
      alunoId: ALUNO,
    } as never;

    const resultados = await Promise.allSettled([
      servicoA.createBooking(E, dto, UADMIN, chave, 'aluno'),
      servicoB.createBooking(E, dto, UADMIN, chave, 'aluno'),
    ]);
    // **A garantia não é "as duas passam".** Quando a perdedora chega antes
    // de a vencedora commitar, a deduplicação não acha o pedido ainda e ela é
    // recusada — o cliente repete, e é assim que idempotência funciona sob
    // corrida. O que NÃO pode é o dinheiro sair duas vezes, e é isso que a
    // asserção abaixo mede. Medido: pelo menos uma passa.
    expect(
      resultados.filter((r) => r.status === 'fulfilled').length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      await contar(
        `SELECT count(*) AS n FROM movimentos_de_credito m
          JOIN ocupacoes_quadra o ON o.id = m.ocupacao_id
         WHERE m.company_id='${E}' AND m.tipo='consumo' AND o.data='2033-08-05'`,
      ),
    ).toBe(1);
    expect(await saldo()).toBe(antes - 8000);
  });
});

// ---------------------------------------------------------------------------
interface TxComRaw {
  $queryRaw: (...args: unknown[]) => Promise<unknown>;
}

async function ocupacaoAvulsa(data: string): Promise<string> {
  const [linha] = await semear.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO ocupacoes_quadra
       (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,aluno_id,valor)
     VALUES (gen_random_uuid(),'${E}','${QUADRA}','${data}','10:00','11:00','AVULSO',now(),'${ALUNO}',80)
     RETURNING id`,
  );
  return linha.id;
}

const consumoSql = (ocupacaoId: string) =>
  `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,autor_id,acao_id,ocupacao_id)
   VALUES (gen_random_uuid(),'${E}','${ALUNO}','consumo',8000,'${UADMIN}','${ACAO}','${ocupacaoId}')`;

async function consumirEm(
  ocupacaoId: string,
  centavos: number,
): Promise<string> {
  const [linha] = await semear.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,autor_id,acao_id,ocupacao_id)
     VALUES (gen_random_uuid(),'${E}','${ALUNO}','consumo',${centavos},'${UADMIN}','${ACAO}','${ocupacaoId}')
     RETURNING id`,
  );
  return linha.id;
}
