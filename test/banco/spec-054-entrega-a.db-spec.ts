/**
 * SPEC-054/TASK-001 — **Entrega A: o código que entende o erro sobe ANTES de o
 * erro existir** (D11).
 *
 * ## O que está em julgamento
 *
 * A Entrega B cria as triggers de estoque, que recusam com `P3303` (esgotado) e
 * `P3304` (adicional inativo). Se o `back` de hoje as encontrar — no rollback de
 * B, ou no contêiner antigo durante o deploy —, o catch trata o erro como
 * corrida perdida, retenta e relança: **`500`** numa recusa normal de negócio.
 * A Entrega A ensina a criação e o movimento a traduzir as duas **antes** de
 * `ehCorridaPerdida`.
 *
 * ## Por que uma trigger de teste, e não objeto de erro montado à mão
 *
 * O Prisma entrega o mesmo `RAISE` de dois jeitos (fato 8, **medido de novo em
 * 2026-09-15** contra Prisma 6.19.3 e PostgreSQL 18.4):
 *
 * - API de modelo → `PrismaClientUnknownRequestError`, **sem `code` nem
 *   `meta`**; o SQLSTATE só na mensagem, como `PostgresError { code: "P3303"`;
 * - SQL cru → `PrismaClientKnownRequestError` `P2010`, com `meta.code`.
 *
 * Um erro montado à mão prova o formato que eu imaginei, não o que o Prisma
 * produz (AC-036). Por isso a trigger é real, e **só dispara para a empresa
 * deste arquivo** (`WHEN`): outros arquivos da suíte não a enxergam.
 *
 * O horário decide a recusa: `15:00` é "sem estoque", `16:00` é "adicional
 * inativo". Cada disparo avança uma sequência — `nextval` não volta no
 * `ROLLBACK` —, e é ela que prova que traduzir **não** retentou.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { CourtsService } from '../../src/courts/courts.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';
import { sqlstateDoErro } from '../../src/courts/recusas-de-estoque';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const EMPRESA = 'e0540000-0000-4000-8000-000000000001';
const UADMIN = 'e0540000-0000-4000-8000-000000000002';
const UALUNO = 'e0540000-0000-4000-8000-000000000003';
const ALUNO = 'e0540000-0000-4000-8000-000000000004';
const QUADRA = 'e0540000-0000-4000-8000-000000000005';
/** O adicional que a trigger de teste nomeia na mensagem. */
const ADICIONAL = 'e0540000-0000-4000-8000-0000000000ad';

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

const DATA = '2035-06-07';

async function disparos(): Promise<number> {
  const [linha] = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT last_value - 1 AS n FROM teste_054a_disparos`,
  );
  return Number(linha.n);
}

async function recusa(promessa: Promise<unknown>) {
  try {
    await promessa;
  } catch (erro) {
    return {
      classe: (erro as Error).constructor.name,
      resposta: (erro as { getResponse?: () => unknown }).getResponse?.() as
        Record<string, unknown> | undefined,
    };
  }
  throw new Error('esperava recusa, e o pedido passou');
}

function reservar(horaInicio: string, horaFim: string) {
  return courts.createBooking(
    EMPRESA,
    {
      quadraId: QUADRA,
      data: DATA,
      slots: [{ horaInicio, horaFim }],
      alunoId: ALUNO,
    },
    UADMIN,
  ) as unknown as Promise<{ reservas: { id: string }[] }>;
}

function inserirPeloModelo(horaInicio: string) {
  return db.ocupacaoQuadra.create({
    data: {
      companyId: EMPRESA,
      quadraId: QUADRA,
      data: new Date(`${DATA}T00:00:00Z`),
      horaInicio: new Date(`1970-01-01T${horaInicio}:00Z`),
      horaFim: new Date(`1970-01-01T17:00:00Z`),
      origemTipo: 'AVULSO',
    },
  });
}

async function semear() {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube 054A','clube-054a',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UADMIN}','054a-admin@t.local','x','Admin','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UALUNO}','054a-aluno@t.local','x','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA}')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora)
     VALUES ('${QUADRA}','${EMPRESA}','Q1',
             (SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),100)`,
  );
  for (let dia = 0; dia < 7; dia++) {
    await q(
      `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,fechado,hora_inicio,hora_fim,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}',NULL,${dia},false,'06:00','23:00',now())`,
    );
  }
}

beforeAll(async () => {
  await q(`DROP TRIGGER IF EXISTS teste_054a ON ocupacoes_quadra`);
  await q(`DROP FUNCTION IF EXISTS teste_054a_lanca()`);
  await q(`DROP SEQUENCE IF EXISTS teste_054a_disparos`);
  await q(`CREATE SEQUENCE teste_054a_disparos`);
  await q(`SELECT nextval('teste_054a_disparos')`);
  await q(`
    CREATE FUNCTION teste_054a_lanca() RETURNS trigger AS $$
    BEGIN
      IF NEW.hora_inicio = '15:00'::time THEN
        PERFORM nextval('teste_054a_disparos');
        RAISE EXCEPTION 'ESTOQUE_ESGOTADO adicional=${ADICIONAL}' USING ERRCODE = 'P3303';
      ELSIF NEW.hora_inicio = '16:00'::time THEN
        PERFORM nextval('teste_054a_disparos');
        RAISE EXCEPTION 'ADICIONAL_INATIVO adicional=${ADICIONAL}' USING ERRCODE = 'P3304';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await q(`
    CREATE TRIGGER teste_054a BEFORE INSERT OR UPDATE ON ocupacoes_quadra
    FOR EACH ROW WHEN (NEW.company_id = '${EMPRESA}'::uuid)
    EXECUTE FUNCTION teste_054a_lanca()`);
});

beforeEach(semear);

afterAll(async () => {
  await q(`DROP TRIGGER IF EXISTS teste_054a ON ocupacoes_quadra`);
  await q(`DROP FUNCTION IF EXISTS teste_054a_lanca()`);
  await q(`DROP SEQUENCE IF EXISTS teste_054a_disparos`);
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-054/AC-036 — sqlstateDoErro, nas duas representações reais', () => {
  it('API de modelo: erro DESCONHECIDO, sem code nem meta — e o P3303 sai da mensagem', async () => {
    let erro: unknown;
    try {
      await inserirPeloModelo('15:00');
    } catch (e) {
      erro = e;
    }
    // A representação é afirmada, e não suposta: se o Prisma um dia passar a
    // mandar `code`, este teste avisa que o fato 8 mudou.
    expect(erro).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect((erro as { code?: string }).code).toBeUndefined();
    expect(sqlstateDoErro(erro)).toBe('P3303');
  });

  it('SQL cru: P2010 com meta.code', async () => {
    let erro: unknown;
    try {
      await q(
        `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at)
         VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${DATA}','16:00','17:00','AVULSO',now())`,
      );
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((erro as { code?: string }).code).toBe('P2010');
    expect(sqlstateDoErro(erro)).toBe('P3304');
  });

  it('erro que não veio do Prisma não tem SQLSTATE, mesmo com o texto parecido', () => {
    expect(
      sqlstateDoErro(
        new Error('PostgresError { code: "P3303", message: "x" }'),
      ),
    ).toBeUndefined();
    expect(sqlstateDoErro('P3303')).toBeUndefined();
  });
});

describe('SPEC-054/D11 — a criação traduz, e não retenta', () => {
  it('P3303 na criação: 409 ESTOQUE_ESGOTADO com o adicional, nenhuma ocupação, um disparo só', async () => {
    const antes = await disparos();

    const r = await recusa(reservar('15:00', '16:00'));

    expect(r).toEqual({
      classe: 'ConflictException',
      resposta: expect.objectContaining({
        statusCode: 409,
        code: 'ESTOQUE_ESGOTADO',
        adicionalId: ADICIONAL,
      }) as unknown,
    });
    const [{ n }] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM ocupacoes_quadra WHERE company_id = '${EMPRESA}'`,
    );
    expect(Number(n)).toBe(0);
    expect((await disparos()) - antes).toBe(1);
  });

  it('P3304 na criação: 422 ADICIONAL_INATIVO, um disparo só', async () => {
    const antes = await disparos();

    const r = await recusa(reservar('16:00', '17:00'));

    expect(r).toEqual({
      classe: 'UnprocessableEntityException',
      resposta: expect.objectContaining({
        statusCode: 422,
        code: 'ADICIONAL_INATIVO',
        adicionalId: ADICIONAL,
      }) as unknown,
    });
    expect((await disparos()) - antes).toBe(1);
  });

  it('a trigger de teste não atrapalha o caminho normal: reserva às 10h nasce', async () => {
    const criada = await reservar('10:00', '11:00');
    expect(criada.reservas).toHaveLength(1);
  });
});

describe('SPEC-054/AC-019 (em A) — o movimento traduz, e não retenta', () => {
  it('mover para horário sem estoque: 409 ESTOQUE_ESGOTADO, a reserva fica onde estava', async () => {
    const criada = await reservar('10:00', '11:00');
    const id = criada.reservas[0].id;
    const antes = await disparos();
    const retentativasAntes = courts.retentativasDeMover;

    const r = await recusa(
      courts.moveBooking(
        EMPRESA,
        id,
        { horaInicio: '15:00', horaFim: '16:00' },
        UADMIN,
      ),
    );

    expect(r).toEqual({
      classe: 'ConflictException',
      resposta: expect.objectContaining({
        statusCode: 409,
        code: 'ESTOQUE_ESGOTADO',
        adicionalId: ADICIONAL,
      }) as unknown,
    });
    const [linha] = await db.$queryRawUnsafe<{ inicio: string }[]>(
      `SELECT hora_inicio::text AS inicio FROM ocupacoes_quadra WHERE id = '${id}'`,
    );
    expect(linha.inicio).toBe('10:00:00');
    expect(courts.retentativasDeMover - retentativasAntes).toBe(0);
    expect((await disparos()) - antes).toBe(1);
  });
});
