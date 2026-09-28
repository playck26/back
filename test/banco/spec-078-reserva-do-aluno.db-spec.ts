/**
 * SPEC-078/REQ-003 — **o dono da reserva sabe quando o clube a desfez.**
 *
 * Cancelar (pelos dois caminhos: `cancelBooking` e o `PATCH payment-status`
 * cancelado) e mover. Os gestores continuam recebendo o aviso de hoje; o aluno
 * passa a receber o dele, com "pelo clube" (I10) — e não recebe o do próprio
 * ato.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { diaNoFuturo } from './datas-relativas';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { momentoDaAula } from '../../src/push/avisos-de-gesto';
import { instanteNoFusoDoClube } from '../../src/courts/date-time.util';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const id = (n: number) =>
  '07800002-0000-4000-8000-' + String(n).padStart(12, '0');
const EMPRESA = id(1);
const QUADRA = id(2);
/** O gestor que faz os gestos (autor) e o outro, que recebe. */
const G_AUTOR = id(10);
const G_OUTRO = id(11);
const U_ALUNO = id(12);
const ALUNO = id(13);
const U_PROF = id(14);
const PROF = id(15);

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const p = db as unknown as PrismaService;
const courts = new CourtsService(
  p,
  { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
  new HorarioFuncionamentoService(p),
  { resolver: () => ({ imagemUrl: null }) } as unknown as ImagemDaQuadraService,
  new ConfigOperacaoService(p),
  new CreditosService(),
  { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
);

let seq = 100;
let dias = 0;

/** Uma reserva avulsa futura, num dia só dela (a EXCLUDE não esbarra). */
async function reserva(
  opcoes: { comAluno?: boolean; particular?: boolean; hora?: string } = {},
) {
  const r = id(++seq);
  const data = diaNoFuturo(10 + ++dias);
  const hora = opcoes.hora ?? '19:00';
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  const aluno = opcoes.comAluno === false ? 'NULL' : `'${ALUNO}'`;
  const professor = opcoes.particular ? `'${PROF}'` : 'NULL';
  await q(`INSERT INTO ocupacoes_quadra
             (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,professor_id,status_pagamento,valor,updated_at)
           VALUES ('${r}','${EMPRESA}','${QUADRA}','${data}','${hora}','${fim}','AVULSO',${aluno},${professor},'pendente_pagamento',80,now())`);
  return {
    id: r,
    data: new Date(`${data}T00:00:00.000Z`),
    horaInicio: new Date(`1970-01-01T${hora}:00.000Z`),
    horaFim: new Date(`1970-01-01T${fim}:00.000Z`),
  };
}

async function avisosDe(usuarioId: string) {
  return db.$queryRawUnsafe<
    {
      titulo: string;
      corpo: string;
      destino_url: string;
      expira_em: Date | null;
    }[]
  >(
    `SELECT titulo, corpo, destino_url, expira_em FROM notificacoes
      WHERE company_id = '${EMPRESA}' AND destinatario_id = '${usuarioId}'
      ORDER BY criada_em`,
  );
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-078 reserva','spec-078-reserva',now())`,
  );
  await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,status,company_id,updated_at) VALUES
    ('${G_AUTOR}','ga@s078b.test','h','Gestor Autor','company_admin','ativo','${EMPRESA}',now()),
    ('${G_OUTRO}','go@s078b.test','h','Gestor Outro','company_admin','ativo','${EMPRESA}',now()),
    ('${U_ALUNO}','al@s078b.test','h','Aluno','aluno','ativo','${EMPRESA}',now()),
    ('${U_PROF}','pr@s078b.test','h','Prof','professor','ativo','${EMPRESA}',now())`);
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${ALUNO}','${U_ALUNO}','${EMPRESA}','aprovado','ativo')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF}','${EMPRESA}','Prof','${U_PROF}')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  const esporte = await db.esporteDeQuadra.findFirstOrThrow({
    where: { companyId: EMPRESA },
    select: { id: true },
  });
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q','${esporte.id}',80,'ativa')`,
  );
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-078/REQ-003 — o clube cancela a reserva do aluno', () => {
  it.each([
    [
      'cancelBooking',
      (r: string) => courts.cancelBooking(EMPRESA, r, G_AUTOR, 'company_admin'),
    ],
    [
      'PATCH payment-status cancelado',
      (r: string) =>
        courts.updatePaymentStatus(EMPRESA, r, 'cancelado', G_AUTOR),
    ],
  ])(
    'AC-012: pelo %s, o aluno recebe o aviso dele; o outro gestor, o de hoje; o autor, nada',
    async (_c, cancelar) => {
      const r = await reserva();
      const m = momentoDaAula(r.data, r.horaInicio);

      await cancelar(r.id);

      expect(await avisosDe(U_ALUNO)).toEqual([
        {
          titulo: 'Reservas',
          corpo: `Sua reserva de ${m} foi cancelada pelo clube`,
          destino_url: '/minhas-aulas',
          expira_em: instanteNoFusoDoClube(r.data, r.horaFim),
        },
      ]);
      expect((await avisosDe(G_OUTRO)).map((a) => a.corpo)).toEqual([
        `Uma reserva de ${m} foi cancelada`,
      ]);
      expect(await avisosDe(G_AUTOR)).toEqual([]);
    },
  );

  it('AC-012: aula particular diz "aula particular"', async () => {
    const r = await reserva({ particular: true });

    await courts.cancelBooking(EMPRESA, r.id, G_AUTOR, 'company_admin');

    expect((await avisosDe(U_ALUNO)).map((a) => a.corpo)).toEqual([
      `Sua aula particular de ${momentoDaAula(r.data, r.horaInicio)} foi cancelada pelo clube`,
    ]);
  });

  it('AC-013: o aluno que cancela a PRÓPRIA reserva não recebe; os gestores recebem', async () => {
    const r = await reserva();

    await courts.cancelBooking(EMPRESA, r.id, U_ALUNO, 'aluno', ALUNO);

    expect(await avisosDe(U_ALUNO)).toEqual([]);
    expect(await avisosDe(G_AUTOR)).toHaveLength(1);
    expect(await avisosDe(G_OUTRO)).toHaveLength(1);
  });

  it('AC-013: reserva SEM aluno não avisa aluno nenhum; cancelar de novo não avisa ninguém', async () => {
    const r = await reserva({ comAluno: false });

    await courts.cancelBooking(EMPRESA, r.id, G_AUTOR, 'company_admin');
    await courts.cancelBooking(EMPRESA, r.id, G_AUTOR, 'company_admin');

    expect(await avisosDe(U_ALUNO)).toEqual([]);
    // Um aviso só para o outro gestor: o segundo cancelamento é idempotente.
    expect(await avisosDe(G_OUTRO)).toHaveLength(1);
  });
});

describe('SPEC-078/REQ-003 — o clube move a reserva do aluno', () => {
  it('AC-015: o aluno recebe "Sua reserva mudou para …", com o instante e o prazo do DESTINO', async () => {
    const r = await reserva({ hora: '19:00' });

    await courts.moveBooking(
      EMPRESA,
      r.id,
      { horaInicio: '20:00', horaFim: '21:00' },
      G_AUTOR,
    );

    const destino = {
      horaInicio: new Date('1970-01-01T20:00:00.000Z'),
      horaFim: new Date('1970-01-01T21:00:00.000Z'),
    };
    expect(await avisosDe(U_ALUNO)).toEqual([
      {
        titulo: 'Reservas',
        corpo: `Sua reserva mudou para ${momentoDaAula(r.data, destino.horaInicio)}`,
        destino_url: '/minhas-aulas',
        expira_em: instanteNoFusoDoClube(r.data, destino.horaFim),
      },
    ]);
    expect((await avisosDe(G_OUTRO)).map((a) => a.corpo)).toEqual([
      'Uma reserva mudou de horário',
    ]);
  });

  it('AC-015: movimento RECUSADO (conflito no destino) não avisa ninguém', async () => {
    const r = await reserva({ hora: '15:00' });
    // Outra reserva no mesmo dia, ocupando o destino.
    await q(`INSERT INTO ocupacoes_quadra
               (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,status_pagamento,valor,updated_at)
             VALUES ('${id(++seq)}','${EMPRESA}','${QUADRA}','${r.data.toISOString().slice(0, 10)}','17:00','18:00','AVULSO','pendente_pagamento',80,now())`);

    await expect(
      courts.moveBooking(
        EMPRESA,
        r.id,
        { horaInicio: '17:00', horaFim: '18:00' },
        G_AUTOR,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(await avisosDe(U_ALUNO)).toEqual([]);
    expect(await avisosDe(G_OUTRO)).toEqual([]);
  });
});
