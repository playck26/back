/**
 * SPEC-044 — **a resposta não muda, e a consulta para de repetir entidade.**
 *
 * A v1 desta spec propunha paginação e janela; a validação cruzada derrubou
 * as duas com defeitos determinísticos (`VEREDITO-2026-09-03-SPEC-031-E-044`).
 * Sobrou a parte sem contrato: `include` → `select`. Como nada muda para quem
 * chama, **a prova precisa ser de igualdade** — e não de comportamento novo.
 *
 * Contra Postgres real, e não com dublê, por um motivo específico: o que está
 * em julgamento é o que o **Prisma pede ao banco**. Um mock devolveria o que
 * se mandasse devolver, com ou sem `select`, e o teste passaria dos dois
 * jeitos — exatamente o tipo de prova que este projeto passou o dia
 * aprendendo a não aceitar.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { ClassesService } from '../../src/classes/classes.service';
import type { CourtsService } from '../../src/courts/courts.service';
import type { StudentsService } from '../../src/people/students.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);
exigirBancoLocal();

const EMPRESA = 'f0440000-0000-4000-8000-000000000001';
const QUADRA = 'f0440000-0000-4000-8000-000000000002';
const TURMA = 'f0440000-0000-4000-8000-000000000003';
const USUARIO = 'f0440000-0000-4000-8000-000000000010';
const ALUNO = 'f0440000-0000-4000-8000-000000000011';
// Duas no mesmo dia (AC-002, ordem por hora), uma no dia seguinte, e uma
// avulsa que NÃO pode aparecer (a rota é de aulas de turma).
const AULA_CEDO = 'f0440000-0000-4000-8000-000000000020';
const AULA_TARDE = 'f0440000-0000-4000-8000-000000000021';
const AULA_AMANHA = 'f0440000-0000-4000-8000-000000000022';
const AVULSA = 'f0440000-0000-4000-8000-000000000023';

const db = new PrismaClient();
const service = new ClassesService(
  db as unknown as PrismaService,
  {} as CourtsService,
  {} as StudentsService,
);

/** `AAAA-MM-DD` em UTC, `dias` à frente — as ocorrências têm de ser futuras
 *  (`data >= hojeNoFusoDoClube`), senão a rota não as devolve. */
function emDias(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

const HOJE = emDias(1);
const AMANHA = emDias(2);

async function montar(): Promise<void> {
  const q = (sql: string) => db.$executeRawUnsafe(sql);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-044','spec-044-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Quadra 044',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80)`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','Turma 044','${QUADRA}',20,'ativa')`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','spec044@teste.local','x','Aluno 044','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${ALUNO}','${USUARIO}','${EMPRESA}','aprovado')`,
  );
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA}','${ALUNO}',now())`,
  );
  // **Inseridas fora de ordem de propósito** (tarde antes de cedo): se o
  // `orderBy` sumir, o teste da ordem tem de cair, não passar por sorte da
  // ordem de inserção.
  for (const [id, data, ini, fim, turma] of [
    [AULA_TARDE, HOJE, '18:00', '19:00', TURMA],
    [AULA_CEDO, HOJE, '09:00', '10:00', TURMA],
    [AULA_AMANHA, AMANHA, '09:00', '10:00', TURMA],
  ] as const) {
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at) VALUES ('${id}','${EMPRESA}','${QUADRA}','${data}','${ini}','${fim}','TURMA','${turma}','pendente_pagamento',now())`,
    );
  }
  // Reserva avulsa do mesmo aluno: a rota é de AULAS, e ela não pode entrar.
  //
  // `valor` NÃO é opcional aqui: o CHECK `ocupacoes_valor_por_origem` exige
  // `valor IS NOT NULL` quando `origem_tipo = 'AVULSO'` e `valor IS NULL`
  // quando é `'TURMA'` — foi ele que derrubou a primeira versão desta
  // fixture no CI (run 33819047182, `23514`). As de turma acima ficam sem
  // `valor` pelo mesmo motivo, e não por esquecimento.
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,status_pagamento,updated_at) VALUES ('${AVULSA}','${EMPRESA}','${QUADRA}','${HOJE}','20:00','21:00','AVULSO','${ALUNO}',80,'pendente_pagamento',now())`,
  );
  // A aula da tarde não aconteceu — `naoRealizada` tem de vir `true` só nela.
  await q(
    `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,completude,updated_at) VALUES ('${AULA_TARDE}','TURMA','${EMPRESA}','${USUARIO}','nao_houve',now())`,
  );
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await montar();
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-044 — myUpcomingClasses depois do select', () => {
  it('AC-001/AC-002: a resposta é campo a campo a esperada, na ordem data+hora', async () => {
    const aulas = await service.myUpcomingClasses(EMPRESA, USUARIO);

    // A avulsa não entra: 3 aulas de turma, não 4.
    expect(aulas).toHaveLength(3);
    expect(aulas.map((a) => a.ocupacaoId)).toEqual([
      AULA_CEDO,
      AULA_TARDE,
      AULA_AMANHA,
    ]);
    // Campo a campo, e não `toMatchObject`: uma chave a mais na resposta é
    // regressão de contrato, e `toEqual` reprova, `toMatchObject` não.
    expect(aulas[0]).toEqual({
      ocupacaoId: AULA_CEDO,
      turmaId: TURMA,
      turmaNome: 'Turma 044',
      quadraId: QUADRA,
      quadraNome: 'Quadra 044',
      naoRealizada: false,
      data: HOJE,
      horaInicio: '09:00',
      horaFim: '10:00',
    });
    // A do mesmo dia, mais tarde, e com chamada `nao_houve`.
    expect(aulas[1]).toEqual({
      ocupacaoId: AULA_TARDE,
      turmaId: TURMA,
      turmaNome: 'Turma 044',
      quadraId: QUADRA,
      quadraNome: 'Quadra 044',
      naoRealizada: true,
      data: HOJE,
      horaInicio: '18:00',
      horaFim: '19:00',
    });
    expect(aulas[2].data).toBe(AMANHA);
    expect(aulas[2].naoRealizada).toBe(false);
  });

  /**
   * AC-003 — a prova de que o `select` existe, e é a razão desta suíte.
   *
   * Espionar o `findMany` seria mais direto, mas passaria com `include`
   * também se alguém escrevesse a asserção errada. Aqui a pergunta é feita
   * ao **objeto que o Prisma devolve**: com `select`, a ocupação vem só com
   * as chaves pedidas; com `include: { origemTurma: true }`, ela viria com
   * `companyId`, `statusPagamento`, `valor`, `pedidoId`, `transicaoId` e o
   * resto — e a turma viria inteira, não só o `nome`.
   */
  it('AC-003/AC-004: a consulta traz só os campos usados — nada de entidade inteira', async () => {
    const espiao = jest.spyOn(db.ocupacaoQuadra, 'findMany');
    await service.myUpcomingClasses(EMPRESA, USUARIO);
    const argumento = espiao.mock.calls[0][0] as {
      select?: Record<string, unknown>;
      include?: Record<string, unknown>;
    };
    espiao.mockRestore();

    // A sabotagem do AC-004 (voltar para `include`) cai nestas três linhas.
    expect(argumento.include).toBeUndefined();
    expect(argumento.select).toBeDefined();
    expect(Object.keys(argumento.select ?? {}).sort()).toEqual([
      'chamadas',
      'data',
      'horaFim',
      'horaInicio',
      'id',
      'origemTurma',
      'origemTurmaId',
      'quadra',
      'quadraId',
    ]);
    // E as relações também são recortadas: turma e quadra só pelo `nome`.
    expect(argumento.select?.origemTurma).toEqual({ select: { nome: true } });
    expect(argumento.select?.quadra).toEqual({ select: { nome: true } });
  });
});
