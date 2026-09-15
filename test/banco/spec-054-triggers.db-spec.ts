/**
 * SPEC-054/TASK-002 — **as sete triggers, contra Postgres real, sem o serviço.**
 *
 * O que se julga aqui é o BANCO: se um caminho novo do `back` — ou um erro de
 * cálculo — tentar vender unidade que o clube não tem, anexar item a reserva já
 * confirmada, mudar o item ou o valor depois, a recusa vem da trigger, e não de
 * um `if` que o próximo caminho esquece. O serviço (TASK-004) é provado à parte.
 *
 * ## Como cada recusa é observada
 *
 * Por SQL cru, que chega como `P2010` com `meta.code` (fato 8), lido por
 * `sqlstateDoErro` — o mesmo leitor da Entrega A.
 *
 * ## Transações desfeitas de propósito
 *
 * Cancelar e reativar ocupação exigem evento e devolução, julgados por
 * constraint triggers DIFERIDAS (SPEC-032/INV-064, SPEC-033/INV-096) — só no
 * `COMMIT`. Os casos que passam por `cancelado` rodam numa transação que termina
 * em `ROLLBACK` (`Desfaz`): a trigger desta spec dispara na própria instrução,
 * antes de qualquer `COMMIT`, e é isso que se afirma.
 */
import { PrismaClient } from '@prisma/client';
import { sqlstateDoErro } from '../../src/courts/recusas-de-estoque';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
type Tx = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;

const EMPRESA = 'e0540000-0000-4000-8000-0000000000b1';
const UALUNO = 'e0540000-0000-4000-8000-0000000000b2';
const ALUNO = 'e0540000-0000-4000-8000-0000000000b3';
const Q1 = 'e0540000-0000-4000-8000-0000000000b4';
const Q2 = 'e0540000-0000-4000-8000-0000000000b5';
const Q3 = 'e0540000-0000-4000-8000-0000000000ba';
const TURMA = 'e0540000-0000-4000-8000-0000000000b6';
const TIPO = 'e0540000-0000-4000-8000-0000000000b7';
/** Raquete: estoque 2, R$ 15. */
const RAQUETE = 'e0540000-0000-4000-8000-0000000000b8';
const INATIVO = 'e0540000-0000-4000-8000-0000000000b9';

const DATA = '2035-06-07';

/** Sai de dentro de um `$transaction` forçando o `ROLLBACK`. */
class Desfaz extends Error {}

async function semear() {
  await limparEmpresa(db, EMPRESA);
  const q = (sql: string) => db.$executeRawUnsafe(sql);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube 054 triggers','clube-054-triggers',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UALUNO}','054t-aluno@t.local','x','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA}')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  for (const [id, nome] of [
    [Q1, 'Q1'],
    [Q2, 'Q2'],
    [Q3, 'Q3'],
  ] as const) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora)
       VALUES ('${id}','${EMPRESA}','${nome}',
               (SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),100)`,
    );
  }
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade)
     VALUES ('${TURMA}','${EMPRESA}','T1','${Q1}',10)`,
  );
  await q(
    `INSERT INTO tipos_de_adicional (id,company_id,nome) VALUES ('${TIPO}','${EMPRESA}','Raquetes')`,
  );
  await q(
    `INSERT INTO adicionais (id,company_id,tipo_id,nome,preco,estoque,updated_at)
     VALUES ('${RAQUETE}','${EMPRESA}','${TIPO}','Raquete',15,2,now())`,
  );
  await q(
    `INSERT INTO adicionais (id,company_id,tipo_id,nome,preco,estoque,ativo,updated_at)
     VALUES ('${INATIVO}','${EMPRESA}','${TIPO}','Bola velha',5,10,false,now())`,
  );
}

beforeEach(semear);

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

interface Reserva {
  quadra?: string;
  inicio: string;
  fim: string;
  valor?: number;
  itens?: { adicional: string; quantidade: number; valorUnitario?: number }[];
}

/** Ocupação avulsa + itens, **na transação dada**. Devolve o id da ocupação. */
async function reservar(tx: Tx, r: Reserva): Promise<string> {
  const [{ id }] = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${r.quadra ?? Q1}','${DATA}','${r.inicio}','${r.fim}','AVULSO','${ALUNO}',${r.valor ?? 1000},now())
     RETURNING id::text AS id`,
  );
  for (const item of r.itens ?? []) {
    await tx.$executeRawUnsafe(
      `INSERT INTO adicionais_da_ocupacao (id,company_id,ocupacao_id,adicional_id,quantidade,valor_unitario)
       VALUES (gen_random_uuid(),'${EMPRESA}','${id}','${item.adicional}',${item.quantidade},${item.valorUnitario ?? 15})`,
    );
  }
  return id;
}

/** Reserva numa transação própria, confirmada. */
function reservarConfirmada(r: Reserva): Promise<string> {
  return db.$transaction((tx) => reservar(tx, r));
}

/** O SQLSTATE da recusa — e FALHA se não houve recusa. */
async function sqlstate(promessa: Promise<unknown>): Promise<string> {
  try {
    await promessa;
  } catch (erro) {
    return sqlstateDoErro(erro) ?? `sem SQLSTATE: ${String(erro)}`;
  }
  throw new Error('esperava recusa do banco, e a instrução passou');
}

/**
 * Roda `corpo` numa transação e a desfaz. Devolve o SQLSTATE que o corpo
 * capturou — ou `'ok'`.
 */
async function numaTransacaoDesfeita(
  corpo: (tx: Tx) => Promise<string>,
): Promise<string> {
  let resultado = 'nao-rodou';
  await db
    .$transaction(
      async (tx) => {
        resultado = await corpo(tx);
        throw new Desfaz();
      },
      { timeout: 30_000 },
    )
    .catch((e: unknown) => {
      if (!(e instanceof Desfaz)) throw e;
    });
  return resultado;
}

async function tentar(tx: Tx, sql: string): Promise<string> {
  try {
    await tx.$executeRawUnsafe(sql);
    return 'ok';
  } catch (erro) {
    return sqlstateDoErro(erro) ?? `sem SQLSTATE: ${String(erro)}`;
  }
}

describe('SPEC-054/D3 — estoque na INSERÇÃO do item (INV-133)', () => {
  it('AC-014: sobreposição parcial com o estoque tomado → P3303; horário vizinho, sem sobrepor → passa', async () => {
    await reservarConfirmada({
      inicio: '09:00',
      fim: '10:00',
      itens: [{ adicional: RAQUETE, quantidade: 2 }],
    });

    expect(
      await sqlstate(
        reservarConfirmada({
          quadra: Q2,
          inicio: '09:30',
          fim: '10:30',
          itens: [{ adicional: RAQUETE, quantidade: 1 }],
        }),
      ),
    ).toBe('P3303');

    // `tsrange` é `[)`: terminar às 10h e começar às 10h não é sobreposição.
    await expect(
      reservarConfirmada({
        inicio: '10:00',
        fim: '11:00',
        itens: [{ adicional: RAQUETE, quantidade: 2 }],
      }),
    ).resolves.toEqual(expect.any(String));
  });

  it('AC-015: o estoque é do CLUBE — quadras diferentes no mesmo horário disputam as mesmas unidades', async () => {
    await reservarConfirmada({
      quadra: Q1,
      inicio: '09:00',
      fim: '10:00',
      itens: [{ adicional: RAQUETE, quantidade: 1 }],
    });
    await reservarConfirmada({
      quadra: Q2,
      inicio: '09:00',
      fim: '10:00',
      itens: [{ adicional: RAQUETE, quantidade: 1 }],
    });
    expect(
      await sqlstate(
        // Numa TERCEIRA quadra: na Q1 ou na Q2 a `EXCLUDE` da quadra (`23P01`)
        // recusaria antes do estoque, e o teste provaria outra coisa.
        reservarConfirmada({
          quadra: Q3,
          inicio: '09:00',
          fim: '10:00',
          itens: [{ adicional: RAQUETE, quantidade: 1 }],
        }),
      ),
    ).toBe('P3303');
  });

  it('AC-016 (banco): ocupação CANCELADA não conta — a unidade dela volta', async () => {
    const resultado = await numaTransacaoDesfeita(async (tx) => {
      const primeira = await reservar(tx, {
        inicio: '09:00',
        fim: '10:00',
        itens: [{ adicional: RAQUETE, quantidade: 2 }],
      });
      await tx.$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET status_pagamento = 'cancelado' WHERE id = '${primeira}'`,
      );
      try {
        await reservar(tx, {
          quadra: Q2,
          inicio: '09:00',
          fim: '10:00',
          itens: [{ adicional: RAQUETE, quantidade: 2 }],
        });
        return 'ok';
      } catch (erro) {
        return sqlstateDoErro(erro) ?? String(erro);
      }
    });
    expect(resultado).toBe('ok');
  });

  it('adicional inativo → P3304', async () => {
    expect(
      await sqlstate(
        reservarConfirmada({
          inicio: '09:00',
          fim: '10:00',
          itens: [{ adicional: INATIVO, quantidade: 1, valorUnitario: 5 }],
        }),
      ),
    ).toBe('P3304');
  });

  it('a mensagem nomeia o adicional — é dela que a Entrega A tira o `adicionalId`', async () => {
    await reservarConfirmada({
      inicio: '09:00',
      fim: '10:00',
      itens: [{ adicional: RAQUETE, quantidade: 2 }],
    });
    let mensagem = '';
    try {
      await reservarConfirmada({
        quadra: Q2,
        inicio: '09:00',
        fim: '10:00',
        itens: [{ adicional: RAQUETE, quantidade: 1 }],
      });
    } catch (e) {
      mensagem = (e as Error).message;
    }
    expect(mensagem).toContain(`adicional=${RAQUETE}`);
  });
});

describe('SPEC-054/D3 — estoque no MOVIMENTO e na saída de `cancelado`', () => {
  it('AC-019 (banco): mudar o intervalo para onde não há unidade → P3303; para onde há → passa', async () => {
    await reservarConfirmada({
      inicio: '09:00',
      fim: '10:00',
      itens: [{ adicional: RAQUETE, quantidade: 2 }],
    });
    const movida = await reservarConfirmada({
      quadra: Q2,
      inicio: '11:00',
      fim: '12:00',
      itens: [{ adicional: RAQUETE, quantidade: 1 }],
    });

    expect(
      await sqlstate(
        db.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET hora_inicio = '09:30', hora_fim = '10:30' WHERE id = '${movida}'`,
        ),
      ),
    ).toBe('P3303');
    await expect(
      db.$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET hora_inicio = '13:00', hora_fim = '14:00' WHERE id = '${movida}'`,
      ),
    ).resolves.toBe(1);
  });

  it('a própria ocupação não disputa consigo: mover sobre o intervalo antigo passa', async () => {
    const id = await reservarConfirmada({
      inicio: '09:00',
      fim: '10:00',
      itens: [{ adicional: RAQUETE, quantidade: 2 }],
    });
    await expect(
      db.$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET hora_inicio = '09:30', hora_fim = '10:30' WHERE id = '${id}'`,
      ),
    ).resolves.toBe(1);
  });

  it('trocar só a quadra não reconfere (o estoque é do clube, e o intervalo não mudou)', async () => {
    // Estoque zerado DEPOIS da reserva (D13): qualquer reconferência recusaria.
    const id = await reservarConfirmada({
      inicio: '09:00',
      fim: '10:00',
      itens: [{ adicional: RAQUETE, quantidade: 2 }],
    });
    await db.$executeRawUnsafe(
      `UPDATE adicionais SET estoque = 0 WHERE id = '${RAQUETE}'`,
    );
    await expect(
      db.$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET quadra_id = '${Q2}' WHERE id = '${id}'`,
      ),
    ).resolves.toBe(1);
  });

  it('sair de `cancelado` quando outra reserva tomou as unidades → P3303', async () => {
    const resultado = await numaTransacaoDesfeita(async (tx) => {
      const antiga = await reservar(tx, {
        inicio: '15:00',
        fim: '16:00',
        itens: [{ adicional: RAQUETE, quantidade: 2 }],
      });
      await tx.$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET status_pagamento = 'cancelado' WHERE id = '${antiga}'`,
      );
      await reservar(tx, {
        quadra: Q2,
        inicio: '15:00',
        fim: '16:00',
        itens: [{ adicional: RAQUETE, quantidade: 2 }],
      });
      return tentar(
        tx,
        `UPDATE ocupacoes_quadra SET status_pagamento = 'pendente_pagamento' WHERE id = '${antiga}'`,
      );
    });
    expect(resultado).toBe('P3303');
  });
});

describe('SPEC-054/D5 — o item nasce na transação da reserva, e não muda (INV-134)', () => {
  it('AC-024: item numa ocupação JÁ CONFIRMADA → 23514', async () => {
    const id = await reservarConfirmada({ inicio: '09:00', fim: '10:00' });
    expect(
      await sqlstate(
        db.$executeRawUnsafe(
          `INSERT INTO adicionais_da_ocupacao (id,company_id,ocupacao_id,adicional_id,quantidade,valor_unitario)
           VALUES (gen_random_uuid(),'${EMPRESA}','${id}','${RAQUETE}',1,15)`,
        ),
      ),
    ).toBe('23514');
  });

  it('AC-024: item numa ocupação ANTERIOR à migration (marcador nulo) → 23514', async () => {
    // A única forma de ter marcador nulo depois da migration é a que as linhas
    // antigas tiveram: sem a trigger e sem o default. DDL transacional, desfeita
    // no mesmo `$transaction` — a suíte roda em série (`--runInBand`).
    const id = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `ALTER TABLE ocupacoes_quadra DISABLE TRIGGER ocupacao_marca_transacao_de_criacao`,
      );
      const [{ id: nova }] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,transacao_de_criacao,updated_at)
         VALUES (gen_random_uuid(),'${EMPRESA}','${Q1}','${DATA}','09:00','10:00','AVULSO','${ALUNO}',1000,NULL,now())
         RETURNING id::text AS id`,
      );
      await tx.$executeRawUnsafe(
        `ALTER TABLE ocupacoes_quadra ENABLE TRIGGER ocupacao_marca_transacao_de_criacao`,
      );
      return nova;
    });
    const [linha] = await db.$queryRawUnsafe<{ marcador: string | null }[]>(
      `SELECT transacao_de_criacao::text AS marcador FROM ocupacoes_quadra WHERE id = '${id}'`,
    );
    expect(linha.marcador).toBeNull();

    expect(
      await sqlstate(
        db.$executeRawUnsafe(
          `INSERT INTO adicionais_da_ocupacao (id,company_id,ocupacao_id,adicional_id,quantidade,valor_unitario)
           VALUES (gen_random_uuid(),'${EMPRESA}','${id}','${RAQUETE}',1,15)`,
        ),
      ),
    ).toBe('23514');
  });

  it('AC-037: marcador FORJADO no INSERT é ignorado — o banco grava a transação real, e o item de outra transação é recusado', async () => {
    let forjado = '';
    let gravado: string | null = null;
    let desfecho = '';
    await db
      .$transaction(
        async (tx2) => {
          // A transação que vai TENTAR anexar o item pega o seu id primeiro.
          const [{ x }] = await tx2.$queryRawUnsafe<{ x: string }[]>(
            `SELECT txid_current()::text AS x`,
          );
          forjado = x;
          // Outra conexão cria a ocupação dizendo que nasceu na transação de tx2.
          const id = await db.$transaction(async (tx1) => {
            const [{ id: nova }] = await tx1.$queryRawUnsafe<{ id: string }[]>(
              `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,transacao_de_criacao,updated_at)
             VALUES (gen_random_uuid(),'${EMPRESA}','${Q1}','${DATA}','09:00','10:00','AVULSO','${ALUNO}',1000,${x},now())
             RETURNING id::text AS id`,
            );
            return nova;
          });
          const [linha] = await tx2.$queryRawUnsafe<{ m: string }[]>(
            `SELECT transacao_de_criacao::text AS m FROM ocupacoes_quadra WHERE id = '${id}'`,
          );
          gravado = linha.m;
          desfecho = await tentar(
            tx2,
            `INSERT INTO adicionais_da_ocupacao (id,company_id,ocupacao_id,adicional_id,quantidade,valor_unitario)
           VALUES (gen_random_uuid(),'${EMPRESA}','${id}','${RAQUETE}',1,15)`,
          );
          throw new Desfaz();
        },
        { timeout: 30_000 },
      )
      .catch((e: unknown) => {
        if (!(e instanceof Desfaz)) throw e;
      });

    expect(gravado).not.toBe(forjado);
    expect(desfecho).toBe('23514');
  });

  it('o marcador não muda depois de gravado → 23514', async () => {
    const id = await reservarConfirmada({ inicio: '09:00', fim: '10:00' });
    expect(
      await sqlstate(
        db.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET transacao_de_criacao = 1 WHERE id = '${id}'`,
        ),
      ),
    ).toBe('23514');
  });

  it('AC-025: UPDATE e DELETE de item → 23514', async () => {
    const id = await reservarConfirmada({
      inicio: '09:00',
      fim: '10:00',
      itens: [{ adicional: RAQUETE, quantidade: 1 }],
    });
    expect(
      await sqlstate(
        db.$executeRawUnsafe(
          `UPDATE adicionais_da_ocupacao SET quantidade = 2 WHERE ocupacao_id = '${id}'`,
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlstate(
        db.$executeRawUnsafe(
          `DELETE FROM adicionais_da_ocupacao WHERE ocupacao_id = '${id}'`,
        ),
      ),
    ).toBe('23514');
  });
});

describe('SPEC-054/D6 — a soma cabe no valor, e o valor não muda (INV-135)', () => {
  it('AC-026: valor de ocupação COM item não muda → 23514; SEM item, muda', async () => {
    const com = await reservarConfirmada({
      inicio: '09:00',
      fim: '10:00',
      itens: [{ adicional: RAQUETE, quantidade: 1 }],
    });
    const sem = await reservarConfirmada({ inicio: '11:00', fim: '12:00' });
    expect(
      await sqlstate(
        db.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET valor = 1 WHERE id = '${com}'`,
        ),
      ),
    ).toBe('23514');
    await expect(
      db.$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET valor = 1 WHERE id = '${sem}'`,
      ),
    ).resolves.toBe(1);
  });

  it('AC-027: itens que passam do valor da reserva → 23514', async () => {
    expect(
      await sqlstate(
        reservarConfirmada({
          inicio: '09:00',
          fim: '10:00',
          valor: 20,
          itens: [{ adicional: RAQUETE, quantidade: 2 }],
        }),
      ),
    ).toBe('23514');
  });
});

describe('SPEC-054/INV-132 — só reserva avulsa', () => {
  it('AC-028: item em ocupação de TURMA → 23503', async () => {
    const desfecho = await numaTransacaoDesfeita(async (tx) => {
      const [{ id }] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,updated_at)
         VALUES (gen_random_uuid(),'${EMPRESA}','${Q1}','${DATA}','18:00','19:00','TURMA','${TURMA}',now())
         RETURNING id::text AS id`,
      );
      return tentar(
        tx,
        `INSERT INTO adicionais_da_ocupacao (id,company_id,ocupacao_id,adicional_id,quantidade,valor_unitario)
         VALUES (gen_random_uuid(),'${EMPRESA}','${id}','${RAQUETE}',1,15)`,
      );
    });
    expect(desfecho).toBe('23503');
  });
});
