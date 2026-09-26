/**
 * SPEC-076/TASK-002 — **`sem_registro` em todos os consumidores** (D5,
 * AC-015 e a parte de banco da AC-016).
 *
 * A aula de turma que terminou **antes do corte** da presença automática, sem
 * cabeçalho, era `pendente` para sempre: nada a fechava e ninguém podia
 * lançar. Agora é `sem_registro` — sem vermelho, fora das pendências — e o
 * estado sai do resolvedor único, igual para o calendário, a agenda do dia, a
 * lista do professor, o histórico do gestor e a frequência.
 *
 * O mundo: TURMA_A (professor UPROF), um aluno, corte há 3 dias, e uma aula de
 * cada estado em dias distintos — o resumo do mês é por dia, e dias distintos
 * separam a contagem de pendências.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { cancelarOcupacaoNaFixture } from './cancelar-ocupacao';
import {
  garantirConexoesDeTeste,
  garantirLoginsDeTeste,
  ligarPresencaAutomatica,
  redefinirConfigDePresenca,
} from './config-de-presenca';
import {
  EMPRESA,
  TURMA_A,
  UGESTOR,
  UPROF,
  aluno,
  aula,
  chamadaCrua,
  db,
  desconectarTodos,
  diasAtras,
  emDias,
  matricular,
  montarEmpresa,
  reiniciarSequencias,
  runtime,
} from './presenca-automatica-fixture';
import { AgendaDoProfessorService } from '../../src/classes/agenda-do-professor.service';
import { AvaliacaoDeAulaService } from '../../src/classes/avaliacao-de-aula.service';
import { PresencaService } from '../../src/classes/presenca.service';
import { FrequenciaService } from '../../src/frequencia/frequencia.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(240_000);
exigirBancoLocal();

const app = runtime as unknown as PrismaService;
const presenca = () => new PresencaService(app);
const agenda = () => new AgendaDoProfessorService(app);
const frequencia = () => new FrequenciaService(app);
const avaliacao = () => new AvaliacaoDeAulaService(app);

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

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await redefinirConfigDePresenca(db);
  await desconectarTodos();
});

/** Uma aula de cada estado; corte há 3 dias. */
async function mundo() {
  const a = await aluno('Ana');
  await matricular(TURMA_A, a.alunoId);
  const semRegistro = await aula(TURMA_A, -6); // antes do corte
  const naoHouveVelha = await aula(TURMA_A, -5); // antes do corte, com nao_houve
  const feita = await aula(TURMA_A, -2); // depois do corte, fechada
  const pendente = await aula(TURMA_A, -1); // depois do corte, o worker ainda não passou
  const cancelada = await aula(TURMA_A, -4);
  const futura = await aula(TURMA_A, 2);
  await ligarPresencaAutomatica(db, diasAtras(3));
  await chamadaCrua(feita, 'automatica', [[a.alunoId, 'presente']]);
  await db.$executeRawUnsafe(
    `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados,origem,origem_inicial)
     VALUES ('${naoHouveVelha}','TURMA','${EMPRESA}','${UPROF}',now(),'nao_houve',NULL,'professor','professor')`,
  );
  await cancelarOcupacaoNaFixture(db, {
    companyId: EMPRESA,
    ocupacaoId: cancelada,
    autorId: UGESTOR,
  });
  return { a, semRegistro, naoHouveVelha, feita, pendente, cancelada, futura };
}

describe('SPEC-076/D5 — `sem_registro` em cada consumidor (AC-015)', () => {
  it('a agenda do MÊS conta como pendência só a `pendente`', async () => {
    const m = await mundo();
    void m;
    const meses = new Set([emDias(-6), emDias(-1)].map((d) => d.slice(0, 7)));
    const porDia = new Map<string, { pendentes: number }>();
    for (const mes of meses) {
      for (const d of await agenda().resumoDoMes(EMPRESA, UPROF, mes)) {
        porDia.set(d.data, d);
      }
    }
    expect(porDia.get(emDias(-6))?.pendentes).toBe(0); // sem_registro
    expect(porDia.get(emDias(-1))?.pendentes).toBe(1); // pendente
    const total = [...porDia.values()].reduce((s, d) => s + d.pendentes, 0);
    expect(total).toBe(1);
  });

  it('a agenda do DIA diz `sem_registro` na anterior ao corte e `pendente` na pós-corte', async () => {
    const m = await mundo();
    const estadoNoDia = async (dias: number, oc: string) =>
      (await agenda().detalheDoDia(EMPRESA, UPROF, emDias(dias))).find(
        (d) => d.ocupacaoId === oc,
      )?.chamada;
    expect(await estadoNoDia(-6, m.semRegistro)).toBe('sem_registro');
    expect(await estadoNoDia(-1, m.pendente)).toBe('pendente');
    expect(await estadoNoDia(-2, m.feita)).toBe('feita');
    expect(await estadoNoDia(-5, m.naoHouveVelha)).toBe('nao_houve');
  });

  it('a lista do PROFESSOR e o histórico do GESTOR dizem o mesmo estado, aula por aula', async () => {
    const m = await mundo();
    const lista = await presenca().ocorrenciasDaTurma(
      EMPRESA,
      UPROF,
      TURMA_A,
      30,
    );
    const historico = await presenca().historicoDaTurma(EMPRESA, TURMA_A, 30);
    const esperado: Record<string, string> = {
      [m.semRegistro]: 'sem_registro',
      [m.pendente]: 'pendente',
      [m.feita]: 'feita',
      [m.naoHouveVelha]: 'nao_houve',
    };
    for (const [oc, estado] of Object.entries(esperado)) {
      expect(lista.data.find((o) => o.ocupacaoId === oc)?.estado).toBe(estado);
      expect(historico.find((o) => o.ocupacaoId === oc)?.estado).toBe(estado);
    }
    // SPEC-076/D1 — e o GET da chamada diz o mesmo, aula por aula.
    for (const [oc, estado] of Object.entries(esperado)) {
      expect((await presenca().chamada(EMPRESA, UPROF, oc)).estado).toBe(
        estado,
      );
    }
    // `sem_registro` não é "chamada feita" em nenhum dos dois.
    expect(
      lista.data.find((o) => o.ocupacaoId === m.semRegistro)?.chamadaFeita,
    ).toBe(false);
    expect(
      historico.find((o) => o.ocupacaoId === m.semRegistro)?.chamadaFeita,
    ).toBe(false);
  });

  it('a FREQUÊNCIA conta `sem_registro` em `pendentesLegadas` e a pós-corte em `pendentesAtuais`', async () => {
    await mundo();
    const turma = await frequencia().daTurma(EMPRESA, TURMA_A, 30);
    expect(turma.cobertura.origens).toMatchObject({
      pendentesLegadas: 1,
      pendentesAtuais: 1,
    });
  });

  it('a descrição OpenAPI de `pendentesLegadas` é a da D5', () => {
    const openapi = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'openapi.json'), 'utf8'),
    ) as {
      components: {
        schemas: Record<
          string,
          { properties?: Record<string, { description?: string }> }
        >;
      };
    };
    expect(
      openapi.components.schemas.OrigensDaCoberturaResponseDto.properties
        ?.pendentesLegadas?.description,
    ).toBe(
      'Aulas anteriores à automação sem registro de presença — não cobram ação.',
    );
  });

  it('AC-016: a avaliação de uma aula `sem_registro` continua aceita', async () => {
    const m = await mundo();
    const r = await avaliacao().avaliar(EMPRESA, m.a.usuarioId, m.semRegistro, {
      nota: 5,
    });
    expect(r).toBeDefined();
    const [n] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM avaliacoes_de_aula WHERE ocupacao_id = $1::uuid`,
      m.semRegistro,
    );
    expect(Number(n.n)).toBe(1);
  });
});
