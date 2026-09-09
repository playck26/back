/**
 * SPEC-033/TASK-005 — **reservar debita, cancelar devolve.** Contra Postgres.
 *
 * ## Por que este arquivo não pode ser unitário
 *
 * O que ele prova depende de coisas que só existem no banco: o `valor`
 * canônico em `numeric(10,2)` (do qual sai o centavo debitado), a trigger que
 * escreve o saldo, o índice que impede devolver duas vezes, a FK causal, e as
 * duas `CONSTRAINT TRIGGER` diferidas que julgam no `COMMIT`. Mock não tem
 * nenhuma delas — os unitários provam a **sequência das chamadas**, este prova
 * o **resultado**.
 *
 * ## Os cinco ramos do AC-007c, e por que os cinco estão aqui
 *
 * Eram três na v1 desta spec, e condensá-los foi o DEF-VC033-R2-01: a linha
 * "gestor, aluno sem saldo" ficou escrita de um jeito que contradizia o
 * AC-007. **O papel é que decide**, e um teste por ramo é o que impede a
 * condensação de voltar.
 */
import { PrismaClient } from '@prisma/client';
import { UnprocessableEntityException } from '@nestjs/common';
import { CourtsService } from '../../src/courts/courts.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { traduzirRecusaDeCancelamento } from '../../src/creditos/set-constraints';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const EMPRESA = 'd0330000-0000-4000-8000-000000000001';
const UADMIN = 'd0330000-0000-4000-8000-000000000002';
const UALUNO = 'd0330000-0000-4000-8000-000000000003';
const ALUNO = 'd0330000-0000-4000-8000-000000000004';
const ESPORTE = 'd0330000-0000-4000-8000-000000000005';
const QUADRA = 'd0330000-0000-4000-8000-000000000006';

const creditos = new CreditosService();
const courts = new CourtsService(
  db as unknown as PrismaService,
  { exigirVinculoAprovado: () => undefined } as unknown as StudentsService,
  new HorarioFuncionamentoService(db as unknown as PrismaService),
  {} as unknown as ImagemDaQuadraService,
  new ConfigOperacaoService(db as unknown as PrismaService),
  creditos,
);

const saldo = async () => {
  const linhas = await db.$queryRawUnsafe<{ saldo_creditos: number }[]>(
    `SELECT saldo_creditos FROM alunos WHERE id = '${ALUNO}'`,
  );
  return linhas[0].saldo_creditos;
};

const movimentos = async (ocupacaoId?: string) =>
  db.$queryRawUnsafe<{ tipo: string; valor_centavos: number }[]>(
    `SELECT tipo, valor_centavos FROM movimentos_de_credito
      WHERE company_id = '${EMPRESA}'
        ${ocupacaoId ? `AND ocupacao_id = '${ocupacaoId}'` : ''}
      ORDER BY criado_em, tipo`,
  );

const statusDa = async (id: string) => {
  const linhas = await db.$queryRawUnsafe<{ status_pagamento: string }[]>(
    `SELECT status_pagamento FROM ocupacoes_quadra WHERE id = '${id}'`,
  );
  return linhas[0]?.status_pagamento;
};

/** A lista nomeada, como o serviço a escreve (`set-constraints.ts`). */
const SET_NOMEADO =
  'SET CONSTRAINTS ocupacao_cancelada_exige_evento, ' +
  'ocupacao_cancelada_exige_devolucao, movimentos_consumo_ativo_unico IMMEDIATE';

async function novaAcao(tipo: string): Promise<string> {
  const [linha] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
     VALUES (gen_random_uuid(),'${EMPRESA}','${tipo}','${UADMIN}') RETURNING id`,
  );
  return linha.id;
}

/** Um aporte pela porta do ledger — a única que existe (D1). */
async function creditar(centavos: number) {
  const acao = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
     VALUES (gen_random_uuid(),'${EMPRESA}','credito_lancado','${UADMIN}') RETURNING id`,
  );
  await db.$transaction((tx) =>
    creditos.lancar(tx, {
      companyId: EMPRESA,
      alunoId: ALUNO,
      valorCentavos: centavos,
      motivo: 'aporte de teste',
      autorId: UADMIN,
      acaoId: acao[0].id,
    }),
  );
}

let dia = 0;
/** Uma data futura nova a cada reserva, para nenhuma esbarrar na EXCLUDE. */
function proximaData() {
  dia += 1;
  const d = new Date(Date.UTC(2031, 5, dia));
  return d.toISOString().slice(0, 10);
}

async function reservar(
  papel: 'aluno' | 'company_admin',
  hora = '10:00',
): Promise<{ id: string; statusPagamento: string }> {
  const resposta = (await courts.createBooking(
    EMPRESA,
    {
      quadraId: QUADRA,
      data: proximaData(),
      slots: [{ horaInicio: hora, horaFim: '11:00' }],
      alunoId: ALUNO,
    },
    UADMIN,
    undefined,
    papel,
  )) as { reservas: { id: string; statusPagamento: string }[] };
  // Com `slots` a resposta é `{ reservas: [...] }`; o formato antigo (sem
  // `slots`) devolve a reserva solta. Os casos não deveriam saber disso.
  return resposta.reservas[0];
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(`INSERT INTO empresas (id,nome,updated_at,slug)
           VALUES ('${EMPRESA}','Reserva 033',now(),'reserva-033')`);
  await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,updated_at,company_id)
           VALUES ('${UADMIN}','admin@d033.test','x','Admin','company_admin',now(),'${EMPRESA}')`);
  await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,updated_at,company_id)
           VALUES ('${UALUNO}','aluno@d033.test','x','Aluno','aluno',now(),'${EMPRESA}')`);
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA}')`,
  );
  await q(`INSERT INTO esportes_de_quadra (id,company_id,nome,ordem)
           VALUES ('${ESPORTE}','${EMPRESA}','Tenis',1)`);
  // R$ 80/h. Um bloco de 1h custa 8000 centavos.
  await q(`INSERT INTO quadras (id,company_id,nome,preco_hora,esporte_id)
           VALUES ('${QUADRA}','${EMPRESA}','Q1',80,'${ESPORTE}')`);
  // Sem horário de funcionamento configurado o clube fica aberto o dia todo,
  // que é o padrão do projeto — este arquivo não é sobre expediente.
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-033/TASK-005 — reservar debita, cancelar devolve', () => {
  it('AC-006 + AC-007c: aluno com saldo consome e a reserva nasce `pago`', async () => {
    await creditar(20_000);
    const antes = await saldo();

    const reserva = await reservar('aluno');
    const id = reserva.id;

    /**
     * **A RESPOSTA, não só o banco — e esta linha nasceu de um defeito real.**
     *
     * O `updateMany` do AC-007c roda depois do `create`, e os objetos que
     * voltam ao cliente carregavam `pendente_pagamento`. O banco ficava certo
     * e a resposta mentia; o app do aluno mostraria "pendente de pagamento"
     * numa reserva que a carteira acabou de quitar.
     *
     * Este arquivo não pegou: ele afirmava `statusDa(id)`, que lê o BANCO.
     * Quem pegou foi o smoke da Neon, por HTTP. A asserção fica aqui para não
     * depender disso de novo.
     */
    expect(reserva.statusPagamento).toBe('pago');

    expect(await saldo()).toBe(antes - 8_000);
    expect(await movimentos(id)).toEqual([
      { tipo: 'consumo', valor_centavos: 8_000 },
    ]);
    // Sem esta linha a carteira pagaria e o clube cobraria de novo.
    expect(await statusDa(id)).toBe('pago');
  });

  it('AC-007: ALUNO sem saldo recebe 422 e a reserva NÃO nasce', async () => {
    const antes = await saldo();
    // Zera a carteira por retirada, que é a porta legítima.
    if (antes > 0) {
      const acao = await db.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
         VALUES (gen_random_uuid(),'${EMPRESA}','credito_retirado','${UADMIN}') RETURNING id`,
      );
      await db.$transaction((tx) =>
        creditos.retirar(tx, {
          companyId: EMPRESA,
          alunoId: ALUNO,
          valorCentavos: antes,
          motivo: 'zerar para o teste',
          autorId: UADMIN,
          acaoId: acao[0].id,
        }),
      );
    }
    const ocupacoesAntes = await db.ocupacaoQuadra.count({
      where: { companyId: EMPRESA },
    });

    await expect(reservar('aluno')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    // Tudo-ou-nada: a transação desfez o `INSERT` da ocupação. O passo 2
    // (inserir) vem antes do 3 (somar) de propósito — o valor canônico só
    // existe depois que o Postgres grava — e é a transação que paga por isso.
    expect(
      await db.ocupacaoQuadra.count({ where: { companyId: EMPRESA } }),
    ).toBe(ocupacoesAntes);
    expect(await saldo()).toBe(0);
  });

  it('PA-04: o GESTOR reserva para aluno sem saldo — aceito, `pendente_pagamento`, ZERO movimento', async () => {
    expect(await saldo()).toBe(0);

    const { id } = await reservar('company_admin');

    // O clube não fica impedido de operar por falta de saldo de um aluno, e
    // ninguém fica negativo — porque neste ramo não nasce movimento.
    expect(await statusDa(id)).toBe('pendente_pagamento');
    expect(await movimentos(id)).toEqual([]);
    expect(await saldo()).toBe(0);
  });

  it('AC-009: cancelar devolve o consumo daquele bloco, e o saldo volta', async () => {
    await creditar(10_000);
    const antesDaReserva = await saldo();

    const { id } = await reservar('aluno');
    expect(await saldo()).toBe(antesDaReserva - 8_000);

    const resposta = await courts.cancelBooking(
      EMPRESA,
      id,
      UADMIN,
      'company_admin',
    );

    expect(await saldo()).toBe(antesDaReserva);
    expect(await movimentos(id)).toEqual([
      { tipo: 'consumo', valor_centavos: 8_000 },
      { tipo: 'devolucao', valor_centavos: 8_000 },
    ]);
    // SPEC-039 — **o numero que vai para a tela do aluno**, e ele e conferido
    // contra o LEDGER logo acima, nao contra si mesmo. A rota deixou de ser
    // `204` para poder dizer isto; um valor errado aqui viraria uma mensagem
    // errada sobre dinheiro.
    expect(resposta).toEqual({ creditoDevolvidoCentavos: 8_000 });
  });

  it('AC-010: cancelar reserva SEM consumo não gera movimento — a ausência é a resposta', async () => {
    // A do gestor, criada sem saldo: existe e não tem consumo.
    const semConsumo = await db.ocupacaoQuadra.findFirst({
      where: { companyId: EMPRESA, statusPagamento: 'pendente_pagamento' },
      select: { id: true },
    });
    const antes = await saldo();

    await courts.cancelBooking(
      EMPRESA,
      semConsumo!.id,
      UADMIN,
      'company_admin',
    );

    expect(await statusDa(semConsumo!.id)).toBe('cancelado');
    expect(await movimentos(semConsumo!.id)).toEqual([]);
    expect(await saldo()).toBe(antes);
  });

  it('SPEC-039: a resposta distingue "nao devolveu" de "devolveu zero"', async () => {
    // **`null`, e nao `0`.** A tela do aluno decide entre "seu credito voltou"
    // e nao dizer nada; com `0` as duas frases ficariam indistinguiveis, e a
    // primeira apareceria em reserva de turma, onde nunca houve credito.
    //
    // **Sujeito PROPRIO, criado aqui.** A primeira versao pegava a reserva
    // pendente do cenario compartilhado -- e o caso anterior ja a cancelava.
    // Cenario compartilhado e conveniencia ate o dia em que dois casos
    // disputam a mesma linha.
    const { id, statusPagamento } = await reservar('company_admin', '09:00');
    expect(statusPagamento).toBe('pendente_pagamento');

    const resposta = await courts.cancelBooking(
      EMPRESA,
      id,
      UADMIN,
      'company_admin',
    );
    expect(resposta).toEqual({ creditoDevolvidoCentavos: null });
    expect(await movimentos(id)).toEqual([]);
  });

  it('PA-02: o SEGUNDO caminho devolve igual — `updatePaymentStatus` não é exceção', async () => {
    await creditar(10_000);
    const antesDaReserva = await saldo();

    const { id } = await reservar('aluno');
    expect(await saldo()).toBe(antesDaReserva - 8_000);

    // A garantia não é esta rota conhecer a regra: é a INV-096, que julga o
    // COMMIT. Se este caminho esquecesse a devolução, a trigger recusaria.
    await courts.updatePaymentStatus(EMPRESA, id, 'cancelado', UADMIN);

    expect(await saldo()).toBe(antesDaReserva);
    expect(await movimentos(id)).toEqual([
      { tipo: 'consumo', valor_centavos: 8_000 },
      { tipo: 'devolucao', valor_centavos: 8_000 },
    ]);
  });

  it('INV-096: cancelar SEM devolver é impossível — a trigger recusa, e vira 409', async () => {
    await creditar(10_000);
    const { id } = await reservar('aluno');

    // A sabotagem: cancelar por fora do serviço, gravando ocupação e evento
    // mas NENHUMA devolução. É exatamente o que o `back` revertido faz (saída
    // B do rollout), e o que qualquer caminho novo faria se esquecesse.
    const acao = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
       VALUES (gen_random_uuid(),'${EMPRESA}','reserva_cancelada','${UADMIN}') RETURNING id`,
    );
    const transicao = '0d330000-0000-4000-8000-0000000000ff';
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET status_pagamento='cancelado', transicao_id='${transicao}' WHERE id='${id}'`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
           VALUES (gen_random_uuid(),'${EMPRESA}','${acao[0].id}','${id}','cancelada','${transicao}')`,
        );
        await tx.$executeRawUnsafe(
          `SET CONSTRAINTS ocupacao_cancelada_exige_evento, ocupacao_cancelada_exige_devolucao, movimentos_consumo_ativo_unico IMMEDIATE`,
        );
      }),
    ).rejects.toMatchObject({ meta: { code: 'P3301' } });

    // E o serviço, que faz certo, continua passando na mesma reserva.
    await courts.cancelBooking(EMPRESA, id, UADMIN, 'company_admin');
    expect(await statusDa(id)).toBe('cancelado');
  });

  it('AC-011: cancelar, reativar e cancelar de novo produz QUATRO linhas legítimas', async () => {
    await creditar(20_000);
    const { id } = await reservar('aluno');

    await courts.cancelBooking(EMPRESA, id, UADMIN, 'company_admin');

    // Reativar não é rota do produto (`cancelado` é terminal, AC-012). Aqui a
    // reativação é feita à mão para provar o que a INV-098 permite: um novo
    // consumo, já que o anterior foi devolvido.
    await q(
      `UPDATE ocupacoes_quadra SET status_pagamento='pendente_pagamento' WHERE id='${id}'`,
    );
    const acao = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
       VALUES (gen_random_uuid(),'${EMPRESA}','reserva_criada','${UADMIN}') RETURNING id`,
    );
    await db.$transaction(async (tx) => {
      await creditos.consumir(tx, {
        companyId: EMPRESA,
        alunoId: ALUNO,
        valorCentavos: 8_000,
        autorId: UADMIN,
        acaoId: acao[0].id,
        ocupacaoId: id,
      });
      await tx.$executeRawUnsafe(
        `SET CONSTRAINTS ocupacao_cancelada_exige_evento, ocupacao_cancelada_exige_devolucao, movimentos_consumo_ativo_unico IMMEDIATE`,
      );
    });

    await courts.cancelBooking(EMPRESA, id, UADMIN, 'company_admin');

    expect(await movimentos(id)).toEqual([
      { tipo: 'consumo', valor_centavos: 8_000 },
      { tipo: 'devolucao', valor_centavos: 8_000 },
      { tipo: 'consumo', valor_centavos: 8_000 },
      { tipo: 'devolucao', valor_centavos: 8_000 },
    ]);
  });

  it('cancelar duas vezes é idempotente e NÃO devolve duas vezes', async () => {
    await creditar(10_000);
    const antes = await saldo();
    const { id } = await reservar('aluno');

    await courts.cancelBooking(EMPRESA, id, UADMIN, 'company_admin');
    // Retentativa de rede: sem escrita, sem erro — e sem segundo estorno.
    await courts.cancelBooking(EMPRESA, id, UADMIN, 'company_admin');

    expect(await saldo()).toBe(antes);
    expect(
      (await movimentos(id)).filter((m) => m.tipo === 'devolucao'),
    ).toHaveLength(1);
  });

  it('DEF: os TRÊS códigos do contrato chegam distintos — um por mecanismo', async () => {
    /**
     * A tabela normativa da spec dá **três** destinos, e o código dava um só
     * (`CANCELAMENTO_CARTEIRA_INDISPONIVEL` para os dois SQLSTATE) e **nenhum**
     * para o índice parcial — que subia cru, virando `500` numa recusa que a
     * norma declara `409`.
     *
     * Achado pelo `Docs/contrato-spec-x-codigo.py`. E a primeira tentativa de
     * conserto casava `23505`, que **nunca teria disparado**: pelo client do
     * Prisma o erro chega como `P2002` + `meta.target`. Este caso existe para
     * que a distinção não volte a ser afirmação.
     */
    await creditar(20_000);
    const { id } = await reservar('aluno');

    // 1. INV-096 — cancelar sem devolver.
    const acaoA = await novaAcao('reserva_cancelada');
    const trans = '0d330000-0000-4000-8000-0000000000e1';
    await expect(
      db
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE ocupacoes_quadra SET status_pagamento='cancelado', transicao_id='${trans}' WHERE id='${id}'`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
             VALUES (gen_random_uuid(),'${EMPRESA}','${acaoA}','${id}','cancelada','${trans}')`,
          );
          await tx.$executeRawUnsafe(SET_NOMEADO);
        })
        .catch(traduzirRecusaDeCancelamento),
    ).rejects.toMatchObject({
      response: { code: 'CANCELAMENTO_CARTEIRA_INDISPONIVEL' },
    });

    // 2. INV-098 — segundo consumo ativo.
    const acaoB = await novaAcao('reserva_criada');
    await expect(
      db
        .$transaction(async (tx) => {
          await creditos.consumir(tx, {
            companyId: EMPRESA,
            alunoId: ALUNO,
            valorCentavos: 8_000,
            autorId: UADMIN,
            acaoId: acaoB,
            ocupacaoId: id,
          });
          await tx.$executeRawUnsafe(SET_NOMEADO);
        })
        .catch(traduzirRecusaDeCancelamento),
    ).rejects.toMatchObject({ response: { code: 'CONSUMO_JA_ATIVO' } });

    // 3. o índice parcial — devolver duas vezes o mesmo consumo.
    const ativo = await creditos.consumoAtivoDaOcupacao(db, EMPRESA, id);
    const acaoC = await novaAcao('reserva_cancelada');
    const devolver = () =>
      db.$transaction((tx) =>
        creditos.devolver(tx, {
          companyId: EMPRESA,
          alunoId: ALUNO,
          valorCentavos: ativo!.valorCentavos,
          autorId: UADMIN,
          acaoId: acaoC,
          ocupacaoId: id,
          movimentoOrigemId: ativo!.id,
        }),
      );
    await devolver();
    await expect(
      devolver().catch(traduzirRecusaDeCancelamento),
    ).rejects.toMatchObject({ response: { code: 'DEVOLUCAO_JA_FEITA' } });
  });

  it('reserva de TURMA não devolve: não tem `valor`, então não há o que estornar', async () => {
    // A ocupação de turma é criada por outro caminho e o `CHECK`
    // `ocupacoes_valor_por_origem` proíbe `valor` nela — a LIM-033a é isto, e
    // ela tem mecanismo de banco, não promessa.
    await expect(
      q(`INSERT INTO ocupacoes_quadra
           (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,valor)
         VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','2031-12-01','10:00','11:00','TURMA',now(),80)`),
    ).rejects.toThrow(/ocupacoes_valor_por_origem|23514/);
  });
});
