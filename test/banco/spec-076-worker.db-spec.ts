/**
 * SPEC-076/TASK-001 — **o fechamento automático grava "Faltou" para quem
 * avisou** (D2, decisões 2 e 10).
 *
 * Antes, o worker gravava `presente` para todo `M ∪ V`, inclusive para quem
 * tinha avisado pelo app que ia faltar (o LIM-057m). Agora cada linha sai de
 * `gravarPresencasDoFechamento`: `ausente` se há falta avisada **nesta
 * ocorrência**, `presente` se não. Autor nulo, origem automática — nada mais
 * no cabeçalho muda.
 *
 * O worker roda pela conexão do login runtime, como em produção.
 */
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import {
  garantirConexoesDeTeste,
  garantirLoginsDeTeste,
  ligarPresencaAutomatica,
  redefinirConfigDePresenca,
} from './config-de-presenca';
import {
  EMPRESA,
  TURMA_A,
  TURMA_ORIGEM,
  aluno,
  aula,
  cabecalhoDe,
  db,
  desconectarTodos,
  diasAtras,
  linhasDe,
  matricular,
  montarEmpresa,
  q,
  reiniciarSequencias,
  runtime,
  soltarTodasAsTravas,
  visita,
} from './presenca-automatica-fixture';
import { FechamentoAutomaticoService } from '../../src/presenca-automatica/fechamento-automatico.service';
import { resolverEstadoDaChamada } from '../../src/classes/estado-da-chamada';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(240_000);
exigirBancoLocal();

const worker = () =>
  new FechamentoAutomaticoService(runtime as unknown as PrismaService);

/** Falta avisada de `alunoId` na ocorrência `ocupacaoId`, crua. */
const avisar = (alunoId: string, ocupacaoId: string) =>
  q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${ocupacaoId}','${alunoId}',now())`,
  );

const statusPorAluno = async (ocupacaoId: string) =>
  Object.fromEntries(
    (await linhasDe(ocupacaoId)).map((l) => [l.alunoId, l.status]),
  );

beforeAll(async () => {
  await garantirLoginsDeTeste(db);
  await garantirConexoesDeTeste(db);
});

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await redefinirConfigDePresenca(db);
  reiniciarSequencias();
  await montarEmpresa();
});

afterEach(async () => {
  await soltarTodasAsTravas();
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await redefinirConfigDePresenca(db);
  await desconectarTodos();
});

describe('SPEC-076/D2 — quem avisou falta vira "Faltou" no fechamento', () => {
  it('AC-004: M = {a, b, c}, b avisou → a presente, b ausente, c presente; autor nulo; cabeçalho automático', async () => {
    const [a, b, c] = [await aluno('A'), await aluno('B'), await aluno('C')];
    for (const x of [a, b, c]) await matricular(TURMA_A, x.alunoId);
    const oc = await aula(TURMA_A, -1);
    await avisar(b.alunoId, oc);
    await ligarPresencaAutomatica(db, diasAtras(3));

    await worker().executarTick();

    expect(await statusPorAluno(oc)).toEqual({
      [a.alunoId]: 'presente',
      [b.alunoId]: 'ausente',
      [c.alunoId]: 'presente',
    });
    expect((await linhasDe(oc)).every((l) => l.autor === null)).toBe(true);
    expect(await cabecalhoDe(oc)).toMatchObject({
      origem: 'automatica',
      origemInicial: 'automatica',
      registradaPor: null,
      completude: 'completa',
    });
    const [cab] = await db.$queryRawUnsafe<{ esperados: number }[]>(
      `SELECT esperados FROM chamadas WHERE ocupacao_id = $1::uuid`,
      oc,
    );
    expect(cab.esperados).toBe(3);
  });

  it('AC-005: a falta de b em OUTRA aula da mesma turma não afeta esta', async () => {
    const [a, b] = [await aluno('A'), await aluno('B')];
    for (const x of [a, b]) await matricular(TURMA_A, x.alunoId);
    const esta = await aula(TURMA_A, -1);
    const outra = await aula(TURMA_A, -2);
    await avisar(b.alunoId, outra);
    await ligarPresencaAutomatica(db, diasAtras(5));

    await worker().executarTick();

    expect((await statusPorAluno(esta))[b.alunoId]).toBe('presente');
    expect((await statusPorAluno(outra))[b.alunoId]).toBe('ausente');
  });

  it('AC-006: todos avisaram → chamada completa com todos ausentes, e o estado é `feita` (não `sem_participantes`)', async () => {
    const [a, b] = [await aluno('A'), await aluno('B')];
    for (const x of [a, b]) await matricular(TURMA_A, x.alunoId);
    const oc = await aula(TURMA_A, -1);
    await avisar(a.alunoId, oc);
    await avisar(b.alunoId, oc);
    await ligarPresencaAutomatica(db, diasAtras(3));

    await worker().executarTick();

    const linhas = await linhasDe(oc);
    expect(linhas).toHaveLength(2);
    expect(linhas.every((l) => l.status === 'ausente')).toBe(true);
    const cab = await cabecalhoDe(oc);
    expect(cab?.completude).toBe('completa');
    expect(
      resolverEstadoDaChamada({
        cancelada: false,
        completude: 'completa',
        data: new Date(),
        horaInicio: new Date(),
        horaFim: new Date(),
      } as Parameters<typeof resolverEstadoDaChamada>[0]),
    ).toBe('feita');
  });

  it('AC-007: quem avisou e SAIU da turma antes do fechamento não ganha linha — e a falta avisada dele continua; o visitante sem falta fica presente', async () => {
    const [fica, saiu] = [await aluno('Fica'), await aluno('Saiu')];
    for (const x of [fica, saiu]) await matricular(TURMA_A, x.alunoId);
    const oc = await aula(TURMA_A, -1);
    await avisar(saiu.alunoId, oc);
    await q(
      `DELETE FROM turma_alunos WHERE turma_id = '${TURMA_A}' AND aluno_id = '${saiu.alunoId}'`,
    );
    const visitante = await aluno('Visitante');
    await matricular(TURMA_ORIGEM, visitante.alunoId);
    await visita(visitante.alunoId, oc);
    await ligarPresencaAutomatica(db, diasAtras(3));

    await worker().executarTick();

    expect(await statusPorAluno(oc)).toEqual({
      [fica.alunoId]: 'presente',
      [visitante.alunoId]: 'presente',
    });
    const [falta] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM faltas_avisadas WHERE ocupacao_id = $1::uuid AND aluno_id = $2::uuid`,
      oc,
      saiu.alunoId,
    );
    expect(Number(falta.n)).toBe(1);
  });
});
