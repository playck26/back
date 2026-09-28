/**
 * SPEC-077/TASK-001 — **as provas da SPEC-031 que a matriz prometia e nunca
 * teve.** Itens 1, 3, 5 e 6 do inventário da SPEC-077:
 *
 * - AC-003 (031 AC-001/002, o CHECK `horas >= 1` NO BANCO): o e2e de hoje usa
 *   Prisma dublado e só prova o DTO;
 * - AC-004 (031 INV-068, com a nota da SPEC-077): avisar e retirar a falta
 *   mudam **só** `faltas_avisadas` — e, no `DELETE` com fila, também a
 *   `lista_de_espera` (SPEC-064). Fotografia do banco INTEIRO, não contagem;
 * - AC-005 (031 AC-020, com a nota): o **ato** de avisar não grava `chamadas`
 *   nem `presencas`; o resultado da chamada é do fechamento (SPEC-076/D2);
 * - AC-006 (031 AC-016b/c): 16h59, 17h00 e 17h01 nos DOIS verbos, com relógio
 *   fixo — a fronteira exata, que antes só a função pura provava.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { diaNoFuturo } from './datas-relativas';
import { limparEmpresa } from './limpar-empresa';
import { comAcao } from './acao-com-efeito';
import { FaltaAvisadaService } from '../../src/classes/falta-avisada.service';
import { PresencaService } from '../../src/classes/presenca.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { lerCatalogo } from '../../src/presenca-automatica/cli/fecho-de-linhas';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const id = (n: number) =>
  `f0770031-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EMPRESA = id(1);
const QUADRA = id(2);
const ESPORTE = id(3);
const TURMA = id(4);
const OUTRA_TURMA = id(5);
const UPROF = id(6);
const PROF = id(7);
const UALUNO = id(8);
const ALUNO = id(9);
const UADMIN = id(10);
const PLANO = id(11);

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const faltas = new FaltaAvisadaService(
  db as unknown as PrismaService,
  new ConfigOperacaoService(db as unknown as PrismaService),
);
const presencas = new PresencaService(db as unknown as PrismaService);

/** Uma ocorrência da turma em `data`, `hora`–`hora+50min`. */
async function ocorrencia(
  data: string,
  hora: string,
  turma = TURMA,
): Promise<string> {
  const [r] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO ocupacoes_quadra
       (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${data}',TIME '${hora}',TIME '${hora}' + INTERVAL '50 minutes','TURMA','${turma}','pendente_pagamento',now())
     RETURNING id`,
  );
  return r.id;
}

async function montar(): Promise<void> {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,contrato_versao_vigente,updated_at) VALUES ('${EMPRESA}','SPEC-077/031','spec-077-031',1,now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES ('${ESPORTE}','${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q1','${ESPORTE}',100,'ativa')`,
  );
  await q(
    `INSERT INTO usuarios (id,company_id,nome,email,senha_hash,role,status,updated_at) VALUES
       ('${UPROF}','${EMPRESA}','P','prof-077031@x.test','x','professor','ativo',now()),
       ('${UALUNO}','${EMPRESA}','A','aluno-077031@x.test','x','aluno','ativo',now()),
       ('${UADMIN}','${EMPRESA}','G','gestor-077031@x.test','x','company_admin','ativo',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF}','${EMPRESA}','P','${UPROF}')`,
  );
  await q(
    `INSERT INTO alunos (id,company_id,usuario_id,status,vinculo) VALUES ('${ALUNO}','${EMPRESA}','${UALUNO}','ativo','aprovado')`,
  );
  for (const [t, nome] of [
    [TURMA, 'Turma 077'],
    [OUTRA_TURMA, 'Outra 077'],
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${t}','${EMPRESA}','${nome}','${QUADRA}','${PROF}',20,'ativa')`,
    );
  }
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id) VALUES (gen_random_uuid(),'${TURMA}','${ALUNO}')`,
  );
}

/**
 * **As linhas que a fotografia vigia.** Um efeito colateral que ATUALIZE ou
 * APAGUE linha só aparece se a linha existir — `UPDATE` em tabela vazia não
 * muda o md5. Cada tabela que a INV-068 protege ganha pelo menos uma.
 */
async function povoar(): Promise<void> {
  // Carteira: um aporte (movimento + saldo do aluno).
  await comAcao(
    db,
    { companyId: EMPRESA, tipo: 'reserva_criada', autorId: UADMIN },
    (tx, acaoId) =>
      tx.$executeRawUnsafe(
        `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,motivo,autor_id,acao_id)
         VALUES (gen_random_uuid(),'${EMPRESA}','${ALUNO}','entrada',50000,'aporte','${UADMIN}','${acaoId}')`,
      ),
  );
  // Matrícula vigente.
  await q(
    `INSERT INTO planos (id,company_id,nome,valor_centavos,prazo_meses,updated_at) VALUES ('${PLANO}','${EMPRESA}','Mensal',30000,1,now())`,
  );
  await q(
    `INSERT INTO aceites (id,usuario_id,tipo,versao,aceito_em) VALUES (gen_random_uuid(),'${UALUNO}','contrato',1,now())`,
  );
  await q(
    `INSERT INTO matriculas (id,company_id,aluno_id,usuario_id,plano_id,valor_centavos,valor_de_tabela_centavos,prazo_meses,inicio,fim,contrato_versao,criado_por_id)
     VALUES (gen_random_uuid(),'${EMPRESA}','${ALUNO}','${UALUNO}','${PLANO}',30000,30000,1,'${diaNoFuturo(-10)}','${diaNoFuturo(365)}',1,'${UADMIN}')`,
  );
  // Uma aula PASSADA com chamada automática e presença.
  const passada = await ocorrencia(diaNoFuturo(-2), '08:00');
  await q(
    `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados,origem,origem_inicial,fechada_automaticamente_em)
     VALUES ('${passada}','TURMA','${EMPRESA}',NULL,now(),'completa',1,'automatica','automatica',clock_timestamp())`,
  );
  await q(
    `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${passada}','TURMA','${ALUNO}','presente',NULL,now())`,
  );
  // Uma falta antiga, com a reposição marcada numa aula da OUTRA turma.
  const perdida = await ocorrencia(diaNoFuturo(-5), '10:00');
  const [f] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${perdida}','${ALUNO}',now()) RETURNING id`,
  );
  const destino = await ocorrencia(diaNoFuturo(6), '20:00', OUTRA_TURMA);
  await q(
    `INSERT INTO reposicoes_de_aula (id,company_id,aluno_id,falta_id,ocupacao_id)
     VALUES (gen_random_uuid(),'${EMPRESA}','${ALUNO}','${f.id}','${destino}')`,
  );
  // A fila da OUTRA turma (sem ligação com as faltas deste teste).
  await q(
    `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,estado)
     VALUES (gen_random_uuid(),'${EMPRESA}','${ALUNO}','${OUTRA_TURMA}','aguardando')`,
  );
}

/**
 * md5 de cada tabela pública e o valor de cada sequência — o banco INTEIRO.
 * O mesmo molde da SPEC-076 (`spec-076-limpeza.db-spec.ts`).
 */
async function fotografia(): Promise<Record<string, string>> {
  const catalogo = await lerCatalogo(db);
  const tabelas = await db.$queryRawUnsafe<{ t: string }[]>(
    `SELECT tablename::text AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
  );
  const foto: Record<string, string> = {};
  for (const { t } of tabelas) {
    const chave = catalogo.chaves.get(t);
    if (!chave?.length) throw new Error(`tabela sem chave primária: ${t}`);
    const [{ h }] = await db.$queryRawUnsafe<{ h: string }[]>(
      `SELECT md5(coalesce(string_agg(x::text, E'\\n' ORDER BY ${chave
        .map((c) => `x."${c}"`)
        .join(', ')}), '')) AS h FROM "${t}" x`,
    );
    foto[t] = h;
  }
  const seqs = await db.$queryRawUnsafe<{ nome: string; v: string }[]>(
    `SELECT schemaname || '.' || sequencename AS nome,
            coalesce(last_value::text, '<last_value nulo>') AS v
       FROM pg_sequences WHERE schemaname = 'public'`,
  );
  for (const s of seqs) foto[`seq:${s.nome}`] = s.v;
  return foto;
}

/** Os nomes do que mudou entre duas fotografias. */
const mudou = (antes: Record<string, string>, depois: Record<string, string>) =>
  Object.keys({ ...antes, ...depois })
    .filter((k) => antes[k] !== depois[k])
    .sort();

/** Quantas linhas cada tabela vigiada tem — a fixture não pode estar vazia. */
async function contagem(tabela: string): Promise<number> {
  const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${tabela} WHERE company_id = '${EMPRESA}'`,
  );
  return n;
}

const codigoDe = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'aceito';
  } catch (e) {
    const r = (e as { getResponse?: () => { code?: string } }).getResponse?.();
    return r?.code ?? (e as { name?: string }).name ?? 'erro';
  }
};

beforeEach(montar);

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-077/AC-003 — o CHECK `horas >= 1` no BANCO (031 AC-001/002)', () => {
  const inserir = (aula: string, reserva: string) =>
    q(
      `INSERT INTO config_operacao_empresa (id,company_id,prazo_cancelamento_aula_horas,prazo_cancelamento_reserva_horas,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}',${aula},${reserva},now())`,
    );

  it.each([
    ['aula = 0', '0', 'NULL', 'config_operacao_prazo_aula_valido'],
    ['aula = -1', '-1', 'NULL', 'config_operacao_prazo_aula_valido'],
    ['reserva = 0', 'NULL', '0', 'config_operacao_prazo_reserva_valido'],
    ['reserva = -1', 'NULL', '-1', 'config_operacao_prazo_reserva_valido'],
  ])(
    '%s é recusado com 23514, pelo nome da constraint',
    async (_c, aula, reserva, nome) => {
      const erro = await inserir(aula, reserva).catch((e: Error) => e);
      expect(erro).toBeInstanceOf(Error);
      expect((erro as Error).message).toMatch(/23514/);
      expect((erro as Error).message).toContain(nome);
    },
  );

  it('NULL e 1 passam (o limite de baixo é 1, e "sem prazo" é NULL)', async () => {
    await inserir('1', '1');
    await q(
      `DELETE FROM config_operacao_empresa WHERE company_id = '${EMPRESA}'`,
    );
    await inserir('NULL', 'NULL');
    expect(await contagem('config_operacao_empresa')).toBe(1);
  });

  it('a sabotagem, no próprio teste: sem a constraint, o `0` ENTRA (e tudo volta)', async () => {
    const r = await db
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `ALTER TABLE config_operacao_empresa DROP CONSTRAINT config_operacao_prazo_aula_valido`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO config_operacao_empresa (id,company_id,prazo_cancelamento_aula_horas,updated_at)
           VALUES (gen_random_uuid(),'${EMPRESA}',0,now())`,
        );
        throw new Error('VOLTA_DE_PROPOSITO');
      })
      .catch((e: Error) => e.message);
    // O `INSERT` do zero passou — só a exceção de propósito interrompeu.
    expect(r).toBe('VOLTA_DE_PROPOSITO');
    // E a constraint continua lá depois da volta.
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'config_operacao_prazo_aula_valido'`,
    );
    expect(n).toBe(1);
  });
});

describe('SPEC-077/AC-004 — avisar e retirar mudam SÓ a falta (031 INV-068, com a nota de 2026-09-27)', () => {
  beforeEach(povoar);

  it('a fixture tem linha em toda tabela vigiada (senão a fotografia não distinguiria)', async () => {
    for (const t of [
      'turma_alunos',
      'presencas',
      'chamadas',
      'movimentos_de_credito',
      'matriculas',
      'reposicoes_de_aula',
      'lista_de_espera',
      'faltas_avisadas',
    ]) {
      const n =
        t === 'turma_alunos'
          ? (
              await db.$queryRawUnsafe<{ n: number }[]>(
                `SELECT count(*)::int AS n FROM turma_alunos WHERE turma_id = '${TURMA}'`,
              )
            )[0].n
          : await contagem(t);
      expect({ t, temLinha: n > 0 }).toEqual({ t, temLinha: true });
    }
    const [{ saldo }] = await db.$queryRawUnsafe<{ saldo: number }[]>(
      `SELECT saldo_creditos::int AS saldo FROM alunos WHERE id = '${ALUNO}'`,
    );
    expect(saldo).toBeGreaterThan(0);
  });

  it('POST: só `faltas_avisadas` muda — e o aviso ao gestor (SPEC-078)', async () => {
    const aula = await ocorrencia(diaNoFuturo(10), '19:00');
    const antes = await fotografia();
    await faltas.avisar(EMPRESA, UALUNO, TURMA, aula);
    // SPEC-078/I1 — desde 2026-09-28 avisar e retirar falta AVISAM O GESTOR:
    // a linha nova em `notificacoes` é o aviso ("Um aluno avisou que vai
    // faltar…"), e é a única tabela a mais. A INV-068 protege matrícula,
    // presença e financeiro — `notificacoes` não é nenhum dos três —, e a
    // fotografia continua pegando qualquer outra escrita.
    expect(mudou(antes, await fotografia())).toEqual([
      'faltas_avisadas',
      'notificacoes',
    ]);
  });

  it('DELETE sem fila: só `faltas_avisadas` muda — e o aviso ao gestor (SPEC-078)', async () => {
    const aula = await ocorrencia(diaNoFuturo(10), '19:00');
    await faltas.avisar(EMPRESA, UALUNO, TURMA, aula);
    const antes = await fotografia();
    await faltas.retirar(EMPRESA, UALUNO, TURMA, aula);
    // SPEC-078/I1 — desde 2026-09-28 avisar e retirar falta AVISAM O GESTOR:
    // a linha nova em `notificacoes` é o aviso ("Um aluno avisou que vai
    // faltar…"), e é a única tabela a mais. A INV-068 protege matrícula,
    // presença e financeiro — `notificacoes` não é nenhum dos três —, e a
    // fotografia continua pegando qualquer outra escrita.
    expect(mudou(antes, await fotografia())).toEqual([
      'faltas_avisadas',
      'notificacoes',
    ]);
  });

  it('DELETE com fila: `faltas_avisadas` e a `lista_de_espera` (SPEC-064), e mais nada', async () => {
    const aula = await ocorrencia(diaNoFuturo(10), '19:00');
    await faltas.avisar(EMPRESA, UALUNO, TURMA, aula);
    const [falta] = await db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM faltas_avisadas WHERE ocupacao_id = '${aula}' AND aluno_id = '${ALUNO}'`,
    );
    // O aluno esperando vaga numa aula da outra turma, com o crédito DESTA falta.
    const alvo = await ocorrencia(diaNoFuturo(12), '20:00', OUTRA_TURMA);
    await q(
      `INSERT INTO lista_de_espera (id,company_id,aluno_id,ocupacao_id,falta_id,estado)
       VALUES (gen_random_uuid(),'${EMPRESA}','${ALUNO}','${alvo}','${falta.id}','aguardando')`,
    );
    const antes = await fotografia();
    await faltas.retirar(EMPRESA, UALUNO, TURMA, aula);
    // SPEC-078/I1 — desde 2026-09-28 avisar e retirar falta AVISAM O GESTOR:
    // a linha nova em `notificacoes` é o aviso ("Um aluno avisou que vai
    // faltar…"), e é a única tabela a mais. A INV-068 protege matrícula,
    // presença e financeiro — `notificacoes` não é nenhum dos três —, e a
    // fotografia continua pegando qualquer outra escrita.
    expect(mudou(antes, await fotografia())).toEqual([
      'faltas_avisadas',
      'lista_de_espera',
      'notificacoes',
    ]);
  });
});

describe('SPEC-077/AC-005 — o ATO de avisar não grava a chamada (031 AC-020, com a nota de 2026-09-27)', () => {
  it('depois de avisar, a ocorrência segue sem `chamadas` e sem `presencas`; a chamada mostra o aviso e nenhum status', async () => {
    const aula = await ocorrencia(diaNoFuturo(10), '19:00');
    await faltas.avisar(EMPRESA, UALUNO, TURMA, aula);

    const [{ c, p }] = await db.$queryRawUnsafe<{ c: number; p: number }[]>(
      `SELECT (SELECT count(*)::int FROM chamadas WHERE ocupacao_id = '${aula}') AS c,
              (SELECT count(*)::int FROM presencas WHERE ocupacao_id = '${aula}') AS p`,
    );
    expect({ c, p }).toEqual({ c: 0, p: 0 });

    const chamada = await presencas.chamada(EMPRESA, UPROF, aula);
    const linha = chamada.alunos.find((a) => a.alunoId === ALUNO);
    expect({
      status: linha?.status,
      faltaAvisada: linha?.faltaAvisada,
    }).toEqual({
      status: null,
      faltaAvisada: true,
    });
  });
});

/**
 * SPEC-077/AC-006 — **a fronteira exata, pelos verbos.** Aula às 19h, prazo de
 * 2h: 16h59 e 17h00 aceitam, 17h01 recusa — no `POST` e no `DELETE`. O serviço
 * lê `new Date()` sem injeção; o relógio do Node é parado no instante (o molde
 * `comNodeEm` da SPEC-076), e o teste confere que a falsificação pegou.
 */
describe('SPEC-077/AC-006 — 16h59, 17h00 e 17h01 nos dois verbos (031 AC-016b/c)', () => {
  const DIA = diaNoFuturo(20);
  const noClube = (hora: string) => new Date(`${DIA}T${hora}:00.000-03:00`);

  async function comNodeEm<T>(
    instante: Date,
    fn: () => Promise<T>,
  ): Promise<T> {
    jest.useFakeTimers({
      now: instante,
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
        'queueMicrotask',
      ],
    });
    try {
      expect(Date.now()).toBe(instante.getTime());
      return await fn();
    } finally {
      jest.useRealTimers();
    }
  }

  beforeEach(async () => {
    await q(
      `INSERT INTO config_operacao_empresa (id,company_id,prazo_cancelamento_aula_horas,prazo_cancelamento_reserva_horas,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}',2,NULL,now())`,
    );
  });

  it.each([
    ['16:59', 'aceito'],
    ['17:00', 'aceito'],
    ['17:01', 'PRAZO_DE_CANCELAMENTO'],
  ])('POST às %s: %s', async (hora, esperado) => {
    const aula = await ocorrencia(DIA, '19:00');
    const r = await comNodeEm(noClube(hora), () =>
      codigoDe(() => faltas.avisar(EMPRESA, UALUNO, TURMA, aula)),
    );
    expect(r).toBe(esperado);
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM faltas_avisadas WHERE ocupacao_id = '${aula}'`,
    );
    expect(n).toBe(esperado === 'aceito' ? 1 : 0);
  });

  it.each([
    ['16:59', 'aceito'],
    ['17:00', 'aceito'],
    ['17:01', 'PRAZO_DE_CANCELAMENTO'],
  ])('DELETE às %s: %s (avisada às 15h)', async (hora, esperado) => {
    const aula = await ocorrencia(DIA, '19:00');
    await comNodeEm(noClube('15:00'), () =>
      faltas.avisar(EMPRESA, UALUNO, TURMA, aula),
    );
    const r = await comNodeEm(noClube(hora), () =>
      codigoDe(() => faltas.retirar(EMPRESA, UALUNO, TURMA, aula)),
    );
    expect(r).toBe(esperado);
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM faltas_avisadas WHERE ocupacao_id = '${aula}'`,
    );
    // Recusado, a linha FICA — é o ponto do D23.
    expect(n).toBe(esperado === 'aceito' ? 0 : 1);
  });
});
