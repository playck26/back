/**
 * SPEC-054/AC-029 — **DEF-032: mover aula particular para um horário em que o
 * professor já tem aula.**
 *
 * ## O defeito, como a spec o registrou (por leitura, não por execução)
 *
 * A `EXCLUDE no_overlap_por_professor` dispara `23P01`. O catch do `moveBooking`
 * o trata como corrida perdida, procura conflito **só na quadra**
 * (`findConflito`), não acha — as duas aulas estão em quadras diferentes, por
 * definição do caso —, tenta de novo e relança: **`500`**. A criação traduz o
 * mesmo erro para `409 PROFESSOR_INDISPONIVEL`.
 *
 * Este arquivo roda **antes** do conserto. Se vier verde, o DEF-032 cai e fica
 * registrado que caiu.
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
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const EMPRESA = 'e0320000-0000-4000-8000-000000000001';
const UADMIN = 'e0320000-0000-4000-8000-000000000002';
const UALUNO = 'e0320000-0000-4000-8000-000000000003';
const ALUNO = 'e0320000-0000-4000-8000-000000000004';
const QUADRA_1 = 'e0320000-0000-4000-8000-000000000005';
const QUADRA_2 = 'e0320000-0000-4000-8000-000000000006';
const PROF = 'e0320000-0000-4000-8000-000000000007';

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

/** `2035-06-07` é quinta (4): a janela do professor é gravada nesse dia. */
const DATA = '2035-06-07';
const DIA_SEMANA_DA_DATA = 4;

async function semear() {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube DEF-032','clube-def-032',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UADMIN}','def032-admin@t.local','x','Admin','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UALUNO}','def032-aluno@t.local','x','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA}')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,status) VALUES ('${PROF}','${EMPRESA}','Prof','ativo')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  for (const [id, nome] of [
    [QUADRA_1, 'Q1'],
    [QUADRA_2, 'Q2'],
  ] as const) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora)
       VALUES ('${id}','${EMPRESA}','${nome}',
               (SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),100)`,
    );
  }
  for (let dia = 0; dia < 7; dia++) {
    await q(
      `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,fechado,hora_inicio,hora_fim,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}',NULL,${dia},false,'06:00','23:00',now())`,
    );
  }
  await q(
    `INSERT INTO disponibilidades_professor (id,company_id,professor_id,dia_semana,hora_inicio,hora_fim,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${PROF}',${DIA_SEMANA_DA_DATA},'08:00','18:00',now())`,
  );
}

async function aula(quadraId: string, horaInicio: string, horaFim: string) {
  const criada = (await courts.createBooking(
    EMPRESA,
    {
      quadraId,
      data: DATA,
      slots: [{ horaInicio, horaFim }],
      alunoId: ALUNO,
      professorId: PROF,
      valor: 250,
    },
    UADMIN,
  )) as unknown as { reservas: { id: string }[] };
  // Pedido com `slots` responde `{ reservas }` (`responderReservas`).
  return criada.reservas[0].id;
}

beforeEach(semear);

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-054/AC-029 — DEF-032', () => {
  it('mover aula particular para horário em que o professor tem outra aula: 409 PROFESSOR_INDISPONIVEL, e a aula fica onde estava', async () => {
    await aula(QUADRA_1, '10:00', '11:00');
    const segunda = await aula(QUADRA_2, '14:00', '15:00');

    let capturado: unknown;
    try {
      await courts.moveBooking(
        EMPRESA,
        segunda,
        { horaInicio: '10:00', horaFim: '11:00' },
        UADMIN,
      );
    } catch (erro) {
      capturado = erro;
    }

    // Presença ANTES de ausência: sem recusa nenhuma, o teste acusa isso.
    expect(capturado).toBeDefined();
    const resposta = (
      capturado as { getResponse?: () => unknown }
    ).getResponse?.() as { code?: string; statusCode?: number } | undefined;
    // Sem `getResponse`, o que subiu foi o erro cru do Prisma — o `500`.
    expect({
      classe: (capturado as Error).constructor.name,
      resposta,
    }).toEqual({
      classe: 'ConflictException',
      resposta: expect.objectContaining({
        statusCode: 409,
        code: 'PROFESSOR_INDISPONIVEL',
      }) as unknown,
    });

    const [linha] = await db.$queryRawUnsafe<{ inicio: string }[]>(
      `SELECT hora_inicio::text AS inicio FROM ocupacoes_quadra WHERE id = '${segunda}'`,
    );
    expect(linha.inicio).toBe('14:00:00');
    // Traduzir não é retentar: a trava do professor não é corrida de quadra.
    expect(courts.retentativasDeMover).toBe(0);
  });
});
