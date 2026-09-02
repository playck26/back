/**
 * SPEC-015/AC-000i e INV-029 — a rede de regressão da raiz de lock.
 *
 * **Esta suíte precisa de Postgres de verdade e roda com DUAS conexões.**
 * Não entra em `pnpm test` nem em `pnpm test:e2e`, que rodam com Prisma
 * mockado: mock não tem lock, não tem snapshot e não tem concorrência —
 * ele não conseguiria reprovar nenhum dos defeitos que esta suíte existe
 * para pegar. Roda por `pnpm test:concorrencia`, contra o Postgres que o
 * CI sobe como serviço.
 *
 * A pergunta, uma só, feita contra TODA tabela que decide escrita:
 *
 *   "Uma transação concorrente pega a raiz (`turmas`), altera algo que
 *    afeta a decisão de escrita, e segura. O `PUT` entra enquanto ela
 *    segura. Ela commita. O `PUT` observa o estado PÓS-COMMIT?"
 *
 * Três correções seguidas falharam aqui, cada uma num caso diferente, e
 * cada uma passava no teste da anterior: a v9 lia antes de travar, a v10
 * travava e lia no mesmo statement. O gatilho fica na **fronteira do
 * lock**, não num método — é isso que faz a suíte sobreviver à reescrita
 * do serviço, que foi o que derrubou os testes anteriores.
 *
 * O que ela NÃO cobre: se todo escritor de fato pega a raiz. Aqui a
 * concorrente pega por construção. Esse outro lado é a INV-029, e quem
 * prova é o harness do `workspace` (`bloq7-concorrencia.ts`).
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
// SPEC-027: ONTEM, não hoje — a chamada exige que a aula tenha começado, e
// estas fixtures usam horários a partir de 00:00. Ver `hoje-no-clube-sql.ts`.
import { diasAtrasNoClube } from './hoje-no-clube-sql';
import { PresencaService } from '../../src/classes/presenca.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { limparEmpresa } from './limpar-empresa';
import { cancelarOcupacaoNaFixture } from './cancelar-ocupacao';

jest.setTimeout(120_000);

// Antes de qualquer conexão: esta suíte escreve, e o `.env` real
// aponta para o Neon de produção (achado da validação cruzada).
exigirBancoLocal();

const A = new PrismaClient(); // o PUT
const B = new PrismaClient(); // quem segura a raiz

const ids = {
  empresa: '11111111-1111-4111-8111-111111111111',
  quadra: '22222222-2222-4222-8222-222222222222',
  turma: '33333333-3333-4333-8333-333333333333',
  uprof1: '44444444-4444-4444-8444-444444444444',
  prof1: '55555555-5555-4555-8555-555555555555',
  prof2: 'bb555555-5555-4555-8555-555555555555',
  uprof2: 'bb444444-4444-4444-8444-444444444444',
  a1: '77777777-7777-4777-8777-777777777777',
  u1: 'aa777777-7777-4777-8777-777777777777',
  a2: '88888888-8888-4888-8888-888888888888',
  u2: 'aa888888-8888-4888-8888-888888888888',
};

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fatias de 10 minutos a partir da meia-noite: a EXCLUDE de
// `ocupacoes_quadra` recusa sobreposição na mesma quadra e data, e todas as
// aulas precisam ser de HOJE por causa dos limites de janela (INV-017).
let fatia = -1;
async function novaAula(): Promise<string> {
  fatia += 1;
  const [r] = await A.$queryRawUnsafe<{ id: string }[]>(`
    INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
    VALUES (gen_random_uuid(),'${ids.empresa}','${ids.quadra}',${diasAtrasNoClube(1)},
            TIME '00:00' + (${fatia} * INTERVAL '10 minutes'),
            TIME '00:00' + (${fatia} * INTERVAL '10 minutes') + INTERVAL '9 minutes',
            'TURMA','${ids.turma}','pendente_pagamento',now())
    RETURNING id`);
  return r.id;
}

async function seed(): Promise<void> {
  const q = (s: string) => A.$executeRawUnsafe(s);
  // DEF-009 — apaga SÓ a empresa desta suíte. Aqui havia um
  // `DELETE FROM <tabela>` sem `WHERE`, dez tabelas, o banco inteiro;
  // em 2026-08-24 isso rodou contra produção e apagou os dados.
  await limparEmpresa(A, ids.empresa);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${ids.empresa}','Harness','harness',now())`,
  );
  for (const [n, u, p] of [
    ['1', ids.uprof1, ids.prof1],
    ['2', ids.uprof2, ids.prof2],
  ] as const) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${u}','prof${n}@teste.local','x','P${n}','professor','${ids.empresa}',now())`,
    );
    await q(
      `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${p}','${ids.empresa}','P${n}','${u}')`,
    );
  }
  // SPEC-020/TASK-004 — quadra sem esporte deixou de existir. A opcao vem
  // antes, e precisa ser da MESMA empresa (a FK e composta).
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${ids.empresa}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${ids.quadra}','${ids.empresa}','Q1',(SELECT id FROM esportes_de_quadra WHERE company_id='${ids.empresa}' AND nome='Tenis'),100)`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade) VALUES ('${ids.turma}','${ids.empresa}','T1','${ids.quadra}','${ids.prof1}',10)`,
  );
  await q(
    `INSERT INTO turma_encontros (id,turma_id,dia_semana,hora_inicio,hora_fim,created_at) VALUES (gen_random_uuid(),'${ids.turma}',1,TIME '08:00',TIME '09:00',now())`,
  );
  for (const [n, a, u] of [
    ['1', ids.a1, ids.u1],
    ['2', ids.a2, ids.u2],
  ] as const) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${u}','al${n}@teste.local','x','A${n}','aluno','${ids.empresa}',now())`,
    );
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${a}','${u}','${ids.empresa}','aprovado')`,
    );
  }
}

type Mutacao = (
  tb: { $executeRawUnsafe: (s: string) => Promise<number> },
  aula: string,
) => Promise<unknown>;

/**
 * Arma o cenário, deixa a concorrente segurando a raiz, entra com o `PUT`,
 * solta a concorrente no meio e devolve o que o `PUT` respondeu.
 */
async function respostaSobConcorrencia(
  matriculaInicial: string[],
  mutacao: Mutacao,
): Promise<string> {
  await A.$executeRawUnsafe(
    `UPDATE turmas SET professor_id='${ids.prof1}' WHERE id='${ids.turma}'`,
  );
  await A.$executeRawUnsafe(`DELETE FROM presencas`);
  await A.$executeRawUnsafe(`DELETE FROM chamadas`);
  await A.$executeRawUnsafe(`DELETE FROM turma_alunos`);
  for (const a of matriculaInicial) {
    await A.$executeRawUnsafe(
      `INSERT INTO turma_alunos (id,turma_id,aluno_id) VALUES (gen_random_uuid(),'${ids.turma}','${a}')`,
    );
  }
  const aula = await novaAula();

  const service = new PresencaService(A as unknown as PrismaService);
  const g = await service.chamada(ids.empresa, ids.uprof1, aula);
  const corpo = g.alunos.map((al) => ({
    alunoId: al.alunoId,
    status: 'presente' as const,
  }));

  let abrir: () => void = () => undefined;
  const portao = new Promise<void>((r) => {
    abrir = r;
  });
  let pronto: () => void = () => undefined;
  const segurou = new Promise<void>((r) => {
    pronto = r;
  });

  const concorrente = B.$transaction(
    async (tb) => {
      // A ordem do `ClassesService.update`: a raiz primeiro.
      await tb.$executeRawUnsafe(
        `UPDATE turmas SET nome = nome WHERE id = '${ids.turma}'`,
      );
      await mutacao(tb, aula);
      pronto();
      await portao;
    },
    { timeout: 60_000 },
  ).catch(() => undefined);

  await segurou;
  void espera(600).then(() => abrir());

  let resposta = '200';
  try {
    await service.salvarChamada(ids.empresa, ids.uprof1, aula, g.versao, corpo);
  } catch (e) {
    const err = e as {
      getStatus?: () => number;
      getResponse?: () => { code?: string };
    };
    resposta =
      `${err.getStatus?.() ?? '?'} ${err.getResponse?.()?.code ?? ''}`.trim();
  }
  await concorrente;
  return resposta;
}

describe('AC-000i/INV-029 — o PUT observa tudo que decide escrita depois da raiz travada', () => {
  beforeAll(async () => {
    await seed();
  });

  afterAll(async () => {
    await A.$disconnect();
    await B.$disconnect();
  });

  it('aluno ENTRA na turma → 409', async () => {
    const r = await respostaSobConcorrencia([ids.a1], (tb) =>
      tb.$executeRawUnsafe(
        `INSERT INTO turma_alunos (id,turma_id,aluno_id) VALUES (gen_random_uuid(),'${ids.turma}','${ids.a2}')`,
      ),
    );
    expect(r).toBe('409 CHAMADA_DESATUALIZADA');
  });

  it('aluno SAI da turma → 409', async () => {
    const r = await respostaSobConcorrencia([ids.a1, ids.a2], (tb) =>
      tb.$executeRawUnsafe(
        `DELETE FROM turma_alunos WHERE turma_id='${ids.turma}' AND aluno_id='${ids.a2}'`,
      ),
    );
    expect(r).toBe('409 CHAMADA_DESATUALIZADA');
  });

  // A v9 falhava aqui: autorizava fora da transação e não revalidava.
  it('turma troca de PROFESSOR → 404', async () => {
    const r = await respostaSobConcorrencia([ids.a1], (tb) =>
      tb.$executeRawUnsafe(
        `UPDATE turmas SET professor_id='${ids.prof2}' WHERE id='${ids.turma}'`,
      ),
    );
    expect(r).toBe('404');
  });

  // A v10 falhava aqui: travava e lia no mesmo statement, então
  // `status_pagamento` ficava no snapshot de antes da espera pelo lock.
  it('aula é CANCELADA → 422 AULA_CANCELADA', async () => {
    // SPEC-032/INV-064 — o cancelamento passa a exigir evento da mesma
    // transicao. O helper faz o par; a corrida que este teste mede nao muda.
    const r = await respostaSobConcorrencia([ids.a1], (tb, aula) =>
      cancelarOcupacaoNaFixture(tb, {
        companyId: ids.empresa,
        ocupacaoId: aula,
        // O professor e o autor disponivel nesta fixture; o que a INV-062
        // exige e que exista um, nao qual papel ele tem.
        autorId: ids.uprof1,
      }),
    );
    expect(r).toBe('422 AULA_CANCELADA');
  });

  // Mesma causa do anterior, campo diferente — provar um não achava o outro.
  it('aula SAI DA JANELA de 7 dias → 422 AULA_ANTIGA', async () => {
    const r = await respostaSobConcorrencia([ids.a1], (tb, aula) =>
      tb.$executeRawUnsafe(
        `UPDATE ocupacoes_quadra SET data = ${diasAtrasNoClube(30)} WHERE id='${aula}'`,
      ),
    );
    expect(r).toBe('422 AULA_ANTIGA');
  });

  it('outro PUT grava a chamada antes → 409', async () => {
    const r = await respostaSobConcorrencia([ids.a1], async (tb, aula) => {
      await tb.$executeRawUnsafe(
        `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados) VALUES ('${aula}','TURMA','${ids.empresa}','${ids.uprof1}',now(),'completa',1)`,
      );
      await tb.$executeRawUnsafe(
        `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at) VALUES (gen_random_uuid(),'${ids.empresa}','${aula}','TURMA','${ids.a1}','ausente','${ids.uprof1}',now())`,
      );
    });
    expect(r).toBe('409 CHAMADA_DESATUALIZADA');
  });
});
