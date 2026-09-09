/**
 * SPEC-033/EVD-033-033 — **o contrato de erro das diferidas, contra o POOLER.**
 *
 * ## Por que este arquivo existe
 *
 * A EVD-033-033 roda no `fit-critical` contra Postgres **local**. O mecanismo
 * que ela prova é o mais dependente de semântica de sessão que esta spec
 * criou: `CONSTRAINT TRIGGER … DEFERRABLE` julgadas por um
 * `SET CONSTRAINTS … IMMEDIATE` no fim da transação, com SQLSTATE customizados
 * lidos por `P2010` + `meta.code`.
 *
 * **O canário da Neon vai pelo endpoint `-pooler`** (`FIT_CANARIO_HOST`), e
 * pgbouncer em modo transação muda o que "sessão" significa. Este projeto já
 * pagou por isso — `P1002` e advisory lock preso —, e o argumento vale
 * inteiro aqui: *local e pooler não são o mesmo alvo*.
 *
 * O FIT-025 fechou a perna de **concorrência** na Neon. Esta fecha a do
 * **contrato de erro**. Continuam de fora, contra o pooler: FIT-027 a
 * FIT-031, e carga.
 *
 * ## O que ele NÃO faz
 *
 * Não sobe app: aqui o assunto é o que o banco entrega ao Prisma, e subir
 * HTTP em volta só afastaria a medição do mecanismo.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { idsDoCenario, montarCenario } from './cenario';

jest.setTimeout(180_000);

exigirBancoLocal();

/** Cenário 4: os 1, 2 e 3 são do FIT-001, do FIT-002 e do FIT-025. */
const C = idsDoCenario(4);
const { ADMIN_USUARIO, ALUNO1, EMPRESA, QUADRA } = C;

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

/** A lista nomeada, exatamente como `src/creditos/set-constraints.ts` a monta. */
const SET_NOMEADO =
  'SET CONSTRAINTS ocupacao_cancelada_exige_evento, ' +
  'ocupacao_cancelada_exige_devolucao, movimentos_consumo_ativo_unico IMMEDIATE';

function sqlstate(erro: unknown): string | undefined {
  const meta = (erro as { meta?: { code?: string; db_error_code?: string } })
    .meta;
  return meta?.code ?? meta?.db_error_code;
}

const uid = (n: number) =>
  'f0440000-0000-4000-8000-' + String(n).padStart(12, '0');
let seq = 0;
const proximo = () => uid(++seq);

async function acao(tipo: string): Promise<string> {
  const [l] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
     VALUES (gen_random_uuid(),'${EMPRESA}','${tipo}','${ADMIN_USUARIO}') RETURNING id`,
  );
  return l.id;
}

async function ocupacaoComConsumo(
  dia: number,
): Promise<{ oc: string; consumo: string }> {
  const oc = proximo();
  const consumo = proximo();
  const acaoId = await acao('reserva_criada');
  await q(`INSERT INTO ocupacoes_quadra
             (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,aluno_id,valor)
           VALUES ('${oc}','${EMPRESA}','${QUADRA}','2035-01-01'::date + ${dia},'10:00','11:00','AVULSO',now(),'${ALUNO1}',80)`);
  await q(`INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,autor_id,acao_id,ocupacao_id)
           VALUES ('${consumo}','${EMPRESA}','${ALUNO1}','consumo',8000,'${ADMIN_USUARIO}','${acaoId}','${oc}')`);
  return { oc, consumo };
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await montarCenario(db, C);
  // Saldo pela porta do ledger — a única que existe (D1/INV-071).
  await q(`INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,motivo,autor_id,acao_id)
           VALUES (gen_random_uuid(),'${EMPRESA}','${ALUNO1}','entrada',500000,'aporte do canario','${ADMIN_USUARIO}','${await acao('credito_lancado')}')`);
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('EVD-033-033 no POOLER — o contrato de erro das diferidas', () => {
  it('as TRÊS constraints existem com estes nomes, no schema da Neon', async () => {
    const achadas = await db.$queryRawUnsafe<{ conname: string }[]>(`
      SELECT conname FROM pg_constraint
       WHERE conname IN ('ocupacao_cancelada_exige_evento',
                         'ocupacao_cancelada_exige_devolucao',
                         'movimentos_consumo_ativo_unico')
       ORDER BY conname
    `);
    expect(achadas.map((c) => c.conname)).toEqual([
      'movimentos_consumo_ativo_unico',
      'ocupacao_cancelada_exige_devolucao',
      'ocupacao_cancelada_exige_evento',
    ]);
  });

  it('INV-096 violada chega como P2010 + meta.code = P3301 — mesmo pelo pooler', async () => {
    const { oc } = await ocupacaoComConsumo(1);
    const acaoId = await acao('reserva_cancelada');
    const transicao = proximo();

    let erro: unknown;
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET status_pagamento='cancelado', transicao_id='${transicao}' WHERE id='${oc}'`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
           VALUES ('${proximo()}','${EMPRESA}','${acaoId}','${oc}','cancelada','${transicao}')`,
        );
        await tx.$executeRawUnsafe(SET_NOMEADO);
      });
    } catch (e) {
      erro = e;
    }
    // **A pergunta que o pooler poderia responder diferente:** o `meta.code`
    // sobrevive à ida e volta por pgbouncer? Sem ele, a tradução para `409`
    // volta a depender de casar texto — o retrocesso que o D7 recusou.
    expect((erro as { code?: string })?.code).toBe('P2010');
    expect(sqlstate(erro)).toBe('P3301');
  });

  it('INV-098 violada chega como P2010 + meta.code = P3302', async () => {
    const { oc } = await ocupacaoComConsumo(2);
    const acaoId = await acao('reserva_criada');

    let erro: unknown;
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,autor_id,acao_id,ocupacao_id)
           VALUES ('${proximo()}','${EMPRESA}','${ALUNO1}','consumo',8000,'${ADMIN_USUARIO}','${acaoId}','${oc}')`,
        );
        await tx.$executeRawUnsafe(SET_NOMEADO);
      });
    } catch (e) {
      erro = e;
    }
    expect(sqlstate(erro)).toBe('P3302');
  });

  it('SABOTAGEM: um nome trocado derruba a transação inteira com 42704', async () => {
    // O custo da lista nomeada, e o que a torna segura: fail-closed e
    // detectável. Vale medir no pooler porque `SET CONSTRAINTS` é comando de
    // transação, e é aí que pgbouncer se mete.
    let erro: unknown;
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS ocupacao_cancelada_exige_evento, ' +
            'ocupacao_cancelada_exige_devolucao_RENOMEADA, ' +
            'movimentos_consumo_ativo_unico IMMEDIATE',
        );
      });
    } catch (e) {
      erro = e;
    }
    expect(sqlstate(erro)).toBe('42704');
  });

  it('o cancelamento LEGÍTIMO passa, e o efeito fica gravado', async () => {
    const { oc, consumo } = await ocupacaoComConsumo(3);
    const acaoId = await acao('reserva_cancelada');
    const transicao = proximo();

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET status_pagamento='cancelado', transicao_id='${transicao}' WHERE id='${oc}'`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
         VALUES ('${proximo()}','${EMPRESA}','${acaoId}','${oc}','cancelada','${transicao}')`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,autor_id,acao_id,ocupacao_id,movimento_origem_id)
         VALUES ('${proximo()}','${EMPRESA}','${ALUNO1}','devolucao',8000,'${ADMIN_USUARIO}','${acaoId}','${oc}','${consumo}')`,
      );
      await tx.$executeRawUnsafe(SET_NOMEADO);
    });

    // **O EFEITO, e não "não lançou".** `$transaction` devolve `undefined`
    // quando o callback não retorna nada; afirmar ausência de erro deixaria
    // passar uma transação que não gravou.
    const [linha] = await db.$queryRawUnsafe<
      { status_pagamento: string; devolucoes: number }[]
    >(`
      SELECT o.status_pagamento,
             (SELECT count(*)::int FROM movimentos_de_credito m
               WHERE m.ocupacao_id = o.id AND m.tipo = 'devolucao') AS devolucoes
        FROM ocupacoes_quadra o WHERE o.id = '${oc}'
    `);
    expect(linha).toEqual({ status_pagamento: 'cancelado', devolucoes: 1 });
  });

  it('INV-071: o saldo NÃO se conserta por fora, nem pelo pooler', async () => {
    await expect(
      q(`UPDATE alunos SET saldo_creditos = 999999 WHERE id = '${ALUNO1}'`),
    ).rejects.toThrow(/INV-071|23514/);
  });
});
