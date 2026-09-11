/**
 * SPEC-047 — **o preço da aula particular sai do corpo do pedido.**
 *
 * ## O DEF-029, que este arquivo existe para não deixar voltar
 *
 * Medido contra a instância local em 2026-09-11, com o código que estava em
 * produção: o aluno marcou aula particular **para si mesmo, por R$ 1,00**, e a
 * carteira dele debitou R$ 1,00. `POST /bookings` aceita `@Roles('aluno')` e
 * nunca conferiu **quem** manda `professorId` e `valor`.
 *
 * O comentário do campo `valor` já dizia *"num campo que a carteira debita"* —
 * a guarda foi posta em `valor` EXIGIR `professorId`, nunca em quem pode
 * mandá-lo. **Quinto caso deste ciclo do mesmo padrão.**
 *
 * ## O que só este arquivo prova
 *
 * A **resolução** do preço: professor → clube → recusa. As três pontas, e
 * principalmente a terceira — cair no preço da quadra seria o pior dos mundos,
 * porque o aluno pagaria o preço da quadra por uma aula com professor e
 * ninguém saberia dizer se foi intenção ou esquecimento.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { CourtsService } from '../../src/courts/courts.service';
import { StudentsService } from '../../src/people/students.service';
import { ProfessoresParaAlunoService } from '../../src/people/professores-para-aluno.service';
import type { FotoDeProfessorService } from '../../src/people/foto-de-professor.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '04700000-0000-4000-8000-000000000001';
const QUADRA = '04700000-0000-4000-8000-000000000002';
const ADMIN = '04700000-0000-4000-8000-000000000003';
const USUARIO = '04700000-0000-4000-8000-000000000004';
const ALUNO = '04700000-0000-4000-8000-000000000005';
const PROF = '04700000-0000-4000-8000-000000000006';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function servico(): CourtsService {
  const p = db as unknown as PrismaService;
  return new CourtsService(
    p,
    new StudentsService(p),
    new HorarioFuncionamentoService(p),
    {
      resolver: () => ({ imagemUrl: null }),
    } as unknown as ImagemDaQuadraService,
    new ConfigOperacaoService(p),
    new CreditosService(),
    new DisponibilidadeProfessorService(p),
  );
}

/**
 * A lista do aluno. O `FotoDeProfessorService` e duble: assinar URL exige
 * storage, e **nenhum caso deste arquivo afere foto** — o que se afere e QUEM
 * aparece e por quanto.
 */
function listaDoAluno(): ProfessoresParaAlunoService {
  return new ProfessoresParaAlunoService(
    db as unknown as PrismaService,
    {
      resolver: () => Promise.resolve({ fotoUrl: null }),
    } as unknown as FotoDeProfessorService,
  );
}

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const DATA = emDias(9);
const DIA_SEMANA = new Date(`${DATA}T00:00:00Z`).getUTCDay();

/**
 * `createBooking` devolve **união**: `{ reservas: [...] }` no formato novo e a
 * ocupação crua no antigo (`formatoAntigo`). Os testes passaram sem isto e o
 * `tsc` reprovou — **quarta vez neste trabalho que runner verde não significa
 * que compila.**
 */
function reservasDe(r: unknown): { id: string; valor: unknown }[] {
  const o = r as { reservas?: { id: string; valor: unknown }[] };
  return o.reservas ?? [r as { id: string; valor: unknown }];
}

/** O pedido, sem `valor` — é o caminho do aluno. */
const pedido = (hora: string, extra: Record<string, unknown> = {}) => ({
  quadraId: QUADRA,
  data: DATA,
  slots: [
    {
      horaInicio: hora,
      horaFim: `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`,
    },
  ],
  alunoId: ALUNO,
  professorId: PROF,
  ...extra,
});

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-047','spec-047-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ADMIN}','admin.s047@x.com','h','Admin','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','aluno.s047@x.com','h','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status,saldo_creditos) VALUES ('${ALUNO}','${USUARIO}','${EMPRESA}','aprovado','ativo',0)`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status)
     SELECT '${QUADRA}','${EMPRESA}','Quadra',id,80,'ativa' FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,status) VALUES ('${PROF}','${EMPRESA}','Prof S047','ativo')`,
  );
  // A janela do professor no dia — senão a recusa viria por
  // `FORA_DA_DISPONIBILIDADE` e eu estaria medindo o portão errado.
  await q(
    `INSERT INTO disponibilidades_professor (id,company_id,professor_id,dia_semana,hora_inicio,hora_fim,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${PROF}',${DIA_SEMANA},'06:00','23:00',now())`,
  );
  // O expediente do clube, pelo mesmo motivo.
  for (let dia = 0; dia < 7; dia++) {
    await q(
      `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,fechado,hora_inicio,hora_fim,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}',NULL,${dia},false,'06:00','23:00',now())`,
    );
  }
}

/** Saldo pela porta do ledger — a INV-071 recusa `UPDATE` direto. */
async function creditar(centavos: number): Promise<void> {
  const [acao] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
     VALUES (gen_random_uuid(),'${EMPRESA}','credito_lancado','${ADMIN}') RETURNING id`,
  );
  await db.$transaction((tx) =>
    new CreditosService().lancar(tx, {
      companyId: EMPRESA,
      alunoId: ALUNO,
      valorCentavos: centavos,
      motivo: 'saldo para medir a SPEC-047',
      autorId: ADMIN,
      acaoId: acao.id,
    }),
  );
}

const saldo = async () =>
  (
    await db.aluno.findUniqueOrThrow({
      where: { id: ALUNO },
      select: { saldoCreditos: true },
    })
  ).saldoCreditos;

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await montar();
  await creditar(100_000);
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-047 — o preço da aula particular', () => {
  // =====================================================================
  // DEF-029 — o aluno não escolhe o preço
  // =====================================================================

  it('**AC-009: aluno mandando `valor` é recusado**', async () => {
    // Era o defeito: `valor: 1` (R$ 1,00) respondia `201` e debitava R$ 1,00.
    await expect(
      servico().createBooking(
        EMPRESA,
        pedido('10:00', { valor: 1 }),
        USUARIO,
        undefined,
        'aluno',
      ),
    ).rejects.toMatchObject({
      response: { statusCode: 422, code: 'VALOR_NAO_E_DO_ALUNO' },
    });
  });

  it('e não grava nada — a recusa vem antes da escrita', async () => {
    await servico()
      .createBooking(
        EMPRESA,
        pedido('10:00', { valor: 1 }),
        USUARIO,
        undefined,
        'aluno',
      )
      .catch(() => undefined);

    expect(
      await db.ocupacaoQuadra.count({ where: { companyId: EMPRESA } }),
    ).toBe(0);
    expect(await saldo()).toBe(100_000);
  });

  // =====================================================================
  // A resolução: professor → clube → recusa
  // =====================================================================

  it('**AC-011: o preço do PROFESSOR vence o padrão do clube**', async () => {
    await q(`UPDATE professores SET preco_aula = 150 WHERE id='${PROF}'`);
    await q(
      `INSERT INTO config_operacao_empresa (id,company_id,preco_aula_padrao,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}',90,now())`,
    );

    const r = await servico().createBooking(
      EMPRESA,
      pedido('10:00'),
      USUARIO,
      undefined,
      'aluno',
    );

    expect(Number(reservasDe(r)[0].valor)).toBe(150);
    // R$ 150,00 = 15000 centavos. A carteira é em centavos e a coluna em
    // reais: se a conversão errasse por 100, apareceria aqui.
    expect(await saldo()).toBe(100_000 - 15_000);
  });

  it('AC-008: sem preço próprio, cai no PADRÃO do clube', async () => {
    await q(
      `INSERT INTO config_operacao_empresa (id,company_id,preco_aula_padrao,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}',90,now())`,
    );

    const r = await servico().createBooking(
      EMPRESA,
      pedido('10:00'),
      USUARIO,
      undefined,
      'aluno',
    );

    expect(Number(reservasDe(r)[0].valor)).toBe(90);
  });

  it('**AC-010: sem preço em lugar nenhum é RECUSA, não o preço da quadra**', async () => {
    // A quadra custa 80. Cair nela seria o pior dos mundos (D2): o aluno
    // pagaria o preço da quadra por uma aula com professor, e ninguém saberia
    // dizer se foi intenção ou esquecimento.
    await expect(
      servico().createBooking(
        EMPRESA,
        pedido('10:00'),
        USUARIO,
        undefined,
        'aluno',
      ),
    ).rejects.toMatchObject({
      response: { statusCode: 422, code: 'AULA_SEM_PRECO' },
    });
  });

  // =====================================================================
  // O gestor não perde nada (REQ-004)
  // =====================================================================

  it('AC-014: o GESTOR continua digitando o valor', async () => {
    const r = await servico().createBooking(
      EMPRESA,
      pedido('10:00', { valor: 220 }),
      ADMIN,
      undefined,
      'company_admin',
    );

    // Desconto, cortesia, pacote fechado — trabalho real do clube (D4).
    expect(Number(reservasDe(r)[0].valor)).toBe(220);
  });

  it('AC-015: o gestor SEM valor usa o preço de tabela, não o da quadra', async () => {
    await q(`UPDATE professores SET preco_aula = 150 WHERE id='${PROF}'`);

    const r = await servico().createBooking(
      EMPRESA,
      pedido('10:00'),
      ADMIN,
      undefined,
      'company_admin',
    );

    // Hoje ele cairia em 80 (o preço da quadra) em silêncio.
    expect(Number(reservasDe(r)[0].valor)).toBe(150);
  });

  // =====================================================================
  // O que NÃO muda
  // =====================================================================

  it('CONTROLE: reserva SEM professor continua no preço da quadra', async () => {
    const r = await servico().createBooking(
      EMPRESA,
      {
        quadraId: QUADRA,
        data: DATA,
        slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
        alunoId: ALUNO,
      },
      USUARIO,
      undefined,
      'aluno',
    );

    // Sem este caso, a mudança poderia ter alcançado a reserva comum — e ela
    // é a maioria do que o clube vende.
    expect(Number(reservasDe(r)[0].valor)).toBe(80);
  });

  it('CONTROLE: `valor` sem `professorId` continua `VALOR_SEM_PROFESSOR`', async () => {
    await expect(
      servico().createBooking(
        EMPRESA,
        {
          quadraId: QUADRA,
          data: DATA,
          slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
          alunoId: ALUNO,
          valor: 5,
        },
        ADMIN,
        undefined,
        'company_admin',
      ),
    ).rejects.toMatchObject({
      response: { code: 'VALOR_SEM_PROFESSOR' },
    });
  });

  it('AC-012: o valor gravado NÃO muda quando o preço do professor muda', async () => {
    await q(`UPDATE professores SET preco_aula = 150 WHERE id='${PROF}'`);
    const r = await servico().createBooking(
      EMPRESA,
      pedido('10:00'),
      USUARIO,
      undefined,
      'aluno',
    );

    await q(`UPDATE professores SET preco_aula = 400 WHERE id='${PROF}'`);

    const depois = await db.ocupacaoQuadra.findUniqueOrThrow({
      where: { id: reservasDe(r)[0].id },
      select: { valor: true },
    });
    // Reajustar amanhã não reescreve a aula de ontem — mesma decisão da
    // matrícula (SPEC-037/D1).
    expect(Number(depois.valor)).toBe(150);
  });

  // =====================================================================
  // REQ-002 — a lista do aluno
  // =====================================================================

  it('AC-004: lista o professor com preço resolvido', async () => {
    await q(`UPDATE professores SET preco_aula = 150 WHERE id='${PROF}'`);

    const lista = await listaDoAluno().listarParaAluno(EMPRESA);

    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      id: PROF,
      nome: 'Prof S047',
      precoAula: 150,
    });
  });

  it('**AC-007: e NÃO devolve telefone, e-mail nem `usuarioId`**', async () => {
    await q(
      `UPDATE professores SET preco_aula = 150, telefone = '11999999999', email = 'prof@x.com' WHERE id='${PROF}'`,
    );

    const [linha] = await listaDoAluno().listarParaAluno(EMPRESA);

    // A rota do GESTOR devolve os três. Reusá-la "porque já existe" é como
    // vazamento de dado começa — o aluno escolhe por nome, rosto e preço.
    expect(Object.keys(linha).sort()).toEqual([
      'fotoUrl',
      'id',
      'nome',
      'precoAula',
    ]);
  });

  it('**AC-005: professor SEM preço não aparece**', async () => {
    // Nem próprio, nem padrão. Oferecer o que a criação vai negar com
    // `AULA_SEM_PRECO` é a forma mais barata de perder a confiança de quem usa.
    expect(await listaDoAluno().listarParaAluno(EMPRESA)).toEqual([]);
  });

  it('sem preço próprio, o PADRÃO do clube já o faz aparecer', async () => {
    await q(
      `INSERT INTO config_operacao_empresa (id,company_id,preco_aula_padrao,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}',90,now())`,
    );

    const [linha] = await listaDoAluno().listarParaAluno(EMPRESA);
    expect(linha.precoAula).toBe(90);
  });

  it('AC-006: professor INATIVO não aparece', async () => {
    await q(
      `UPDATE professores SET preco_aula = 150, status = 'inativo' WHERE id='${PROF}'`,
    );

    expect(await listaDoAluno().listarParaAluno(EMPRESA)).toEqual([]);
  });

  it('**a lista e a CRIAÇÃO concordam sobre quem tem preço**', async () => {
    // A resolução `professor ?? padrão` existe em dois lugares (a lista e o
    // `createBooking`), e duas cópias da mesma regra divergem no primeiro
    // ajuste. **Este caso é o que impede a divergência**, e está declarado no
    // docstring do serviço.
    expect(await listaDoAluno().listarParaAluno(EMPRESA)).toEqual([]);
    await expect(
      servico().createBooking(
        EMPRESA,
        pedido('10:00'),
        USUARIO,
        undefined,
        'aluno',
      ),
    ).rejects.toMatchObject({ response: { code: 'AULA_SEM_PRECO' } });

    await q(`UPDATE professores SET preco_aula = 150 WHERE id='${PROF}'`);

    expect(await listaDoAluno().listarParaAluno(EMPRESA)).toHaveLength(1);
    const r = await servico().createBooking(
      EMPRESA,
      pedido('11:00'),
      USUARIO,
      undefined,
      'aluno',
    );
    expect(Number(reservasDe(r)[0].valor)).toBe(150);
  });

  it('a empresa vizinha não entra na lista', async () => {
    await q(`UPDATE professores SET preco_aula = 150 WHERE id='${PROF}'`);

    expect(
      await listaDoAluno().listarParaAluno(
        '04700000-0000-4000-8000-0000000000ff',
      ),
    ).toEqual([]);
  });

  // =====================================================================
  // INV-122
  // =====================================================================

  it('INV-122: preço zero ou negativo é recusado pelo BANCO', async () => {
    // **Zero também não passa, e não é rigor gratuito:** zero é o valor que o
    // ledger recusa (`valor_centavos > 0`), então a aula de graça quebraria na
    // COBRANÇA — depois de a tela ter dito que deu certo.
    for (const preco of ['0', '-10']) {
      const erro = await q(
        `UPDATE professores SET preco_aula = ${preco} WHERE id='${PROF}'`,
      ).catch((e: unknown) => e as Error);
      expect(erro).toBeInstanceOf(Error);
      expect((erro as Error).message).toContain(
        'professores_preco_aula_positivo',
      );
    }
  });
});
