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
 * ## Os cinco ramos do AC-007c, e onde cada um está
 *
 * Eram três na v1 desta spec, e condensá-los foi o DEF-VC033-R2-01: a linha
 * "gestor, aluno sem saldo" ficou escrita de um jeito que contradizia o
 * AC-007. **O papel é que decide**, e um teste por ramo é o que impede a
 * condensação de voltar.
 *
 * **Este cabeçalho dizia "os cinco estão aqui", e até 2026-09-27 eram três.**
 * O gestor com saldo era montado (no caso da SPEC-048/AC-010) e só a
 * devolução era aferida; o `valor = 0` não tinha caso nenhum. A SPEC-077
 * (TASK-002) é quem completou:
 *
 * | ramo | caso |
 * |---|---|
 * | aluno com saldo ⇒ `pago`, 1 consumo | "AC-006 + AC-007c" |
 * | aluno sem saldo ⇒ `422`, não nasce | "AC-007" |
 * | gestor, aluno sem saldo ⇒ `pendente_pagamento`, 0 movimento | "PA-04" |
 * | gestor, aluno com saldo ⇒ `pago`, 1 consumo | "SPEC-077/AC-008" |
 * | `valor = 0` ⇒ `pago`, 0 movimento | "SPEC-077/AC-009" |
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
import { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { StudentsService } from '../../src/people/students.service';
import { comAcao } from './acao-com-efeito';
import { exigirBancoLocal } from './exigir-banco-local';
import { diaNoFuturo, somarDias } from './datas-relativas';
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
  { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
  new HorarioFuncionamentoService(db as unknown as PrismaService),
  {} as unknown as ImagemDaQuadraService,
  new ConfigOperacaoService(db as unknown as PrismaService),
  creditos,
  // SPEC-039: duble vazio -- estes testes nao criam aula particular, e o
  // gate so roda quando `professorId` vem no pedido.
  { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
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

/** Um aporte pela porta do ledger — a única que existe (D1). */
async function creditar(centavos: number) {
  // SPEC-069/INV-069a — **a acao e o efeito na MESMA transacao.** Em
  // autocommit o `INSERT` da acao commita sozinho, o `acao_exige_alvo` julga
  // ali e o movimento ainda nao existe: `23514` numa fixture que nunca foi o
  // defeito. O servico sempre gravou os dois juntos; era a fixture que nao.
  await comAcao(
    db,
    { companyId: EMPRESA, tipo: 'credito_lancado', autorId: UADMIN },
    (tx, acaoId) =>
      creditos.lancar(tx, {
        companyId: EMPRESA,
        alunoId: ALUNO,
        valorCentavos: centavos,
        motivo: 'aporte de teste',
        autorId: UADMIN,
        acaoId,
      }),
  );
}

let dia = 0;
/** Uma data futura nova a cada reserva, para nenhuma esbarrar na EXCLUDE. */
function proximaData() {
  dia += 1;
  // SPEC-077/TASK-000: relativa ao hoje do clube; era junho de 2031.
  return somarDias(diaNoFuturo(30), dia);
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
      await comAcao(
        db,
        { companyId: EMPRESA, tipo: 'credito_retirado', autorId: UADMIN },
        (tx, acaoId) =>
          creditos.retirar(tx, {
            companyId: EMPRESA,
            alunoId: ALUNO,
            valorCentavos: antes,
            motivo: 'zerar para o teste',
            autorId: UADMIN,
            acaoId,
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
    const resposta = await courts.updatePaymentStatus(
      EMPRESA,
      id,
      'cancelado',
      UADMIN,
    );

    // **SPEC-048/AC-009 — e agora ele DIZ quanto voltou.** O valor já era
    // calculado aqui e descartado: o dinheiro voltava e a tela do gestor não
    // tinha como falar. `toBe` e não `toBeGreaterThan`: é o mesmo número que
    // saiu, e "algum crédito voltou" não é a afirmação que a tela precisa.
    expect(resposta.creditoDevolvidoCentavos).toBe(8_000);

    expect(await saldo()).toBe(antesDaReserva);
    expect(await movimentos(id)).toEqual([
      { tipo: 'consumo', valor_centavos: 8_000 },
      { tipo: 'devolucao', valor_centavos: 8_000 },
    ]);
  });

  it('**SPEC-048/AC-010: marcar como `pago` devolve `null`, não `0`**', async () => {
    await creditar(10_000);
    // Hora padrão: o helper fixa `horaFim: '11:00'`, e `proximaData()` já dá
    // uma data nova a cada reserva — nenhuma esbarra na `EXCLUDE`.
    const { id } = await reservar('company_admin');

    // Reserva do GESTOR sem saldo suficiente nasce pendente e sem consumo
    // (PA-04); aqui há saldo, então ela já nasce paga. Marcar como `pago` de
    // novo não é cancelamento e **não devolve nada**.
    const resposta = await courts.updatePaymentStatus(
      EMPRESA,
      id,
      'pago',
      UADMIN,
    );

    // **`null` e não `0`**: zero seria "devolvi zero centavos", e a tela do
    // gestor mostraria "R$ 0,00 voltou para a carteira" — prometer devolução
    // que não houve é o que a SPEC-039 comprou esta distinção para evitar.
    expect(resposta.creditoDevolvidoCentavos).toBeNull();
  });

  it('AC-009: cancelar reserva SEM consumo também devolve `null`', async () => {
    // Reserva sem aluno: não há carteira, não há consumo, não há o que
    // devolver. A rota cancela e fica calada — é a mesma ausência que o
    // `cancelBooking` já respondia (SPEC-033/AC-010).
    const resposta = (await courts.createBooking(
      EMPRESA,
      {
        quadraId: QUADRA,
        data: proximaData(),
        slots: [{ horaInicio: '16:00', horaFim: '17:00' }],
      },
      UADMIN,
    )) as { reservas: { id: string }[] };

    const cancelada = await courts.updatePaymentStatus(
      EMPRESA,
      resposta.reservas[0].id,
      'cancelado',
      UADMIN,
    );
    expect(cancelada.creditoDevolvidoCentavos).toBeNull();
  });

  it('INV-096: cancelar SEM devolver é impossível — a trigger recusa, e vira 409', async () => {
    await creditar(10_000);
    const { id } = await reservar('aluno');

    // A sabotagem: cancelar por fora do serviço, gravando ocupação e evento
    // mas NENHUMA devolução. É exatamente o que o `back` revertido faz (saída
    // B do rollout), e o que qualquer caminho novo faria se esquecesse.
    const transicao = '0d330000-0000-4000-8000-0000000000ff';
    await expect(
      comAcao(
        db,
        { companyId: EMPRESA, tipo: 'reserva_cancelada', autorId: UADMIN },
        async (tx, acaoId) => {
          await tx.$executeRawUnsafe(
            `UPDATE ocupacoes_quadra SET status_pagamento='cancelado', transicao_id='${transicao}' WHERE id='${id}'`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
             VALUES (gen_random_uuid(),'${EMPRESA}','${acaoId}','${id}','cancelada','${transicao}')`,
          );
          await tx.$executeRawUnsafe(
            `SET CONSTRAINTS ocupacao_cancelada_exige_evento, ocupacao_cancelada_exige_devolucao, movimentos_consumo_ativo_unico IMMEDIATE`,
          );
        },
      ),
    ).rejects.toMatchObject({ meta: { code: 'P3301' } });

    // E o serviço, que faz certo, continua passando na mesma reserva.
    await courts.cancelBooking(EMPRESA, id, UADMIN, 'company_admin');
    expect(await statusDa(id)).toBe('cancelado');
  });

  it('AC-011: cancelar, reativar e cancelar de novo produz QUATRO linhas legítimas', async () => {
    await creditar(20_000);
    const { id } = await reservar('aluno');

    await courts.cancelBooking(EMPRESA, id, UADMIN, 'company_admin');

    /**
     * A reativação é feita à mão para provar o que a INV-098 permite: um novo
     * consumo, já que o anterior foi devolvido.
     *
     * **Este bloco mudou com a SPEC-035, e o comentário anterior envelheceu.**
     * Ele dizia "reativar não é rota do produto" — verdade que virou meia
     * verdade: a SPEC-035 criou a rota para **ocorrência de turma**, e para
     * reserva avulsa continua não havendo (LIM-035a, por causa do crédito que
     * teria de ser recobrado sem o aluno pedir). Este caso é de reserva
     * avulsa, então o "à mão" segue certo.
     *
     * O que mudou de fato: o `UPDATE` solto **deixou de ser aceito**. A
     * `ocupacao_reativada_exige_evento` (INV-106) exige o evento `reativada`
     * desta transição, e a exigência alcança qualquer caminho — inclusive um
     * teste que simula o produto. É a invariante nova funcionando sobre
     * código antigo, e não uma regressão: a simulação agora é fiel ao que o
     * banco cobra de quem descancela de verdade.
     */
    const acaoDaReativacao = await comAcao(
      db,
      { companyId: EMPRESA, tipo: 'reserva_criada', autorId: UADMIN },
      async (tx, acaoId) => {
        const [{ t }] = await tx.$queryRawUnsafe<{ t: string }[]>(
          `SELECT gen_random_uuid()::text AS t`,
        );
        await tx.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET status_pagamento='pendente_pagamento', transicao_id='${t}' WHERE id='${id}'`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id,criado_em)
           VALUES (gen_random_uuid(),'${EMPRESA}','${acaoId}','${id}','reativada','${t}',now())`,
        );
        return acaoId;
      },
    );
    await db.$transaction(async (tx) => {
      await creditos.consumir(tx, {
        companyId: EMPRESA,
        alunoId: ALUNO,
        valorCentavos: 8_000,
        autorId: UADMIN,
        acaoId: acaoDaReativacao,
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
    const trans = '0d330000-0000-4000-8000-0000000000e1';
    await expect(
      comAcao(
        db,
        { companyId: EMPRESA, tipo: 'reserva_cancelada', autorId: UADMIN },
        async (tx, acaoId) => {
          await tx.$executeRawUnsafe(
            `UPDATE ocupacoes_quadra SET status_pagamento='cancelado', transicao_id='${trans}' WHERE id='${id}'`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
             VALUES (gen_random_uuid(),'${EMPRESA}','${acaoId}','${id}','cancelada','${trans}')`,
          );
          await tx.$executeRawUnsafe(SET_NOMEADO);
        },
      ).catch(traduzirRecusaDeCancelamento),
    ).rejects.toMatchObject({
      response: { code: 'CANCELAMENTO_CARTEIRA_INDISPONIVEL' },
    });

    // 2. INV-098 — segundo consumo ativo.
    await expect(
      comAcao(
        db,
        { companyId: EMPRESA, tipo: 'reserva_criada', autorId: UADMIN },
        async (tx, acaoId) => {
          await creditos.consumir(tx, {
            companyId: EMPRESA,
            alunoId: ALUNO,
            valorCentavos: 8_000,
            autorId: UADMIN,
            acaoId,
            ocupacaoId: id,
          });
          await tx.$executeRawUnsafe(SET_NOMEADO);
        },
      ).catch(traduzirRecusaDeCancelamento),
    ).rejects.toMatchObject({ response: { code: 'CONSUMO_JA_ATIVO' } });

    // 3. o índice parcial — devolver duas vezes o mesmo consumo.
    const ativo = await creditos.consumoAtivoDaOcupacao(db, EMPRESA, id);
    const devolver = () =>
      comAcao(
        db,
        { companyId: EMPRESA, tipo: 'reserva_cancelada', autorId: UADMIN },
        (tx, acaoId) =>
          creditos.devolver(tx, {
            companyId: EMPRESA,
            alunoId: ALUNO,
            valorCentavos: ativo!.valorCentavos,
            autorId: UADMIN,
            acaoId,
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
         VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${diaNoFuturo(400)}','10:00','11:00','TURMA',now(),80)`),
    ).rejects.toThrow(/ocupacoes_valor_por_origem|23514/);
  });
});

/**
 * SPEC-077/TASK-002 — **o que a matriz da 033 prometia e nenhum teste
 * afirmava.** Roda depois dos casos acima e não depende do saldo que eles
 * deixam: cada caso lê o seu "antes".
 *
 * `ALUNO2` nunca recebe crédito — é o aluno de saldo zero dos casos que
 * precisam dele (a quadra grátis e as reservas sem consumo do gancho).
 */
describe('SPEC-077/TASK-002 — as lacunas da 033', () => {
  const UALUNO2 = 'd0330000-0000-4000-8000-000000000007';
  const ALUNO2 = 'd0330000-0000-4000-8000-000000000008';
  const QUADRA_GRATIS = 'd0330000-0000-4000-8000-000000000009';
  const outra = new PrismaClient();

  const saldoDe = async (aluno: string) => {
    const [l] = await db.$queryRawUnsafe<{ saldo_creditos: number }[]>(
      `SELECT saldo_creditos FROM alunos WHERE id = '${aluno}'`,
    );
    return l.saldo_creditos;
  };

  /** Tudo o que um gesto que "não escreve" não pode ter mudado. */
  const fotografia = async (id: string) => {
    const [linha] = await db.$queryRawUnsafe<
      {
        status_pagamento: string;
        aluno_id: string | null;
        transicao_id: string | null;
      }[]
    >(
      `SELECT status_pagamento, aluno_id, transicao_id FROM ocupacoes_quadra WHERE id = '${id}'`,
    );
    const eventos = await db.$queryRawUnsafe<{ tipo: string }[]>(
      `SELECT tipo::text FROM eventos_de_ocupacao WHERE ocupacao_id = '${id}' ORDER BY criado_em, tipo`,
    );
    const [{ acoes }] = await db.$queryRawUnsafe<{ acoes: number }[]>(
      `SELECT count(*)::int AS acoes FROM acoes_administrativas WHERE company_id = '${EMPRESA}'`,
    );
    const [{ movs }] = await db.$queryRawUnsafe<{ movs: number }[]>(
      `SELECT count(*)::int AS movs FROM movimentos_de_credito WHERE company_id = '${EMPRESA}'`,
    );
    return {
      linha,
      eventos,
      acoes,
      movs,
      daReserva: await movimentos(id),
      saldo: await saldoDe(ALUNO),
      saldo2: await saldoDe(ALUNO2),
    };
  };

  const reservarNo = async (
    papel: 'aluno' | 'company_admin',
    aluno: string,
    faixa: {
      data?: string;
      horaInicio?: string;
      horaFim?: string;
      quadra?: string;
    } = {},
  ) => {
    const resposta = (await courts.createBooking(
      EMPRESA,
      {
        quadraId: faixa.quadra ?? QUADRA,
        data: faixa.data ?? proximaData(),
        slots: [
          {
            horaInicio: faixa.horaInicio ?? '10:00',
            horaFim: faixa.horaFim ?? '11:00',
          },
        ],
        alunoId: aluno,
      },
      UADMIN,
      undefined,
      papel,
    )) as { reservas: { id: string; statusPagamento: string }[] };
    return resposta.reservas[0];
  };

  beforeAll(async () => {
    await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,updated_at,company_id)
             VALUES ('${UALUNO2}','aluno2@d033.test','x','Aluno 2','aluno',now(),'${EMPRESA}')`);
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO2}','${UALUNO2}','${EMPRESA}')`,
    );
    await q(`INSERT INTO quadras (id,company_id,nome,preco_hora,esporte_id)
             VALUES ('${QUADRA_GRATIS}','${EMPRESA}','Q gratis',0,'${ESPORTE}')`);
  });

  afterAll(async () => {
    await outra.$disconnect();
  });

  it('AC-008 (#8 + #10): o GESTOR reservando para aluno COM saldo ⇒ nasce `pago` com UM consumo; e `PATCH pago` sobre ela não muda nada', async () => {
    await creditar(10_000);
    const antes = await saldo();

    const reserva = await reservarNo('company_admin', ALUNO);

    // O ramo que o caso da SPEC-048/AC-010 montava e não aferia.
    expect(reserva.statusPagamento).toBe('pago');
    expect(await statusDa(reserva.id)).toBe('pago');
    expect(await movimentos(reserva.id)).toEqual([
      { tipo: 'consumo', valor_centavos: 8_000 },
    ]);
    expect(await saldo()).toBe(antes - 8_000);

    // #10 — a quitada pela carteira NÃO oferece nova cobrança: marcar `pago`
    // de novo é a saída idempotente, sem ação, sem evento, sem movimento.
    const foto = await fotografia(reserva.id);
    const resposta = await courts.updatePaymentStatus(
      EMPRESA,
      reserva.id,
      'pago',
      UADMIN,
    );
    expect(resposta.creditoDevolvidoCentavos).toBeNull();
    expect(await fotografia(reserva.id)).toEqual(foto);
  });

  it('AC-009 (#9): `valor = 0` ⇒ `pago` e NENHUM movimento — mesmo para aluno de saldo zero', async () => {
    expect(await saldoDe(ALUNO2)).toBe(0);
    const [{ movs: antes }] = await db.$queryRawUnsafe<{ movs: number }[]>(
      `SELECT count(*)::int AS movs FROM movimentos_de_credito WHERE company_id = '${EMPRESA}'`,
    );

    // PAPEL aluno: o de saldo zero seria recusado com `422` numa quadra paga
    // (AC-007). Numa grátis não há o que cobrar — e o ledger recusa movimento
    // de zero (`valor_centavos > 0`), então tentar emitir daria erro.
    const reserva = await reservarNo('aluno', ALUNO2, {
      quadra: QUADRA_GRATIS,
    });

    expect(reserva.statusPagamento).toBe('pago');
    expect(await statusDa(reserva.id)).toBe('pago');
    expect(await movimentos(reserva.id)).toEqual([]);
    const [{ movs: depois }] = await db.$queryRawUnsafe<{ movs: number }[]>(
      `SELECT count(*)::int AS movs FROM movimentos_de_credito WHERE company_id = '${EMPRESA}'`,
    );
    expect(depois).toBe(antes);
    expect(await saldoDe(ALUNO2)).toBe(0);
  });

  let passado = 0;
  /** Um dia que JÁ PASSOU, novo a cada reserva — sem relógio falso. */
  const diaPassado = () => diaNoFuturo(-10 - ++passado);

  it.each([
    [
      'cancelBooking',
      (id: string) =>
        courts.cancelBooking(EMPRESA, id, UADMIN, 'company_admin'),
    ],
    [
      'PATCH payment-status cancelado',
      (id: string) =>
        courts.updatePaymentStatus(EMPRESA, id, 'cancelado', UADMIN),
    ],
  ])(
    'AC-010 (#12): o GESTOR cancelando reserva já iniciada, com consumo, pelo %s ⇒ 409 e nenhum movimento nasce',
    async (_caminho, cancelar) => {
      await creditar(10_000);
      // O gestor pode lançar no passado (SPEC-042/D-I5, a assimetria); o
      // aluno tem saldo, então a reserva nasce paga e COM consumo.
      const reserva = await reservarNo('company_admin', ALUNO, {
        data: diaPassado(),
      });
      expect(await movimentos(reserva.id)).toEqual([
        { tipo: 'consumo', valor_centavos: 8_000 },
      ]);
      const foto = await fotografia(reserva.id);

      await expect(cancelar(reserva.id)).rejects.toMatchObject({
        response: { code: 'PRAZO_DE_CANCELAMENTO' },
      });

      // `movimentos` = [o consumo]: a devolução NÃO nasceu. Saldo, status,
      // eventos e ações iguais.
      expect(await fotografia(reserva.id)).toEqual(foto);
    },
  );

  /**
   * AC-012 (#14) — **o gancho da INV-095.**
   *
   * A espiada que descobre o `aluno_id` é SEM trava, fora da transação. Um
   * gancho sequencial reproduz a intercalação sem corrida: o serviço usa um
   * `prisma` embrulhado cujo `ocupacaoQuadra.findFirst` — a espiada, que é a
   * primeira leitura dos dois caminhos — devolve o que leu e, ANTES de
   * devolver, deixa OUTRA conexão trocar o `aluno_id` e commitar. A
   * transação então trava a carteira do aluno velho e encontra o novo.
   *
   * A reserva é SEM consumo de propósito: com consumo, a FK de quatro colunas
   * (`movimentos_ocupacao_avulsa_fkey`) recusaria a troca, e o gancho não
   * chegaria a existir.
   */
  const courtsComGancho = (gancho: () => Promise<unknown>) => {
    const estado = { disparou: false };
    type Funcao = (...a: unknown[]) => Promise<unknown>;
    const espiao = new Proxy(db, {
      get(alvo, prop): unknown {
        const v: unknown = Reflect.get(alvo, prop, alvo);
        if (prop === 'ocupacaoQuadra') {
          return new Proxy(v as object, {
            get(d, p): unknown {
              const f: unknown = Reflect.get(d, p, d);
              if (typeof f !== 'function') return f;
              const chamar = f as Funcao;
              if (p === 'findFirst' && !estado.disparou) {
                return async (...args: unknown[]): Promise<unknown> => {
                  const lido: unknown = await chamar.apply(d, args);
                  estado.disparou = true;
                  await gancho();
                  return lido;
                };
              }
              return chamar.bind(d);
            },
          });
        }
        return typeof v === 'function' ? (v as Funcao).bind(alvo) : v;
      },
    });
    const servico = new CourtsService(
      espiao as unknown as PrismaService,
      { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
      new HorarioFuncionamentoService(db as unknown as PrismaService),
      {} as unknown as ImagemDaQuadraService,
      new ConfigOperacaoService(db as unknown as PrismaService),
      creditos,
      {
        carregarSemana: jest.fn(),
      } as unknown as DisponibilidadeProfessorService,
    );
    return { servico, estado };
  };

  it.each([
    [
      'cancelBooking',
      (s: CourtsService, id: string) =>
        s.cancelBooking(EMPRESA, id, UADMIN, 'company_admin'),
    ],
    [
      'PATCH payment-status cancelado',
      (s: CourtsService, id: string) =>
        s.updatePaymentStatus(EMPRESA, id, 'cancelado', UADMIN),
    ],
  ])(
    'AC-012 (#14): a reserva troca de aluno entre a espiada e a trava ⇒ 409 RESERVA_MUDOU_DE_ALUNO pelo %s, sem escrita',
    async (_caminho, cancelar) => {
      // Reserva do GESTOR para o aluno de saldo zero: nasce pendente e SEM
      // consumo (PA-04) — a única que admite trocar de aluno.
      const reserva = await reservarNo('company_admin', ALUNO2);
      expect(await movimentos(reserva.id)).toEqual([]);

      const { servico, estado } = courtsComGancho(() =>
        outra.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET aluno_id = '${ALUNO}' WHERE id = '${reserva.id}'`,
        ),
      );
      // A fotografia é do estado DEPOIS da troca: o que o gesto recusado não
      // pode mudar é o resto.
      await outra.$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET aluno_id = '${ALUNO}' WHERE id = '${reserva.id}'`,
      );
      const foto = await fotografia(reserva.id);
      await outra.$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET aluno_id = '${ALUNO2}' WHERE id = '${reserva.id}'`,
      );

      await expect(cancelar(servico, reserva.id)).rejects.toMatchObject({
        response: { code: 'RESERVA_MUDOU_DE_ALUNO' },
      });
      // Sem isto o teste passaria sem o gancho ter rodado.
      expect(estado.disparou).toBe(true);
      expect(await fotografia(reserva.id)).toEqual(foto);
      expect(foto.linha.status_pagamento).toBe('pendente_pagamento');
      expect(foto.linha.aluno_id).toBe(ALUNO);
    },
  );

  it('AC-014 (#17): 20 min a R$ 80/h PELO SERVIÇO ⇒ consumo de 2667 centavos, igual a `valor × 100` lido do banco', async () => {
    await creditar(10_000);
    const reserva = await reservarNo('aluno', ALUNO, {
      horaInicio: '10:00',
      horaFim: '10:20',
    });

    const [linha] = await db.$queryRawUnsafe<
      { valor: string; centavos_do_banco: number }[]
    >(
      `SELECT valor::text AS valor, (valor * 100)::int AS centavos_do_banco
         FROM ocupacoes_quadra WHERE id = '${reserva.id}'`,
    );
    expect(linha.valor).toBe('26.67');
    expect(await movimentos(reserva.id)).toEqual([
      { tipo: 'consumo', valor_centavos: linha.centavos_do_banco },
    ]);
    // O número, e não só a igualdade: `2666` é o que a conta de memória
    // truncada daria, e o FIT-031 mostra por quê.
    expect(linha.centavos_do_banco).toBe(2667);
  });
});
