/**
 * SPEC-023/REQ-003 — **FIT-010: duas pessoas na última vaga.**
 *
 * Esta é a prova que ficou aberta quando a SPEC-023 foi commitada, e a spec
 * dizia isso em vez de esconder: as 17 provas do serviço usam dublê, e
 * **dublê não prova `FOR UPDATE`**. Um `$queryRaw` mockado devolve o que se
 * mandar devolver; ele não serializa nada.
 *
 * Foi exatamente esse vão que deixou o DEF-013 subir para produção — dois
 * testes existiam, passavam, e o laço que atravessa a rede morava entre os
 * dois dublês.
 *
 * **Precisa de duas conexões, não de duas chamadas.** Com um cliente só, as
 * duas transações poderiam sair da mesma conexão e serializar por acidente,
 * provando nada. É a lição do `bloq7-concorrencia.ts`: concorrência não se
 * prova em transação revertida, nem em conexão compartilhada.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { limparEmpresa } from './limpar-empresa';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA = 'f0100000-0000-4000-8000-000000000001';
const QUADRA = 'f0100000-0000-4000-8000-000000000002';
const TURMA = 'f0100000-0000-4000-8000-000000000003';
const U1 = 'f0100000-0000-4000-8000-000000000011';
const U2 = 'f0100000-0000-4000-8000-000000000012';
const A1 = 'f0100000-0000-4000-8000-000000000021';
const A2 = 'f0100000-0000-4000-8000-000000000022';

// Duas conexões independentes — é o ponto inteiro deste arquivo.
const dbA = new PrismaClient();
const dbB = new PrismaClient();
const semear = new PrismaClient();

const servicoA = new MatriculaDoAlunoService(
  dbA as unknown as PrismaService,
  new ConfigOperacaoService(dbA as unknown as PrismaService),
);
const servicoB = new MatriculaDoAlunoService(
  dbB as unknown as PrismaService,
  new ConfigOperacaoService(dbB as unknown as PrismaService),
);

/**
 * Fixture em SQL cru, como os outros `db-spec` deste diretório. Não é
 * preguiça: `quadras` tem FK composta para `esportes_de_quadra` (SPEC-020) e
 * a forma de entrada do Prisma para isso é mais ruído que o INSERT.
 */
async function montarCenario(capacidade: number) {
  await limparEmpresa(semear, EMPRESA);
  const q = (sql: string) => semear.$executeRawUnsafe(sql);

  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-010 ${EMPRESA}','fit-010-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Q FIT-010',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' AND nome='Tenis'),100)`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','Turma da ultima vaga','${QUADRA}',${capacidade},'ativa')`,
  );

  for (const [usuarioId, alunoId, n] of [
    [U1, A1, 1],
    [U2, A2, 2],
  ] as const) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','fit010-${n}@teste.local','x','Aluno FIT-010 ${n}','aluno','${EMPRESA}',now())`,
    );
    // `aprovado` de propósito: o que está em julgamento aqui é a capacidade,
    // não o vínculo. Com `pendente` as duas falhariam por outro motivo e o
    // teste passaria dizendo nada.
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado')`,
    );
  }
}

function codigoDe(erro: unknown): string {
  const r = (erro as { getResponse?: () => unknown }).getResponse?.();
  return (r as { code?: string })?.code ?? String(erro);
}

afterAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  await Promise.all([
    dbA.$disconnect(),
    dbB.$disconnect(),
    semear.$disconnect(),
  ]);
});

describe('FIT-010 — a última vaga sob concorrência real', () => {
  it('duas entradas simultâneas: uma entra, a outra recebe TURMA_CHEIA', async () => {
    await montarCenario(1);

    // Disparadas juntas, em conexões diferentes. `allSettled` porque uma
    // DEVE falhar — `all` mataria o teste antes de olhar o resultado.
    const [r1, r2] = await Promise.allSettled([
      servicoA.entrar(EMPRESA, U1, TURMA),
      servicoB.entrar(EMPRESA, U2, TURMA),
    ]);

    const ok = [r1, r2].filter((r) => r.status === 'fulfilled');
    const falhas = [r1, r2].filter((r) => r.status === 'rejected');

    expect(ok).toHaveLength(1);
    expect(falhas).toHaveLength(1);
    expect(codigoDe(falhas[0].reason)).toBe('TURMA_CHEIA');

    // E o banco concorda com a resposta. Sem esta asserção o teste passaria
    // mesmo se as duas tivessem entrado e uma tivesse dado erro depois.
    const matriculados = await semear.turmaAluno.count({
      where: { turmaId: TURMA },
    });
    expect(matriculados).toBe(1);
  });

  it('com duas vagas, as duas entram — a trava serializa, não bloqueia', async () => {
    // O outro lado da prova: uma trava que recusasse sempre também passaria
    // no teste acima. Este é o que a impede de ser um `throw` disfarçado.
    await montarCenario(2);

    const resultados = await Promise.allSettled([
      servicoA.entrar(EMPRESA, U1, TURMA),
      servicoB.entrar(EMPRESA, U2, TURMA),
    ]);

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await semear.turmaAluno.count({ where: { turmaId: TURMA } })).toBe(
      2,
    );
  });

  it('o mesmo aluno duas vezes ao mesmo tempo não vira duas linhas', async () => {
    // Idempotência sob concorrência: toque duplo em conexão ruim dispara
    // duas requisições de verdade, não duas chamadas em sequência.
    await montarCenario(5);

    await Promise.allSettled([
      servicoA.entrar(EMPRESA, U1, TURMA),
      servicoB.entrar(EMPRESA, U1, TURMA),
    ]);

    expect(
      await semear.turmaAluno.count({ where: { turmaId: TURMA, alunoId: A1 } }),
    ).toBe(1);
  });
});

describe('SPEC-023 — o que só o banco garante', () => {
  it('o CHECK recusa limite 0 — zero é desligar, não limitar', async () => {
    await montarCenario(1);

    await expect(
      semear.empresa.update({
        where: { id: EMPRESA },
        data: { limiteTurmasPorAluno: 0 },
      }),
    ).rejects.toThrow();
  });

  it('o limite do clube barra a segunda turma', async () => {
    await montarCenario(5);
    await semear.empresa.update({
      where: { id: EMPRESA },
      data: { limiteTurmasPorAluno: 1 },
    });

    const OUTRA = 'f0100000-0000-4000-8000-000000000004';
    await semear.$executeRawUnsafe(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${OUTRA}','${EMPRESA}','Segunda turma','${QUADRA}',5,'ativa')`,
    );

    await servicoA.entrar(EMPRESA, U1, TURMA);
    await expect(
      servicoA.entrar(EMPRESA, U1, OUTRA).catch((e: unknown) => {
        throw new Error(codigoDe(e));
      }),
    ).rejects.toThrow('LIMITE_DE_TURMAS');
  });
});
