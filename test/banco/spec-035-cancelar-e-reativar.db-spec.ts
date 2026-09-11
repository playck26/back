/**
 * SPEC-035 — cancelar e reativar, contra o banco de verdade.
 *
 * ## Este arquivo nasceu de um ENSAIO que passou, e passar era o defeito
 *
 * Antes de escrever uma linha de código eu medi o estado de hoje
 * (`ensaio-035-estado.db-spec.ts`, removido depois de virar isto aqui):
 *
 * ```
 * >> turma.status ............. inativa
 * >> ocupacao.status_pagamento  pendente_pagamento
 * >> slot 09:00-10:00 ......... ocupado_turma
 * ```
 *
 * **Inativar a turma deixava a quadra bloqueada para sempre.** O Admin tinha
 * o botão desde a SPEC-008; o back gravava a coluna e não fazia mais nada. O
 * backlog dizia "item 12, 50% — a coluna existe"; a coluna sozinha não é soft
 * delete.
 *
 * Os casos abaixo são aquele ensaio **invertido**. É por isso que a sabotagem
 * de cada um é fácil de descrever: remover o conserto devolve exatamente o
 * texto medido acima.
 *
 * ## O que só o banco decide, e está aqui por isso
 *
 * - a `EXCLUDE no_overlap_por_quadra` recusando o `UPDATE` que descancela
 *   (`23P01`) — **mesmo sem a pré-checagem da aplicação**;
 * - a trigger `ocupacao_reativada_exige_evento` (INV-106) recusando o
 *   descancelamento sem evento (`23514`).
 *
 * Nenhum dos dois é observável por mock.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = 'c0350000-0000-4000-8000-000000000001';
const QUADRA = 'c0350000-0000-4000-8000-000000000002';
const TURMA = 'c0350000-0000-4000-8000-000000000003';
const ADMIN = 'c0350000-0000-4000-8000-000000000004';
const ALUNO_U = 'c0350000-0000-4000-8000-000000000005';
const ALUNO = 'c0350000-0000-4000-8000-000000000006';

const db = new PrismaClient();

/** `AAAA-MM-DD` a `dias` de distância, no mesmo fuso que o corte usa. */
function emDias(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
function diaDaSemana(data: string): number {
  return new Date(`${data}T00:00:00Z`).getUTCDay();
}

/** Daqui a duas semanas: futuro folgado, longe do corte de "hoje". */
const FUTURO = emDias(14);
const PASSADO = emDias(-14);

function courts(cliente: PrismaClient = db): CourtsService {
  return new CourtsService(
    cliente as unknown as PrismaService,
    {} as unknown as StudentsService,
    new HorarioFuncionamentoService(cliente as unknown as PrismaService),
    {} as unknown as ImagemDaQuadraService,
    new ConfigOperacaoService(cliente as unknown as PrismaService),
    new CreditosService(),
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
}

function classes(cliente: PrismaClient = db): ClassesService {
  return new ClassesService(
    cliente as unknown as PrismaService,
    courts(cliente),
    {} as unknown as StudentsService,
    new ConfigOperacaoService(cliente as unknown as PrismaService),
  );
}

const q = (sql: string) => db.$executeRawUnsafe(sql);

/**
 * Empresa, quadra, turma com UM encontro no dia de `FUTURO`, e as duas
 * ocupações que os casos observam: uma futura e uma passada.
 *
 * **Semeado por teste, não por `beforeAll`.** A lição da SPEC-039: as tabelas
 * append-only (`eventos_de_ocupacao`, `acoes_administrativas`) têm trigger que
 * recusa `DELETE`, então limpar entre casos exige `limparEmpresa` inteiro — e
 * resíduo de um caso fazia o seguinte falhar por conflito de quadra, com uma
 * mensagem que não apontava para a causa.
 *
 * As ocupações nascem no estado pedido, e **`cancelado` se pede no `INSERT`,
 * nunca por `UPDATE` depois.**
 *
 * A primeira versão desta fixture cancelava com `UPDATE ... SET
 * status_pagamento='cancelado'` e levou `23514` da
 * `ocupacao_cancelada_exige_evento` (INV-064) — a trigger é `AFTER UPDATE` e
 * exige o evento no mesmo COMMIT. **O teste não conseguiu trapacear porque a
 * invariante é de verdade**, e o registro fica aqui em vez de o contorno
 * parecer arbitrário.
 */
async function montar(
  opcoes: {
    statusDaTurma?: 'ativa' | 'inativa';
    statusDaFutura?: 'pendente_pagamento' | 'cancelado';
    statusDaPassada?: 'pendente_pagamento' | 'cancelado';
  } = {},
) {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-035','spec-035-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Quadra 035',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80)`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ADMIN}','admin035@teste.local','x','Gestor','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ALUNO_U}','aluno035@teste.local','x','Ana','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${ALUNO}','${ALUNO_U}','${EMPRESA}','aprovado')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','Turma 035','${QUADRA}',20,'${opcoes.statusDaTurma ?? 'ativa'}')`,
  );
  await q(
    `INSERT INTO turma_encontros (id,turma_id,dia_semana,hora_inicio,hora_fim,created_at) VALUES (gen_random_uuid(),'${TURMA}',${diaDaSemana(FUTURO)},'09:00','10:00',now())`,
  );
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA}','${ALUNO}',now())`,
  );
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${FUTURO}','09:00','10:00','TURMA','${TURMA}','${opcoes.statusDaFutura ?? 'pendente_pagamento'}',now())`,
  );
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${PASSADO}','09:00','10:00','TURMA','${TURMA}','${opcoes.statusDaPassada ?? 'pendente_pagamento'}',now())`,
  );
}

async function ocupacoes(): Promise<
  { data: string; status: string; id: string }[]
> {
  const linhas = await db.ocupacaoQuadra.findMany({
    where: { companyId: EMPRESA, origemTurmaId: TURMA },
    select: { id: true, data: true, statusPagamento: true },
    orderBy: { data: 'asc' },
  });
  return linhas.map((l) => ({
    id: l.id,
    data: l.data.toISOString().slice(0, 10),
    status: l.statusPagamento,
  }));
}

/**
 * **Falha se o pedido PASSAR.**
 *
 * `promessa.catch(e => expect(...))` fica verde quando nada é lançado — foi o
 * furo que a SPEC-039 achou nos próprios testes, e não vai voltar por aqui.
 */
async function recusa(promessa: Promise<unknown>): Promise<{
  status: number;
  corpo: Record<string, unknown>;
}> {
  try {
    await promessa;
  } catch (erro) {
    const e = erro as { status?: number; response?: Record<string, unknown> };
    return { status: e.status ?? 0, corpo: e.response ?? {} };
  }
  throw new Error('o pedido PASSOU, e deveria ter sido recusado');
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-035/REQ-001 — inativar libera a quadra', () => {
  it('AC-001/AC-002: cancela a FUTURA e não toca a PASSADA', async () => {
    await montar();
    await classes().update(
      EMPRESA,
      TURMA,
      { status: 'inativa' } as never,
      ADMIN,
    );

    const linhas = await ocupacoes();
    const passada = linhas.find((l) => l.data === PASSADO);
    const futura = linhas.find((l) => l.data === FUTURO);

    // **Estas duas asserções são o ensaio invertido.** Antes do conserto, a
    // futura vinha `pendente_pagamento`.
    expect(futura?.status).toBe('cancelado');
    expect(passada?.status).toBe('pendente_pagamento');
  });

  it('e a quadra volta a ficar LIVRE no horário dela', async () => {
    await montar();
    await classes().update(
      EMPRESA,
      TURMA,
      { status: 'inativa' } as never,
      ADMIN,
    );

    const disp = await courts().availability(EMPRESA, QUADRA, FUTURO);
    // O ensaio media `ocupado_turma` aqui — quadra travada apontando para uma
    // turma fora de operação, sem nenhuma tela que explicasse.
    expect(disp.slots.find((s) => s.slot === '09:00-10:00')?.status).toBe(
      'livre',
    );
  });

  it('AC-003: UMA ação `turma_inativada`, e um evento por ocupação', async () => {
    await montar();
    await classes().update(
      EMPRESA,
      TURMA,
      { status: 'inativa' } as never,
      ADMIN,
    );

    const acoes = await db.acaoAdministrativa.findMany({
      where: { companyId: EMPRESA },
    });
    const eventos = await db.eventoDeOcupacao.findMany({
      where: { companyId: EMPRESA },
    });

    // INV-078: uma ação por comando lógico. Dois registradores no mesmo gesto
    // criariam duas ações e o banco não reclamaria — por isso a contagem.
    expect(acoes).toHaveLength(1);
    expect(acoes[0].tipo).toBe('turma_inativada');
    expect(eventos).toHaveLength(1);
    expect(eventos[0].tipo).toBe('cancelada');
    expect(eventos[0].acaoId).toBe(acoes[0].id);
  });

  it('AC-004: inativar de novo é idempotente — nenhuma ação nova', async () => {
    await montar();
    const s = classes();
    await s.update(EMPRESA, TURMA, { status: 'inativa' } as never, ADMIN);
    await s.update(EMPRESA, TURMA, { status: 'inativa' } as never, ADMIN);

    // Rede instável repete `PATCH`. Auditoria que conta tentativas em vez de
    // gestos é a razão de o `RegistradorDeAcao` ser preguiçoso.
    expect(
      await db.acaoAdministrativa.count({ where: { companyId: EMPRESA } }),
    ).toBe(1);
  });

  it('AC-005: `turma_alunos` não é tocado', async () => {
    await montar();
    await classes().update(
      EMPRESA,
      TURMA,
      { status: 'inativa' } as never,
      ADMIN,
    );
    // D9 — inativar é reversível por definição; apagar matrícula não é.
    expect(await db.turmaAluno.count({ where: { turmaId: TURMA } })).toBe(1);
  });
});

describe('SPEC-035/REQ-002 — reativar reconfere o horário', () => {
  it('AC-006/AC-009: regenera a grade futura e grava `turma_reativada`', async () => {
    await montar();
    const s = classes();
    await s.update(EMPRESA, TURMA, { status: 'inativa' } as never, ADMIN);
    await s.update(EMPRESA, TURMA, { status: 'ativa' } as never, ADMIN);

    const vivas = (await ocupacoes()).filter((l) => l.status !== 'cancelado');
    // 8 semanas de janela (`JANELA_OCUPACOES_TURMA_SEMANAS`) + a passada, que
    // nunca foi cancelada. **A grade nasce de hoje para frente** (D3): as
    // linhas antigas ficam canceladas como registro.
    expect(vivas.length).toBe(9);
    expect(vivas.filter((l) => l.data === PASSADO)).toHaveLength(1);

    const tipos = (
      await db.acaoAdministrativa.findMany({
        where: { companyId: EMPRESA },
        orderBy: { criadoEm: 'asc' },
      })
    ).map((a) => a.tipo);
    expect(tipos).toEqual(['turma_inativada', 'turma_reativada']);
  });

  it('AC-007: uma reserva no lugar RECUSA a reativação inteira, com a lista', async () => {
    await montar();
    const s = classes();
    await s.update(EMPRESA, TURMA, { status: 'inativa' } as never, ADMIN);

    // Alguém reservou o horário enquanto a turma estava desligada — que é
    // exatamente o que liberar a quadra torna possível, e por isso a
    // reativação precisa reconferir.
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${FUTURO}','09:00','10:00','AVULSO','${ALUNO}',80,'pago',now())`,
    );

    const { status, corpo } = await recusa(
      s.update(EMPRESA, TURMA, { status: 'ativa' } as never, ADMIN),
    );
    expect(status).toBe(409);
    expect(Array.isArray(corpo.conflicts)).toBe(true);

    // **D4 — tudo ou nada.** Reativação parcial produziria uma turma ativa com
    // buracos invisíveis na grade, e a descoberta viria por aluno reclamando.
    const turma = await db.turma.findUniqueOrThrow({ where: { id: TURMA } });
    expect(turma.status).toBe('inativa');
    const daTurma = (await ocupacoes()).filter(
      (l) => l.status !== 'cancelado' && l.data === FUTURO,
    );
    expect(daTurma).toHaveLength(0);
  });

  it('turma inativada ANTES desta spec (grade viva) reativa sem bater em si mesma', async () => {
    // O estado que o defeito deixou em produção: `status = inativa` com as
    // ocupações **vivas**. Regerar por cima bateria na `EXCLUDE` contra as
    // próprias linhas — é por isso que a reativação cancela antes de gerar.
    await montar({ statusDaTurma: 'inativa' });

    await classes().update(EMPRESA, TURMA, { status: 'ativa' } as never, ADMIN);

    const vivas = (await ocupacoes()).filter((l) => l.status !== 'cancelado');
    expect(vivas.length).toBe(9);
  });

  it('editar o horário de turma INATIVA não gera ocupação viva (INV-107)', async () => {
    // Defeito irmão, que ninguém pediu para consertar: amarrar a regeneração
    // ao status resolve os dois com uma condição só.
    await montar({
      statusDaTurma: 'inativa',
      statusDaFutura: 'cancelado',
      statusDaPassada: 'cancelado',
    });

    await classes().update(
      EMPRESA,
      TURMA,
      {
        encontros: [
          {
            diaSemana: diaDaSemana(FUTURO),
            horaInicio: '14:00',
            horaFim: '15:00',
          },
        ],
      },
      ADMIN,
    );

    const vivas = (await ocupacoes()).filter((l) => l.status !== 'cancelado');
    expect(vivas).toHaveLength(0);
  });
});

describe('SPEC-035/REQ-003 — reativar UMA ocorrência', () => {
  async function cancelarAFutura(): Promise<string> {
    const alvo = (await ocupacoes()).find((l) => l.data === FUTURO);
    await classes().cancelarOcorrencia(
      EMPRESA,
      TURMA,
      alvo!.id,
      'Cancelada por engano',
      ADMIN,
    );
    return alvo!.id;
  }

  it('AC-011/AC-014: descancela a MESMA linha e grava `reativada`', async () => {
    await montar();
    const id = await cancelarAFutura();

    await classes().reativarOcorrencia(
      EMPRESA,
      TURMA,
      id,
      'Foi engano, a aula acontece',
      ADMIN,
    );

    const linha = await db.ocupacaoQuadra.findUniqueOrThrow({ where: { id } });
    // **A mesma linha**, e não uma nova (D5): ocorrência é uma data
    // específica, não uma grade.
    expect(linha.statusPagamento).toBe('pendente_pagamento');

    const evento = await db.eventoDeOcupacao.findFirstOrThrow({
      where: { ocupacaoId: id, tipo: 'reativada' },
    });
    // INV-106: o `transicao_id` da linha tem de casar com o do evento — é o
    // que a trigger confere no COMMIT.
    expect(evento.transicaoId).toBe(linha.transicaoId);
  });

  it('AC-012: horário tomado recusa com `HORARIO_OCUPADO` e NOMEIA quem tomou', async () => {
    await montar();
    const id = await cancelarAFutura();
    const invasoraId = 'c0350000-0000-4000-8000-0000000000ff';
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,status_pagamento,updated_at) VALUES ('${invasoraId}','${EMPRESA}','${QUADRA}','${FUTURO}','09:00','10:00','AVULSO','${ALUNO}',80,'pago',now())`,
    );

    const { status, corpo } = await recusa(
      classes().reativarOcorrencia(EMPRESA, TURMA, id, 'Tentativa', ADMIN),
    );
    expect(status).toBe(409);
    expect(corpo.code).toBe('HORARIO_OCUPADO');
    // "Recusar COM AVISO" (item 13 do backlog) é isto: o gestor não precisa
    // caçar na agenda quem ocupou.
    expect(corpo.conflictWith).toEqual({
      ocupacaoId: invasoraId,
      origemTipo: 'AVULSO',
    });
  });

  it('AC-013: o passado não reativa', async () => {
    await montar({ statusDaPassada: 'cancelado' });
    const passada = (await ocupacoes()).find((l) => l.data === PASSADO)!;

    const { status, corpo } = await recusa(
      classes().reativarOcorrencia(
        EMPRESA,
        TURMA,
        passada.id,
        'Tentativa',
        ADMIN,
      ),
    );
    expect(status).toBe(409);
    expect(corpo.code).toBe('PRAZO_DE_CANCELAMENTO');
  });

  it('AC-015: a URL da turma A não alcança a ocorrência da B', async () => {
    await montar();
    const outraTurma = 'c0350000-0000-4000-8000-0000000000aa';
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${outraTurma}','${EMPRESA}','Outra','${QUADRA}',10,'ativa')`,
    );
    const id = await cancelarAFutura();

    const { status } = await recusa(
      classes().reativarOcorrencia(EMPRESA, outraTurma, id, 'Tentativa', ADMIN),
    );
    expect(status).toBe(404);
  });

  it('reativar o que já está no ar é idempotente', async () => {
    await montar();
    const alvo = (await ocupacoes()).find((l) => l.data === FUTURO)!;
    await classes().reativarOcorrencia(
      EMPRESA,
      TURMA,
      alvo.id,
      'Nada a fazer',
      ADMIN,
    );
    expect(
      await db.acaoAdministrativa.count({ where: { companyId: EMPRESA } }),
    ).toBe(0);
  });
});

describe('SPEC-035/TASK-004 — a PORTA da reativação', () => {
  it('lista a cancelada FUTURA, com `horarioLivre`, e ignora a passada', async () => {
    await montar({ statusDaPassada: 'cancelado' });
    const alvo = (await ocupacoes()).find((l) => l.data === FUTURO)!;
    await classes().cancelarOcorrencia(
      EMPRESA,
      TURMA,
      alvo.id,
      'Cancelada por engano',
      ADMIN,
    );

    const lista = await classes().ocorrenciasCanceladas(EMPRESA, TURMA);

    // **A passada não entra.** A lista não é histórico: é o que ainda dá para
    // desfazer, e oferecer o passado seria um botão que só sabe recusar.
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      ocupacaoId: alvo.id,
      data: FUTURO,
      horaInicio: '09:00',
      horaFim: '10:00',
      quadraNome: 'Quadra 035',
      horarioLivre: true,
    });
  });

  it('`horarioLivre: false` quando alguém tomou o lugar', async () => {
    await montar();
    const alvo = (await ocupacoes()).find((l) => l.data === FUTURO)!;
    await classes().cancelarOcorrencia(
      EMPRESA,
      TURMA,
      alvo.id,
      'Engano',
      ADMIN,
    );
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${FUTURO}','09:00','10:00','AVULSO','${ALUNO}',80,'pago',now())`,
    );

    const lista = await classes().ocorrenciasCanceladas(EMPRESA, TURMA);
    // A tela avisa ANTES; quem decide continua sendo a `EXCLUDE` no `POST`.
    expect(lista[0].horarioLivre).toBe(false);
  });

  it('turma de outra empresa devolve 404, e não lista vazia', async () => {
    await montar();
    const { status } = await recusa(
      classes().ocorrenciasCanceladas(
        '00000000-0000-4000-8000-000000000999',
        TURMA,
      ),
    );
    expect(status).toBe(404);
  });
});

describe('SPEC-035 — o que só o BANCO decide', () => {
  it('INV-106: descancelar SEM evento é recusado com 23514', async () => {
    await montar();
    const alvo = (await ocupacoes()).find((l) => l.data === FUTURO)!;
    await classes().cancelarOcorrencia(
      EMPRESA,
      TURMA,
      alvo.id,
      'Para o ensaio',
      ADMIN,
    );

    const erro = await db
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET status_pagamento='pendente_pagamento', transicao_id=gen_random_uuid() WHERE id='${alvo.id}'`,
        );
        return null;
      })
      .catch((e: Error) => e);

    expect(erro).toBeInstanceOf(Error);
    // A metade que faltava da INV-064: até esta spec, descancelar não exigia
    // evento nenhum — e até esta spec não existia caminho que descancelasse.
    expect(String((erro as Error).message)).toContain('INV-106');
  });

  it('INV-106: evento de OUTRA transição também é recusado', async () => {
    await montar();
    const alvo = (await ocupacoes()).find((l) => l.data === FUTURO)!;
    await classes().cancelarOcorrencia(
      EMPRESA,
      TURMA,
      alvo.id,
      'Para o ensaio',
      ADMIN,
    );

    const erro = await db
      .$transaction(async (tx) => {
        const acao = await tx.acaoAdministrativa.create({
          data: {
            companyId: EMPRESA,
            tipo: 'aula_reativada',
            autorId: ADMIN,
          },
          select: { id: true },
        });
        await tx.$executeRawUnsafe(
          `UPDATE ocupacoes_quadra SET status_pagamento='pendente_pagamento', transicao_id=gen_random_uuid() WHERE id='${alvo.id}'`,
        );
        // Evento com transição PRÓPRIA, diferente da que ficou na linha.
        await tx.eventoDeOcupacao.create({
          data: {
            companyId: EMPRESA,
            acaoId: acao.id,
            ocupacaoId: alvo.id,
            tipo: 'reativada',
            transicaoId: '00000000-0000-4000-8000-000000000000',
          },
        });
        return null;
      })
      .catch((e: Error) => e);

    expect(String((erro as Error).message)).toContain('INV-106');
  });

  it('a EXCLUDE recusa o UPDATE que descancela, SEM pré-checagem nenhuma', async () => {
    await montar();
    const alvo = (await ocupacoes()).find((l) => l.data === FUTURO)!;
    await classes().cancelarOcorrencia(
      EMPRESA,
      TURMA,
      alvo.id,
      'Para o ensaio',
      ADMIN,
    );
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${FUTURO}','09:00','10:00','AVULSO','${ALUNO}',80,'pago',now())`,
    );

    // **Direto no banco, sem passar pela aplicação.** É o que prova que a
    // pré-checagem do serviço é conveniência e a garantia é da constraint —
    // e é por isso que a corrida do FIT-034 tem um vencedor só.
    const erro = await db
      .$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET status_pagamento='pendente_pagamento' WHERE id='${alvo.id}'`,
      )
      .then(() => null)
      .catch((e: unknown) => e);

    expect(erro).not.toBeNull();
    const codigo = (erro as Prisma.PrismaClientKnownRequestError).meta?.code;
    expect(codigo).toBe('23P01');
  });
});
