/**
 * SPEC-015/TASK-005 — FIT-005, a tabela de provas da chamada.
 *
 * **Precisa de Postgres de verdade.** Metade destas linhas depende de
 * constraint (a FK composta que impede presença sem cabeçalho, o CHECK de
 * `completude`/`esperados`, o par único), e mock não tem constraint
 * nenhuma — provar isso com Prisma mockado provaria só que o meu código
 * concorda comigo.
 *
 * A tabela nasceu ao longo de dez rodadas de validação cruzada, e cada
 * linha existe porque uma versão da correção errou nela. Elas viviam no
 * harness do `workspace`, que roda à mão; aqui viram teste do repositório,
 * porque prova que não se pode rodar de novo não é prova.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { PresencaService } from '../../src/classes/presenca.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

// Antes de qualquer conexão: esta suíte escreve, e o `.env` real
// aponta para o Neon de produção (achado da validação cruzada).
exigirBancoLocal();

const db = new PrismaClient();
const service = new PresencaService(db as unknown as PrismaService);

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const QUADRA = '22222222-2222-4222-8222-222222222222';
const TURMA = '33333333-3333-4333-8333-333333333333';
const OUTRA_TURMA = '3a333333-3333-4333-8333-333333333333';
const UPROF = '44444444-4444-4444-8444-444444444444';
const PROF = '55555555-5555-4555-8555-555555555555';

/** `a0`..`a9`, com nomes estáveis para a ordenação do `GET`. */
const alunoId = (n: number) =>
  `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const usuarioId = (n: number) =>
  `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

let fatia = -1;
async function novaAula(turmaId = TURMA, diasAtras = 0): Promise<string> {
  fatia += 1;
  const [r] = await db.$queryRawUnsafe<{ id: string }[]>(`
    INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
    VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}',CURRENT_DATE - ${diasAtras},
            TIME '00:00' + (${fatia} * INTERVAL '10 minutes'),
            TIME '00:00' + (${fatia} * INTERVAL '10 minutes') + INTERVAL '9 minutes',
            'TURMA','${turmaId}','pendente_pagamento',now())
    RETURNING id`);
  return r.id;
}

async function matricular(alunos: number[], turmaId = TURMA) {
  await db.$executeRawUnsafe(
    `DELETE FROM turma_alunos WHERE turma_id='${turmaId}'`,
  );
  for (const n of alunos) {
    await db.$executeRawUnsafe(
      `INSERT INTO turma_alunos (id,turma_id,aluno_id) VALUES (gen_random_uuid(),'${turmaId}','${alunoId(n)}')`,
    );
  }
}

type Item = { alunoId: string; status: 'presente' | 'ausente' | 'justificado' };
const corpoDe = (g: {
  alunos: { alunoId: string; status: string | null }[];
}): Item[] =>
  g.alunos.map((a) => ({
    alunoId: a.alunoId,
    status: (a.status ?? 'presente') as 'presente',
  }));

async function erroDe(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as {
      getStatus?: () => number;
      getResponse?: () => { code?: string };
    };
  }
}
const cod = (e: Awaited<ReturnType<typeof erroDe>>) =>
  e
    ? `${e.getStatus?.() ?? '?'} ${e.getResponse?.()?.code ?? ''}`.trim()
    : 'aceito';

const cabecalho = (ocupacaoId: string) =>
  db.chamada.findUnique({ where: { ocupacaoId } });
const contaPresencas = (ocupacaoId: string) =>
  db.presenca.count({ where: { ocupacaoId } });

beforeAll(async () => {
  const q = (s: string) => db.$executeRawUnsafe(s);
  // DEF-009 — apaga SÓ a empresa desta suíte. Aqui havia um
  // `DELETE FROM <tabela>` sem `WHERE`, dez tabelas, o banco inteiro;
  // em 2026-08-24 isso rodou contra produção e apagou os dados.
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT','fit',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${UPROF}','prof@fit.local','x','Prof','professor','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF}','${EMPRESA}','Prof','${UPROF}')`,
  );
  // SPEC-020/TASK-004 — quadra sem esporte deixou de existir. A opcao vem
  // antes, e precisa ser da MESMA empresa (a FK e composta).
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Q1',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' AND nome='Tenis'),100)`,
  );
  for (const [id, nome] of [
    [TURMA, 'Turma FIT'],
    [OUTRA_TURMA, 'Outra Turma'],
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade) VALUES ('${id}','${EMPRESA}','${nome}','${QUADRA}','${PROF}',20)`,
    );
    await q(
      `INSERT INTO turma_encontros (id,turma_id,dia_semana,hora_inicio,hora_fim,created_at) VALUES (gen_random_uuid(),'${id}',1,TIME '08:00',TIME '09:00',now())`,
    );
  }
  // 10 alunos, nomes em ordem alfabética estável (Aluno 00..09).
  for (let n = 0; n < 10; n++) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId(n)}','a${n}@fit.local','x','Aluno ${String(n).padStart(2, '0')}','aluno','${EMPRESA}',now())`,
    );
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${alunoId(n)}','${usuarioId(n)}','${EMPRESA}','aprovado')`,
    );
  }
  await db.$executeRawUnsafe(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id) VALUES (gen_random_uuid(),'${OUTRA_TURMA}','${alunoId(9)}')`,
  );
});

afterAll(async () => {
  await db.$disconnect();
});

describe('FIT-005 — a chamada, contra banco real', () => {
  // INV-026/DEF-002: era exatamente isto que o produto aceitava antes, e
  // meia chamada virava meia frequência sem ninguém saber.
  it('PUT com 2 de 10 → 422, zero linhas, e NENHUM cabeçalho criado', async () => {
    await matricular([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const aula = await novaAula();
    const g = await service.chamada(EMPRESA, UPROF, aula);

    const e = await erroDe(() =>
      service.salvarChamada(
        EMPRESA,
        UPROF,
        aula,
        g.versao,
        corpoDe(g).slice(0, 2),
      ),
    );

    expect(cod(e)).toBe('422 CHAMADA_INCOMPLETA');
    expect(await contaPresencas(aula)).toBe(0);
    // O cabeçalho é o que torna a completude verificável — criá-lo numa
    // recusa deixaria uma chamada "existente e vazia" no banco.
    expect(await cabecalho(aula)).toBeNull();
  });

  it('PUT com os 10 → presenças e cabeçalho na MESMA transação; reenviar não duplica', async () => {
    await matricular([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const aula = await novaAula();
    const g = await service.chamada(EMPRESA, UPROF, aula);

    await service.salvarChamada(EMPRESA, UPROF, aula, g.versao, corpoDe(g));

    expect(await contaPresencas(aula)).toBe(10);
    expect(await cabecalho(aula)).toMatchObject({
      completude: 'completa',
      esperados: 10,
    });

    // Reenvio acontece: quadra tem sinal ruim. `PUT` descreve o estado
    // final, então repetir é inofensivo — e o par único do banco garante.
    const g2 = await service.chamada(EMPRESA, UPROF, aula);
    await service.salvarChamada(EMPRESA, UPROF, aula, g2.versao, corpoDe(g2));
    expect(await contaPresencas(aula)).toBe(10);
  });

  it('GET de chamada legada (cabeçalho desconhecida) → união, faltantes com status null', async () => {
    await matricular([0, 1, 2]);
    const aula = await novaAula();
    const g0 = await service.chamada(EMPRESA, UPROF, aula);
    await service.salvarChamada(EMPRESA, UPROF, aula, g0.versao, corpoDe(g0));
    // Rebaixa para o estado que o backfill registra no legado.
    await db.$executeRawUnsafe(
      `UPDATE chamadas SET completude='desconhecida', esperados=NULL WHERE ocupacao_id='${aula}'`,
    );
    await db.$executeRawUnsafe(
      `DELETE FROM presencas WHERE ocupacao_id='${aula}' AND aluno_id='${alunoId(2)}'`,
    );

    const g = await service.chamada(EMPRESA, UPROF, aula);

    expect(g.completude).toBe('desconhecida');
    expect(g.alunos).toHaveLength(3);
    expect(g.alunos.find((a) => a.alunoId === alunoId(2))?.status).toBeNull();
  });

  it('completar uma desconhecida → grava e PROMOVE a completa, com esperados', async () => {
    await matricular([0, 1, 2]);
    const aula = await novaAula();
    const g0 = await service.chamada(EMPRESA, UPROF, aula);
    await service.salvarChamada(EMPRESA, UPROF, aula, g0.versao, corpoDe(g0));
    await db.$executeRawUnsafe(
      `UPDATE chamadas SET completude='desconhecida', esperados=NULL WHERE ocupacao_id='${aula}'`,
    );

    const g = await service.chamada(EMPRESA, UPROF, aula);
    await service.salvarChamada(EMPRESA, UPROF, aula, g.versao, corpoDe(g));

    expect(await cabecalho(aula)).toMatchObject({
      completude: 'completa',
      esperados: 3,
    });
  });

  // O contra-exemplo da 2ª validação cruzada, e a linha seguinte é a que
  // faltava: a prova antiga parava no `GET` e por isso a DEF-006 passou.
  it('completa na segunda, aluno entra na terça, GET na quarta → ele NÃO aparece', async () => {
    await matricular([0, 1]); // Ana e Bruno
    const aula = await novaAula(TURMA, 2);
    const g0 = await service.chamada(EMPRESA, UPROF, aula);
    await service.salvarChamada(EMPRESA, UPROF, aula, g0.versao, corpoDe(g0));

    await matricular([0, 1, 2]); // Carol entra depois

    const g = await service.chamada(EMPRESA, UPROF, aula);

    expect(g.completude).toBe('completa');
    expect(g.alunos.map((a) => a.alunoId)).not.toContain(alunoId(2));
    expect(g.alunos).toHaveLength(2);
  });

  it('…e o PUT do que esse GET devolveu é ACEITO — era a DEF-006', async () => {
    await matricular([0, 1]);
    const aula = await novaAula(TURMA, 2);
    const g0 = await service.chamada(EMPRESA, UPROF, aula);
    await service.salvarChamada(EMPRESA, UPROF, aula, g0.versao, corpoDe(g0));
    await matricular([0, 1, 2]);

    const g = await service.chamada(EMPRESA, UPROF, aula);
    const e = await erroDe(() =>
      service.salvarChamada(EMPRESA, UPROF, aula, g.versao, corpoDe(g)),
    );

    // A v6 recusava com 422 acusando Carol, que a tela nem mostrou.
    expect(cod(e)).toBe('aceito');
  });

  // AC-000h nos três estados de cabeçalho.
  it('GET → PUT do corpo devolvido é aceito: sem cabeçalho, desconhecida e completa', async () => {
    await matricular([0, 1, 2]);
    const aula = await novaAula();

    // (a) sem cabeçalho
    const g1 = await service.chamada(EMPRESA, UPROF, aula);
    expect(
      cod(
        await erroDe(() =>
          service.salvarChamada(EMPRESA, UPROF, aula, g1.versao, corpoDe(g1)),
        ),
      ),
    ).toBe('aceito');

    // (b) desconhecida
    await db.$executeRawUnsafe(
      `UPDATE chamadas SET completude='desconhecida', esperados=NULL WHERE ocupacao_id='${aula}'`,
    );
    const g2 = await service.chamada(EMPRESA, UPROF, aula);
    expect(
      cod(
        await erroDe(() =>
          service.salvarChamada(EMPRESA, UPROF, aula, g2.versao, corpoDe(g2)),
        ),
      ),
    ).toBe('aceito');
    expect(await cabecalho(aula)).toMatchObject({ completude: 'completa' });

    // (c) completa
    const g3 = await service.chamada(EMPRESA, UPROF, aula);
    expect(
      cod(
        await erroDe(() =>
          service.salvarChamada(EMPRESA, UPROF, aula, g3.versao, corpoDe(g3)),
        ),
      ),
    ).toBe('aceito');
  });

  it('completa + PUT acrescentando aluno matriculado hoje → aceito, esperados vira itens.length', async () => {
    await matricular([0, 1]);
    const aula = await novaAula();
    const g0 = await service.chamada(EMPRESA, UPROF, aula);
    await service.salvarChamada(EMPRESA, UPROF, aula, g0.versao, corpoDe(g0));
    await matricular([0, 1, 2]);

    const g = await service.chamada(EMPRESA, UPROF, aula);
    const e = await erroDe(() =>
      service.salvarChamada(EMPRESA, UPROF, aula, g.versao, [
        ...corpoDe(g),
        { alunoId: alunoId(2), status: 'presente' },
      ]),
    );

    // O teto não estreitou com a correção: quem está na turma hoje cabe.
    expect(cod(e)).toBe('aceito');
    expect(await cabecalho(aula)).toMatchObject({ esperados: 3 });
  });

  it('completa + PUT com aluno de OUTRA turma → 422 ALUNO_FORA_DA_TURMA', async () => {
    await matricular([0, 1]);
    const aula = await novaAula();
    const g0 = await service.chamada(EMPRESA, UPROF, aula);
    await service.salvarChamada(EMPRESA, UPROF, aula, g0.versao, corpoDe(g0));

    const g = await service.chamada(EMPRESA, UPROF, aula);
    const e = await erroDe(() =>
      service.salvarChamada(EMPRESA, UPROF, aula, g.versao, [
        ...corpoDe(g),
        { alunoId: alunoId(9), status: 'presente' },
      ]),
    );

    expect(cod(e)).toBe('422 ALUNO_FORA_DA_TURMA');
  });

  it('completa de 3, PUT com 2 deles → 422: o piso continua sendo piso', async () => {
    await matricular([0, 1, 2]);
    const aula = await novaAula();
    const g0 = await service.chamada(EMPRESA, UPROF, aula);
    await service.salvarChamada(EMPRESA, UPROF, aula, g0.versao, corpoDe(g0));

    const g = await service.chamada(EMPRESA, UPROF, aula);
    const e = await erroDe(() =>
      service.salvarChamada(
        EMPRESA,
        UPROF,
        aula,
        g.versao,
        corpoDe(g).slice(0, 2),
      ),
    );

    expect(cod(e)).toBe('422 CHAMADA_INCOMPLETA');
  });

  // AC-000b — antes da correção o aluno removido caía em
  // ALUNO_FORA_DA_TURMA e a chamada dele ficava sem conserto.
  it('aluno saiu da turma, chamada completa corrigida → aceito', async () => {
    await matricular([0, 1, 2]);
    const aula = await novaAula();
    const g0 = await service.chamada(EMPRESA, UPROF, aula);
    await service.salvarChamada(EMPRESA, UPROF, aula, g0.versao, corpoDe(g0));

    await matricular([0, 1]); // o aluno 2 sai depois da aula

    const g = await service.chamada(EMPRESA, UPROF, aula);
    expect(g.alunos).toHaveLength(3); // o snapshot preserva quem esteve lá
    const e = await erroDe(() =>
      service.salvarChamada(EMPRESA, UPROF, aula, g.versao, [
        ...corpoDe(g).filter((i) => i.alunoId !== alunoId(2)),
        { alunoId: alunoId(2), status: 'justificado' },
      ]),
    );

    expect(cod(e)).toBe('aceito');
  });

  it('versão velha → 409 CHAMADA_DESATUALIZADA', async () => {
    await matricular([0, 1]);
    const aula = await novaAula();
    const g0 = await service.chamada(EMPRESA, UPROF, aula);
    await service.salvarChamada(EMPRESA, UPROF, aula, g0.versao, corpoDe(g0));

    const e = await erroDe(() =>
      service.salvarChamada(EMPRESA, UPROF, aula, g0.versao, corpoDe(g0)),
    );

    expect(cod(e)).toBe('409 CHAMADA_DESATUALIZADA');
  });

  // INV-027 imposta pelo BANCO, não por código. É a metade que mock
  // nenhum consegue provar.
  it('presença sem cabeçalho é recusada pela FK, não pelo serviço', async () => {
    const aula = await novaAula();

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at)
         VALUES (gen_random_uuid(),'${EMPRESA}','${aula}','TURMA','${alunoId(0)}','presente','${UPROF}',now())`,
      ),
    ).rejects.toThrow();
  });
});
