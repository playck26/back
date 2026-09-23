/**
 * SPEC-055 — **a reserva diz de quem é.**
 *
 * `OcupacaoResponseDto` trazia `alunoId` e não o nome, e a tela da quadra montava
 * o nome a partir de `listStudents(1, 100)`: com 101+ alunos, a reserva do aluno
 * 101 aparecia como "Aluno" (LIM-049e). Aqui, cada uma das SETE leituras que
 * viram resposta de reserva é conferida com banco real.
 */
import { PrismaClient } from '@prisma/client';
import { CourtsService } from '../../src/courts/courts.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';
import { comAcao } from './acao-com-efeito';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const EMPRESA = 'e0550000-0000-4000-8000-000000000001';
const UADMIN = 'e0550000-0000-4000-8000-000000000002';
const UANA = 'e0550000-0000-4000-8000-000000000003';
const ANA = 'e0550000-0000-4000-8000-000000000004';
const UBRUNO = 'e0550000-0000-4000-8000-000000000005';
const BRUNO = 'e0550000-0000-4000-8000-000000000006';
const QUADRA = 'e0550000-0000-4000-8000-000000000007';
const TURMA = 'e0550000-0000-4000-8000-000000000008';
const OCUPACAO_DA_TURMA = 'e0550000-0000-4000-8000-000000000009';

const DATA = '2035-06-07';

const prisma = db as unknown as PrismaService;
const courts = new CourtsService(
  prisma,
  { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
  new HorarioFuncionamentoService(prisma),
  {} as unknown as ImagemDaQuadraService,
  new ConfigOperacaoService(prisma),
  new CreditosService(),
  new DisponibilidadeProfessorService(prisma),
);

type Reserva = {
  id: string;
  alunoId: string | null;
  alunoNome?: string | null;
};

async function semear() {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube SPEC-055','clube-spec-055',now())`,
  );
  for (const [id, email, nome, role] of [
    [UADMIN, 'spec055-admin@t.local', 'Gestora', 'company_admin'],
    [UANA, 'spec055-ana@t.local', 'Ana Souza', 'aluno'],
    [UBRUNO, 'spec055-bruno@t.local', 'Bruno Lima', 'aluno'],
  ] as const) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
       VALUES ('${id}','${email}','x','${nome}','${role}','${EMPRESA}',now())`,
    );
  }
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ANA}','${UANA}','${EMPRESA}'),('${BRUNO}','${UBRUNO}','${EMPRESA}')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora)
     VALUES ('${QUADRA}','${EMPRESA}','Q1',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),100)`,
  );
  for (let dia = 0; dia < 7; dia++) {
    await q(
      `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,fechado,hora_inicio,hora_fim,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}',NULL,${dia},false,'06:00','23:00',now())`,
    );
  }
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade) VALUES ('${TURMA}','${EMPRESA}','T1','${QUADRA}',10)`,
  );
}

/** Saldo pela porta do ledger (a INV-071 recusa `UPDATE` direto). */
async function creditarAna(centavos: number) {
  // SPEC-069/INV-069a — **a acao e o efeito na MESMA transacao.** Em
  // autocommit o `INSERT` da acao commita sozinho, o `acao_exige_alvo` julga
  // ali e o movimento ainda nao existe: `23514` numa fixture que nunca foi o
  // defeito. O servico sempre gravou os dois juntos; era a fixture que nao.
  await comAcao(
    db,
    { companyId: EMPRESA, tipo: 'credito_lancado', autorId: UADMIN },
    (tx, acaoId) =>
      new CreditosService().lancar(tx, {
        companyId: EMPRESA,
        alunoId: ANA,
        valorCentavos: centavos,
        motivo: 'saldo para medir a SPEC-055',
        autorId: UADMIN,
        acaoId,
      }),
  );
}

async function reservarPeloGestor(
  alunoId: string,
  horaInicio: string,
  horaFim: string,
) {
  const r = (await courts.createBooking(
    EMPRESA,
    { quadraId: QUADRA, data: DATA, slots: [{ horaInicio, horaFim }], alunoId },
    UADMIN,
  )) as unknown as { reservas: Reserva[] };
  return r.reservas[0];
}

beforeEach(semear);

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-055 — o nome do aluno na reserva', () => {
  it('AC-001: o gestor reserva em nome da Ana, e a resposta diz "Ana Souza"', async () => {
    const reserva = await reservarPeloGestor(ANA, '10:00', '11:00');
    expect(reserva.alunoNome).toBe('Ana Souza');
  });

  it('AC-002: a própria Ana reserva, e a resposta diz o nome dela', async () => {
    await creditarAna(100_000);
    const r = (await courts.createBooking(
      EMPRESA,
      {
        quadraId: QUADRA,
        data: DATA,
        slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
        alunoId: ANA,
      },
      UANA,
      undefined,
      'aluno',
    )) as unknown as { reservas: Reserva[] };
    expect(r.reservas[0].alunoNome).toBe('Ana Souza');
  });

  it('AC-003: a listagem do gestor dá a CADA reserva o nome do seu dono', async () => {
    const daAna = await reservarPeloGestor(ANA, '10:00', '11:00');
    const doBruno = await reservarPeloGestor(BRUNO, '11:00', '12:00');

    const lista = (await courts.listBookings(EMPRESA, {})) as unknown as {
      data: Reserva[];
    };
    const nomePorId = new Map(lista.data.map((r) => [r.id, r.alunoNome]));
    expect(nomePorId.get(daAna.id)).toBe('Ana Souza');
    expect(nomePorId.get(doBruno.id)).toBe('Bruno Lima');
  });

  it('AC-004: a Ana só recebe as próprias reservas, e o nome é sempre o dela', async () => {
    const daAna = await reservarPeloGestor(ANA, '10:00', '11:00');
    const doBruno = await reservarPeloGestor(BRUNO, '11:00', '12:00');

    const lista = (await courts.listBookings(
      EMPRESA,
      {},
      ANA,
      UANA,
    )) as unknown as {
      data: Reserva[];
    };
    expect(lista.data.map((r) => r.id)).toEqual([daAna.id]);
    expect(lista.data.map((r) => r.id)).not.toContain(doBruno.id);
    expect(lista.data.every((r) => r.alunoNome === 'Ana Souza')).toBe(true);
  });

  it('AC-005: marcar pago, cancelar e mover devolvem o nome', async () => {
    const pendente = await reservarPeloGestor(BRUNO, '10:00', '11:00');
    const paga = (await courts.updatePaymentStatus(
      EMPRESA,
      pendente.id,
      'pago',
      UADMIN,
    )) as Reserva;
    expect(paga.alunoNome).toBe('Bruno Lima');

    // A segunda chamada cai no retorno antecipado ("já está nesse status") —
    // a leitura que o `tsc` já pegou uma vez sem os itens (SPEC-054).
    const deNovo = (await courts.updatePaymentStatus(
      EMPRESA,
      pendente.id,
      'pago',
      UADMIN,
    )) as Reserva;
    expect(deNovo.alunoNome).toBe('Bruno Lima');

    const outra = await reservarPeloGestor(BRUNO, '12:00', '13:00');
    const movida = (await courts.moveBooking(
      EMPRESA,
      outra.id,
      { horaInicio: '14:00', horaFim: '15:00' },
      UADMIN,
    )) as Reserva;
    expect(movida.alunoNome).toBe('Bruno Lima');

    const cancelada = (await courts.updatePaymentStatus(
      EMPRESA,
      outra.id,
      'cancelado',
      UADMIN,
    )) as Reserva;
    expect(cancelada.alunoNome).toBe('Bruno Lima');
  });

  it('AC-006: o replay de uma Idempotency-Key devolve o nome — no pedido novo e no legado', async () => {
    const dto = {
      quadraId: QUADRA,
      data: DATA,
      slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
      alunoId: BRUNO,
    };
    await courts.createBooking(EMPRESA, dto, UADMIN, 'spec055-chave');
    const replay = (await courts.createBooking(
      EMPRESA,
      dto,
      UADMIN,
      'spec055-chave',
    )) as unknown as {
      reservas: Reserva[];
    };
    expect(replay.reservas[0].alunoNome).toBe('Bruno Lima');

    // Formato antigo (uma hora, sem `slots`): o replay passa pelo caminho legado.
    const antigo = {
      quadraId: QUADRA,
      data: DATA,
      horaInicio: '15:00',
      horaFim: '16:00',
      alunoId: BRUNO,
    };
    await courts.createBooking(EMPRESA, antigo, UADMIN, 'spec055-chave-antiga');
    const replayAntigo = (await courts.createBooking(
      EMPRESA,
      antigo,
      UADMIN,
      'spec055-chave-antiga',
    )) as unknown as Reserva;
    expect(replayAntigo.alunoNome).toBe('Bruno Lima');
  });

  it('AC-007: ocupação de turma não tem aluno, e o nome é null', async () => {
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,updated_at)
       VALUES ('${OCUPACAO_DA_TURMA}','${EMPRESA}','${QUADRA}','${DATA}','20:00','21:00','TURMA','${TURMA}',now())`,
    );
    const lista = (await courts.listBookings(EMPRESA, {})) as unknown as {
      data: Reserva[];
    };
    const daTurma = lista.data.find((r) => r.id === OCUPACAO_DA_TURMA);
    expect(daTurma).toBeDefined();
    expect(daTurma?.alunoId).toBeNull();
    expect(daTurma?.alunoNome).toBeNull();
  });

  it('AC-008: renomear o aluno muda o nome na leitura seguinte — é leitura, não cópia', async () => {
    const reserva = await reservarPeloGestor(ANA, '10:00', '11:00');
    await q(`UPDATE usuarios SET nome = 'Ana Souza Lima' WHERE id = '${UANA}'`);
    const lista = (await courts.listBookings(EMPRESA, {})) as unknown as {
      data: Reserva[];
    };
    expect(lista.data.find((r) => r.id === reserva.id)?.alunoNome).toBe(
      'Ana Souza Lima',
    );
  });
});

/**
 * SPEC-059/D2 — **o que a reserva é, dito pelo servidor.**
 *
 * Reserva de quadra e aula particular são as duas `origemTipo: AVULSO`, e até
 * a SPEC-059 nada as separava no payload — o app não tinha como escrever
 * "aula particular" porque não tinha como saber. A prova é em banco real
 * porque `tipo`, `professorNome` e `quadraNome` saem de duas relações lidas
 * na mesma consulta: um mock devolveria o que eu mandasse devolver.
 */
describe('SPEC-059 — tipo, professor e quadra na listagem', () => {
  const UPROF = 'e0550000-0000-4000-8000-0000000000a1';
  const PROF = 'e0550000-0000-4000-8000-0000000000a2';

  type ItemDaLista = Reserva & {
    tipo?: string;
    professorNome?: string | null;
    quadraNome?: string;
  };

  async function comProfessor() {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
       VALUES ('${UPROF}','spec059-prof@t.local','x','Marcos Lima','professor','${EMPRESA}',now())
       ON CONFLICT (id) DO NOTHING`,
    );
    await q(
      `INSERT INTO professores (id,company_id,nome,usuario_id,preco_aula,created_at)
       VALUES ('${PROF}','${EMPRESA}','Marcos Lima','${UPROF}',150,now())
       ON CONFLICT (id) DO NOTHING`,
    );
    // SPEC-040 — aula particular exige o professor DISPONÍVEL no dia da
    // semana. `2035-06-07` é quinta (dia 4); sem esta linha o serviço recusa
    // com 422 FORA_DA_DISPONIBILIDADE, e foi o que aconteceu na primeira
    // tentativa desta fixture.
    await q(
      `INSERT INTO disponibilidades_professor (id,company_id,professor_id,dia_semana,hora_inicio,hora_fim,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}','${PROF}',4,'06:00','23:00',now())
       ON CONFLICT DO NOTHING`,
    );
  }

  const listar = async () =>
    (
      (await courts.listBookings(EMPRESA, {})) as unknown as {
        data: ItemDaLista[];
      }
    ).data;

  it('reserva sem professor é `quadra`, e traz o nome da quadra', async () => {
    const r = await reservarPeloGestor(ANA, '10:00', '11:00');

    const item = (await listar()).find((x) => x.id === r.id);

    expect(item?.tipo).toBe('quadra');
    expect(item?.professorNome).toBeNull();
    expect(item?.quadraNome).toBe('Q1');
  });

  it('reserva COM professor é `aula_particular`, e diz quem dá a aula', async () => {
    await comProfessor();
    const criada = (await courts.createBooking(
      EMPRESA,
      {
        quadraId: QUADRA,
        data: DATA,
        slots: [{ horaInicio: '14:00', horaFim: '15:00' }],
        alunoId: ANA,
        professorId: PROF,
      },
      UADMIN,
    )) as unknown as { reservas: Reserva[] };

    const item = (await listar()).find((x) => x.id === criada.reservas[0].id);

    expect(item?.tipo).toBe('aula_particular');
    expect(item?.professorNome).toBe('Marcos Lima');
    expect(item?.quadraNome).toBe('Q1');
  });

  /**
   * INV-005 continua valendo: o campo novo não pode virar caminho para o
   * aluno enxergar reserva de outro. Se alguém trocasse o escopo por
   * descuido ao mexer no `include`, é aqui que apareceria.
   */
  it('o aluno continua vendo só as dele, agora com tipo', async () => {
    const daAna = await reservarPeloGestor(ANA, '10:00', '11:00');
    await reservarPeloGestor(BRUNO, '11:00', '12:00');

    const lista = (
      (await courts.listBookings(EMPRESA, {}, ANA, UANA)) as unknown as {
        data: ItemDaLista[];
      }
    ).data;

    expect(lista.map((x) => x.id)).toEqual([daAna.id]);
    expect(lista[0].tipo).toBe('quadra');
  });
});

/**
 * SPEC-059/D5 — **a janela de datas da listagem**, que é o que o calendário
 * do aluno pede para desenhar um mês.
 */
describe('SPEC-059 — janela de datas em GET /bookings', () => {
  type Item = { id: string; data: string };
  const listar = async (query: Record<string, string>) =>
    ((await courts.listBookings(EMPRESA, query)) as unknown as { data: Item[] })
      .data;

  it('`de`/`ate` recortam o intervalo, inclusive nas pontas', async () => {
    const dentro = await reservarPeloGestor(ANA, '10:00', '11:00'); // DATA
    const fora = (await courts.createBooking(
      EMPRESA,
      {
        quadraId: QUADRA,
        data: '2035-06-20',
        slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
        alunoId: ANA,
      },
      UADMIN,
    )) as unknown as { reservas: Reserva[] };

    const ids = (await listar({ de: DATA, ate: DATA })).map((x) => x.id);

    expect(ids).toContain(dentro.id);
    expect(ids).not.toContain(fora.reservas[0].id);
  });

  /**
   * A primeira versão do filtro espalhava `data` e depois a janela no mesmo
   * objeto, e o segundo sobrescrevia o primeiro em silêncio. Aqui a regra
   * fica presa: o dia é mais específico e ganha.
   */
  it('`data` e janela juntos: o DIA vence, sem virar intervalo vazio', async () => {
    const noDia = await reservarPeloGestor(ANA, '10:00', '11:00');

    const ids = (
      await listar({ data: DATA, de: '2035-01-01', ate: '2035-01-02' })
    ).map((x) => x.id);

    expect(ids).toEqual([noDia.id]);
  });
});
