/**
 * **A matrícula nova cabe em todas as próximas aulas, contando as reposições
 * já marcadas** — decisão do Israel em 2026-09-26, tomada durante a SPEC-075,
 * quando o FIT-035 ficou vermelho no CI do PR.
 *
 * ## O defeito, que não era de corrida
 *
 * Capacidade 1, ninguém matriculado. Um aluno marca reposição na aula de
 * sábado; **depois**, em sequência, o gestor aloca outro aluno na turma. A
 * alocação contava só `turma_alunos` (zero) e passava: sábado com dois corpos
 * numa vaga. O FIT-035 corria os dois ao mesmo tempo e só passava porque a
 * matrícula costumava pegar a trava da turma primeiro; a trava de nível da
 * SPEC-075 mudou essa ordem e o expôs. **A corrida só revelou; o furo era
 * sequencial**, e é em sequência que este arquivo o prova.
 *
 * ## O que se afirma
 *
 * Os dois caminhos que matriculam (`allocateStudent` do gestor e `entrar` do
 * aluno) recusam quando alguma aula que ainda não terminou passaria da
 * capacidade, pela MESMA projeção da agenda (`calcularOcupacao`). E, porque é
 * uma simulação e não uma soma, cada caso em que uma soma erraria tem o seu:
 * a falta que libera a vaga, o aluno que já era visitante, a aula cancelada, a
 * que já passou e a de hoje que já terminou. Cada recusa tem o seu controle
 * logo ao lado — sem ele, uma recusa de outra regra passaria por esta.
 *
 * E os dois que OFERECEM a vaga seguem a mesma regra: a lista de turmas do
 * aluno (`podeEntrar`) e o varredor da fila de turma — que, contando só
 * `turma_alunos`, chamaria para uma vaga que a confirmação recusa, e
 * encerraria a linha.
 */
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { cancelarOcupacaoNaFixture } from './cancelar-ocupacao';
import { ClassesService } from '../../src/classes/classes.service';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CourtsService } from '../../src/courts/courts.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { VarredorDaFilaService } from '../../src/fila-de-espera/varredor-da-fila.service';
import { aulasQueAMatriculaLotaria } from '../../src/classes/ocupacao-da-ocorrencia';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import { StudentsService } from '../../src/people/students.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '07510000-0000-4000-8000-000000000001';
const QUADRA = '07510000-0000-4000-8000-000000000002';
const ORIGEM = '07510000-0000-4000-8000-00000000000a';
const ALVO_TURMA = '07510000-0000-4000-8000-00000000000b';
/** A aula da turma alvo daqui a 6 dias — a disputada. */
const SABADO = '07510000-0000-4000-8000-3000000000ff';

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string) => db.$executeRawUnsafe(sql);

const operacao = () => new ConfigOperacaoService(p);
const matricula = () => new MatriculaDoAlunoService(p, operacao());
const reposicao = () => new ReposicaoService(p, operacao());
function classes(): ClassesService {
  const courts = new CourtsService(
    p,
    { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
    new HorarioFuncionamentoService(p),
    {} as unknown as ImagemDaQuadraService,
    operacao(),
    new CreditosService(),
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
  return new ClassesService(p, courts, new StudentsService(p), operacao());
}

async function desfecho(
  promessa: Promise<unknown>,
): Promise<{ code: string; message?: string; status?: number }> {
  try {
    await promessa;
    return { code: 'OK' };
  } catch (erro) {
    if (!(erro instanceof HttpException)) throw erro;
    const corpo = erro.getResponse() as { code?: string; message?: string };
    return {
      code: corpo.code ?? 'SEM_CODIGO',
      message: corpo.message,
      status: erro.getStatus(),
    };
  }
}

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

let seq = 0;
async function aluno(): Promise<{ alunoId: string; usuarioId: string }> {
  seq += 1;
  const s = String(seq).padStart(2, '0');
  const usuarioId = `07510000-0000-4000-8000-1000000000${s}`;
  const alunoId = `07510000-0000-4000-8000-2000000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','s075l.${seq}@x.com','h','Aluno ${seq}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  return { alunoId, usuarioId };
}

let ocSeq = 0;
async function aula(
  turmaId: string,
  data: string,
  inicio: string,
  fim: string,
  id?: string,
): Promise<string> {
  ocSeq += 1;
  const oid =
    id ?? `07510000-0000-4000-8000-3000000000${String(ocSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${oid}','${EMPRESA}','${QUADRA}','${data}','${inicio}','${fim}','TURMA','${turmaId}','pendente_pagamento',now())`,
  );
  return oid;
}

/** Um aluno da turma de origem, com uma falta avisada numa aula que passou. */
let faltaSeq = 0;
async function alunoComFalta(): Promise<{
  alunoId: string;
  usuarioId: string;
  faltaId: string;
}> {
  const a = await aluno();
  faltaSeq += 1;
  const h = String(faltaSeq).padStart(2, '0');
  const origem = await aula(ORIGEM, emDias(-3), `${h}:00`, `${h}:30`);
  const faltaId = `07510000-0000-4000-8000-4000000000${h}`;
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${ORIGEM}','${a.alunoId}',now())`,
  );
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${faltaId}','${EMPRESA}','${origem}','${a.alunoId}',now())`,
  );
  return { ...a, faltaId };
}

/** Um visitante com reposição ativa na aula — por SQL, para as aulas que o
 *  `marcar` não aceitaria (as que passaram, as de hoje já dadas). */
async function visitanteEm(ocupacaoId: string): Promise<string> {
  const v = await alunoComFalta();
  await q(
    `INSERT INTO reposicoes_de_aula (id,company_id,aluno_id,falta_id,ocupacao_id) VALUES (gen_random_uuid(),'${EMPRESA}','${v.alunoId}','${v.faltaId}','${ocupacaoId}')`,
  );
  return v.alunoId;
}

const matriculados = () =>
  db.turmaAluno.count({ where: { turmaId: ALVO_TURMA } });

async function montar(capacidade: number): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Lotacao','s075-lotacao-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status)
     SELECT '${QUADRA}','${EMPRESA}','Quadra',id,80,'ativa' FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${ORIGEM}','${EMPRESA}','Origem','${QUADRA}',10,'ativa')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${ALVO_TURMA}','${EMPRESA}','Alvo','${QUADRA}',${capacidade},'ativa')`,
  );
  await aula(ALVO_TURMA, emDias(6), '20:00', '21:00', SABADO);
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  seq = 0;
  ocSeq = 0;
  faltaSeq = 0;
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('a matrícula conta as reposições das próximas aulas', () => {
  it('controle: sem reposição, a última vaga é da matrícula', async () => {
    await montar(1);
    const novato = await aluno();
    expect(
      await desfecho(
        classes().allocateStudent(EMPRESA, ALVO_TURMA, novato.alunoId),
      ),
    ).toEqual({ code: 'OK' });
    expect(await matriculados()).toBe(1);
  });

  it('**reposição marcada e DEPOIS o gestor aloca: 409 AULA_LOTADA, com o dia, e nada gravado**', async () => {
    await montar(1);
    const visitante = await alunoComFalta();
    // Pelo serviço de verdade: é exatamente a sequência do defeito.
    await reposicao().marcar(
      EMPRESA,
      visitante.usuarioId,
      visitante.faltaId,
      SABADO,
    );
    const novato = await aluno();

    const r = await desfecho(
      classes().allocateStudent(EMPRESA, ALVO_TURMA, novato.alunoId),
    );
    expect(r).toEqual({
      code: 'AULA_LOTADA',
      status: 409,
      message: `A aula de ${ddmm(emDias(6))} desta turma já está lotada, contando as reposições marcadas. Alocar agora deixaria esse dia acima da capacidade.`,
    });
    expect(await matriculados()).toBe(0);
  });

  it('**e o aluno que tenta entrar recebe 409 TURMA_CHEIA, com o dia**', async () => {
    await montar(1);
    const visitante = await alunoComFalta();
    await reposicao().marcar(
      EMPRESA,
      visitante.usuarioId,
      visitante.faltaId,
      SABADO,
    );
    const novato = await aluno();

    const r = await desfecho(
      matricula().entrar(EMPRESA, novato.usuarioId, ALVO_TURMA),
    );
    expect(r).toEqual({
      code: 'TURMA_CHEIA',
      status: 409,
      message: `A aula de ${ddmm(emDias(6))} desta turma já está com todas as vagas ocupadas, contando as reposições marcadas.`,
    });
    expect(await matriculados()).toBe(0);
  });

  it('controle do aluno: sem reposição, ele entra', async () => {
    await montar(1);
    const novato = await aluno();
    expect(
      await desfecho(matricula().entrar(EMPRESA, novato.usuarioId, ALVO_TURMA)),
    ).toEqual({ code: 'OK' });
  });

  describe('a vaga que a falta libera', () => {
    /** Capacidade 2, um matriculado que avisou falta no sábado. */
    async function comFaltaNoSabado(): Promise<void> {
      await montar(2);
      const membro = await aluno();
      await q(
        `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${ALVO_TURMA}','${membro.alunoId}',now())`,
      );
      await q(
        `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${SABADO}','${membro.alunoId}',now())`,
      );
    }

    it('já dada a DUAS reposições: o sábado tem 2 corpos em 2 vagas, e a matrícula recusa', async () => {
      await comFaltaNoSabado();
      await visitanteEm(SABADO);
      await visitanteEm(SABADO);
      const novato = await aluno();
      // Uma soma de contagens (1 matriculado < 2) deixaria passar.
      expect(
        (
          await desfecho(
            classes().allocateStudent(EMPRESA, ALVO_TURMA, novato.alunoId),
          )
        ).code,
      ).toBe('AULA_LOTADA');
      expect(await matriculados()).toBe(1);
    });

    it('controle: dada a UMA só, sobra a vaga do novato', async () => {
      await comFaltaNoSabado();
      await visitanteEm(SABADO);
      const novato = await aluno();
      expect(
        (
          await desfecho(
            classes().allocateStudent(EMPRESA, ALVO_TURMA, novato.alunoId),
          )
        ).code,
      ).toBe('OK');
    });
  });

  it('quem já é visitante do sábado vira membro sem ocupar um corpo a mais', async () => {
    await montar(1);
    const jaVisitante = await visitanteEm(SABADO);
    expect(
      (
        await desfecho(
          classes().allocateStudent(EMPRESA, ALVO_TURMA, jaVisitante),
        )
      ).code,
    ).toBe('OK');
  });

  it('aula cancelada não conta', async () => {
    await montar(1);
    await visitanteEm(SABADO);
    const novato = await aluno();
    // Pelo caminho que o produto usa: `UPDATE` cru a trigger da INV-064 recusa.
    await cancelarOcupacaoNaFixture(db, {
      companyId: EMPRESA,
      ocupacaoId: SABADO,
      autorId: novato.usuarioId,
    });
    expect(
      (
        await desfecho(
          classes().allocateStudent(EMPRESA, ALVO_TURMA, novato.alunoId),
        )
      ).code,
    ).toBe('OK');
  });

  it('aula que já passou não conta', async () => {
    await montar(1);
    const ontem = await aula(ALVO_TURMA, emDias(-1), '10:00', '11:00');
    await visitanteEm(ontem);
    const novato = await aluno();
    expect(
      (
        await desfecho(
          classes().allocateStudent(EMPRESA, ALVO_TURMA, novato.alunoId),
        )
      ).code,
    ).toBe('OK');
  });

  /**
   * **"Hoje" com o relógio FIXO** (achado A-07 da validação da implementação).
   * A versão anterior usava o relógio de verdade, com uma aula das 00h00 às
   * 00h01 e outra das 23h às 23h59 — janela de 2 minutos em que o teste mudava
   * de lado, e o recorte das 21h às 00h (o dia UTC já virou, o do clube não)
   * nunca era exercitado. Aqui a função é chamada com o instante injetado, e a
   * aula é num dia fixo, longe do relógio real (as aulas de `montar` ficam no
   * passado desse instante e não entram).
   *
   * Aula de 15/01/2030, das 22h às 23h no fuso do clube (UTC−3).
   */
  describe('hoje, com o relógio fixo', () => {
    const DIA = '2030-01-15';
    const lotada = (agoraUtc: string, alunoId: string) =>
      aulasQueAMatriculaLotaria(
        p,
        EMPRESA,
        [{ id: ALVO_TURMA, capacidade: 1 }],
        alunoId,
        new Date(agoraUtc),
      );

    async function comAulaLotadaNoDia(): Promise<{
      aulaId: string;
      novato: string;
    }> {
      await montar(1);
      const aulaId = await aula(ALVO_TURMA, DIA, '22:00', '23:00');
      await visitanteEm(aulaId);
      return { aulaId, novato: (await aluno()).alunoId };
    }

    it('às 22h30 do clube, com o dia UTC JÁ VIRADO (01h30Z do dia 16), a aula em andamento conta', async () => {
      const { aulaId, novato } = await comAulaLotadaNoDia();
      const r = await lotada('2030-01-16T01:30:00Z', novato);
      expect(r.get(ALVO_TURMA)?.id).toBe(aulaId);
    });

    it('às 23h30 do clube (02h30Z do dia 16), a aula já terminou e não conta', async () => {
      const { novato } = await comAulaLotadaNoDia();
      const r = await lotada('2030-01-16T02:30:00Z', novato);
      expect(r.has(ALVO_TURMA)).toBe(false);
    });

    it('de manhã (09h do clube), a aula da noite ainda vai acontecer e conta', async () => {
      const { aulaId, novato } = await comAulaLotadaNoDia();
      const r = await lotada('2030-01-15T12:00:00Z', novato);
      expect(r.get(ALVO_TURMA)?.id).toBe(aulaId);
    });
  });

  /**
   * **Todas as aulas, e não só a primeira** (achado A-03: a sabotagem `take: 1`
   * na leitura das aulas passava os 18 casos, porque em todos eles a aula
   * lotada era a primeira). Aqui a primeira cabe e só a seguinte lota.
   */
  it('a primeira aula cabe e a da semana seguinte lota: recusa, citando a da semana seguinte', async () => {
    await montar(1);
    const semanaQueVem = await aula(ALVO_TURMA, emDias(13), '20:00', '21:00');
    await visitanteEm(semanaQueVem);
    const novato = await aluno();
    const r = await desfecho(
      classes().allocateStudent(EMPRESA, ALVO_TURMA, novato.alunoId),
    );
    expect(r.code).toBe('AULA_LOTADA');
    expect(r.message).toContain(`A aula de ${ddmm(emDias(13))} `);
    expect(await matriculados()).toBe(0);
  });

  it('a recusa cita a aula MAIS CEDO que lotaria', async () => {
    await montar(1);
    const semanaQueVem = await aula(ALVO_TURMA, emDias(13), '20:00', '21:00');
    // A mais tarde lotada primeiro: a ordem de inserção não decide.
    await visitanteEm(semanaQueVem);
    await visitanteEm(SABADO);
    const novato = await aluno();
    const r = await desfecho(
      classes().allocateStudent(EMPRESA, ALVO_TURMA, novato.alunoId),
    );
    expect(r.message).toContain(`A aula de ${ddmm(emDias(6))} `);
  });
});

describe('quem oferece a vaga segue a mesma regra', () => {
  const varredor = () =>
    new VarredorDaFilaService(p, new ConfigOperacaoService(p));
  const FILA = '07510000-0000-4000-8000-6000000000ff';

  async function daLista(usuarioId: string) {
    const lista = await matricula().disponiveis(EMPRESA, usuarioId);
    return lista.find((t) => t.id === ALVO_TURMA);
  }

  it('a lista marca CHEIA a turma com o sábado lotado por reposição', async () => {
    await montar(1);
    await visitanteEm(SABADO);
    const novato = await aluno();
    expect(await daLista(novato.usuarioId)).toMatchObject({
      matriculados: 0,
      podeEntrar: false,
      motivo: 'TURMA_CHEIA',
    });
  });

  it('controle da lista: sem reposição, pode entrar', async () => {
    await montar(1);
    const novato = await aluno();
    expect(await daLista(novato.usuarioId)).toMatchObject({
      podeEntrar: true,
      motivo: null,
    });
  });

  /**
   * **Duas turmas no mesmo lote** (achado A-03): a lista lê as aulas de todas
   * numa ida só, e um corte que olhasse só a primeira aula do lote — ou só a
   * primeira de cada turma — erraria aqui. A turma B tem a primeira aula livre
   * e a seguinte lotada; a alvo não tem nada lotado, e aula mais cedo que B.
   */
  it('duas turmas no lote: marca CHEIA só a que tem uma aula POSTERIOR lotada, e deixa a outra', async () => {
    await montar(1);
    const TURMA_B = '07510000-0000-4000-8000-00000000000c';
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA_B}','${EMPRESA}','B','${QUADRA}',1,'ativa')`,
    );
    await aula(TURMA_B, emDias(7), '20:00', '21:00');
    const bLotada = await aula(TURMA_B, emDias(14), '20:00', '21:00');
    await visitanteEm(bLotada);
    const novato = await aluno();

    const lista = await matricula().disponiveis(EMPRESA, novato.usuarioId);
    expect(lista.find((t) => t.id === TURMA_B)).toMatchObject({
      podeEntrar: false,
      motivo: 'TURMA_CHEIA',
    });
    expect(lista.find((t) => t.id === ALVO_TURMA)).toMatchObject({
      podeEntrar: true,
      motivo: null,
    });
  });

  /**
   * **A tela do GESTOR** (ADR-027, achado A-04): a lista e o detalhe da turma
   * dizem o dia em que um aluno novo não caberia — antes, o gestor via "0/1" e
   * recebia `409 AULA_LOTADA` ao alocar.
   */
  describe('a turma do gestor diz a próxima aula lotada', () => {
    const daListaDoGestor = async () =>
      (await classes().list(EMPRESA, { page: 1, pageSize: 50 })).data.find(
        (t) => t.id === ALVO_TURMA,
      );

    it('com o sábado lotado por reposição: a lista E o detalhe dizem o sábado', async () => {
      await montar(1);
      await visitanteEm(SABADO);
      expect(await daListaDoGestor()).toMatchObject({
        alunosAlocados: 0,
        proximaAulaLotada: emDias(6),
      });
      expect(await classes().findOne(EMPRESA, ALVO_TURMA)).toMatchObject({
        proximaAulaLotada: emDias(6),
      });
    });

    it('controle: sem reposição, nada lotado', async () => {
      await montar(1);
      expect((await daListaDoGestor())?.proximaAulaLotada).toBeNull();
      expect(
        (await classes().findOne(EMPRESA, ALVO_TURMA)).proximaAulaLotada,
      ).toBeNull();
    });

    it('turma já cheia por matrícula: nulo — ela já aparece cheia, e o campo não acrescenta nada', async () => {
      await montar(1);
      const membro = await aluno();
      await q(
        `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${ALVO_TURMA}','${membro.alunoId}',now())`,
      );
      expect(await daListaDoGestor()).toMatchObject({
        alunosAlocados: 1,
        proximaAulaLotada: null,
      });
    });
  });

  it('e, para quem já é o visitante do sábado, a lista deixa entrar', async () => {
    await montar(1);
    const jaVisitante = await visitanteEm(SABADO);
    const usuario = await db.aluno.findUniqueOrThrow({
      where: { id: jaVisitante },
      select: { usuarioId: true },
    });
    expect(await daLista(usuario.usuarioId)).toMatchObject({
      podeEntrar: true,
      motivo: null,
    });
  });

  it('o varredor NÃO chama para a turma com o sábado lotado — a linha continua aguardando', async () => {
    await montar(1);
    await visitanteEm(SABADO);
    const esperando = await aluno();
    await q(
      `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id) VALUES ('${FILA}','${EMPRESA}','${esperando.alunoId}','${ALVO_TURMA}')`,
    );
    await varredor().executarCiclo();
    const linha = await db.listaDeEspera.findUniqueOrThrow({
      where: { id: FILA },
      select: { estado: true },
    });
    expect(linha.estado).toBe('aguardando');
  });

  it('e chama quem está na fila e já é o visitante do sábado: para ele, cabe', async () => {
    await montar(1);
    const jaVisitante = await visitanteEm(SABADO);
    await q(
      `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id) VALUES ('${FILA}','${EMPRESA}','${jaVisitante}','${ALVO_TURMA}')`,
    );
    await varredor().executarCiclo();
    const linha = await db.listaDeEspera.findUniqueOrThrow({
      where: { id: FILA },
      select: { estado: true },
    });
    expect(linha.estado).toBe('chamado');
  });

  it('controle do varredor: sem reposição, ele chama', async () => {
    await montar(1);
    const esperando = await aluno();
    await q(
      `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id) VALUES ('${FILA}','${EMPRESA}','${esperando.alunoId}','${ALVO_TURMA}')`,
    );
    await varredor().executarCiclo();
    const linha = await db.listaDeEspera.findUniqueOrThrow({
      where: { id: FILA },
      select: { estado: true },
    });
    expect(linha.estado).toBe('chamado');
  });
});
