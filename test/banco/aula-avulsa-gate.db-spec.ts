/**
 * SPEC-039/TASK-002 — **os quatro portões da aula particular, contra Postgres
 * real.**
 *
 * ## Por que db-spec e não unitário
 *
 * Três dos quatro portões perguntam ao banco: a ficha do professor, a janela
 * de atendimento (`disponibilidades_professor`, que a SPEC-040 criou) e a
 * ocupação já existente. O quarto — a corrida — depende da `EXCLUDE`. Um
 * unitário com Prisma mockado provaria o `if`, não a regra.
 *
 * ## O portão que existe porque o banco não alcança (LIM-039f)
 *
 * A `EXCLUDE no_overlap_por_professor` só enxerga
 * `ocupacoes_quadra.professor_id`, e a ocorrência de TURMA guarda o professor
 * **na turma** — o `CHECK` proíbe a coluna na linha dela. **Medido:** aula de
 * turma às 14h na quadra 1 e particular do mesmo professor às 14h na quadra 2
 * passam as duas no banco. Este gate é a única defesa desse caso, e o caso
 * `LIM-039f` abaixo é o que prova que ela funciona.
 */
import { PrismaClient } from '@prisma/client';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CourtsService } from '../../src/courts/courts.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const EMPRESA = 'e0390000-0000-4000-8000-000000000001';
const UADMIN = 'e0390000-0000-4000-8000-000000000002';
const UALUNO = 'e0390000-0000-4000-8000-000000000003';
const ALUNO = 'e0390000-0000-4000-8000-000000000004';
const QUADRA_1 = 'e0390000-0000-4000-8000-000000000005';
const QUADRA_2 = 'e0390000-0000-4000-8000-000000000006';
const PROF = 'e0390000-0000-4000-8000-000000000007';
const PROF_INATIVO = 'e0390000-0000-4000-8000-000000000008';
const PROF_DE_OUTRA = 'e0390000-0000-4000-8000-000000000009';
const EMPRESA_B = 'e0390000-0000-4000-8000-00000000000a';
const TURMA = 'e0390000-0000-4000-8000-00000000000b';

const prisma = db as unknown as PrismaService;
const courts = new CourtsService(
  prisma,
  { exigirVinculoAprovado: () => undefined } as unknown as StudentsService,
  new HorarioFuncionamentoService(prisma),
  {} as unknown as ImagemDaQuadraService,
  new ConfigOperacaoService(prisma),
  new CreditosService(),
  // **Serviço de verdade, não dublê.** O que está em julgamento é a janela de
  // atendimento que a SPEC-040 gravou; um dublê provaria o `if` e não a regra.
  new DisponibilidadeProfessorService(prisma),
);

/**
 * Uma quinta-feira futura. `2035-06-07` é quinta (dia 4), e o cenário grava a
 * disponibilidade nesse dia — data e dia da semana têm de casar, senão o teste
 * verde não diria nada sobre a janela.
 */
const DATA = '2035-06-07';
const DIA_SEMANA_DA_DATA = 4;

function reservar(campos: {
  quadraId?: string;
  professorId?: string;
  horaInicio?: string;
  horaFim?: string;
  valor?: number;
}) {
  return courts.createBooking(
    EMPRESA,
    {
      quadraId: campos.quadraId ?? QUADRA_1,
      data: DATA,
      slots: [
        {
          horaInicio: campos.horaInicio ?? '10:00',
          horaFim: campos.horaFim ?? '11:00',
        },
      ],
      alunoId: ALUNO,
      professorId: campos.professorId,
      valor: campos.valor,
    },
    UADMIN,
  );
}

/**
 * O corpo da recusa — e **falha se não houve recusa**.
 *
 * A primeira versão deste arquivo usava `promessa.catch((e) => expect(...))`,
 * que passa em SILÊNCIO quando nada é lançado: o gate podia estar desligado e
 * os casos ficariam verdes. É o antipadrão que a revisão adversarial deste
 * ciclo mandou procurar — "afirmar ausência sem afirmar presença" —, e ele
 * apareceu no meu próprio arquivo na mesma tarde.
 */
async function recusa(
  promessa: Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  try {
    await promessa;
  } catch (erro) {
    const r = (erro as { getResponse?: () => unknown }).getResponse?.();
    return (r ?? { message: String(erro) }) as {
      code?: string;
      message: string;
    };
  }
  throw new Error('esperava recusa, e o pedido passou');
}

/**
 * O cenário inteiro, **por teste**.
 *
 * A primeira versão semeava uma vez e limpava `eventos_de_ocupacao` no
 * `afterEach` — e essa tabela é **append-only** (SPEC-032/INV-061): o
 * `DELETE` é recusado com `23514`. O resíduo entao sobrevivia entre os casos,
 * e o teste do `404` batia num conflito de QUADRA antes de chegar ao portão
 * do professor: recebia `ConflictException` e acusava a coisa errada.
 *
 * `limparEmpresa` conhece a válvula da append-only. Semear por teste custa
 * segundos e compra independência — que é o que faltou.
 */
async function semear() {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, EMPRESA_B);
  for (const [id, slug] of [
    [EMPRESA, 'gate-a'],
    [EMPRESA_B, 'gate-b'],
  ] as const) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${id}','Clube 039 ${slug}','clube-039-${slug}',now())`,
    );
  }
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UADMIN}','gate-admin@t.local','x','Admin','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UALUNO}','gate-aluno@t.local','x','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA}')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,status) VALUES ('${PROF}','${EMPRESA}','Ativo','ativo')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,status) VALUES ('${PROF_INATIVO}','${EMPRESA}','Inativo','inativo')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,status) VALUES ('${PROF_DE_OUTRA}','${EMPRESA_B}','Alheio','ativo')`,
  );
  for (const [empresa, id, nome] of [
    [EMPRESA, QUADRA_1, 'Q1'],
    [EMPRESA, QUADRA_2, 'Q2'],
  ] as const) {
    await q(
      `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at)
       SELECT gen_random_uuid(),'${empresa}','Tenis',0,now()
        WHERE NOT EXISTS (SELECT 1 FROM esportes_de_quadra WHERE company_id='${empresa}')`,
    );
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora)
       VALUES ('${id}','${empresa}','${nome}',
               (SELECT id FROM esportes_de_quadra WHERE company_id='${empresa}' LIMIT 1),100)`,
    );
  }
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,professor_id)
     VALUES ('${TURMA}','${EMPRESA}','T1','${QUADRA_1}',10,'${PROF}')`,
  );
  // O clube abre cedo e fecha tarde: o expediente da quadra não pode ser o que
  // recusa, senão o teste da janela do PROFESSOR provaria outra coisa.
  for (let dia = 0; dia < 7; dia++) {
    await q(
      `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,fechado,hora_inicio,hora_fim,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}',NULL,${dia},false,'06:00','23:00',now())`,
    );
  }
  // A janela do professor: 08:00–12:00 na quinta, e mais nada na semana.
  await q(
    `INSERT INTO disponibilidades_professor (id,company_id,professor_id,dia_semana,hora_inicio,hora_fim,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${PROF}',${DIA_SEMANA_DA_DATA},'08:00','12:00',now())`,
  );
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, EMPRESA_B);
  await semear();
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, EMPRESA_B);
  await db.$disconnect();
});

describe('SPEC-039/TASK-002 — os portões da aula particular', () => {
  it('AC-001: dentro da janela, a aula nasce AVULSO com o professor e o preço do clube', async () => {
    await reservar({ professorId: PROF, valor: 250 });

    const [linha] = await db.$queryRawUnsafe<
      { origem_tipo: string; professor_id: string; valor: string }[]
    >(`SELECT origem_tipo, professor_id, valor::text
         FROM ocupacoes_quadra WHERE company_id = '${EMPRESA}'`);
    // `AVULSO`, e não um `origem_tipo` novo (D1) — é o que faz a carteira
    // funcionar sem uma linha de migration.
    expect(linha.origem_tipo).toBe('AVULSO');
    expect(linha.professor_id).toBe(PROF);
    // O preço é o do CLUBE (250), não `precoHora × horas` (100).
    expect(Number(linha.valor)).toBe(250);
  });

  it('AC-001: sem `professorId` o comportamento é o de hoje, byte por byte', async () => {
    await reservar({});
    const [linha] = await db.$queryRawUnsafe<
      { professor_id: string | null; valor: string }[]
    >(
      `SELECT professor_id, valor::text FROM ocupacoes_quadra WHERE company_id = '${EMPRESA}'`,
    );
    expect(linha.professor_id).toBeNull();
    expect(Number(linha.valor)).toBe(100);
  });

  it('AC-002: professor de outra empresa devolve 404, nunca 403', async () => {
    await expect(
      reservar({ professorId: PROF_DE_OUTRA }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // E nada foi gravado: o portão é anterior à transação.
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ocupacoes_quadra WHERE company_id = '${EMPRESA}'`,
    );
    expect(n).toBe(0);
  });

  it('AC-005: professor inativo devolve 422 PROFESSOR_INATIVO', async () => {
    const r = await recusa(reservar({ professorId: PROF_INATIVO }));
    expect(r.code).toBe('PROFESSOR_INATIVO');
  });

  it('AC-003: fora da janela devolve 422 FORA_DA_DISPONIBILIDADE, com a janela na mensagem', async () => {
    // A janela é 08:00–12:00; 14:00 está fora, e a quadra abre até 23:00 —
    // então quem recusa é o professor, não o expediente.
    const r = await recusa(
      reservar({
        professorId: PROF,
        horaInicio: '14:00',
        horaFim: '15:00',
        valor: 100,
      }),
    );
    expect(r.code).toBe('FORA_DA_DISPONIBILIDADE');
    expect(r.message).toContain('08:00');
    expect(r.message).toContain('12:00');
  });

  it('AC-003: o bloco que ATRAVESSA o fim da janela também é recusado', async () => {
    // 11:00–13:00 começa dentro e termina fora. Um gate que só olhasse o
    // início deixaria passar uma aula que invade o fim do expediente dele.
    const r = await recusa(
      reservar({
        professorId: PROF,
        horaInicio: '11:00',
        horaFim: '13:00',
        valor: 100,
      }),
    );
    expect(r.code).toBe('FORA_DA_DISPONIBILIDADE');
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ocupacoes_quadra WHERE company_id = '${EMPRESA}'`,
    );
    expect(n).toBe(0);
  });

  it('AC-004: dia SEM linha nenhuma recusa igual — ausência é "não atende"', async () => {
    // `2035-06-08` é sexta, e o professor só tem linha na quinta. É o estado
    // inicial de todo professor já cadastrado (SPEC-040/D3), e o contrário
    // abriria agenda para quem não combinou nada.
    const r = await recusa(
      courts.createBooking(
        EMPRESA,
        {
          quadraId: QUADRA_1,
          data: '2035-06-08',
          slots: [{ horaInicio: '09:00', horaFim: '10:00' }],
          alunoId: ALUNO,
          professorId: PROF,
          valor: 100,
        },
        UADMIN,
      ),
    );
    expect(r.code).toBe('FORA_DA_DISPONIBILIDADE');
    expect(r.message).toContain('não atende neste dia');
  });

  it('409 PROFESSOR_INDISPONIVEL: outra AULA do mesmo professor, em quadra diferente', async () => {
    await reservar({ professorId: PROF, valor: 100 });
    await expect(
      reservar({ professorId: PROF, quadraId: QUADRA_2, valor: 100 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('LIM-039f: a ocorrência de TURMA também bloqueia — e o BANCO não alcança este caso', async () => {
    // **O caso que este gate existe para cobrir.** A `EXCLUDE` só enxerga
    // `ocupacoes_quadra.professor_id`; a ocorrência de turma guarda o
    // professor na TURMA. Sem esta consulta, as duas passariam — medido.
    await q(
      `INSERT INTO ocupacoes_quadra
         (id, company_id, quadra_id, data, hora_inicio, hora_fim, origem_tipo,
          origem_turma_id, updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA_1}','${DATA}','10:00','11:00',
               'TURMA','${TURMA}',now())`,
    );
    const r = await recusa(
      reservar({ professorId: PROF, quadraId: QUADRA_2, valor: 100 }),
    );
    expect(r.code).toBe('PROFESSOR_INDISPONIVEL');
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ocupacoes_quadra
        WHERE company_id = '${EMPRESA}' AND origem_tipo = 'AVULSO'`,
    );
    expect(n).toBe(0);
  });

  it('aula CANCELADA do professor libera o horário', async () => {
    const criada = (await reservar({ professorId: PROF, valor: 100 })) as {
      reservas: { id: string }[];
    };
    // **Pelo serviço, não por `UPDATE` cru.** A primeira versão fazia o UPDATE
    // direto e a trigger diferida recusou com `23514`
    // (`ocupacao cancelada sem evento desta transicao`, SPEC-032/INV-064) —
    // que é a trigger fazendo o trabalho dela contra o meu atalho.
    await courts.cancelBooking(
      EMPRESA,
      criada.reservas[0].id,
      UADMIN,
      'company_admin',
    );
    // Sem o `status_pagamento <> 'cancelado'` na consulta, remarcar uma aula
    // cancelada seria impossível.
    await expect(
      reservar({ professorId: PROF, quadraId: QUADRA_2, valor: 100 }),
    ).resolves.toBeDefined();
  });

  it('D2: `valor` SEM `professorId` é recusado — o preço da quadra é da quadra', async () => {
    const r = await recusa(reservar({ valor: 999 }));
    expect(r.code).toBe('VALOR_SEM_PROFESSOR');
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ocupacoes_quadra WHERE company_id = '${EMPRESA}'`,
    );
    expect(n).toBe(0);
  });
});
