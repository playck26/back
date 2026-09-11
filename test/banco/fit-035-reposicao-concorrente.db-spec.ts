/**
 * SPEC-046/TASK-006 — **FIT-035: duas reposições na última vaga, ao mesmo
 * tempo.**
 *
 * ## Por que sequencial não prova nada — e eu medi isso
 *
 * A sabotagem registrada na spec inclui *"sem `turmas FOR UPDATE`"*, e rodá-la
 * contra `spec-046-reposicao.db-spec.ts` deixou **os 17 casos verdes**. Está
 * certo: em sequência, quem chega depois é recusado pela contagem — ela lê a
 * vaga já ocupada. **A contagem é boa e não é a garantia.** Entre ler
 * "capacidade 2, ocupados 1" e escrever existe uma janela, e nela as duas
 * transações veem a mesma vaga livre.
 *
 * Quem fecha a janela é o **lock da turma** (D8), e este arquivo é o único
 * lugar onde ele é exercitado. Sem ele, a decisão mais cara da spec — tomar um
 * nível a mais de lock que a SPEC-031 deliberadamente não toma — seria
 * afirmação.
 *
 * ## Por que a INV-118 não resolve este caso
 *
 * Ela impede a mesma FALTA de virar duas reposições. Aqui são **duas pessoas
 * diferentes, com faltas diferentes**, disputando a mesma vaga: nenhuma
 * constraint alcança isso, porque capacidade é contagem com subtração e não
 * cabe num `CHECK` nem numa `EXCLUDE`. A spec declara isso — *"a capacidade
 * NÃO é invariante de banco"* —, e é justamente por ser declarado que o teste
 * precisa existir.
 *
 * ## O que se afirma, e o que não
 *
 * Afirma-se o **efeito**: a turma não passa da capacidade. **Não** se afirma
 * qual das duas vence — isso depende de quem chega primeiro ao lock, e exigir
 * um vencedor fixo seria medir o escalonador do Postgres.
 */
import { PrismaClient } from '@prisma/client';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { StudentsService } from '../../src/people/students.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import { limparEmpresa } from './limpar-empresa';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = 'f0350000-0000-4000-8000-000000000001';
const QUADRA = 'f0350000-0000-4000-8000-000000000002';
const TURMA_ORIGEM = 'f0350000-0000-4000-8000-00000000000a';
const TURMA_ALVO = 'f0350000-0000-4000-8000-00000000000b';

/**
 * **Três conexões, e é o ponto do arquivo.** Uma para semear e duas para
 * correr: com um cliente só, o Prisma serializa as transações e a corrida vira
 * sequência — que é exatamente o arranjo que não prova nada.
 */
const semear = new PrismaClient();
const dbA = new PrismaClient();
const dbB = new PrismaClient();

const q = (sql: string) => semear.$executeRawUnsafe(sql);
const servico = (cliente: PrismaClient) =>
  new ReposicaoService(
    cliente as unknown as PrismaService,
    new ConfigOperacaoService(cliente as unknown as PrismaService),
  );

/** O outro lado da corrida que a D8 existe para proteger. */
const turmas = (cliente: PrismaClient) => {
  const p = cliente as unknown as PrismaService;
  return new ClassesService(
    p,
    new CourtsService(
      p,
      new StudentsService(p),
      new HorarioFuncionamentoService(p),
      {
        resolver: () => ({ imagemUrl: null }),
      } as unknown as ImagemDaQuadraService,
      new ConfigOperacaoService(p),
      new CreditosService(),
      {
        carregarSemana: jest.fn(),
      } as unknown as DisponibilidadeProfessorService,
    ),
    new StudentsService(p),
    new ConfigOperacaoService(p),
  );
};

function emDias(dias: number): string {
  // **A base é `hojeNoFusoDoClube()`, e não `new Date()`.**
  //
  // A primeira versão usava o relógio UTC, e o CI a derrubou às 22h locais:
  // 01h UTC do dia seguinte faz `emDias(-5)` cair num dia a mais do que o
  // serviço calcula, e `diasRestantes` vem `-4` onde o teste espera `-5`.
  // **O defeito era latente**, invisível antes das 21h — que é exatamente a
  // classe de erro que o gate `fuso-do-clube` existe para impedir no `src/`,
  // e que o `test/` precisa respeitar por disciplina.
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Resultado de um dos dois lados, sem derrubar a corrida. */
async function desfecho<T>(
  p: Promise<T>,
): Promise<{ ok: true; valor: T } | { ok: false; erro: unknown }> {
  try {
    return { ok: true, valor: await p };
  } catch (erro) {
    return { ok: false, erro };
  }
}

let seq = 0;
async function alunoComFalta(nome: string) {
  seq += 1;
  const s = String(seq).padStart(2, '0');
  const usuarioId = `f0350000-0000-4000-8000-1000000000${s}`;
  const alunoId = `f0350000-0000-4000-8000-2000000000${s}`;
  const ocupacaoId = `f0350000-0000-4000-8000-3000000000${s}`;
  const faltaId = `f0350000-0000-4000-8000-4000000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','fit035.${seq}@x.com','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA_ORIGEM}','${alunoId}',now())`,
  );
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${ocupacaoId}','${EMPRESA}','${QUADRA}','${emDias(-3)}','0${seq}:00','0${seq + 1}:00','TURMA','${TURMA_ORIGEM}','pendente_pagamento',now())`,
  );
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${faltaId}','${EMPRESA}','${ocupacaoId}','${alunoId}',now())`,
  );
  return { usuarioId, alunoId, faltaId };
}

const ALVO = 'f0350000-0000-4000-8000-3000000000ff';

/**
 * A turma alvo tem **capacidade 1 e ninguém matriculado** — uma vaga exata.
 * Dois querem, e só um pode.
 */
async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-035','fit-035-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status)
     SELECT '${QUADRA}','${EMPRESA}','Quadra',id,80,'ativa' FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA_ORIGEM}','${EMPRESA}','Origem','${QUADRA}',10,'ativa')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA_ALVO}','${EMPRESA}','Alvo','${QUADRA}',1,'ativa')`,
  );
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${ALVO}','${EMPRESA}','${QUADRA}','${emDias(6)}','20:00','21:00','TURMA','${TURMA_ALVO}','pendente_pagamento',now())`,
  );
}

beforeEach(async () => {
  await limparEmpresa(semear, EMPRESA);
  seq = 0;
  await montar();
});
afterAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  await Promise.all([
    semear.$disconnect(),
    dbA.$disconnect(),
    dbB.$disconnect(),
  ]);
});

describe('FIT-035 — duas reposições na última vaga', () => {
  it('o cenário é mesmo de UMA vaga — senão a corrida não disputa nada', async () => {
    const turma = await semear.turma.findUniqueOrThrow({
      where: { id: TURMA_ALVO },
      select: { capacidade: true, _count: { select: { alunos: true } } },
    });
    // Sem esta asserção, uma turma de capacidade 10 deixaria os dois passarem
    // e o teste ficaria verde afirmando o contrário do que mede.
    expect(turma.capacidade).toBe(1);
    expect(turma._count.alunos).toBe(0);
  });

  it('**exatamente UMA reposição sobrevive, e a turma não passa da capacidade**', async () => {
    const a = await alunoComFalta('Corre A');
    const b = await alunoComFalta('Corre B');

    const [ra, rb] = await Promise.all([
      desfecho(servico(dbA).marcar(EMPRESA, a.usuarioId, a.faltaId, ALVO)),
      desfecho(servico(dbB).marcar(EMPRESA, b.usuarioId, b.faltaId, ALVO)),
    ]);

    const vivas = await semear.reposicaoDeAula.count({
      where: { ocupacaoId: ALVO },
    });

    // **O efeito é o que se afirma.** Duas linhas aqui significa turma com o
    // dobro da capacidade — um corpo a mais numa quadra que tem tamanho.
    expect(vivas).toBe(1);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
  });

  it('o perdedor recebe `409 TURMA_SEM_VAGA` — nunca `500`', async () => {
    const a = await alunoComFalta('Corre A');
    const b = await alunoComFalta('Corre B');

    const [ra, rb] = await Promise.all([
      desfecho(servico(dbA).marcar(EMPRESA, a.usuarioId, a.faltaId, ALVO)),
      desfecho(servico(dbB).marcar(EMPRESA, b.usuarioId, b.faltaId, ALVO)),
    ]);

    const perdedor = [ra, rb].find((r) => !r.ok);
    expect(perdedor).toBeDefined();
    // Corrida perdida é resposta de PRODUTO, não erro de servidor: o aluno
    // precisa entender que a aula encheu e escolher outra.
    expect(perdedor).toMatchObject({
      erro: { response: { statusCode: 409, code: 'TURMA_SEM_VAGA' } },
    });
  });

  /**
   * **A corrida que a D8 existe para proteger — e a que eu tinha esquecido.**
   *
   * A sabotagem "sem `turmas FOR UPDATE`" deixou os quatro casos acima VERDES,
   * e a explicação não é que o lock sobra: é que **reposição × reposição já é
   * serializada pelo lock da OCUPAÇÃO** (as duas disputam a mesma linha de
   * `ocupacoes_quadra`). O lock da turma protege outra coisa, e era ela que
   * faltava medir.
   *
   * `allocateStudent` segura `turmas FOR UPDATE` e **não toca** a ocupação.
   * Sem o mesmo lock deste lado, as duas transações contam a turma ao mesmo
   * tempo, as duas veem a vaga livre, e a turma fica com o dobro da
   * capacidade — um corpo a mais numa quadra que tem tamanho.
   *
   * *Registrado assim porque a sabotagem corrigiu o teste, não o código: sem
   * ela eu teria declarado a D8 provada por quatro casos que não a exercitam.*
   */
  it('**reposição × matrícula na turma: a capacidade não estoura**', async () => {
    const a = await alunoComFalta('Vai Repor');
    const novato = await alunoComFalta('Vai Matricular');

    const [ra, rb] = await Promise.all([
      desfecho(servico(dbA).marcar(EMPRESA, a.usuarioId, a.faltaId, ALVO)),
      desfecho(
        turmas(dbB).allocateStudent(EMPRESA, TURMA_ALVO, novato.alunoId),
      ),
    ]);

    const [matriculados, reposicoes] = await Promise.all([
      semear.turmaAluno.count({ where: { turmaId: TURMA_ALVO } }),
      semear.reposicaoDeAula.count({ where: { ocupacaoId: ALVO } }),
    ]);

    // Capacidade 1: a soma dos dois não pode passar disso.
    expect(matriculados + reposicoes).toBeLessThanOrEqual(1);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
  });

  it('e a falta do perdedor continua VALENDO — ele repõe em outro dia', async () => {
    const a = await alunoComFalta('Corre A');
    const b = await alunoComFalta('Corre B');

    const [ra, rb] = await Promise.all([
      desfecho(servico(dbA).marcar(EMPRESA, a.usuarioId, a.faltaId, ALVO)),
      desfecho(servico(dbB).marcar(EMPRESA, b.usuarioId, b.faltaId, ALVO)),
    ]);

    // **A corrida não pode consumir o crédito de quem perdeu.** Como ele é
    // derivado (D1), isso sai de graça — mas "sai de graça" é exatamente o
    // tipo de coisa que se acredita sem medir.
    const perdedorEh = ra.ok ? b : a;
    const credito = await servico(semear).meuCredito(
      EMPRESA,
      perdedorEh.usuarioId,
    );
    expect(credito.creditos).toBe(1);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
  });
});
