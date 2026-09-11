/**
 * SPEC-047/REQ-005 — **o que a rota oferece é exatamente o que a criação
 * aceita.**
 *
 * ## Por que este arquivo existe
 *
 * A rota `GET /me/professores/:id/horarios` não tem regra própria: ela
 * **antecipa** as do `POST /bookings`. Um arquivo de testes que só conferisse
 * a resposta dela mediria a cópia contra si mesma.
 *
 * Por isso o caso central aqui não afere um horário esperado: ele pega **cada
 * horário oferecido** e manda criar de verdade. Se um só for recusado, a tela
 * está mentindo para o aluno — e é esse o defeito que esta rota existe para
 * não ter.
 *
 * O contrário também é aferido: o que ela **esconde** tem de ser recusado pela
 * criação. Uma rota que esconde demais não quebra nada visivelmente; só faz o
 * professor parecer ocupado e o clube vender menos.
 */
import { PrismaClient } from '@prisma/client';
import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { CourtsService } from '../../src/courts/courts.service';
import { HorariosDeAulaParticularService } from '../../src/courts/horarios-de-aula-particular.service';
import { StudentsService } from '../../src/people/students.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import { PrecoDeAulaService } from '../../src/people/preco-de-aula.service';
import {
  agoraNoFusoDoClube,
  hojeNoFusoDoClube,
  minutosDaHora,
  parseTimeOnly,
} from '../../src/courts/date-time.util';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '04710000-0000-4000-8000-000000000001';
const QUADRA_A = '04710000-0000-4000-8000-000000000002';
const QUADRA_B = '04710000-0000-4000-8000-000000000003';
const ADMIN = '04710000-0000-4000-8000-000000000004';
const USUARIO = '04710000-0000-4000-8000-000000000005';
const ALUNO = '04710000-0000-4000-8000-000000000006';
const PROF = '04710000-0000-4000-8000-000000000007';
const OUTRO_PROF = '04710000-0000-4000-8000-000000000008';
const TURMA = '04710000-0000-4000-8000-000000000009';
const VIZINHA = '04710000-0000-4000-8000-00000000000a';
const PROF_VIZINHO = '04710000-0000-4000-8000-00000000000b';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function courts(): CourtsService {
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

function servico(): HorariosDeAulaParticularService {
  const p = db as unknown as PrismaService;
  return new HorariosDeAulaParticularService(
    p,
    courts(),
    new DisponibilidadeProfessorService(p),
    new PrecoDeAulaService(p),
  );
}

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
/** Nove dias à frente: nenhum caso depende de "hoje", exceto o que diz depender. */
const DATA = emDias(9);
const DIA_SEMANA = new Date(`${DATA}T00:00:00Z`).getUTCDay();
/** Um dia da semana em que o professor NÃO atende. */
const OUTRA_DATA = emDias(10);

async function recusa(p: Promise<unknown>): Promise<{ code?: string }> {
  try {
    await p;
    throw new Error('esperava recusa, e passou');
  } catch (e) {
    if (e instanceof UnprocessableEntityException) {
      return e.getResponse() as { code?: string };
    }
    throw e;
  }
}

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-047h','spec-047h-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ADMIN}','admin.s047h@x.com','h','Admin','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','aluno.s047h@x.com','h','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status,saldo_creditos) VALUES ('${ALUNO}','${USUARIO}','${EMPRESA}','aprovado','ativo',0)`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  // **'A' antes de 'B' por nome**, e o desempate do serviço é por nome: sem
  // isso o teste da escolha determinística não teria o que afirmar.
  for (const [id, nome] of [
    [QUADRA_A, 'Quadra A'],
    [QUADRA_B, 'Quadra B'],
  ] as const) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status)
       SELECT '${id}','${EMPRESA}','${nome}',id,80,'ativa' FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1`,
    );
  }
  await q(
    `INSERT INTO professores (id,company_id,nome,status,preco_aula) VALUES ('${PROF}','${EMPRESA}','Prof S047h','ativo',150)`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,status) VALUES ('${OUTRO_PROF}','${EMPRESA}','Sem preco','ativo')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,professor_id)
     VALUES ('${TURMA}','${EMPRESA}','T S047h','${QUADRA_A}',10,'${PROF}')`,
  );
  // O clube abre 06–23 todo dia: o expediente não pode ser o que recorta, ou
  // os casos da janela do professor provariam outra coisa.
  for (let dia = 0; dia < 7; dia++) {
    await q(
      `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,fechado,hora_inicio,hora_fim,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}',NULL,${dia},false,'06:00','23:00',now())`,
    );
  }
  // A janela do professor: 08:00–12:00 só no dia de `DATA`.
  await q(
    `INSERT INTO disponibilidades_professor (id,company_id,professor_id,dia_semana,hora_inicio,hora_fim,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${PROF}',${DIA_SEMANA},'08:00','12:00',now())`,
  );
  await q(
    `INSERT INTO disponibilidades_professor (id,company_id,professor_id,dia_semana,hora_inicio,hora_fim,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${OUTRO_PROF}',${DIA_SEMANA},'08:00','12:00',now())`,
  );
  // A empresa vizinha, para o caso do `404`.
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${VIZINHA}','Vizinha S047h','viz-047h-${VIZINHA}',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,status,preco_aula) VALUES ('${PROF_VIZINHO}','${VIZINHA}','Prof vizinho','ativo',90)`,
  );
}

/** Saldo pela porta do ledger — a INV-071 recusa `UPDATE` direto em `alunos`. */
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
      motivo: 'saldo para medir a SPEC-047/REQ-005',
      autorId: ADMIN,
      acaoId: acao.id,
    }),
  );
}

const horas = (r: { slots: { horaInicio: string }[] }) =>
  r.slots.map((s) => s.horaInicio);

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, VIZINHA);
  await montar();
  await creditar(100_000);
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, VIZINHA);
  await db.$disconnect();
});

describe('SPEC-047 — os horários que o aluno consegue marcar', () => {
  it('**o que é oferecido, a CRIAÇÃO aceita — todos, um por um**', async () => {
    const r = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    expect(r.slots.length).toBeGreaterThan(0);

    // **O caso central deste arquivo.** Não afere uma lista esperada: manda
    // criar cada horário oferecido. Uma recusa aqui é a tela mentindo.
    for (const slot of r.slots) {
      await expect(
        courts().createBooking(
          EMPRESA,
          {
            quadraId: slot.quadraId,
            data: DATA,
            slots: [{ horaInicio: slot.horaInicio, horaFim: slot.horaFim }],
            alunoId: ALUNO,
            professorId: PROF,
          },
          USUARIO,
          undefined,
          'aluno',
        ),
      ).resolves.toBeDefined();
    }
  });

  it('a janela do professor recorta: 08–12 devolve 4 horas, e só elas', async () => {
    const r = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    expect(r.atende).toBe(true);
    expect(r.janela).toEqual({ horaInicio: '08:00', horaFim: '12:00' });
    expect(horas(r)).toEqual(['08:00', '09:00', '10:00', '11:00']);
    // O clube abre às 06 e fecha às 23 — o recorte é do professor, não do
    // expediente, e é isto que a igualdade acima prova.
  });

  it('**o que ela ESCONDE, a criação recusa** — 07:00 está fora da janela', async () => {
    const r = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    expect(horas(r)).not.toContain('07:00');

    const negada = await recusa(
      courts().createBooking(
        EMPRESA,
        {
          quadraId: QUADRA_A,
          data: DATA,
          slots: [{ horaInicio: '07:00', horaFim: '08:00' }],
          alunoId: ALUNO,
          professorId: PROF,
        },
        USUARIO,
        undefined,
        'aluno',
      ),
    );
    expect(negada.code).toBe('FORA_DA_DISPONIBILIDADE');
  });

  it('a aula de TURMA do professor tira a hora — mesmo em OUTRA quadra', async () => {
    // A ocupação é da Quadra A; as duas quadras somem das 10:00 porque quem
    // está ocupado é o PROFESSOR. É o caso que a `EXCLUDE` do banco não
    // alcança (LIM-039f): ela só enxerga `ocupacoes_quadra.professor_id`, e
    // aqui o professor está na TURMA.
    await q(
      `INSERT INTO ocupacoes_quadra
         (id, company_id, quadra_id, data, hora_inicio, hora_fim, origem_tipo, origem_turma_id, updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA_A}','${DATA}','10:00','11:00','TURMA','${TURMA}',now())`,
    );
    const r = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    expect(horas(r)).toEqual(['08:00', '09:00', '11:00']);
  });

  it('quadra ocupada NÃO tira a hora: a outra quadra assume', async () => {
    await courts().createBooking(
      EMPRESA,
      {
        quadraId: QUADRA_A,
        data: DATA,
        slots: [{ horaInicio: '09:00', horaFim: '10:00' }],
      },
      ADMIN,
    );
    const r = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    expect(horas(r)).toEqual(['08:00', '09:00', '10:00', '11:00']);
    // **A hora continua, e a QUADRA muda.** É a LIM-047e funcionando: o aluno
    // escolhe hora, o servidor escolhe quadra.
    expect(r.slots.find((s) => s.horaInicio === '09:00')?.quadraId).toBe(
      QUADRA_B,
    );
  });

  it('as duas quadras ocupadas: aí sim a hora some', async () => {
    for (const quadraId of [QUADRA_A, QUADRA_B]) {
      await courts().createBooking(
        EMPRESA,
        {
          quadraId,
          data: DATA,
          slots: [{ horaInicio: '09:00', horaFim: '10:00' }],
        },
        ADMIN,
      );
    }
    const r = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    expect(horas(r)).toEqual(['08:00', '10:00', '11:00']);
  });

  it('com as duas livres, a escolha é a MESMA nas duas chamadas', async () => {
    const a = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    const b = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    expect(a.slots).toEqual(b.slots);
    // 'Quadra A' vence por nome. Sem `orderBy`, o Postgres poderia devolver
    // qualquer ordem e a tela "mudaria sozinha" entre dois carregamentos.
    expect(a.slots.every((s) => s.quadraId === QUADRA_A)).toBe(true);
  });

  it('**`atende: false` não é o mesmo que lista vazia**', async () => {
    const r = await servico().horariosDoProfessor(EMPRESA, PROF, OUTRA_DATA);
    expect(r.atende).toBe(false);
    expect(r.janela).toBeNull();
    expect(r.slots).toEqual([]);
    // A tela precisa da diferença: "não atende neste dia" manda trocar de dia,
    // "atende e está cheio" manda esperar. Sem o campo, as duas são a mesma
    // grade vazia — a lição da AC-008 da SPEC-010.
  });

  it('o preço resolvido vem junto, para a tela não ter de guardar o da lista', async () => {
    const r = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    expect(r.precoAula).toBe(150);
  });

  it('sem preço próprio, o PADRÃO do clube responde', async () => {
    // **O `PUT` e substituicao TOTAL, e o `tsc` cobra os tres campos aqui.**
    // E a mesma cobranca que pegou, no Admin, o card de prazos apagando o
    // preco padrao ao salvar um prazo.
    await new ConfigOperacaoService(db as unknown as PrismaService).gravar(
      EMPRESA,
      {
        prazoCancelamentoAulaHoras: null,
        prazoCancelamentoReservaHoras: null,
        precoAulaPadrao: 90,
      },
    );
    const r = await servico().horariosDoProfessor(EMPRESA, OUTRO_PROF, DATA);
    expect(r.precoAula).toBe(90);
  });

  it('**professor sem preço nenhum: `AULA_SEM_PRECO`, e não uma grade vazia**', async () => {
    const negada = await recusa(
      servico().horariosDoProfessor(EMPRESA, OUTRO_PROF, DATA),
    );
    expect(negada.code).toBe('AULA_SEM_PRECO');
    // Mesmo código do `createBooking`. Devolver `slots: []` aqui esconderia o
    // motivo, e o aluno ficaria trocando de dia atrás de um horário que não
    // existe em dia nenhum.
  });

  it('professor INATIVO: `PROFESSOR_INATIVO`', async () => {
    await q(
      `UPDATE professores SET status='inativo' WHERE id='${PROF}' AND company_id='${EMPRESA}'`,
    );
    const negada = await recusa(
      servico().horariosDoProfessor(EMPRESA, PROF, DATA),
    );
    expect(negada.code).toBe('PROFESSOR_INATIVO');
  });

  it('professor de OUTRA empresa: `404`, nunca `403`', async () => {
    await expect(
      servico().horariosDoProfessor(EMPRESA, PROF_VIZINHO, DATA),
    ).rejects.toBeInstanceOf(NotFoundException);
    // `403` confirmaria que o id existe em algum lugar, e a resposta viraria
    // um oráculo de existência de recurso alheio.
  });

  it('id inexistente também é `404` — existência antes de preço', async () => {
    await expect(
      servico().horariosDoProfessor(
        EMPRESA,
        '04710000-0000-4000-8000-0000000000ff',
        DATA,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('quadra INATIVA não entra na escolha', async () => {
    await q(
      `UPDATE quadras SET status='inativa' WHERE id='${QUADRA_A}' AND company_id='${EMPRESA}'`,
    );
    const r = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    expect(horas(r)).toEqual(['08:00', '09:00', '10:00', '11:00']);
    expect(r.slots.every((s) => s.quadraId === QUADRA_B)).toBe(true);
  });

  it('aula do professor CANCELADA devolve a hora para a grade', async () => {
    const criada = (await courts().createBooking(
      EMPRESA,
      {
        quadraId: QUADRA_A,
        data: DATA,
        slots: [{ horaInicio: '09:00', horaFim: '10:00' }],
        alunoId: ALUNO,
        professorId: PROF,
        valor: 150,
      },
      ADMIN,
    )) as { reservas: { id: string }[] };

    // Com a aula de pé, a hora some das DUAS quadras — o ocupado é o professor.
    const antes = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    expect(horas(antes)).toEqual(['08:00', '10:00', '11:00']);

    // **Pelo serviço, não por `UPDATE` cru**: a INV-064 recusa o `UPDATE`
    // direto para `cancelado`, e o caminho da recusa é o que o aluno usa.
    await courts().cancelBooking(
      EMPRESA,
      criada.reservas[0].id,
      ADMIN,
      'company_admin',
    );

    const depois = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    expect(horas(depois)).toEqual(['08:00', '09:00', '10:00', '11:00']);
  });

  it('**a carteira vazia ainda recusa — e isto é da TELA, não desta rota**', async () => {
    // SPEC-033/AC-007: o aluno não reserva nada com valor acima do saldo. A rota
    // oferece o horário assim mesmo, **de propósito**: saldo é do aluno, a
    // grade é do professor, e esconder o dia inteiro de quem está sem crédito
    // trocaria uma mensagem acionável ("faltam R$ 150") por um sumiço sem
    // motivo.
    //
    // O que fecha o buraco é a tela mostrar saldo e preço ANTES da escolha —
    // e é a LIM-047f, declarada em vez de escondida.
    // **O preço passa do saldo**, em vez de um débito: o ledger recusa
    // `entrada` negativa (`movimentos_de_credito_valor_centavos_check`), e
    // inventar um caminho de débito só para o teste seria testar o caminho
    // inventado. A carteira tem R$ 1.000; a aula passa a custar R$ 2.000.
    await q(
      `UPDATE professores SET preco_aula = 2000 WHERE id='${PROF}' AND company_id='${EMPRESA}'`,
    );

    const r = await servico().horariosDoProfessor(EMPRESA, PROF, DATA);
    expect(r.slots.length).toBeGreaterThan(0);

    const negada = await recusa(
      courts().createBooking(
        EMPRESA,
        {
          quadraId: r.slots[0].quadraId,
          data: DATA,
          slots: [
            { horaInicio: r.slots[0].horaInicio, horaFim: r.slots[0].horaFim },
          ],
          alunoId: ALUNO,
          professorId: PROF,
        },
        USUARIO,
        undefined,
        'aluno',
      ),
    );
    expect(negada.code).toBe('SALDO_INSUFICIENTE');
  });

  it('**HOJE: nada que já começou é oferecido** (SPEC-042/INV-093)', async () => {
    // Este caso existe porque os outros não alcançavam a guarda do passado:
    // `DATA` é daqui a nove dias, e nove dias à frente nada já começou.
    //
    // **O clube abre à MEIA-NOITE só aqui**, e é o que torna o caso
    // determinístico: a qualquer hora do dia existe pelo menos uma hora já
    // começada. Com o expediente das 06:00, rodar de madrugada não cortaria
    // nada e o teste passaria sem provar coisa alguma.
    const HOJE = emDias(0);
    const DIA_DE_HOJE = new Date(`${HOJE}T00:00:00Z`).getUTCDay();
    await q(
      `UPDATE horarios_funcionamento SET hora_inicio='00:00', hora_fim='23:00'
        WHERE company_id='${EMPRESA}' AND dia_semana=${DIA_DE_HOJE}`,
    );
    await q(
      `INSERT INTO disponibilidades_professor (id,company_id,professor_id,dia_semana,hora_inicio,hora_fim,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}','${PROF}',${DIA_DE_HOJE},'00:00','23:00',now())
       ON CONFLICT (company_id,professor_id,dia_semana)
       DO UPDATE SET hora_inicio='00:00', hora_fim='23:00'`,
    );

    const r = await servico().horariosDoProfessor(EMPRESA, PROF, HOJE);
    expect(r.atende).toBe(true);

    const { minutos } = agoraNoFusoDoClube();
    for (const slot of r.slots) {
      expect(minutosDaHora(parseTimeOnly(slot.horaInicio))).toBeGreaterThan(
        minutos,
      );
    }
    // E alguma coisa FOI cortada: sem esta linha o caso passaria com a lista
    // vazia, ou com a guarda arrancada num horário em que ela não morde.
    expect(r.slots.length).toBeLessThan(23);
  });
});
