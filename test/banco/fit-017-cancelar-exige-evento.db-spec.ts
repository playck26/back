/**
 * **FIT-017 — cancelar exige evento DESTA transição (INV-064).**
 *
 * SPEC-032, fase **contract**. Este arquivo prova a única parte da spec que
 * **muda comportamento existente**, e por isso ele viaja junto com a
 * migration `..._spec032_rastreabilidade_contract` — nunca antes.
 *
 * ## A armadilha do `DEFERRABLE`, e ela quase produziu falso verde
 *
 * A trigger é `DEFERRABLE INITIALLY DEFERRED`: só julga no `COMMIT`. A
 * primeira versão desta prova isolava os casos por *rollback* e deu **verde
 * em quatro casos que deveriam falhar** — o `COMMIT` nunca acontecia.
 *
 * Por isso todo caso aqui força `SET CONSTRAINTS ... IMMEDIATE` antes de
 * terminar. Sem essa linha, este arquivo inteiro é decorativo.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA = 'f0170000-0000-4000-8000-000000000001';
const USUARIO = 'f0170000-0000-4000-8000-000000000011';
const ESPORTE = 'f0170000-0000-4000-8000-000000000021';
const QUADRA = 'f0170000-0000-4000-8000-000000000031';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const uuid = () => crypto.randomUUID();

async function novaOcupacao(dia: string): Promise<string> {
  const id = uuid();
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,valor,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${dia}','08:00','09:00','AVULSO',80,now())`,
  );
  return id;
}

async function novaAcao(): Promise<string> {
  const id = uuid();
  await q(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
     VALUES ('${id}','${EMPRESA}','reserva_cancelada','${USUARIO}')`,
  );
  return id;
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-017','fit-017',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${USUARIO}','fit017@teste.local','x','Gestor','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES ('${ESPORTE}','${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Q','${ESPORTE}',80)`,
  );
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('FIT-017 — cancelar exige evento DESTA transição (INV-064)', () => {
  /**
   * Cada caso numa transação própria, e **todos forçam a constraint a
   * IMMEDIATE antes de sair**. Sem isso o rollback chega antes do `COMMIT`,
   * a trigger nunca julga, e a prova fica verde por não ter perguntado nada.
   */
  const emTransacao = (corpo: (tx: PrismaClient) => Promise<void>) =>
    db.$transaction(async (tx) => {
      await corpo(tx as unknown as PrismaClient);
      await tx.$executeRawUnsafe(
        `SET CONSTRAINTS "ocupacao_cancelada_exige_evento" IMMEDIATE`,
      );
      throw new Error('ROLLBACK_DA_PROVA');
    });

  const rolou = async (p: Promise<unknown>) =>
    p.then(
      () => 'passou',
      (e: unknown) =>
        String((e as Error).message).includes('ROLLBACK_DA_PROVA')
          ? 'passou'
          : (e as Error).message,
    );

  const cancelar = (tx: PrismaClient, oc: string, transicao: string) =>
    tx.$executeRawUnsafe(
      `UPDATE ocupacoes_quadra SET status_pagamento='cancelado', transicao_id='${transicao}' WHERE id='${oc}'`,
    );

  const gravarEvento = (
    tx: PrismaClient,
    acao: string,
    oc: string,
    transicao: string,
  ) =>
    tx.$executeRawUnsafe(
      `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
       VALUES ('${uuid()}','${EMPRESA}','${acao}','${oc}','cancelada','${transicao}')`,
    );

  it('cancelar SEM evento é recusado', async () => {
    const oc = await novaOcupacao('2027-02-01');
    const r = await rolou(
      emTransacao(async (tx) => {
        await cancelar(tx, oc, uuid());
      }),
    );
    expect(r).toContain('INV-064');
  });

  it('cancelar sem transicao_id é recusado', async () => {
    const oc = await novaOcupacao('2027-02-02');
    const r = await rolou(
      emTransacao(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET status_pagamento='cancelado' WHERE id='${oc}'`,
        );
      }),
    );
    expect(r).toContain('INV-064');
  });

  it('cancelar COM evento da mesma transição passa', async () => {
    const oc = await novaOcupacao('2027-02-03');
    const acao = await novaAcao();
    const t = uuid();
    const r = await rolou(
      emTransacao(async (tx) => {
        await cancelar(tx, oc, t);
        await gravarEvento(tx, acao, oc, t);
      }),
    );
    expect(r).toBe('passou');
  });

  /**
   * **O primeiro dos dois furos que derrubaram a versão com
   * `transaction_timestamp()`.** O timestamp é o início da transação, não a
   * identidade dela: o evento de qualquer transação iniciada depois
   * satisfazia a exigência.
   */
  it('evento de OUTRA transição não serve', async () => {
    const oc = await novaOcupacao('2027-02-04');
    const acao = await novaAcao();
    const r = await rolou(
      emTransacao(async (tx) => {
        await cancelar(tx, oc, uuid());
        await gravarEvento(tx, acao, oc, uuid());
      }),
    );
    expect(r).toContain('INV-064');
  });

  /** **O segundo furo.** Um evento não pode pagar por duas transições. */
  it('cancelar → reativar → cancelar com UM evento é recusado', async () => {
    const oc = await novaOcupacao('2027-02-05');
    const acao = await novaAcao();
    const t1 = uuid();
    const r = await rolou(
      emTransacao(async (tx) => {
        await cancelar(tx, oc, t1);
        await gravarEvento(tx, acao, oc, t1);
        await tx.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET status_pagamento='pendente_pagamento' WHERE id='${oc}'`,
        );
        await cancelar(tx, oc, uuid());
      }),
    );
    expect(r).toContain('INV-064');
  });

  /**
   * O `DEFERRABLE` provado pelo caminho positivo: gravar o evento **antes**
   * do cancelamento tem de passar. Se a trigger fosse imediata, a ordem
   * natural do código — que grava a ocupação primeiro, porque o evento aponta
   * para ela — falharia sempre.
   */
  it('evento gravado ANTES do cancelamento passa', async () => {
    const oc = await novaOcupacao('2027-02-06');
    const acao = await novaAcao();
    const t = uuid();
    const r = await rolou(
      emTransacao(async (tx) => {
        await gravarEvento(tx, acao, oc, t);
        await cancelar(tx, oc, t);
      }),
    );
    expect(r).toBe('passou');
  });

  it('mexer em outra coluna de ocupação já cancelada NÃO exige evento', async () => {
    const oc = await novaOcupacao('2027-02-07');
    const acao = await novaAcao();
    const t = uuid();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET status_pagamento='cancelado', transicao_id='${t}' WHERE id='${oc}'`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
         VALUES ('${uuid()}','${EMPRESA}','${acao}','${oc}','cancelada','${t}')`,
      );
    });
    const r = await rolou(
      emTransacao(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET updated_at=now() WHERE id='${oc}'`,
        );
      }),
    );
    expect(r).toBe('passou');
  });
});
