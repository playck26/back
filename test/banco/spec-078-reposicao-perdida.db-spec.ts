/**
 * SPEC-078/REQ-002 — **quem tinha reposição numa aula que o clube desfaz é
 * avisado.**
 *
 * Quatro gestos apagam reposição (DEF-036): cancelar a aula, encerrar a turma,
 * mudar a grade e reativar a turma — os três últimos pela mesma função de
 * cancelamento em lote. O titular da reposição não está em `turma_alunos` (a
 * reposição é de outra turma), e a linha dele some na mesma transação: por
 * isso quem ele é sai do próprio `DELETE … RETURNING`.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { diaNoFuturo } from './datas-relativas';
import { ClassesService } from '../../src/classes/classes.service';
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
  '07800001-0000-4000-8000-' + String(n).padStart(12, '0');
const EMPRESA = id(1);
const QUADRA = id(2);
const TURMA_B = id(3);
const GESTOR = id(10);
const U_PROF = id(11);
const PROF = id(12);
/** Matriculado na turma A. */
const U_M = id(13);
const M = id(14);
/** Titular de reposição na turma A, vindo da turma B. */
const U_R = id(15);
const R = id(16);
/** Matriculado na turma A **e** titular de reposição na mesma aula (AC-010). */
const U_X = id(17);
const X = id(18);

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
const classes = new ClassesService(
  p,
  courts,
  {} as unknown as StudentsService,
  new ConfigOperacaoService(p),
);

let seq = 100;

interface Ocorrencia {
  id: string;
  data: Date;
  hora_inicio: Date;
  hora_fim: Date;
}

/** A turma A, criada pelo próprio serviço — é ele que gera as ocorrências. */
async function criarTurmaA(): Promise<{
  turmaId: string;
  futuras: Ocorrencia[];
}> {
  const diaSemana = new Date(`${diaNoFuturo(3)}T12:00:00.000Z`).getUTCDay();
  const turma = (await classes.create(
    EMPRESA,
    {
      nome: 'Turma A',
      quadraId: QUADRA,
      professorId: PROF,
      capacidade: 10,
      encontros: [{ diaSemana, horaInicio: '19:00', horaFim: '20:00' }],
    },
    GESTOR,
  )) as { id: string };
  const futuras = await db.$queryRawUnsafe<Ocorrencia[]>(
    `SELECT id::text, data, hora_inicio, hora_fim FROM ocupacoes_quadra
      WHERE origem_turma_id = '${turma.id}' AND status_pagamento <> 'cancelado'
        AND data > CURRENT_DATE + 1
      ORDER BY data LIMIT 2`,
  );
  expect(futuras).toHaveLength(2);
  return { turmaId: turma.id, futuras };
}

async function faltaNaTurmaB(alunoId: string): Promise<string> {
  const oc = id(++seq);
  await q(`INSERT INTO ocupacoes_quadra
             (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
           VALUES ('${oc}','${EMPRESA}','${QUADRA}','${diaNoFuturo(-2 - seq)}','08:00','09:00','TURMA','${TURMA_B}','pendente_pagamento',now())`);
  const f = id(++seq);
  await q(`INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at)
           VALUES ('${f}','${EMPRESA}','${oc}','${alunoId}',now())`);
  return f;
}

async function reposicao(alunoId: string, ocupacaoId: string): Promise<void> {
  const f = await faltaNaTurmaB(alunoId);
  await q(`INSERT INTO reposicoes_de_aula (id,company_id,aluno_id,falta_id,ocupacao_id)
           VALUES (gen_random_uuid(),'${EMPRESA}','${alunoId}','${f}','${ocupacaoId}')`);
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
      WHERE company_id = '${EMPRESA}' AND tipo = 'gesto' AND destinatario_id = '${usuarioId}'
      ORDER BY corpo, expira_em`,
  );
}

const avisoDeReposicao = (o: Ocorrencia) => ({
  titulo: 'Sua aula',
  corpo: `Sua reposição de ${momentoDaAula(o.data, o.hora_inicio)} foi cancelada`,
  destino_url: '/minhas-aulas',
  expira_em: instanteNoFusoDoClube(o.data, o.hora_fim),
});

async function reposicoesEm(ocupacaoId: string): Promise<number> {
  const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM reposicoes_de_aula WHERE ocupacao_id = '${ocupacaoId}'`,
  );
  return n;
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  seq = 100;
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-078 reposicao','spec-078-reposicao',now())`,
  );
  await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,status,company_id,updated_at) VALUES
    ('${GESTOR}','gestor@s078r.test','h','Gestor','company_admin','ativo','${EMPRESA}',now()),
    ('${U_PROF}','prof@s078r.test','h','Prof','professor','ativo','${EMPRESA}',now()),
    ('${U_M}','m@s078r.test','h','Matriculado','aluno','ativo','${EMPRESA}',now()),
    ('${U_R}','r@s078r.test','h','Repositor','aluno','ativo','${EMPRESA}',now()),
    ('${U_X}','x@s078r.test','h','Ambos','aluno','ativo','${EMPRESA}',now())`);
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF}','${EMPRESA}','Prof','${U_PROF}')`,
  );
  for (const [a, u] of [
    [M, U_M],
    [R, U_R],
    [X, U_X],
  ]) {
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${a}','${u}','${EMPRESA}','aprovado','ativo')`,
    );
  }
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
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA_B}','${EMPRESA}','Turma B','${QUADRA}',10,'ativa')`,
  );
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

async function montarTitulares() {
  const { turmaId, futuras } = await criarTurmaA();
  const [o1, o2] = futuras;
  for (const a of [M, X]) {
    await q(
      `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${a}',now())`,
    );
  }
  await reposicao(R, o1.id);
  await reposicao(R, o2.id);
  await reposicao(X, o1.id);
  return { turmaId, o1, o2 };
}

describe('SPEC-078/REQ-002 — reposição em aula que o clube desfaz', () => {
  it('AC-008 + AC-010 + AC-011: cancelar a aula avisa o titular, uma vez; o matriculado-titular só recebe o de aula', async () => {
    const { turmaId, o1, o2 } = await montarTitulares();

    await classes.cancelarOcorrencia(EMPRESA, turmaId, o1.id, 'Chuva', GESTOR);

    expect(await avisosDe(U_R)).toEqual([avisoDeReposicao(o1)]);
    const deX = await avisosDe(U_X);
    expect(deX).toHaveLength(1);
    expect(deX[0].corpo).toBe(
      `Sua aula de ${momentoDaAula(o1.data, o1.hora_inicio)} foi cancelada`,
    );
    // A reposição da aula cancelada continua sendo apagada (DEF-036); a da
    // outra aula, não.
    expect(await reposicoesEm(o1.id)).toBe(0);
    expect(await reposicoesEm(o2.id)).toBe(1);
  });

  it('AC-009: ENCERRAR a turma avisa o titular uma vez POR OCORRÊNCIA perdida', async () => {
    const { turmaId, o1, o2 } = await montarTitulares();

    await classes.update(EMPRESA, turmaId, { status: 'inativa' }, GESTOR);

    expect(await avisosDe(U_R)).toEqual(
      // O corpo sozinho EMPATA: as duas ocorrências perdidas caem no mesmo dia
      // da semana e hora, duas semanas separadas, e dizem a mesma frase. Sem o
      // desempate pelo `expira_em` (aqui e no `ORDER BY`), a ordem era a do
      // banco — e o caso passava ou caía conforme ela (medido em 2026-09-28).
      [avisoDeReposicao(o1), avisoDeReposicao(o2)].sort(
        (a, b) =>
          a.corpo.localeCompare(b.corpo) ||
          (a.expira_em?.getTime() ?? 0) - (b.expira_em?.getTime() ?? 0),
      ),
    );
    // Matriculado: só o aviso da turma, nenhum de reposição (I11).
    expect((await avisosDe(U_X)).map((a) => a.corpo)).toEqual([
      'Uma das suas turmas foi encerrada',
    ]);
    expect(await reposicoesEm(o1.id)).toBe(0);
    expect(await reposicoesEm(o2.id)).toBe(0);
  });

  it('AC-009: MUDAR A GRADE avisa o titular pelas ocorrências antigas', async () => {
    const { turmaId, o1, o2 } = await montarTitulares();
    const diaSemana = new Date(`${diaNoFuturo(4)}T12:00:00.000Z`).getUTCDay();

    await classes.update(
      EMPRESA,
      turmaId,
      { encontros: [{ diaSemana, horaInicio: '07:00', horaFim: '08:00' }] },
      GESTOR,
    );

    const deR = await avisosDe(U_R);
    expect(deR).toEqual(
      expect.arrayContaining([avisoDeReposicao(o1), avisoDeReposicao(o2)]),
    );
    expect(deR).toHaveLength(2);
  });

  it('AC-009: REATIVAR a turma também apaga a reposição da ocorrência antiga, e avisa', async () => {
    const {
      turmaId,
      futuras: [o1],
    } = await criarTurmaA();
    await reposicao(R, o1.id);
    // O estado de antes da SPEC-035: turma inativa com ocorrência futura viva.
    await q(`UPDATE turmas SET status = 'inativa' WHERE id = '${turmaId}'`);

    await classes.update(EMPRESA, turmaId, { status: 'ativa' }, GESTOR);

    expect(await avisosDe(U_R)).toEqual([avisoDeReposicao(o1)]);
    expect(await reposicoesEm(o1.id)).toBe(0);
  });
});
