/**
 * SPEC-075/TASK-002 — **o nível decide o acesso, pelos serviços de verdade,
 * contra o banco de verdade.**
 *
 * O que está em julgamento: o nível efetivo (D1), a regra (D2), a recusa nos
 * cinco gestos — quatro do aluno e o do gestor — na posição da D3, com o texto
 * de quem lê (D4), a herança pela confirmação da fila (fato 5 da spec), e o
 * recorte das duas listas do aluno.
 *
 * O mundo da maior parte dos casos: uma empresa com **Iniciante (1),
 * Intermediário (2) e Avançado (3)**, uma turma de cada nível e uma sem nível.
 * O aluno de nível é Intermediário; o aluno sem nível conta como Iniciante.
 *
 * **Cada recusa é conferida pelo CÓDIGO e pelo efeito** (nada gravado): um
 * `422` que viesse de outra regra passaria por qualquer `rejects`.
 */
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { ClassesService } from '../../src/classes/classes.service';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CourtsService } from '../../src/courts/courts.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { FilaDeEsperaService } from '../../src/fila-de-espera/fila-de-espera.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import { nivelEfetivoDoAluno } from '../../src/people/nivel-efetivo';
import { StudentsService } from '../../src/people/students.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(300_000);
exigirBancoLocal();

const EMPRESA = '07500000-0000-4000-8000-000000000001';
/** Empresa SEM nível nenhum — AC-003. */
const EMPRESA_SEM = '07500000-0000-4000-8000-000000000002';
/** Empresa só dos desempates — AC-002. */
const EMPRESA_ORD = '07500000-0000-4000-8000-000000000003';
const QUADRA = '07500000-0000-4000-8000-000000000011';
const QUADRA_SEM = '07500000-0000-4000-8000-000000000012';
const INI = '07500000-0000-4000-8000-000000000021';
const INT = '07500000-0000-4000-8000-000000000022';
const AVA = '07500000-0000-4000-8000-000000000023';
const T_INI = '07500000-0000-4000-8000-000000000031';
const T_INT = '07500000-0000-4000-8000-000000000032';
const T_AVA = '07500000-0000-4000-8000-000000000033';
const T_SEM = '07500000-0000-4000-8000-000000000034';
const T_DA_EMPRESA_SEM = '07500000-0000-4000-8000-000000000035';

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string) => db.$executeRawUnsafe(sql);

const operacao = () => new ConfigOperacaoService(p);
const matricula = () => new MatriculaDoAlunoService(p, operacao());
const reposicao = () => new ReposicaoService(p, operacao());
const fila = () =>
  new FilaDeEsperaService(p, operacao(), matricula(), reposicao());
/** O molde de `spec-064-encerramentos`, com o `StudentsService` de verdade:
 *  o `allocateStudent` chama `garantirAlunoOperante`. */
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

/** O `code` da recusa, ou a mensagem, ou `OK`. */
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

let seq = 0;
async function aluno(
  nivelId: string | null,
  empresa = EMPRESA,
): Promise<{ alunoId: string; usuarioId: string }> {
  seq += 1;
  const s = String(seq).padStart(3, '0');
  const usuarioId = `07500000-0000-4000-8000-100000000${s}`;
  const alunoId = `07500000-0000-4000-8000-200000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','s075.${seq}@x.com','h','Aluno ${seq}','aluno','${empresa}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status,nivel_id) VALUES ('${alunoId}','${usuarioId}','${empresa}','aprovado','ativo',${nivelId ? `'${nivelId}'` : 'NULL'})`,
  );
  return { alunoId, usuarioId };
}

/** Matrícula de antes da regra — por SQL, sem passar por ela (D6). */
const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${alunoId}',now())`,
  );

let ocSeq = 0;
async function ocorrencia(
  turmaId: string,
  data: string,
  hora = '09:00',
): Promise<string> {
  ocSeq += 1;
  const id = `07500000-0000-4000-8000-3000000${String(ocSeq).padStart(5, '0')}`;
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${data}','${hora}','${fim}','TURMA','${turmaId}','pendente_pagamento',now())`,
  );
  return id;
}

let faltaSeq = 0;
/** Um crédito de reposição: a falta avisada numa aula (passada) da turma do
 *  aluno — o molde de `spec-064-confirmar`. */
async function credito(alunoId: string): Promise<string> {
  await matricular(T_SEM, alunoId);
  const perdida = await ocorrencia(T_SEM, emDias(-2), '08:00');
  faltaSeq += 1;
  const id = `07500000-0000-4000-8000-4000000000${String(faltaSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${id}','${EMPRESA}','${perdida}','${alunoId}',now())`,
  );
  return id;
}

let filaSeq = 0;
async function chamada(opcoes: {
  alunoId: string;
  turmaId?: string;
  ocupacaoId?: string;
  faltaId?: string;
}): Promise<string> {
  filaSeq += 1;
  const id = `07500000-0000-4000-8000-5000000000${String(filaSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,ocupacao_id,falta_id,estado,chamado_em,chamado_ate)
     VALUES ('${id}','${EMPRESA}','${opcoes.alunoId}',
             ${opcoes.turmaId ? `'${opcoes.turmaId}'` : 'NULL'},
             ${opcoes.ocupacaoId ? `'${opcoes.ocupacaoId}'` : 'NULL'},
             ${opcoes.faltaId ? `'${opcoes.faltaId}'` : 'NULL'},
             'chamado', now(), now() + interval '6 hours')`,
  );
  return id;
}

const matriculas = (alunoId: string, turmaId: string) =>
  db.turmaAluno.count({ where: { alunoId, turmaId } });

async function montar(): Promise<void> {
  for (const [emp, nome] of [
    [EMPRESA, 'com niveis'],
    [EMPRESA_SEM, 'sem nivel'],
  ] as const) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${emp}','SPEC-075 ${nome}','spec-075-${emp}',now())`,
    );
    await q(
      `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${emp}','Tenis',0,now())`,
    );
  }
  for (const [quadra, emp] of [
    [QUADRA, EMPRESA],
    [QUADRA_SEM, EMPRESA_SEM],
  ] as const) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${quadra}','${emp}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${emp}' LIMIT 1),80,'ativa')`,
    );
  }
  for (const [id, nome, ordem] of [
    [INI, 'Iniciante', 1],
    [INT, 'Intermediário', 2],
    [AVA, 'Avançado', 3],
  ] as const) {
    await q(
      `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${id}','${EMPRESA}','${nome}',${ordem})`,
    );
  }
  for (const [id, nivel, nome] of [
    [T_INI, INI, 'Turma Iniciante'],
    [T_INT, INT, 'Turma Intermediário'],
    [T_AVA, AVA, 'Turma Avançado'],
    [T_SEM, null, 'Turma sem nível'],
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ('${id}','${EMPRESA}','${nome}','${QUADRA}',4,'ativa',${nivel ? `'${nivel}'` : 'NULL'})`,
    );
  }
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${T_DA_EMPRESA_SEM}','${EMPRESA_SEM}','T','${QUADRA_SEM}',4,'ativa')`,
  );
}

beforeEach(async () => {
  for (const emp of [EMPRESA, EMPRESA_SEM, EMPRESA_ORD]) {
    await limparEmpresa(db, emp);
  }
  await montar();
});

afterAll(async () => {
  for (const emp of [EMPRESA, EMPRESA_SEM, EMPRESA_ORD]) {
    await limparEmpresa(db, emp);
  }
  await db.$disconnect();
});

// ==========================================================================
// D1 — o nível efetivo
// ==========================================================================

describe('AC-001 a AC-003 — o nível efetivo', () => {
  it('AC-001 — aluno COM nível: o efetivo é o dele', async () => {
    const a = await aluno(AVA);
    const efetivo = await nivelEfetivoDoAluno(p, EMPRESA, AVA);
    expect(efetivo).toEqual({ id: AVA, nome: 'Avançado', doPrimeiro: false });
    expect(a.alunoId).toBeDefined();
  });

  describe('AC-002 — o primeiro nível, pelas três chaves (INV-075c)', () => {
    beforeEach(async () => {
      await q(
        `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA_ORD}','SPEC-075 ordem','spec-075-${EMPRESA_ORD}',now())`,
      );
    });
    const nivel = (id: string, nome: string, ordem: number, criado: string) =>
      q(
        `INSERT INTO niveis (id,company_id,nome,ordem,created_at) VALUES ('${id}','${EMPRESA_ORD}','${nome}',${ordem},'${criado}')`,
      );

    it('(a) ordem: de 2, 1 e 3, o primeiro é o de ordem 1', async () => {
      await nivel(
        '07500000-0000-4000-8000-0000000000a2',
        'Dois',
        2,
        '2026-01-01T10:00:00Z',
      );
      await nivel(
        '07500000-0000-4000-8000-0000000000a1',
        'Um',
        1,
        '2026-01-01T10:00:00Z',
      );
      await nivel(
        '07500000-0000-4000-8000-0000000000a3',
        'Tres',
        3,
        '2026-01-01T10:00:00Z',
      );
      const efetivo = await nivelEfetivoDoAluno(p, EMPRESA_ORD, null);
      expect(efetivo?.nome).toBe('Um');
    });

    it('(b) created_at: dois de ordem 1, o mais ANTIGO tem o id MAIOR → o efetivo é o mais antigo', async () => {
      const ANTIGO = '07500000-0000-4000-8000-0000000000bf';
      const NOVO = '07500000-0000-4000-8000-0000000000b1';
      await nivel(NOVO, 'Novo', 1, '2026-01-02T10:00:00Z');
      await nivel(ANTIGO, 'Antigo', 1, '2026-01-01T10:00:00Z');
      // As duas premissas, afirmadas: created_at diferentes, id do antigo maior.
      const linhas = await db.nivel.findMany({
        where: { companyId: EMPRESA_ORD },
        orderBy: { createdAt: 'asc' },
      });
      expect(linhas[0].id).toBe(ANTIGO);
      expect(linhas[0].createdAt.getTime()).not.toBe(
        linhas[1].createdAt.getTime(),
      );
      expect(ANTIGO > NOVO).toBe(true);

      const efetivo = await nivelEfetivoDoAluno(p, EMPRESA_ORD, null);
      expect(efetivo?.id).toBe(ANTIGO);
    });

    it('(c) id: dois de ordem 1 com o MESMO created_at, o de id MAIOR inserido primeiro → o efetivo é o de id MENOR', async () => {
      const MAIOR = '07500000-0000-4000-8000-0000000000cf';
      const MENOR = '07500000-0000-4000-8000-0000000000c1';
      await nivel(MAIOR, 'Maior', 1, '2026-01-01T10:00:00Z');
      await nivel(MENOR, 'Menor', 1, '2026-01-01T10:00:00Z');
      const linhas = await db.nivel.findMany({
        where: { companyId: EMPRESA_ORD },
      });
      expect(linhas[0].createdAt.getTime()).toBe(linhas[1].createdAt.getTime());

      const efetivo = await nivelEfetivoDoAluno(p, EMPRESA_ORD, null);
      expect(efetivo?.id).toBe(MENOR);
    });
  });

  it('AC-003 — empresa SEM nível: efetivo nenhum, e a turma aceita o aluno (regra inerte)', async () => {
    const a = await aluno(null, EMPRESA_SEM);
    expect(await nivelEfetivoDoAluno(p, EMPRESA_SEM, null)).toBeNull();
    const r = await desfecho(
      matricula().entrar(EMPRESA_SEM, a.usuarioId, T_DA_EMPRESA_SEM),
    );
    expect(r.code).toBe('OK');
  });
});

// ==========================================================================
// Os quatro gestos do aluno
// ==========================================================================

describe('AC-004 — entrar numa turma', () => {
  it('do nível dele → entra; sem nível → entra', async () => {
    const a = await aluno(INT);
    expect(
      (await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_INT))).code,
    ).toBe('OK');
    expect(
      (await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_SEM))).code,
    ).toBe('OK');
    expect(await matriculas(a.alunoId, T_INT)).toBe(1);
  });

  it('de outro nível → 422 NIVEL_INCOMPATIVEL, com o texto do aluno, e nenhuma matrícula (AC-017)', async () => {
    const a = await aluno(INT);
    const r = await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_AVA));
    expect(r).toEqual({
      code: 'NIVEL_INCOMPATIVEL',
      status: 422,
      message: 'Esta turma é do nível Avançado. O seu nível é Intermediário.',
    });
    expect(await matriculas(a.alunoId, T_AVA)).toBe(0);
  });

  it('aluno SEM nível: turma do primeiro → entra; de outro → recusa, dizendo que conta como o primeiro (AC-017)', async () => {
    const a = await aluno(null);
    expect(
      (await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_INI))).code,
    ).toBe('OK');
    const r = await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_INT));
    expect(r.code).toBe('NIVEL_INCOMPATIVEL');
    expect(r.message).toBe(
      'Esta turma é do nível Intermediário. O clube ainda não definiu o seu nível; por enquanto você conta como Iniciante.',
    );
    expect(await matriculas(a.alunoId, T_INT)).toBe(0);
  });

  it('JÁ matriculado (de antes) numa turma de outro nível: tocar de novo devolve a matrícula que existe', async () => {
    const a = await aluno(INT);
    await matricular(T_AVA, a.alunoId);
    const r = await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_AVA));
    expect(r.code).toBe('OK');
    expect(await matriculas(a.alunoId, T_AVA)).toBe(1);
  });

  it('turma de outro nível E cheia → NIVEL_INCOMPATIVEL, não TURMA_CHEIA', async () => {
    await q(`UPDATE turmas SET capacidade = 1 WHERE id = '${T_AVA}'`);
    const ocupante = await aluno(AVA);
    await matricular(T_AVA, ocupante.alunoId);
    const a = await aluno(INT);
    const r = await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_AVA));
    expect(r.code).toBe('NIVEL_INCOMPATIVEL');
  });
});

describe('AC-005 — marcar reposição', () => {
  it('aula de turma de outro nível → 422, e a falta continua sem reposição', async () => {
    const a = await aluno(INT);
    const falta = await credito(a.alunoId);
    const alvo = await ocorrencia(T_AVA, emDias(3));
    const r = await desfecho(
      reposicao().marcar(EMPRESA, a.usuarioId, falta, alvo),
    );
    expect(r.code).toBe('NIVEL_INCOMPATIVEL');
    expect(await db.reposicaoDeAula.count({ where: { faltaId: falta } })).toBe(
      0,
    );
  });

  it('aula do nível dele → marca (controle)', async () => {
    const a = await aluno(INT);
    const falta = await credito(a.alunoId);
    const alvo = await ocorrencia(T_INT, emDias(3));
    expect(
      (await desfecho(reposicao().marcar(EMPRESA, a.usuarioId, falta, alvo)))
        .code,
    ).toBe('OK');
  });

  it('aula de outro nível E cheia → NIVEL_INCOMPATIVEL, não TURMA_SEM_VAGA', async () => {
    await q(`UPDATE turmas SET capacidade = 1 WHERE id = '${T_AVA}'`);
    const ocupante = await aluno(AVA);
    await matricular(T_AVA, ocupante.alunoId);
    const a = await aluno(INT);
    const falta = await credito(a.alunoId);
    const alvo = await ocorrencia(T_AVA, emDias(3));
    const r = await desfecho(
      reposicao().marcar(EMPRESA, a.usuarioId, falta, alvo),
    );
    expect(r.code).toBe('NIVEL_INCOMPATIVEL');
  });
});

describe('AC-006 e AC-007 — entrar na fila', () => {
  it('AC-006 — fila de TURMA de outro nível → 422, sem linha', async () => {
    const a = await aluno(INT);
    const r = await desfecho(fila().entrarNaTurma(EMPRESA, a.usuarioId, T_AVA));
    expect(r.code).toBe('NIVEL_INCOMPATIVEL');
    expect(
      await db.listaDeEspera.count({ where: { alunoId: a.alunoId } }),
    ).toBe(0);
  });

  it('AC-007 — fila de AULA de turma de outro nível → 422, sem linha', async () => {
    const a = await aluno(INT);
    await credito(a.alunoId);
    const alvo = await ocorrencia(T_AVA, emDias(3));
    const r = await desfecho(fila().entrarNaAula(EMPRESA, a.usuarioId, alvo));
    expect(r.code).toBe('NIVEL_INCOMPATIVEL');
    expect(
      await db.listaDeEspera.count({ where: { alunoId: a.alunoId } }),
    ).toBe(0);
  });

  it('controle — fila de turma e de aula do nível dele entram', async () => {
    const a = await aluno(INT);
    await credito(a.alunoId);
    const alvo = await ocorrencia(T_INT, emDias(3));
    expect(
      (await desfecho(fila().entrarNaTurma(EMPRESA, a.usuarioId, T_INT))).code,
    ).toBe('OK');
    expect(
      (await desfecho(fila().entrarNaAula(EMPRESA, a.usuarioId, alvo))).code,
    ).toBe('OK');
  });
});

describe('AC-008 — a confirmação da fila HERDA a regra, e encerra a linha', () => {
  it('fila de TURMA: linha antiga, aluno de outro nível → recusa NIVEL_INCOMPATIVEL e a linha fica encerrada', async () => {
    const a = await aluno(INT);
    const linha = await chamada({ alunoId: a.alunoId, turmaId: T_AVA });
    const r = await fila().confirmar(EMPRESA, a.usuarioId, linha);
    expect(r).toMatchObject({ ok: false, code: 'NIVEL_INCOMPATIVEL' });
    const depois = await db.listaDeEspera.findUniqueOrThrow({
      where: { id: linha },
    });
    expect(depois.estado).toBe('encerrada');
    expect(await matriculas(a.alunoId, T_AVA)).toBe(0);
  });

  it('fila de AULA: idem — recusa, encerrada, e nenhuma reposição', async () => {
    const a = await aluno(INT);
    const falta = await credito(a.alunoId);
    const alvo = await ocorrencia(T_AVA, emDias(3));
    const linha = await chamada({
      alunoId: a.alunoId,
      ocupacaoId: alvo,
      faltaId: falta,
    });
    const r = await fila().confirmar(EMPRESA, a.usuarioId, linha);
    expect(r).toMatchObject({ ok: false, code: 'NIVEL_INCOMPATIVEL' });
    const depois = await db.listaDeEspera.findUniqueOrThrow({
      where: { id: linha },
    });
    expect(depois.estado).toBe('encerrada');
    expect(await db.reposicaoDeAula.count({ where: { faltaId: falta } })).toBe(
      0,
    );
  });
});

// ==========================================================================
// As duas listas do aluno
// ==========================================================================

describe('AC-009 — GET /me/classes/disponiveis, recortada pelo servidor', () => {
  it('aluno COM nível: o nível dele e as sem nível — e a de outro nível em que JÁ está', async () => {
    const a = await aluno(INT);
    await matricular(T_AVA, a.alunoId);
    const lista = await matricula().disponiveis(EMPRESA, a.usuarioId);
    const ids = lista.map((t) => t.id).sort();
    expect(ids).toEqual([T_INT, T_AVA, T_SEM].sort());
    expect(lista.find((t) => t.id === T_AVA)?.jaEstouNela).toBe(true);
  });

  it('aluno SEM nível: as do primeiro nível e as sem nível', async () => {
    const a = await aluno(null);
    const lista = await matricula().disponiveis(EMPRESA, a.usuarioId);
    expect(lista.map((t) => t.id).sort()).toEqual([T_INI, T_SEM].sort());
  });
});

describe('AC-010 — GET /me/reposicoes/oportunidades, recortada NO BANCO', () => {
  it('o mesmo recorte, com e sem incluirSemVaga', async () => {
    const a = await aluno(INT);
    const oIni = await ocorrencia(T_INI, emDias(3), '09:00');
    const oInt = await ocorrencia(T_INT, emDias(3), '11:00');
    const oAva = await ocorrencia(T_AVA, emDias(3), '13:00');
    const oSem = await ocorrencia(T_SEM, emDias(3), '15:00');
    for (const incluirSemVaga of [false, true]) {
      const lista = await reposicao().oportunidades(
        EMPRESA,
        a.usuarioId,
        incluirSemVaga,
      );
      const ids = lista.map((o) => o.ocupacaoId);
      expect(ids).toContain(oInt);
      expect(ids).toContain(oSem);
      expect(ids).not.toContain(oAva);
      expect(ids).not.toContain(oIni);
    }
  });

  it('com 200 ocorrências de OUTRO nível antes da primeira do nível dele, a dele aparece', async () => {
    const a = await aluno(INT);
    // 200 aulas do Avançado, uma por dia, antes da do Intermediário.
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
       SELECT gen_random_uuid(),'${EMPRESA}','${QUADRA}',('${emDias(1)}'::date + g),'09:00','10:00','TURMA','${T_AVA}','pendente_pagamento',now()
         FROM generate_series(0,199) g`,
    );
    const dele = await ocorrencia(T_INT, emDias(1 + 200), '09:00');
    const [antes] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM ocupacoes_quadra WHERE origem_turma_id = '${T_AVA}'`,
    );
    expect(Number(antes.n)).toBe(200);

    const lista = await reposicao().oportunidades(EMPRESA, a.usuarioId, true);
    expect(lista.map((o) => o.ocupacaoId)).toContain(dele);
  });
});

// ==========================================================================
// O gestor, e o que não é retroativo
// ==========================================================================

describe('AC-011 e AC-020 — o gestor também é recusado', () => {
  it('aluno de outro nível → 422, com o texto do GESTOR, e nenhuma matrícula', async () => {
    const a = await aluno(INT);
    const r = await desfecho(
      classes().allocateStudent(EMPRESA, T_AVA, a.alunoId),
    );
    expect(r).toEqual({
      code: 'NIVEL_INCOMPATIVEL',
      status: 422,
      message:
        'Esta turma é do nível Avançado, e este aluno é Intermediário. Para alocá-lo, mude o nível dele.',
    });
    expect(await matriculas(a.alunoId, T_AVA)).toBe(0);
  });

  it('aluno SEM nível numa turma que não é do primeiro → 422, dizendo que conta como o primeiro', async () => {
    const a = await aluno(null);
    const r = await desfecho(
      classes().allocateStudent(EMPRESA, T_INT, a.alunoId),
    );
    expect(r.code).toBe('NIVEL_INCOMPATIVEL');
    expect(r.message).toBe(
      'Esta turma é do nível Intermediário, e este aluno ainda não tem nível — ele conta como Iniciante. Para alocá-lo, defina o nível dele.',
    );
  });

  it('do nível dele, ou turma sem nível → aloca', async () => {
    const a = await aluno(INT);
    expect(
      (await desfecho(classes().allocateStudent(EMPRESA, T_INT, a.alunoId)))
        .code,
    ).toBe('OK');
    expect(
      (await desfecho(classes().allocateStudent(EMPRESA, T_SEM, a.alunoId)))
        .code,
    ).toBe('OK');
  });

  it('JÁ alocado (de antes) → devolve a alocação que existe', async () => {
    const a = await aluno(INT);
    await matricular(T_AVA, a.alunoId);
    expect(
      (await desfecho(classes().allocateStudent(EMPRESA, T_AVA, a.alunoId)))
        .code,
    ).toBe('OK');
    expect(await matriculas(a.alunoId, T_AVA)).toBe(1);
  });

  it('turma de outro nível E cheia → NIVEL_INCOMPATIVEL, não o erro de capacidade', async () => {
    await q(`UPDATE turmas SET capacidade = 1 WHERE id = '${T_AVA}'`);
    const ocupante = await aluno(AVA);
    await matricular(T_AVA, ocupante.alunoId);
    const a = await aluno(INT);
    const r = await desfecho(
      classes().allocateStudent(EMPRESA, T_AVA, a.alunoId),
    );
    expect(r.code).toBe('NIVEL_INCOMPATIVEL');
  });
});

describe('AC-012 — não é retroativo', () => {
  it('a matrícula de antes, fora do nível, continua — e continua aparecendo para ele', async () => {
    const a = await aluno(INT);
    await matricular(T_AVA, a.alunoId);
    // Um gesto recusado em outra turma não mexe na que já existe.
    await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_INI));
    expect(await matriculas(a.alunoId, T_AVA)).toBe(1);
    const lista = await matricula().disponiveis(EMPRESA, a.usuarioId);
    expect(lista.find((t) => t.id === T_AVA)?.jaEstouNela).toBe(true);
  });
});

// ==========================================================================
// AC-021 — o lado de cima da posição (D3): a recusa IMEDIATAMENTE anterior vence
// ==========================================================================

describe('AC-021 — a recusa imediatamente anterior vence a de nível', () => {
  it('entrarNaTransacao: LIMITE_DE_TURMAS vence', async () => {
    await q(
      `UPDATE empresas SET limite_turmas_por_aluno = 1 WHERE id = '${EMPRESA}'`,
    );
    const a = await aluno(INT);
    await matricular(T_SEM, a.alunoId);
    const r = await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_AVA));
    expect(r.code).toBe('LIMITE_DE_TURMAS');
  });

  it('marcarNaTransacao: o prazo (avaliarSaidaDeTurma) vence', async () => {
    const a = await aluno(INT);
    const falta = await credito(a.alunoId);
    // A aula de hoje que já começou: o prazo recusa com o código dele.
    const alvo = await ocorrencia(T_AVA, emDias(0), '00:00');
    const r = await desfecho(
      reposicao().marcar(EMPRESA, a.usuarioId, falta, alvo),
    );
    expect(r.code).toBe('PRAZO_DE_CANCELAMENTO');
  });

  it('entrarNaTurma: recusarSeJaMatriculado vence', async () => {
    const a = await aluno(INT);
    await matricular(T_AVA, a.alunoId);
    const r = await desfecho(fila().entrarNaTurma(EMPRESA, a.usuarioId, T_AVA));
    expect(r.code).toBe('JA_MATRICULADO_NA_TURMA');
  });

  it('entrarNaAula: SEM_CREDITO vence', async () => {
    const a = await aluno(INT);
    const alvo = await ocorrencia(T_AVA, emDias(3));
    const r = await desfecho(fila().entrarNaAula(EMPRESA, a.usuarioId, alvo));
    expect(r.code).toBe('SEM_CREDITO');
  });

  // allocateStudent: o vizinho de cima é o `jaAlocado` — é o caso "JÁ alocado"
  // da AC-011, que devolve a alocação existente em vez de NIVEL_INCOMPATIVEL.
});
