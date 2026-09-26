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
import { diasAtrasNoClube } from './hoje-no-clube-sql';
import { PresencaService } from '../../src/classes/presenca.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { limparEmpresa } from './limpar-empresa';
import { comValvula } from './valvula-de-presenca';

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
/**
 * SPEC-027 — **o padrão é ONTEM, não hoje.**
 *
 * A chamada passou a exigir que a aula tenha começado, e estas fixtures montam
 * horários a partir de `TIME '00:00'`. Com "hoje", a suíte falharia toda vez
 * que rodasse na primeira hora da madrugada — e foi o que derrubou o CI em
 * 2026-08-30, às 00:03 de Brasília.
 *
 * Ontem já passou inteiro a qualquer hora, e continua dentro da janela
 * retroativa de 7 dias. Ver `hoje-no-clube-sql.ts`.
 */
async function novaAula(turmaId = TURMA, diasAtras = 1): Promise<string> {
  fatia += 1;
  const [r] = await db.$queryRawUnsafe<{ id: string }[]>(`
    INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
    VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}',${diasAtrasNoClube(diasAtras)},
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

/**
 * SPEC-076/D7 — uma chamada HUMANA LEGADA, gravada pela válvula de teste: o
 * `PUT` que as criava saiu (D1), e a D10 recusa autor humano fora da válvula.
 * É o legado que a produção tem, e é ele que as provas de leitura precisam.
 */
async function chamadaHumana(
  aula: string,
  completude: 'completa' | 'desconhecida',
  alunos: number[],
): Promise<void> {
  const esperados = completude === 'completa' ? String(alunos.length) : 'NULL';
  await comValvula(db, [
    `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados)
     VALUES ('${aula}','TURMA','${EMPRESA}','${UPROF}',now(),'${completude}',${esperados})`,
    ...alunos.map(
      (n) =>
        `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at)
         VALUES (gen_random_uuid(),'${EMPRESA}','${aula}','TURMA','${alunoId(n)}','presente','${UPROF}',now())`,
    ),
  ]);
}

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

/**
 * SPEC-076/D7 — dez casos desta tabela provavam o `PUT` da chamada, que saiu
 * (D1): o 422 de 2 de 10, a transação dos 10, promover `desconhecida`, o PUT
 * do GET (DEF-006), o GET→PUT nos três estados, acrescentar matriculado, aluno
 * de outra turma, o piso da completa, quem saiu da turma e a versão velha. O
 * que os substitui é a AC-001 (a rota dá 404, nada muda) e a AC-002 (o banco
 * recusa autor humano). Ficam as provas de LEITURA e a da FK.
 */
describe('FIT-005 — a chamada, contra banco real', () => {
  it('GET de chamada legada (cabeçalho desconhecida) → união, faltantes com status null', async () => {
    await matricular([0, 1, 2]);
    const aula = await novaAula();
    await chamadaHumana(aula, 'desconhecida', [0, 1]);

    const g = await service.chamada(EMPRESA, UPROF, aula);

    expect(g.completude).toBe('desconhecida');
    expect(g.alunos).toHaveLength(3);
    expect(g.alunos.find((a) => a.alunoId === alunoId(2))?.status).toBeNull();
  });

  it('completa na segunda, aluno entra na terça, GET na quarta → ele NÃO aparece', async () => {
    await matricular([0, 1]); // Ana e Bruno
    const aula = await novaAula(TURMA, 2);
    await chamadaHumana(aula, 'completa', [0, 1]);

    await matricular([0, 1, 2]); // Carol entra depois

    const g = await service.chamada(EMPRESA, UPROF, aula);

    expect(g.completude).toBe('completa');
    expect(g.alunos.map((a) => a.alunoId)).not.toContain(alunoId(2));
    expect(g.alunos).toHaveLength(2);
  });

  // INV-027 imposta pelo BANCO, não por código. É a metade que mock
  // nenhum consegue provar.
  //
  // SPEC-076 — a presença vai SEM autor: com autor, o gatilho da D10 a
  // recusaria antes da FK, e este caso passaria pelo motivo errado.
  it('presença sem cabeçalho é recusada pela FK, não pelo serviço', async () => {
    const aula = await novaAula();

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at)
         VALUES (gen_random_uuid(),'${EMPRESA}','${aula}','TURMA','${alunoId(0)}','presente',NULL,now())`,
      ),
    ).rejects.toThrow(/presencas_chamada_fkey|foreign key|23503/);
  });
});
