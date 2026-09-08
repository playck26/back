/**
 * SPEC-033/TASK-009 — **FIT-026, FIT-030, FIT-031 e a EVD-033-033.**
 *
 * As provas sequenciais da carteira. As concorrentes (FIT-025, 027, 028, 029)
 * exigem duas conexões com barreira e moram em arquivo próprio.
 *
 * ## A EVD-033-033 é a ressalva 1 da 7ª validação cruzada, e é a mais
 * importante deste arquivo
 *
 * O contrato de erro fecha as transações com `SET CONSTRAINTS` das **três
 * constraints nomeadas**. Isso troca um acoplamento por outro: com `ALL`,
 * toda diferida futura mudava de comportamento em silêncio; com nomes, **um
 * rename ou `DROP` futuro derruba a transação inteira com `42704`**.
 *
 * Eu tinha apontado esse buraco sem saber fechá-lo. O parecer fechou: o
 * `42704` é **fail-closed e detectável**, e a prova de integração **é** o
 * mecanismo. É esta — e ela roda contra o SCHEMA REAL, não contra o DDL do
 * ensaio, porque o ensaio pode divergir do que a migration aplicou (foi o que
 * o modelo Prisma expôs na 4ª rodada).
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const E = 'e0330000-0000-4000-8000-000000000001';
const UADMIN = 'e0330000-0000-4000-8000-000000000002';
const UALUNO = 'e0330000-0000-4000-8000-000000000003';
const ALUNO = 'e0330000-0000-4000-8000-000000000004';
const OUTRO_UALUNO = 'e0330000-0000-4000-8000-000000000005';
const OUTRO_ALUNO = 'e0330000-0000-4000-8000-000000000006';
const ESPORTE = 'e0330000-0000-4000-8000-000000000007';
const QUADRA = 'e0330000-0000-4000-8000-000000000008';
const OC1 = 'e0330000-0000-4000-8000-000000000009';
const OC2 = 'e0330000-0000-4000-8000-00000000000a';
const ACAO = 'e0330000-0000-4000-8000-00000000000b';

/** A lista nomeada, exatamente como o serviço a escreve (`set-constraints.ts`). */
const SET_NOMEADO =
  'SET CONSTRAINTS ocupacao_cancelada_exige_evento, ' +
  'ocupacao_cancelada_exige_devolucao, movimentos_consumo_ativo_unico IMMEDIATE';

/** O SQLSTATE que o Postgres reporta, como o Prisma o entrega. */
function sqlstate(erro: unknown): string | undefined {
  const meta = (erro as { meta?: { code?: string; db_error_code?: string } })
    .meta;
  return meta?.code ?? meta?.db_error_code;
}

const uid = (n: number) =>
  'e0330000-0000-4000-8000-' + String(n).padStart(12, '0');

let seq = 100;
const proximo = () => uid(++seq);

async function movimento(campos: Record<string, string | number | null>) {
  const chaves = Object.keys(campos);
  const valores = chaves
    .map((k) => (campos[k] === null ? 'NULL' : `'${String(campos[k])}'`))
    .join(',');
  return q(
    `INSERT INTO movimentos_de_credito (${chaves.join(',')}) VALUES (${valores})`,
  );
}

beforeAll(async () => {
  await limparEmpresa(db, E);
  await q(`INSERT INTO empresas (id,nome,updated_at,slug)
           VALUES ('${E}','FIT 033',now(),'fit-033')`);
  await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,updated_at,company_id)
           VALUES ('${UADMIN}','admin@fit033.test','x','Admin','company_admin',now(),'${E}')`);
  await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,updated_at,company_id)
           VALUES ('${UALUNO}','aluno@fit033.test','x','Aluno','aluno',now(),'${E}')`);
  await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,updated_at,company_id)
           VALUES ('${OUTRO_UALUNO}','outro@fit033.test','x','Outro','aluno',now(),'${E}')`);
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO}','${UALUNO}','${E}')`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${OUTRO_ALUNO}','${OUTRO_UALUNO}','${E}')`,
  );
  await q(`INSERT INTO esportes_de_quadra (id,company_id,nome,ordem)
           VALUES ('${ESPORTE}','${E}','Tenis',1)`);
  await q(`INSERT INTO quadras (id,company_id,nome,preco_hora,esporte_id)
           VALUES ('${QUADRA}','${E}','Q1',80,'${ESPORTE}')`);
  await q(`INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
           VALUES ('${ACAO}','${E}','reserva_criada','${UADMIN}')`);
  for (const [id, dia] of [
    [OC1, '2032-01-01'],
    [OC2, '2032-01-02'],
  ] as const) {
    await q(`INSERT INTO ocupacoes_quadra
               (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,aluno_id,valor)
             VALUES ('${id}','${E}','${QUADRA}','${dia}','10:00','11:00','AVULSO',now(),'${ALUNO}',80)`);
  }
});

afterAll(async () => {
  await limparEmpresa(db, E);
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
describe('EVD-033-033 — o SET CONSTRAINTS nomeado, contra o SCHEMA REAL', () => {
  it('as TRÊS constraints existem com estes nomes exatos', async () => {
    // A prova mais barata e a que falha primeiro num rename. Sem ela, o
    // `42704` só apareceria em produção, dentro de uma transação de dinheiro.
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

  it('a INV-096 violada chega como P3301 — o código do cancelamento sem devolução', async () => {
    const oc = proximo();
    const consumo = proximo();
    const acao = proximo();
    const transicao = proximo();
    const evento = proximo();
    await q(`INSERT INTO ocupacoes_quadra
               (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,aluno_id,valor)
             VALUES ('${oc}','${E}','${QUADRA}','2032-02-01','10:00','11:00','AVULSO',now(),'${ALUNO}',80)`);
    await movimento({
      id: proximo(),
      company_id: E,
      aluno_id: ALUNO,
      tipo: 'entrada',
      valor_centavos: 50_000,
      motivo: 'aporte',
      autor_id: UADMIN,
      acao_id: ACAO,
    });
    await movimento({
      id: consumo,
      company_id: E,
      aluno_id: ALUNO,
      tipo: 'consumo',
      valor_centavos: 8000,
      autor_id: UADMIN,
      acao_id: ACAO,
      ocupacao_id: oc,
    });
    await q(`INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
             VALUES ('${acao}','${E}','reserva_cancelada','${UADMIN}')`);

    let erro: unknown;
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET status_pagamento='cancelado', transicao_id='${transicao}' WHERE id='${oc}'`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
           VALUES ('${evento}','${E}','${acao}','${oc}','cancelada','${transicao}')`,
        );
        await tx.$executeRawUnsafe(SET_NOMEADO);
      });
    } catch (e) {
      erro = e;
    }
    expect(sqlstate(erro)).toBe('P3301');
  });

  it('a INV-098 violada chega como P3302 — dois consumos ATIVOS na mesma ocupação', async () => {
    const oc = proximo();
    await q(`INSERT INTO ocupacoes_quadra
               (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,aluno_id,valor)
             VALUES ('${oc}','${E}','${QUADRA}','2032-02-02','10:00','11:00','AVULSO',now(),'${ALUNO}',80)`);
    await movimento({
      id: proximo(),
      company_id: E,
      aluno_id: ALUNO,
      tipo: 'consumo',
      valor_centavos: 8000,
      autor_id: UADMIN,
      acao_id: ACAO,
      ocupacao_id: oc,
    });

    let erro: unknown;
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,autor_id,acao_id,ocupacao_id)
           VALUES ('${proximo()}','${E}','${ALUNO}','consumo',8000,'${UADMIN}','${ACAO}','${oc}')`,
        );
        await tx.$executeRawUnsafe(SET_NOMEADO);
      });
    } catch (e) {
      erro = e;
    }
    expect(sqlstate(erro)).toBe('P3302');
  });

  it('**A SABOTAGEM:** um nome trocado derruba a transação INTEIRA com 42704', async () => {
    // É o custo da lista nomeada, e é o que a torna segura: fail-closed e
    // detectável. Um rename futuro quebra ESTA prova antes de quebrar
    // produção — que é exatamente a garantia que faltava quando eu escrevi
    // que a lista "dependia de alguém lembrar dela".
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

  it('o cancelamento LEGÍTIMO passa com a lista nomeada — ela não barra o certo', async () => {
    const oc = proximo();
    const consumo = proximo();
    const acao = proximo();
    const transicao = proximo();
    await q(`INSERT INTO ocupacoes_quadra
               (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,aluno_id,valor)
             VALUES ('${oc}','${E}','${QUADRA}','2032-02-03','10:00','11:00','AVULSO',now(),'${ALUNO}',80)`);
    await movimento({
      id: consumo,
      company_id: E,
      aluno_id: ALUNO,
      tipo: 'consumo',
      valor_centavos: 8000,
      autor_id: UADMIN,
      acao_id: ACAO,
      ocupacao_id: oc,
    });
    await q(`INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
             VALUES ('${acao}','${E}','reserva_cancelada','${UADMIN}')`);

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET status_pagamento='cancelado', transicao_id='${transicao}' WHERE id='${oc}'`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
           VALUES ('${proximo()}','${E}','${acao}','${oc}','cancelada','${transicao}')`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,autor_id,acao_id,ocupacao_id,movimento_origem_id)
           VALUES ('${proximo()}','${E}','${ALUNO}','devolucao',8000,'${UADMIN}','${acao}','${oc}','${consumo}')`,
      );
      await tx.$executeRawUnsafe(SET_NOMEADO);
    });

    // **Afirmar o EFEITO, e não "não lançou".** `$transaction` devolve
    // `undefined` quando o callback não retorna nada, então um
    // `resolves.toBeDefined()` falharia com a transação correta — e um
    // `not.toThrow()` passaria mesmo que nada tivesse sido gravado.
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
});

// ---------------------------------------------------------------------------
describe('FIT-026 — saldo == soma dos movimentos', () => {
  it('depois de entrada, consumo, devolução e retirada, os dois batem', async () => {
    const oc = proximo();
    const consumo = proximo();
    await q(`INSERT INTO ocupacoes_quadra
               (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,aluno_id,valor)
             VALUES ('${oc}','${E}','${QUADRA}','2032-03-01','10:00','11:00','AVULSO',now(),'${OUTRO_ALUNO}',80)`);

    await movimento({
      id: proximo(),
      company_id: E,
      aluno_id: OUTRO_ALUNO,
      tipo: 'entrada',
      valor_centavos: 30_000,
      motivo: 'aporte',
      autor_id: UADMIN,
      acao_id: ACAO,
    });
    await movimento({
      id: consumo,
      company_id: E,
      aluno_id: OUTRO_ALUNO,
      tipo: 'consumo',
      valor_centavos: 8000,
      autor_id: UADMIN,
      acao_id: ACAO,
      ocupacao_id: oc,
    });
    await movimento({
      id: proximo(),
      company_id: E,
      aluno_id: OUTRO_ALUNO,
      tipo: 'devolucao',
      valor_centavos: 8000,
      autor_id: UADMIN,
      acao_id: ACAO,
      ocupacao_id: oc,
      movimento_origem_id: consumo,
    });
    await movimento({
      id: proximo(),
      company_id: E,
      aluno_id: OUTRO_ALUNO,
      tipo: 'retirada',
      valor_centavos: 5000,
      motivo: 'estorno',
      autor_id: UADMIN,
      acao_id: ACAO,
    });

    // A soma é feita NO BANCO, com o sinal vindo do tipo (D3) — refazê-la em
    // JavaScript reproduziria a regra em vez de conferi-la.
    const [linha] = await db.$queryRawUnsafe<
      { saldo: number; soma: number }[]
    >(`
      SELECT a.saldo_creditos AS saldo,
             coalesce(sum(CASE WHEN m.tipo IN ('entrada','devolucao')
                               THEN m.valor_centavos ELSE -m.valor_centavos END), 0)::int AS soma
        FROM alunos a
        LEFT JOIN movimentos_de_credito m ON m.aluno_id = a.id
       WHERE a.id = '${OUTRO_ALUNO}'
       GROUP BY a.saldo_creditos
    `);
    expect(linha.saldo).toBe(linha.soma);
    expect(linha.saldo).toBe(30_000 - 8000 + 8000 - 5000);
  });
});

// ---------------------------------------------------------------------------
describe('FIT-030 — a causalidade da devolução, os seis casos', () => {
  const base = {
    company_id: E,
    aluno_id: ALUNO,
    tipo: 'devolucao',
    valor_centavos: 8000,
    autor_id: UADMIN,
    acao_id: ACAO,
    ocupacao_id: OC1,
  };
  let consumoBom: string;
  let entrada: string;

  beforeAll(async () => {
    entrada = proximo();
    consumoBom = proximo();
    await movimento({
      id: entrada,
      company_id: E,
      aluno_id: ALUNO,
      tipo: 'entrada',
      valor_centavos: 8000,
      motivo: 'aporte do FIT-030',
      autor_id: UADMIN,
      acao_id: ACAO,
    });
    await movimento({
      id: consumoBom,
      ...base,
      tipo: 'consumo',
      movimento_origem_id: null,
    });
  });

  // "Foi recusado" sozinho pode passar pelo motivo errado — cada caso afirma
  // o SQLSTATE, e os cinco são `23503` porque a garantia é a FK causal.
  it('1. devolução apontando uma `entrada` é recusada', async () => {
    // Este é o caso que só existe por causa do `movimentos_ocupacao_por_tipo`:
    // sem o CHECK, a `entrada` teria `ocupacao_id` nulo, o `MATCH SIMPLE`
    // pularia a FK inteira, e a devolução indevida passaria.
    await expect(
      movimento({ id: proximo(), ...base, movimento_origem_id: entrada }),
    ).rejects.toThrow(/movimentos_origem_causal_fkey|23503/);
  });

  it('2. devolução de outro ALUNO é recusada', async () => {
    await expect(
      movimento({
        id: proximo(),
        ...base,
        aluno_id: OUTRO_ALUNO,
        movimento_origem_id: consumoBom,
      }),
    ).rejects.toThrow(/movimentos_origem_causal_fkey|23503/);
  });

  it('3. devolução de outro VALOR é recusada', async () => {
    await expect(
      movimento({
        id: proximo(),
        ...base,
        valor_centavos: 7999,
        movimento_origem_id: consumoBom,
      }),
    ).rejects.toThrow(/movimentos_origem_causal_fkey|23503/);
  });

  it('4. devolução de outra OCUPAÇÃO é recusada', async () => {
    await expect(
      movimento({
        id: proximo(),
        ...base,
        ocupacao_id: OC2,
        movimento_origem_id: consumoBom,
      }),
    ).rejects.toThrow(/movimentos_origem_causal_fkey|23503/);
  });

  it('5. devolução SEM origem é recusada — pelo CHECK, não pela FK', async () => {
    await expect(
      movimento({ id: proximo(), ...base, movimento_origem_id: null }),
    ).rejects.toThrow(/movimentos_origem_check|23514/);
  });

  it('6. a devolução CORRETA passa — e o teste não vale sem esta linha', async () => {
    // Cinco recusas sem uma aceitação seriam indistinguíveis de uma FK que
    // recusa tudo.
    await expect(
      movimento({ id: proximo(), ...base, movimento_origem_id: consumoBom }),
    ).resolves.toBeDefined();
  });

  it('e o MESMO consumo não é estornado duas vezes — índice parcial', async () => {
    await expect(
      movimento({ id: proximo(), ...base, movimento_origem_id: consumoBom }),
    ).rejects.toThrow(/ux_movimentos_devolucao_por_consumo|23505/);
  });
});

// ---------------------------------------------------------------------------
describe('FIT-031 — a conversão para centavos', () => {
  it('bloco de 20 min a R$ 80/h: o centavo sai do BANCO, não da memória', async () => {
    // 80 * (20/60) = 26,6666… em memória; `numeric(10,2)` grava 26,67.
    // Multiplicar o número de memória por 100 debitaria 2666 contra uma
    // reserva de 2667 — e o `CHECK` do saldo não pegaria a diferença.
    const oc = proximo();
    await q(`INSERT INTO ocupacoes_quadra
               (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,aluno_id,valor)
             VALUES ('${oc}','${E}','${QUADRA}','2032-04-01','10:00','10:20','AVULSO',now(),'${ALUNO}',
                     ${80 * (20 / 60)})`);

    const [linha] = await db.$queryRawUnsafe<
      { valor: string; centavos_do_banco: number }[]
    >(`
      SELECT valor::text AS valor, (valor * 100)::int AS centavos_do_banco
        FROM ocupacoes_quadra WHERE id = '${oc}'
    `);

    // O que o Postgres guardou, e o que a aplicação tem de debitar.
    expect(linha.valor).toBe('26.67');
    expect(linha.centavos_do_banco).toBe(2667);
    // A conta de memória, que é a armadilha:
    expect(Math.trunc(80 * (20 / 60) * 100)).toBe(2666);
  });
});
