/**
 * SPEC-076/TASK-003 — **"a aula não aconteceu" continua para os dois, e se
 * desfaz por rota própria, idempotente, sem renovar a janela, num relógio só**
 * (D3, D11; AC-008 a AC-013 e AC-030).
 *
 * O serviço roda pela conexão do login runtime, com o `RelogioDaPresenca`
 * **substituído por um relógio controlado** onde a prova depende do tempo
 * (AC-009 iii, AC-013): o portão lê `agora` uma vez, desse provedor, e decide
 * em TypeScript. O instante do FECHAMENTO continua sendo o do banco — é o
 * worker real que fecha.
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
  UPROF_VAZIA,
  aluno,
  aula,
  cabecalhoDe,
  codigoDe,
  db,
  desconectarTodos,
  diasAtras,
  linhasDe,
  matricular,
  montarEmpresa,
  q,
  reiniciarSequencias,
  runtime,
} from './presenca-automatica-fixture';
import {
  PresencaService,
  limiteDoDesfazerNaoHouve,
} from '../../src/classes/presenca.service';
import { RelogioDaPresenca } from '../../src/classes/relogio-da-presenca';
import { CorteDaPresenca } from '../../src/presenca-automatica/corte-da-presenca';
import { FechamentoAutomaticoService } from '../../src/presenca-automatica/fechamento-automatico.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(240_000);
exigirBancoLocal();

const app = runtime as unknown as PrismaService;

/** O relógio do portão, parado onde o teste mandar; sem ordem, o do banco. */
class RelogioControlado extends RelogioDaPresenca {
  instante: Date | null = null;
  override async agora(
    db2: Parameters<RelogioDaPresenca['agora']>[0],
  ): Promise<Date> {
    return this.instante ?? super.agora(db2);
  }
}

let relogio: RelogioControlado;
const presenca = () =>
  new PresencaService(app, new CorteDaPresenca(app), relogio);
const worker = () => new FechamentoAutomaticoService(app);

const MS_DIA = 24 * 60 * 60 * 1000;

const avisar = (alunoId: string, ocupacaoId: string) =>
  q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${ocupacaoId}','${alunoId}',now())`,
  );

/** Linhas completas da ocorrência, para comparar ANTES e DEPOIS (não contagem). */
const fotografia = async (oc: string) =>
  JSON.stringify(
    await db.$queryRawUnsafe(
      `SELECT (SELECT row_to_json(c) FROM chamadas c WHERE c.ocupacao_id = $1::uuid) AS cab,
              (SELECT json_agg(p ORDER BY p.aluno_id) FROM presencas p WHERE p.ocupacao_id = $1::uuid) AS linhas`,
      oc,
    ),
  );

beforeAll(async () => {
  await garantirLoginsDeTeste(db);
  await garantirConexoesDeTeste(db);
});

beforeEach(async () => {
  relogio = new RelogioControlado();
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

/** M = {a, b} em TURMA_A, b avisou falta, aula ontem fechada pelo worker. */
async function automaticaComFalta() {
  const a = await aluno('Ana');
  const b = await aluno('Bruno');
  await matricular(TURMA_A, a.alunoId);
  await matricular(TURMA_A, b.alunoId);
  const oc = await aula(TURMA_A, -1);
  await avisar(b.alunoId, oc);
  await ligarPresencaAutomatica(db, diasAtras(3));
  await worker().executarTick();
  const cab = await cabecalhoDe(oc);
  expect(cab).toMatchObject({ origem: 'automatica', completude: 'completa' });
  return { a, b, oc, fechada: cab?.fechada as Date };
}

const statusPorAluno = async (oc: string) =>
  Object.fromEntries((await linhasDe(oc)).map((l) => [l.alunoId, l.status]));

describe('AC-008 — registrar sobre automática apaga `presente` E `ausente`', () => {
  it.each([
    ['professor', UPROF, true],
    ['gestor', UGESTOR, false],
  ] as const)('%s', async (_nome, usuario, comoProfessor) => {
    const { a, b, oc } = await automaticaComFalta();
    expect(await statusPorAluno(oc)).toEqual({
      [a.alunoId]: 'presente',
      [b.alunoId]: 'ausente',
    });

    await presenca().registrarNaoHouve(
      EMPRESA,
      oc,
      usuario,
      comoProfessor,
      comoProfessor ? undefined : TURMA_A,
    );

    expect(await linhasDe(oc)).toHaveLength(0);
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');
  });
});

describe('AC-009 — desfazer, pelo professor', () => {
  it('(i) nascido sobre automática: refecha NA HORA, com D2, autor nulo e o MESMO instante', async () => {
    const { a, b, oc, fechada } = await automaticaComFalta();
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);

    const r = await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);

    expect(r).toEqual({ ocupacaoId: oc, estado: 'feita' });
    expect(await statusPorAluno(oc)).toEqual({
      [a.alunoId]: 'presente',
      [b.alunoId]: 'ausente',
    });
    expect((await linhasDe(oc)).every((l) => l.autor === null)).toBe(true);
    const cab = await cabecalhoDe(oc);
    expect(cab).toMatchObject({
      completude: 'completa',
      origem: 'automatica',
      registradaPor: null,
    });
    expect(cab?.fechada?.getTime()).toBe(fechada.getTime());
  });

  it('(ii) nascido humano, pós-corte: o cabeçalho sai, o estado é `pendente`, e um tick o fecha', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    expect(await cabecalhoDe(oc)).toMatchObject({
      completude: 'nao_houve',
      fechada: null,
    });

    const r = await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);

    expect(r.estado).toBe('pendente');
    expect(await cabecalhoDe(oc)).toBeNull();
    await worker().executarTick();
    expect(await cabecalhoDe(oc)).toMatchObject({
      completude: 'completa',
      origem: 'automatica',
    });
  });

  it('(iii) o laço NÃO estende a janela: dentro dela, registrar/desfazer em série passam; passado o prazo do FECHAMENTO, 422', async () => {
    const { oc, fechada } = await automaticaComFalta();

    relogio.instante = new Date(fechada.getTime() + 60 * 60 * 1000);
    for (let i = 0; i < 2; i += 1) {
      expect(
        await codigoDe(presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true)),
      ).toBe('ok');
      expect(
        await codigoDe(presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true)),
      ).toBe('ok');
    }
    // O instante é o do primeiro fechamento, e continua sendo.
    expect((await cabecalhoDe(oc))?.fechada?.getTime()).toBe(fechada.getTime());

    relogio.instante = new Date(fechada.getTime() + 7 * MS_DIA + 1000);
    expect(
      await codigoDe(presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('AULA_ANTIGA');
  });
});

describe('AC-010 — desfazer, pelo gestor', () => {
  it('desfaz pela rota aninhada, e `:turmaId` de outra turma é 404', async () => {
    const { oc } = await automaticaComFalta();
    await presenca().registrarNaoHouve(EMPRESA, oc, UGESTOR, false, TURMA_A);

    expect(
      await codigoDe(
        presenca().desfazerNaoHouve(
          EMPRESA,
          oc,
          UGESTOR,
          false,
          '05720000-0000-4000-8000-0000000000b1',
        ),
      ),
    ).toBe('NotFoundException');
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');

    const r = await presenca().desfazerNaoHouve(
      EMPRESA,
      oc,
      UGESTOR,
      false,
      TURMA_A,
    );
    expect(r.estado).toBe('feita');
  });
});

describe('AC-011 — nao_houve ANTERIOR ao corte', () => {
  it('desfazer deixa `sem_registro`, e o worker não a fecha', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    // O corte vem DEPOIS da aula: ela é anterior à automação.
    await ligarPresencaAutomatica(db, new Date());

    const r = await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);

    expect(r.estado).toBe('sem_registro');
    await worker().executarTick();
    expect(await cabecalhoDe(oc)).toBeNull();
  });
});

describe('AC-012 — idempotência que não destrói', () => {
  it('sobre chamada `completa`: 200, e as linhas idênticas antes e depois', async () => {
    const { oc } = await automaticaComFalta();
    const antes = await fotografia(oc);

    const r = await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);

    expect(r.estado).toBe('feita');
    expect(await fotografia(oc)).toBe(antes);
  });

  it('o retry depois de o worker refechar um nao_houve humano é no-op', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);
    await worker().executarTick();
    const antes = await fotografia(oc);

    await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);

    expect(await fotografia(oc)).toBe(antes);
  });
});

describe('AC-013 — o DELETE herda o portão', () => {
  it('AULA_CANCELADA', async () => {
    const { oc } = await automaticaComFalta();
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    await cancelarOcupacaoNaFixture(db, {
      companyId: EMPRESA,
      ocupacaoId: oc,
      autorId: UGESTOR,
    });
    expect(
      await codigoDe(presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('AULA_CANCELADA');
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');
  });

  it('AULA_FUTURA', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, 2);
    expect(
      await codigoDe(presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('AULA_FUTURA');
  });

  it('AULA_ANTIGA pela janela RETROATIVA (nao_houve humano), pelo relógio controlado', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    relogio.instante = new Date(Date.now() + 8 * MS_DIA);
    expect(
      await codigoDe(presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('AULA_ANTIGA');
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');
  });

  it('AULA_ANTIGA pela janela da AUTOMÁTICA, pelo relógio controlado', async () => {
    const { oc, fechada } = await automaticaComFalta();
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    relogio.instante = new Date(fechada.getTime() + 7 * MS_DIA + 1000);
    expect(
      await codigoDe(presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('AULA_ANTIGA');
  });

  it('404 para aula de outro professor', async () => {
    const { oc } = await automaticaComFalta();
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    expect(
      await codigoDe(
        presenca().desfazerNaoHouve(EMPRESA, oc, UPROF_VAZIA, true),
      ),
    ).toBe('NotFoundException');
  });

  it('403 para quem não é professor', async () => {
    const { oc } = await automaticaComFalta();
    expect(
      await codigoDe(presenca().desfazerNaoHouve(EMPRESA, oc, UGESTOR, true)),
    ).toBe('ForbiddenException');
  });
});

describe('D3 — `desfazerNaoHouveAte` no GET e no histórico', () => {
  it('automática: fechamento + 7 dias; depois de desfeito, nulo', async () => {
    const { oc, fechada } = await automaticaComFalta();
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);

    const esperado = new Date(fechada.getTime() + 7 * MS_DIA).toISOString();
    expect(
      (await presenca().chamada(EMPRESA, UPROF, oc)).desfazerNaoHouveAte,
    ).toBe(esperado);
    expect(
      (await presenca().historicoDaTurma(EMPRESA, TURMA_A, 30)).find(
        (o) => o.ocupacaoId === oc,
      )?.desfazerNaoHouveAte,
    ).toBe(esperado);

    await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);
    expect(
      (await presenca().chamada(EMPRESA, UPROF, oc)).desfazerNaoHouveAte,
    ).toBeNull();
  });

  it('humano: meia-noite do dia `data + 8` no fuso do clube; fora dele, nulo', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    const [linha] = await db.$queryRawUnsafe<{ data: Date }[]>(
      `SELECT data FROM ocupacoes_quadra WHERE id = $1::uuid`,
      oc,
    );
    const esperado = limiteDoDesfazerNaoHouve(
      { completude: 'nao_houve', fechadaAutomaticamenteEm: null },
      linha.data,
      new Date(0),
    );
    // Meia-noite no clube (UTC−3) é 03:00Z do dia `data + 8`.
    const d8 = new Date(linha.data.getTime() + 8 * MS_DIA);
    expect(esperado).toBe(`${d8.toISOString().slice(0, 10)}T03:00:00.000Z`);
    expect(
      (await presenca().chamada(EMPRESA, UPROF, oc)).desfazerNaoHouveAte,
    ).toBe(esperado);

    relogio.instante = new Date(new Date(esperado as string).getTime() + 1000);
    expect(
      (await presenca().chamada(EMPRESA, UPROF, oc)).desfazerNaoHouveAte,
    ).toBeNull();
  });

  it('sem nao_houve, nulo', async () => {
    const { oc } = await automaticaComFalta();
    expect(
      (await presenca().chamada(EMPRESA, UPROF, oc)).desfazerNaoHouveAte,
    ).toBeNull();
  });
});

describe('AC-030 — a produção lê o relógio do BANCO, e o portão tem um relógio só', () => {
  it('o `RelogioDaPresenca` real difere do `clock_timestamp()` da mesma transação em menos de 1 s', async () => {
    const real = new RelogioDaPresenca();
    await db.$transaction(async (tx) => {
      const agora = await real.agora(tx);
      const [linha] = await tx.$queryRawUnsafe<{ t: Date }[]>(
        `SELECT clock_timestamp() AS t`,
      );
      expect(Math.abs(linha.t.getTime() - agora.getTime())).toBeLessThan(1000);
    });
  });

  it('o corpo de `travarEValidarOcorrencia` não tem outro relógio', () => {
    // Fim de linha normalizado: com `core.autocrlf=true` o checkout no
    // Windows é CRLF, e o recorte por `'\n  }\n'` devolvia -1 — o `slice`
    // pegava o resto do arquivo e achava o `clock_timestamp()` legítimo do
    // refechamento (achado A2 da validação independente da implementação).
    const fonte = readFileSync(
      join(__dirname, '..', '..', 'src', 'classes', 'presenca.service.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const inicio = fonte.indexOf('private async travarEValidarOcorrencia(');
    const fim = fonte.indexOf('\n  }\n', inicio);
    expect(inicio).toBeGreaterThan(0);
    // O recorte achou o fim do MÉTODO, e não o do arquivo.
    expect(fim).toBeGreaterThan(inicio);
    // Sem comentários: eles citam `dia > hoje` e o `clock_timestamp` antigo.
    const corpo = semComentarios(fonte.slice(inicio, fim));

    // Regra 3 — UMA leitura do relógio, e é a do provedor.
    expect(corpo.match(/this\.relogio\.agora\(/g)).toHaveLength(1);

    // Regra 1 — nenhuma OUTRA fonte de tempo. É uma classe, e não uma lista de
    // grafias: a 2ª rodada da validação inseriu `Date.now()` e a versão
    // anterior (que proibia `new Date(`, `this.hoje(` e `clock_timestamp`)
    // continuou verde.
    const fontesDeTempo: [string, RegExp][] = [
      ['Date como chamada, construtor ou método', /\bDate\s*(\(|\.)/],
      [
        'performance.now / process.hrtime',
        /\b(performance\s*\.\s*now|process\s*\.\s*hrtime)\b/,
      ],
      [
        'relógio do SQL',
        /\b(clock_timestamp|statement_timestamp|transaction_timestamp|now|timeofday)\s*\(|\bcurrent_(timestamp|date|time)\b|\blocal(timestamp|time)\b/i,
      ],
      ['o `hoje` antigo do serviço', /this\.hoje\s*\(/],
    ];
    for (const [nome, re] of fontesDeTempo) {
      expect({ nome, achado: re.exec(corpo)?.[0] ?? null }).toEqual({
        nome,
        achado: null,
      });
    }

    // Regra 2 — função cujo parâmetro de relógio tem padrão `new Date()` cai
    // no relógio do Node quando chamada sem ele (`hojeNoFusoDoClube()`,
    // `aulaJaComecou(data, hora)`). A lista vem do PRÓPRIO `date-time.util`,
    // e não de uma cópia: toda chamada dessas no portão passa o `agora`.
    const util = semComentarios(
      readFileSync(
        join(__dirname, '..', '..', 'src', 'courts', 'date-time.util.ts'),
        'utf8',
      ).replace(/\r\n/g, '\n'),
    );
    const comRelogioPadrao = [
      ...util.matchAll(
        /export function (\w+)\s*\(([^)]*?)\b\w+\s*:\s*Date\s*=\s*new Date\(\)/g,
      ),
    ].map((m) => m[1]);
    expect(comRelogioPadrao).toEqual(
      expect.arrayContaining(['hojeNoFusoDoClube', 'aulaJaComecou']),
    );
    for (const nome of comRelogioPadrao) {
      for (const args of argumentosDasChamadas(corpo, nome)) {
        expect({ nome, args, temAgora: /\bagora\b/.test(args) }).toEqual({
          nome,
          args,
          temAgora: true,
        });
      }
    }
  });
});

/** Tira comentários de bloco e de linha (o código do portão não tem URL). */
function semComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Os argumentos de cada chamada `nome(...)`, com parênteses balanceados. */
function argumentosDasChamadas(codigo: string, nome: string): string[] {
  const saida: string[] = [];
  const re = new RegExp(`\\b${nome}\\s*\\(`, 'g');
  for (const m of codigo.matchAll(re)) {
    let nivel = 1;
    let i = (m.index ?? 0) + m[0].length;
    const comeco = i;
    while (i < codigo.length && nivel > 0) {
      if (codigo[i] === '(') nivel += 1;
      else if (codigo[i] === ')') nivel -= 1;
      i += 1;
    }
    saida.push(codigo.slice(comeco, i - 1));
  }
  return saida;
}
