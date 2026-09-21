/**
 * **SPEC-066/TASK-005 — a paginação contra o banco de verdade.**
 *
 * ## Por que esta prova não pode ser um mock
 *
 * O que está em julgamento aqui é **o que o PostgreSQL faz com `OFFSET` sobre
 * uma ordem que não é total**. Um dublê de Prisma confirma o pedido que foi
 * feito — e o `spec-066-rota-proximas.e2e-spec.ts` faz exatamente isso, e diz
 * que faz. Mas nenhum dublê tem planejador de consulta, e é o planejador que
 * decide o que acontece quando duas linhas empatam.
 *
 * ## A AC-004 reproduz uma medição do validador, não uma dedução
 *
 * Na 1ª rodada de validação, sem o `id` no `ORDER BY`, duas páginas devolveram
 * as mesmas dez linhas:
 *
 * ```text
 * sem_id pagina1=12,13,14,15,16,17,18,19,20,11
 * sem_id pagina2=20,19,18,17,16,15,14,13,12,11
 * vistos=10   esperados_nas_2_paginas=20
 * ```
 *
 * Por isso aqui há **dois** casos e não um: o positivo, que percorre as
 * páginas pelo serviço de verdade e exige cada `ocupacaoId` uma vez; e o
 * negativo, em SQL cru, que mostra o que acontece **sem** o desempate. Sem o
 * segundo, o primeiro poderia estar passando por sorte do planejador.
 *
 * ## A AC-008 é a prova de que o bloqueio 2 fechou
 *
 * A v1 desta spec tinha teto de página e queria servir a home pela mesma rota.
 * O validador mediu **270 aulas em 90 dias com três turmas**, e
 * `limiteTurmasPorAluno` é nulável — `NULL` = sem limite. Nenhum número
 * serviria.
 *
 * A resposta não foi um número maior: foi **separar as duas rotas**. Aqui se
 * prova o lado que restou — a rota da janela devolve **todas**, e não há
 * truncamento nem silencioso nem declarado.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { StudentsService } from '../../src/people/students.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = 'd0660000-0000-4000-8000-000000000001';
const QUADRA = 'd0660000-0000-4000-8000-000000000002';
const TURMA_A = 'd0660000-0000-4000-8000-00000000000a';
const TURMA_B = 'd0660000-0000-4000-8000-00000000000b';
const USUARIO = 'd0660000-0000-4000-8000-100000000001';
const ALUNO = 'd0660000-0000-4000-8000-200000000001';

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string) => db.$executeRawUnsafe(sql);

const operacao = () => new ConfigOperacaoService(p);

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

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

async function montarEmpresa(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-066','spec-066-${EMPRESA}',now())`,
  );
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
  for (const t of [TURMA_A, TURMA_B]) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${t}','${EMPRESA}','T','${QUADRA}',30,'ativa')`,
    );
  }
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','aluno.spec066@x.com','h','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${ALUNO}','${USUARIO}','${EMPRESA}','aprovado','ativo')`,
  );
  for (const t of [TURMA_A, TURMA_B]) {
    await q(
      `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${t}','${ALUNO}',now())`,
    );
  }
}

/**
 * Cria `quantas` ocorrências **todas na MESMA data e hora**, alternando entre
 * as duas turmas — o empate que a AC-004 exige.
 *
 * ## Uma quadra por ocorrência, e isso não é detalhe de fixture
 *
 * A primeira versão desta função punha todas na mesma quadra e o banco
 * recusou:
 *
 * ```text
 * 23P01 conflicting key value violates exclusion constraint
 *       "no_overlap_por_quadra"
 * ```
 *
 * **O modelo proíbe duas ocupações sobrepostas na MESMA quadra** — é o
 * `EXCLUDE` com `tsrange` que a ADR-009 guarda, e ele é a invariante central
 * do produto. O empate de data e hora, portanto, só existe entre **quadras
 * diferentes**: o aluno matriculado em duas turmas que treinam no mesmo
 * horário, em quadras distintas.
 *
 * Isso torna o cenário **mais** realista, não menos — e é exatamente o que a
 * 1ª rodada de validação mandou montar antes de deduzir.
 */
async function empatadas(quantas: number, data: string, hora: string) {
  const esporte = await db.esporteDeQuadra.findFirstOrThrow({
    where: { companyId: EMPRESA },
    select: { id: true },
  });
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status)
     SELECT gen_random_uuid(),'${EMPRESA}','Q'||i,'${esporte.id}',80,'ativa'
       FROM generate_series(1, ${quantas}) AS i`,
  );
  const novas = await db.quadra.findMany({
    where: { companyId: EMPRESA, id: { not: QUADRA } },
    select: { id: true },
    take: quantas,
  });
  for (let i = 0; i < novas.length; i += 1) {
    await q(
      `INSERT INTO ocupacoes_quadra
         (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}','${novas[i].id}','${data}','${hora}','23:00','TURMA',
               '${i % 2 === 0 ? TURMA_A : TURMA_B}','pendente_pagamento',now())`,
    );
  }
}

/** Ocorrências espalhadas em dias distintos, uma por dia, a partir de amanhã. */
async function espalhadas(quantas: number) {
  await q(
    `INSERT INTO ocupacoes_quadra
       (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     SELECT gen_random_uuid(),'${EMPRESA}','${QUADRA}',
            (DATE '${emDias(1)}' + (i || ' days')::interval)::date,
            '08:00','09:00','TURMA','${TURMA_A}','pendente_pagamento', now()
       FROM generate_series(0, ${quantas - 1}) AS i`,
  );
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await montarEmpresa();
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-066/AC-004 — percorrer as páginas não repete nem pula', () => {
  it('com 20 aulas EMPATADAS, cada ocupacaoId aparece exatamente uma vez', async () => {
    await empatadas(20, emDias(3), '19:00');

    const servico = classes();
    const vistos: string[] = [];
    let total = 0;

    for (let pagina = 1; pagina <= 10; pagina += 1) {
      const r = await servico.listProximasAulasPaginadas(
        EMPRESA,
        USUARIO,
        pagina,
        2,
      );
      total = r.total;
      for (const aula of r.data) vistos.push(aula.ocupacaoId);
    }

    expect(total).toBe(20);
    expect(vistos).toHaveLength(20);
    // `Set` menor que a lista significa repetição; qualquer um dos dois
    // números fora de 20 significa que o `OFFSET` pulou linha.
    expect(new Set(vistos).size).toBe(20);
  });

  it('SEM o `id`, a ordem NAO e total — e e isso que o desempate resolve', async () => {
    await empatadas(20, emDias(3), '19:00');

    // Quantos pares (data, hora_inicio) tem mais de uma linha. Se houver um,
    // `ORDER BY data, hora_inicio` **nao e ordem total**, e `OFFSET` sobre
    // ordem parcial nao tem resultado garantido: o PostgreSQL pode devolver
    // os empatados em qualquer ordem, e nada o obriga a repeti-la entre duas
    // consultas.
    const empates = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM (
         SELECT data, hora_inicio
           FROM ocupacoes_quadra
          WHERE company_id = '${EMPRESA}' AND origem_tipo = 'TURMA'
          GROUP BY data, hora_inicio
         HAVING count(*) > 1) AS x`,
    );

    expect(Number(empates[0].n)).toBeGreaterThan(0);
  });

  /**
   * **O que este arquivo NAO conseguiu reproduzir, e nao vou esconder.**
   *
   * A 1a rodada de validacao mediu duas paginas devolvendo as mesmas dez
   * linhas sem o `id` no `ORDER BY`. **Aqui isso nao aconteceu**: com 20
   * linhas e um `Seq Scan` seguido de `Sort`, o planejador local devolveu
   * ordem estavel, e o caso que eu tinha escrito para falhar passou verde
   * (`Expected: < 20, Received: 20`).
   *
   * Isso **nao desmente** a medicao dele: o plano era outro (`Hash Semi Join`
   * sobre as turmas do aluno), e ordem instavel sobre empate e comportamento
   * **indefinido** — nao definido-errado. Depende de plano, de volume e de
   * paralelismo.
   *
   * Por isso a prova acima nao e "repete", e sim "**existe empate, logo a
   * ordem sem o `id` nao e total**". Essa e verdadeira em qualquer plano, e e
   * a razao pela qual a INV-066b existe.
   *
   * *Um teste que depende de comportamento indefinido para ficar vermelho e
   * um teste que um dia fica verde sozinho.*
   */
});

describe('SPEC-066/AC-008 — a janela NÃO trunca', () => {
  it('uma janela com mais de 200 aulas devolve TODAS', async () => {
    await espalhadas(230);

    const servico = classes();
    const naJanela = await servico.myUpcomingClasses(EMPRESA, USUARIO, {
      de: emDias(1),
      ate: emDias(260),
    });

    const contado = await db.ocupacaoQuadra.count({
      where: { companyId: EMPRESA, origemTipo: 'TURMA' },
    });

    // O número do banco, não um literal: se a fixture mudar, a prova continua
    // dizendo a mesma coisa.
    expect(contado).toBe(230);
    expect(naJanela).toHaveLength(230);
  });

  it('e a rota paginada, no mesmo dado, devolve no máximo uma página', async () => {
    await espalhadas(230);

    const r = await classes().listProximasAulasPaginadas(
      EMPRESA,
      USUARIO,
      1,
      10,
    );

    // As duas garantias convivendo: a janela inteira acima, a página aqui. É
    // a separação que fechou os três bloqueios da 1ª rodada.
    expect(r.data).toHaveLength(10);
    expect(r.total).toBe(230);
  });
});
