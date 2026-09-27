/**
 * SPEC-076/TASK-006 — **o script da D8 e da D9, contra o banco de verdade.**
 *
 * O observador é o catálogo e o erro do banco (AC-025), e a prova de "nada
 * mudou" é de CONTEÚDO: `md5` de cada tabela pública na ordem da chave
 * primária, mais o `last_value` de cada sequência (AC-023, R8). Contagem não
 * serve — um `UPDATE` confirmado não muda contagem nenhuma (a N3).
 *
 * O script roda pela função de verdade (`executarComGanchos`), com conexão
 * própria, como em produção; os ganchos da R12 só entram nos casos (vi) e
 * (vii) da AC-033.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { cancelarOcupacaoNaFixture } from './cancelar-ocupacao';
import {
  declararAmbienteDeTeste,
  ligarPresencaAutomatica,
  redefinirConfigDePresenca,
} from './config-de-presenca';
import { comValvula } from './valvula-de-presenca';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import {
  executarComGanchos,
  type GanchosDeTeste,
  type RelatorioDaEmpresa,
  type ResultadoDaLimpeza,
} from '../../src/presenca-automatica/cli/limpeza-chamada';
import { lerCatalogo } from '../../src/presenca-automatica/cli/fecho-de-linhas';
import { FilaDeEsperaService } from '../../src/fila-de-espera/fila-de-espera.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(600_000);
exigirBancoLocal();

const E1 = '07600000-0000-4000-8000-0000000e0001';
const E2 = '07600000-0000-4000-8000-0000000e0002';
/** O corte: três dias atrás. Legada = terminou antes; `d` = depois. */
const CORTE = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

const db = new PrismaClient();
/** Outra conexão, para o gesto concorrente da AC-033 (vii). */
const outra = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

let INSTANCIA = '';

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

interface Base {
  empresa: string;
  quadra: string;
  gestor: string;
  uprof: string;
  turma: string;
  outraTurma: string;
}
const bases = new Map<string, Base>();
let hora = 5;
let dia = 0;

async function montarBase(empresa: string): Promise<Base> {
  const b: Base = {
    empresa,
    quadra: randomUUID(),
    gestor: randomUUID(),
    uprof: randomUUID(),
    turma: randomUUID(),
    outraTurma: randomUUID(),
  };
  const prof = randomUUID();
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${empresa}','SPEC-076 ${empresa.slice(-4)}','spec-076-${empresa}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${empresa}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${b.quadra}','${empresa}','Quadra',(SELECT id FROM esportes_de_quadra WHERE company_id='${empresa}' LIMIT 1),80,'ativa')`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${b.gestor}','g-${b.gestor}@teste.local','x','Gestor','company_admin','${empresa}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${b.uprof}','p-${b.uprof}@teste.local','x','Prof','professor','${empresa}',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id,created_at) VALUES ('${prof}','${empresa}','Prof','${b.uprof}',now())`,
  );
  for (const t of [b.turma, b.outraTurma]) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${t}','${empresa}','T ${t.slice(0, 4)}','${b.quadra}','${prof}',20,'ativa')`,
    );
  }
  bases.set(empresa, b);
  return b;
}

async function aluno(b: Base): Promise<{ alunoId: string; usuarioId: string }> {
  const usuarioId = randomUUID();
  const alunoId = randomUUID();
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','a-${usuarioId}@teste.local','h','Aluno','aluno','${b.empresa}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${b.empresa}','aprovado','ativo')`,
  );
  return { alunoId, usuarioId };
}

/** Uma aula de 50 min; a hora gira para não colidir na quadra. */
async function aula(b: Base, turma: string, dias: number): Promise<string> {
  const id = randomUUID();
  hora += 1;
  if (hora > 21) {
    hora = 6;
    dia += 1;
  }
  // Legadas e futuras andam para longe de hoje quando a hora dá a volta.
  const d = dias < 0 ? dias - dia : dias + dia;
  const h = String(hora).padStart(2, '0');
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${b.empresa}','${b.quadra}','${emDias(d)}','${h}:00','${h}:50','TURMA','${turma}','pendente_pagamento',now())`,
  );
  return id;
}

async function falta(b: Base, ocupacao: string, alunoId: string) {
  const id = randomUUID();
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${id}','${b.empresa}','${ocupacao}','${alunoId}',now())`,
  );
  return id;
}

async function filaDeAula(
  b: Base,
  alunoId: string,
  ocupacao: string,
  faltaId: string,
) {
  const id = randomUUID();
  await q(
    `INSERT INTO lista_de_espera (id,company_id,aluno_id,ocupacao_id,falta_id,estado) VALUES ('${id}','${b.empresa}','${alunoId}','${ocupacao}','${faltaId}','aguardando')`,
  );
  return id;
}

/** Um evento de ocupação (só-acréscimo) numa aula que NÃO muda de status. */
async function eventoMovida(b: Base, ocupacao: string): Promise<void> {
  const acao = randomUUID();
  const transicao = randomUUID();
  await db.$transaction([
    db.$executeRawUnsafe(
      `UPDATE ocupacoes_quadra SET transicao_id = '${transicao}' WHERE id = '${ocupacao}'`,
    ),
    db.$executeRawUnsafe(
      `INSERT INTO acoes_administrativas (id, company_id, tipo, autor_id) VALUES ('${acao}','${b.empresa}','turma_horario_editado','${b.gestor}')`,
    ),
    db.$executeRawUnsafe(
      `INSERT INTO eventos_de_ocupacao (id, company_id, acao_id, ocupacao_id, tipo, transicao_id) VALUES (gen_random_uuid(),'${b.empresa}','${acao}','${ocupacao}','movida','${transicao}')`,
    ),
  ]);
}

// ---------------------------------------------------------------------------
// A fotografia de conteúdo (AC-023)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Rodar o script
// ---------------------------------------------------------------------------

interface Rodada {
  codigo: number;
  saida: string[];
  r: ResultadoDaLimpeza;
}

async function rodar(
  args: string[],
  ganchos: GanchosDeTeste = {},
  env: Record<string, string | undefined> = {},
): Promise<Rodada> {
  const saida: string[] = [];
  let r: ResultadoDaLimpeza = { modo: 'contar', plano: '', empresas: [] };
  const codigo = await executarComGanchos(
    ['--', ...args],
    {
      env: {
        MIGRATION_DATABASE_URL: process.env.DATABASE_URL,
        APP_ENVIRONMENT: 'teste',
        ...env,
      },
      conectar: (url) => new PrismaClient({ datasources: { db: { url } } }),
      escrever: (l) => saida.push(l),
    },
    { ...ganchos, resultado: (x) => (r = x) },
  );
  return { codigo, saida, r };
}

const contar = () =>
  rodar(['contar', '--ambiente', 'teste', '--instancia', INSTANCIA]);
const aplicar = (plano: string, ganchos: GanchosDeTeste = {}) =>
  rodar(
    [
      'aplicar',
      '--ambiente',
      'teste',
      '--instancia',
      INSTANCIA,
      '--plano',
      plano,
    ],
    ganchos,
  );

const daEmpresa = (r: ResultadoDaLimpeza, e: string): RelatorioDaEmpresa => {
  const achado = r.empresas.find((x) => x.empresa === e);
  if (!achado) throw new Error(`empresa ${e} não está no relatório`);
  return achado;
};

const existe = async (tabela: string, id: string): Promise<boolean> => {
  const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "${tabela}" WHERE id = $1::uuid`,
    id,
  );
  return n === 1;
};

const ordenado = (xs: string[]) => [...xs].sort();

const dataDe = async (ocupacao: string): Promise<string> => {
  const [{ d }] = await db.$queryRawUnsafe<{ d: string }[]>(
    `SELECT data::text AS d FROM ocupacoes_quadra WHERE id = $1::uuid`,
    ocupacao,
  );
  return d;
};

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

const TABELAS_DE_TESTE = [
  't076_restrita',
  't076_protegida',
  't076_auto',
  't076_ca',
  't076_cb',
  't076_nova',
];

async function limparTudo(): Promise<void> {
  for (const t of TABELAS_DE_TESTE) {
    await q(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await q(`DROP FUNCTION IF EXISTS t076_recusa() CASCADE`);
  await limparEmpresa(db, E1);
  await limparEmpresa(db, E2);
  bases.clear();
}

beforeAll(async () => {
  await limparTudo();
  await ligarPresencaAutomatica(db, CORTE);
  const [c] = await db.$queryRawUnsafe<{ i: string }[]>(
    `SELECT instancia_id::text AS i FROM config_presenca_automatica WHERE id = 1`,
  );
  INSTANCIA = c.i;
});

beforeEach(async () => {
  await limparTudo();
  await ligarPresencaAutomatica(db, CORTE);
  await montarBase(E1);
  await montarBase(E2);
});

afterAll(async () => {
  await limparTudo();
  await redefinirConfigDePresenca(db);
  await db.$disconnect();
  await outra.$disconnect();
});

// ---------------------------------------------------------------------------
// A fixture da AC-023
// ---------------------------------------------------------------------------

interface Fixture023 {
  a: string;
  b: string;
  b2: string;
  b3: string;
  c: string;
  h: string;
  j1: string;
  j2: string;
  d: string;
  e: string;
  f: string;
  g: string;
  f1: string;
  f2: string;
  reposicaoB2: string;
  filaB3: string;
  filaJ: string;
  eventoH: string;
  k0: string;
  avisouK0: string;
}

async function fixture023(): Promise<Fixture023> {
  const b1 = bases.get(E1) as Base;
  const b2base = bases.get(E2) as Base;
  const x = await aluno(b1);
  const y = await aluno(b1);
  const z = await aluno(b1);
  const w = await aluno(b1);

  const a = await aula(b1, b1.turma, -10);
  const b = await aula(b1, b1.turma, -10);
  await falta(b1, b, x.alunoId);

  const b2 = await aula(b1, b1.turma, -10);
  const faltaB2 = await falta(b1, b2, y.alunoId);
  const f1 = await aula(b1, b1.outraTurma, 5);
  const reposicaoB2 = randomUUID();
  await q(
    `INSERT INTO reposicoes_de_aula (id,company_id,aluno_id,falta_id,ocupacao_id) VALUES ('${reposicaoB2}','${E1}','${y.alunoId}','${faltaB2}','${f1}')`,
  );

  const b3 = await aula(b1, b1.turma, -10);
  const faltaB3 = await falta(b1, b3, z.alunoId);
  const f2 = await aula(b1, b1.outraTurma, 6);
  const filaB3 = await filaDeAula(b1, z.alunoId, f2, faltaB3);

  const c = await aula(b1, b1.turma, -10);
  await q(
    `INSERT INTO avaliacoes_de_aula (id,company_id,ocupacao_id,aluno_id,nota,updated_at) VALUES (gen_random_uuid(),'${E1}','${c}','${x.alunoId}',5,now())`,
  );

  const h = await aula(b1, b1.turma, -10);
  await eventoMovida(b1, h);
  const [{ id: eventoH }] = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id::text AS id FROM eventos_de_ocupacao WHERE ocupacao_id = $1::uuid`,
    h,
  );

  // (j) a fila espera em j2 e gasta o crédito da falta de j1.
  const j1 = await aula(b1, b1.turma, -10);
  const j2 = await aula(b1, b1.turma, -10);
  const faltaJ = await falta(b1, j1, w.alunoId);
  const filaJ = await filaDeAula(b1, w.alunoId, j2, faltaJ);

  // (d) pós-corte sem cabeçalho: ontem.
  const d = await aula(b1, b1.turma, -1);
  // (e) legada COM cabeçalho.
  const e = await aula(b1, b1.turma, -10);
  await q(
    `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude)
     VALUES ('${e}','TURMA','${E1}','${b1.gestor}',now(),'nao_houve')`,
  );
  // (f) legada cancelada.
  const f = await aula(b1, b1.turma, -10);
  await cancelarOcupacaoNaFixture(db, {
    companyId: E1,
    ocupacaoId: f,
    autorId: b1.gestor,
  });
  // (k0) uma chamada AUTOMÁTICA pós-corte com quem avisou `presente` — a
  // D9 a reescreveria. Está aqui para que a fotografia desta AC pegue a D9
  // confirmada antes do ROLLBACK (a sabotagem da N3).
  const k0 = await aula(b1, b1.turma, -1);
  await q(
    `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados,origem,origem_inicial,fechada_automaticamente_em)
     VALUES ('${k0}','TURMA','${E1}',NULL,now(),'completa',1,'automatica','automatica',clock_timestamp())`,
  );
  await falta(b1, k0, x.alunoId);
  await q(
    `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at)
     VALUES (gen_random_uuid(),'${E1}','${k0}','TURMA','${x.alunoId}','presente',NULL,now())`,
  );
  // (g) legada limpa de OUTRA empresa.
  const g = await aula(b2base, b2base.turma, -10);

  return {
    a,
    b,
    b2,
    b3,
    c,
    h,
    j1,
    j2,
    d,
    e,
    f,
    g,
    f1,
    f2,
    reposicaoB2,
    filaB3,
    filaJ,
    eventoH,
    k0,
    avisouK0: x.alunoId,
  };
}

// ===========================================================================
describe('AC-023 — contar: o plano inteiro, e nenhuma linha muda', () => {
  it('alvo, apagáveis, mantida, fora do alvo, a fila de (j) uma vez — e a fotografia igual', async () => {
    const fx = await fixture023();
    const antes = await fotografia();

    const { codigo, saida, r } = await contar();

    // Primeiro a fotografia: é ela, e não a contagem, que pega a D9 confirmada
    // antes do ROLLBACK (a sabotagem da N3).
    expect(await fotografia()).toEqual(antes);
    expect(codigo).toBe(0);
    const e1 = daEmpresa(r, E1);
    expect(ordenado(e1.alvo)).toEqual(
      ordenado([fx.a, fx.b, fx.b2, fx.b3, fx.c, fx.h, fx.j1, fx.j2]),
    );
    expect(ordenado(e1.apagadas)).toEqual(
      ordenado([fx.a, fx.b, fx.b2, fx.b3, fx.c, fx.j1, fx.j2]),
    );
    expect(e1.mantidas).toEqual([
      expect.objectContaining({
        aula: fx.h,
        tabela: 'eventos_de_ocupacao',
        sqlstate: '23514',
      }),
    ]);
    expect(e1.mantidas[0].mensagem.length).toBeGreaterThan(0);
    expect(
      e1.foraDoAlvo.map((x) => `${x.tabela}|${x.aula}|${x.data}`).sort(),
    ).toEqual([
      `lista_de_espera|${fx.f2}|${await dataDe(fx.f2)}`,
      `reposicoes_de_aula|${fx.f1}|${await dataDe(fx.f1)}`,
    ]);
    // Duas filas no fecho — a de (b3) e a de (j) —, e a de (j) conta UMA vez
    // embora as duas aulas (j1 e j2) a alcancem.
    expect(e1.porTabela.lista_de_espera).toBe(2);
    expect(e1.porTabela.faltas_avisadas).toBe(4);
    expect(e1.porTabela.ocupacoes_quadra).toBe(7);
    expect(e1.d9).toEqual([`${fx.k0}:${fx.avisouK0}`]);
    expect(daEmpresa(r, E2).alvo).toEqual([fx.g]);
    expect(saida).toContain('CONTAR: nada foi gravado.');
    expect(r.plano).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('A3 da validação — o efeito que cai numa aula do alvo que o banco MANTÉM', () => {
  it('a reposição que gasta a falta de uma aula apagada, marcada numa legada mantida, aparece fora do alvo', async () => {
    // A fixture que a validação independente montou e a suíte não tinha: o
    // relatório comparava com o ALVO, e a aula de destino estava no alvo —
    // só que o banco a manteve (evento só-acréscimo). Foi o caso real de
    // produção: duas reposições assim, que só uma leitura à parte mostrou.
    const b1 = bases.get(E1) as Base;
    const q1 = await aluno(b1);
    const apagavel = await aula(b1, b1.turma, -10);
    const faltaId = await falta(b1, apagavel, q1.alunoId);
    const mantida = await aula(b1, b1.outraTurma, -10);
    await eventoMovida(b1, mantida);
    const reposicao = randomUUID();
    await q(
      `INSERT INTO reposicoes_de_aula (id,company_id,aluno_id,falta_id,ocupacao_id) VALUES ('${reposicao}','${E1}','${q1.alunoId}','${faltaId}','${mantida}')`,
    );

    const { codigo, r } = await contar();

    expect(codigo).toBe(0);
    const e1 = daEmpresa(r, E1);
    expect(e1.apagadas).toContain(apagavel);
    expect(e1.mantidas.map((m) => m.aula)).toEqual([mantida]);
    expect(e1.foraDoAlvo).toEqual([
      expect.objectContaining({
        tabela: 'reposicoes_de_aula',
        aula: mantida,
        data: await dataDe(mantida),
      }),
    ]);
  });
});

describe('AC-024 — aplicar: some o apagável, fica o protegido, e a segunda apaga zero', () => {
  it('apaga, mantém h inteira, não toca d/e/f, e a aula futura perde o visitante', async () => {
    const fx = await fixture023();
    const { r: contado } = await contar();

    const { codigo, r } = await aplicar(contado.plano);

    expect(codigo).toBe(0);
    expect(daEmpresa(r, E1).situacao).toBe('gravada');
    for (const id of [fx.a, fx.b, fx.b2, fx.b3, fx.c, fx.j1, fx.j2, fx.g]) {
      expect(await existe('ocupacoes_quadra', id)).toBe(false);
    }
    expect(await existe('ocupacoes_quadra', fx.h)).toBe(true);
    expect(await existe('eventos_de_ocupacao', fx.eventoH)).toBe(true);
    for (const id of [fx.d, fx.e, fx.f, fx.f1, fx.f2]) {
      expect(await existe('ocupacoes_quadra', id)).toBe(true);
    }
    expect(await existe('reposicoes_de_aula', fx.reposicaoB2)).toBe(false);
    expect(await existe('lista_de_espera', fx.filaB3)).toBe(false);
    expect(await existe('lista_de_espera', fx.filaJ)).toBe(false);

    const segundo = await contar();
    const denovo = await aplicar(segundo.r.plano);
    expect(denovo.codigo).toBe(0);
    const e1 = daEmpresa(denovo.r, E1);
    expect(e1.apagadas).toEqual([]);
    expect(e1.mantidas.map((m) => m.aula)).toEqual([fx.h]);
  });
});

// ===========================================================================
describe('AC-025 — o observador é o catálogo e o erro do banco', () => {
  it('(i) tabela nova com FK RESTRICT para a aula: a linha vai junto', async () => {
    const b1 = bases.get(E1) as Base;
    const a = await aula(b1, b1.turma, -10);
    await q(
      `CREATE TABLE t076_restrita (id uuid PRIMARY KEY, ocupacao_id uuid NOT NULL REFERENCES ocupacoes_quadra(id) ON DELETE RESTRICT)`,
    );
    const linha = randomUUID();
    await q(`INSERT INTO t076_restrita VALUES ('${linha}','${a}')`);

    const { r: contado } = await contar();
    const { codigo, r } = await aplicar(contado.plano);

    expect(codigo).toBe(0);
    expect(daEmpresa(r, E1).porTabela.t076_restrita).toBe(1);
    expect(await existe('t076_restrita', linha)).toBe(false);
    expect(await existe('ocupacoes_quadra', a)).toBe(false);
  });

  it('(ii) a aula cujo fecho o banco recusa fica inteira, e as outras somem mesmo assim', async () => {
    const b1 = bases.get(E1) as Base;
    const x = await aluno(b1);
    const a = await aula(b1, b1.turma, -10);
    const b = await aula(b1, b1.turma, -10);
    await falta(b1, b, x.alunoId);
    const c = await aula(b1, b1.turma, -10);
    await q(
      `INSERT INTO avaliacoes_de_aula (id,company_id,ocupacao_id,aluno_id,nota,updated_at) VALUES (gen_random_uuid(),'${E1}','${c}','${x.alunoId}',5,now())`,
    );
    const a2 = await aula(b1, b1.turma, -10);
    await q(
      `CREATE TABLE t076_protegida (id uuid PRIMARY KEY, ocupacao_id uuid NOT NULL REFERENCES ocupacoes_quadra(id))`,
    );
    await q(
      `CREATE FUNCTION t076_recusa() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 't076: esta linha não se apaga'; END $$`,
    );
    await q(
      `CREATE TRIGGER t076_recusa BEFORE DELETE ON t076_protegida FOR EACH ROW EXECUTE FUNCTION t076_recusa()`,
    );
    const protegida = randomUUID();
    await q(`INSERT INTO t076_protegida VALUES ('${protegida}','${a2}')`);

    const { r: contado } = await contar();
    const { codigo, r } = await aplicar(contado.plano);

    expect(codigo).toBe(0);
    const e1 = daEmpresa(r, E1);
    expect(e1.mantidas).toEqual([
      expect.objectContaining({ aula: a2, tabela: 't076_protegida' }),
    ]);
    expect(e1.mantidas[0].mensagem).toContain('t076: esta linha não se apaga');
    expect(await existe('ocupacoes_quadra', a2)).toBe(true);
    expect(await existe('t076_protegida', protegida)).toBe(true);
    for (const id of [a, b, c]) {
      expect(await existe('ocupacoes_quadra', id)).toBe(false);
    }
  });

  it('(iii) ciclo ESTRUTURAL (autorreferência só-AVULSO) não aborta', async () => {
    const b1 = bases.get(E1) as Base;
    const a = await aula(b1, b1.turma, -10);
    await q(
      `CREATE TABLE t076_auto (
         id uuid PRIMARY KEY,
         ocupacao_id uuid NOT NULL,
         origem_tipo origem_tipo NOT NULL DEFAULT 'AVULSO' CHECK (origem_tipo = 'AVULSO'),
         pai_id uuid REFERENCES t076_auto(id),
         FOREIGN KEY (ocupacao_id, origem_tipo) REFERENCES ocupacoes_quadra(id, origem_tipo))`,
    );

    const contado = await contar();
    expect(contado.codigo).toBe(0);
    const { codigo, r } = await aplicar(contado.r.plano);

    expect(codigo).toBe(0);
    expect(daEmpresa(r, E1).situacao).toBe('gravada');
    expect(await existe('ocupacoes_quadra', a)).toBe(false);
  });

  it('(iv) ciclo de LINHAS aborta a empresa, e nada dela muda', async () => {
    const b1 = bases.get(E1) as Base;
    const a4 = await aula(b1, b1.turma, -10);
    await aula(b1, b1.turma, -10);
    await q(
      `CREATE TABLE t076_ca (id uuid PRIMARY KEY, ocupacao_id uuid NOT NULL REFERENCES ocupacoes_quadra(id), b_id uuid)`,
    );
    await q(
      `CREATE TABLE t076_cb (id uuid PRIMARY KEY, a_id uuid NOT NULL REFERENCES t076_ca(id) DEFERRABLE INITIALLY DEFERRED)`,
    );
    await q(
      `ALTER TABLE t076_ca ADD FOREIGN KEY (b_id) REFERENCES t076_cb(id) DEFERRABLE INITIALLY DEFERRED`,
    );
    const a1 = randomUUID();
    const bb1 = randomUUID();
    await db.$transaction([
      db.$executeRawUnsafe(
        `INSERT INTO t076_ca VALUES ('${a1}','${a4}','${bb1}')`,
      ),
      db.$executeRawUnsafe(`INSERT INTO t076_cb VALUES ('${bb1}','${a1}')`),
    ]);

    const contado = await contar();
    expect(daEmpresa(contado.r, E1).situacao).toBe('ciclo');
    expect(contado.codigo).not.toBe(0);
    const antes = await fotografia();

    const { codigo, r } = await aplicar(contado.r.plano);

    expect(codigo).not.toBe(0);
    expect(daEmpresa(r, E1).situacao).toBe('ciclo');
    expect(await fotografia()).toEqual(antes);
  });

  it('(v) o código do script não mexe em gatilho, papel nem DDL', () => {
    for (const arquivo of ['limpeza-chamada.ts', 'fecho-de-linhas.ts']) {
      const fonte = readFileSync(
        join(__dirname, '../../src/presenca-automatica/cli', arquivo),
        'utf8',
      );
      for (const proibido of [
        'DISABLE TRIGGER',
        'ALTER TABLE',
        'playck.limpeza_append_only',
        'SET ROLE',
      ]) {
        expect(fonte).not.toContain(proibido);
      }
    }
  });
});

// ===========================================================================
describe('AC-026/AC-027 — o script não escreve quando não sabe onde está', () => {
  it('AC-026: ativada_em nulo → sai ≠ 0, com mensagem, sem escrever', async () => {
    const b1 = bases.get(E1) as Base;
    await aula(b1, b1.turma, -10);
    // Sem corte, e com o ambiente declarado — senão a recusa seria a da
    // AC-027, e não esta.
    await redefinirConfigDePresenca(db);
    await declararAmbienteDeTeste(db);
    const antes = await fotografia();

    const { codigo, saida } = await contar();

    expect(codigo).not.toBe(0);
    expect(saida.join('\n')).toMatch(/ativada_em nulo/);
    expect(await fotografia()).toEqual(antes);
  });

  it('AC-027: --instancia ou --ambiente que não conferem → sai ≠ 0 sem escrever', async () => {
    const b1 = bases.get(E1) as Base;
    await aula(b1, b1.turma, -10);
    const antes = await fotografia();

    const instanciaErrada = await rodar([
      'contar',
      '--ambiente',
      'teste',
      '--instancia',
      randomUUID(),
    ]);
    const ambienteErrado = await rodar(
      ['contar', '--ambiente', 'producao', '--instancia', INSTANCIA],
      {},
      { APP_ENVIRONMENT: 'producao' },
    );
    const terminalErrado = await rodar(
      ['contar', '--ambiente', 'teste', '--instancia', INSTANCIA],
      {},
      { APP_ENVIRONMENT: 'producao' },
    );

    for (const x of [instanciaErrada, ambienteErrado, terminalErrado]) {
      expect(x.codigo).not.toBe(0);
    }
    expect(instanciaErrada.saida.join('\n')).toMatch(/não conferem/);
    expect(ambienteErrado.saida.join('\n')).toMatch(/não conferem/);
    expect(terminalErrado.saida.join('\n')).toMatch(/APP_ENVIRONMENT/);
    expect(await fotografia()).toEqual(antes);
  });
});

// ===========================================================================
describe('AC-029 — D9: a automática ganha a falta avisada; a ratificada fica', () => {
  async function fixture029() {
    const b1 = bases.get(E1) as Base;
    const b = await aluno(b1);
    const c = await aluno(b1);
    const outro = await aluno(b1);
    const k = await aula(b1, b1.turma, -1);
    const l = await aula(b1, b1.turma, -1);
    const m = await aula(b1, b1.turma, -1);
    const auto = (oc: string) =>
      q(
        `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados,origem,origem_inicial,fechada_automaticamente_em)
         VALUES ('${oc}','TURMA','${E1}',NULL,now(),'completa',2,'automatica','automatica',clock_timestamp())`,
      );
    const linha = (oc: string, al: string, st: string, autor: string) =>
      `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at)
       VALUES (gen_random_uuid(),'${E1}','${oc}','TURMA','${al}','${st}',${autor},now() - interval '1 hour')`;

    // (k) automática: b avisou e está presente; o outro não avisou.
    await auto(k);
    await falta(b1, k, b.alunoId);
    await q(linha(k, b.alunoId, 'presente', 'NULL'));
    await q(linha(k, outro.alunoId, 'presente', 'NULL'));
    // (l) ratificada: o professor confirmou, com b avisado e presente.
    await falta(b1, l, b.alunoId);
    await comValvula(db, [
      `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados,origem,origem_inicial,fechada_automaticamente_em)
       VALUES ('${l}','TURMA','${E1}','${b1.uprof}',now(),'completa',1,'professor','automatica',clock_timestamp() - interval '1 hour')`,
      linha(l, b.alunoId, 'presente', `'${b1.uprof}'`),
    ]);
    // (m) automática: c avisou e já está ausente.
    await auto(m);
    await falta(b1, m, c.alunoId);
    await q(linha(m, c.alunoId, 'ausente', 'NULL'));
    return { b, c, k, l, m };
  }

  const presencas = (ocs: string[]) =>
    db.$queryRawUnsafe<unknown[]>(
      `SELECT ocupacao_id::text, aluno_id::text, status::text, registrado_por::text, updated_at
         FROM presencas WHERE ocupacao_id::text = ANY($1::text[])
        ORDER BY ocupacao_id, aluno_id`,
      ocs,
    );

  it('contar vê 1 e não toca; o primeiro aplicar reescreve exatamente 1; o segundo, 0', async () => {
    const { b, k, l, m } = await fixture029();
    const antes = await presencas([k, l, m]);

    const contado = await contar();
    const e1c = daEmpresa(contado.r, E1);
    expect(e1c.d9).toEqual([`${k}:${b.alunoId}`]);
    expect(e1c.ratificadasComAviso).toEqual({ chamadas: 1, presencas: 1 });
    expect(await presencas([k, l, m])).toEqual(antes);

    const aplicado = await aplicar(contado.r.plano);
    expect(aplicado.codigo).toBe(0);
    expect(daEmpresa(aplicado.r, E1).d9).toEqual([`${k}:${b.alunoId}`]);
    const [status] = await db.$queryRawUnsafe<
      { s: string; autor: string | null }[]
    >(
      `SELECT status::text AS s, registrado_por::text AS autor FROM presencas WHERE ocupacao_id = $1::uuid AND aluno_id = $2::uuid`,
      k,
      b.alunoId,
    );
    expect(status).toEqual({ s: 'ausente', autor: null });
    const depois = await presencas([l, m]);
    expect(depois).toEqual(
      (antes as { ocupacao_id: string }[]).filter((p) => p.ocupacao_id !== k),
    );

    const segundo = await contar();
    const outraVez = await aplicar(segundo.r.plano);
    expect(daEmpresa(outraVez.r, E1).d9).toEqual([]);
  });
});

// ===========================================================================
describe('AC-031 — a trava que não vem', () => {
  it('a empresa travada desiste por lock_timeout sem mudar nada; a seguinte é processada', async () => {
    const b1 = bases.get(E1) as Base;
    const b2 = bases.get(E2) as Base;
    const legadaE1 = await aula(b1, b1.turma, -10);
    const legadaE2 = await aula(b2, b2.turma, -10);
    const { r: contado } = await contar();

    let soltar!: () => void;
    const solto = new Promise<void>((ok) => (soltar = ok));
    let travou!: () => void;
    const travada = new Promise<void>((ok) => (travou = ok));
    const segurando = outra
      .$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT id FROM turmas WHERE id = '${b1.outraTurma}' FOR UPDATE`,
          );
          travou();
          await solto;
        },
        { timeout: 120_000 },
      )
      .catch(() => undefined);
    await travada;
    let resultado: Rodada;
    try {
      resultado = await aplicar(contado.plano);
    } finally {
      soltar();
      await segurando;
    }

    const e1 = daEmpresa(resultado.r, E1);
    expect(e1.situacao).toBe('desistiu_trava');
    expect(e1.erro).toMatch(/55P03/);
    expect(resultado.saida.join('\n')).toContain(
      `empresa ${E1} — desistiu_trava`,
    );
    expect(await existe('ocupacoes_quadra', legadaE1)).toBe(true);
    expect(daEmpresa(resultado.r, E2).situacao).toBe('gravada');
    expect(await existe('ocupacoes_quadra', legadaE2)).toBe(false);
    expect(resultado.codigo).not.toBe(0);
  });
});

// ===========================================================================
describe('AC-033 — a impressão do plano', () => {
  function servicoDaFila(cliente: PrismaClient): FilaDeEsperaService {
    const p = cliente as unknown as PrismaService;
    const operacao = new ConfigOperacaoService(p);
    return new FilaDeEsperaService(
      p,
      operacao,
      new MatriculaDoAlunoService(p, operacao),
      new ReposicaoService(p, operacao),
    );
  }

  /** Um aluno com crédito de uma falta numa aula LEGADA, e uma aula futura. */
  async function cenarioDaFila() {
    const b1 = bases.get(E1) as Base;
    const s = await aluno(b1);
    const legada = await aula(b1, b1.turma, -10);
    const faltaId = await falta(b1, legada, s.alunoId);
    const futura = await aula(b1, b1.outraTurma, 7);
    return { s, legada, faltaId, futura };
  }

  it('(i) contar duas vezes imprime a mesma impressão; (ii) aplicar com ela apaga', async () => {
    const { legada } = await cenarioDaFila();
    const um = await contar();
    const dois = await contar();
    expect(dois.r.plano).toBe(um.r.plano);
    expect(dois.saida).toContain(`impressão do plano: ${um.r.plano}`);

    const aplicado = await aplicar(um.r.plano);
    expect(aplicado.codigo).toBe(0);
    expect(await existe('ocupacoes_quadra', legada)).toBe(false);
  });

  it('(iii) FK nova depois do contar → aplicar com a impressão velha sai ≠ 0 sem escrever', async () => {
    await cenarioDaFila();
    const { r } = await contar();
    await q(
      `CREATE TABLE t076_nova (id uuid PRIMARY KEY, ocupacao_id uuid REFERENCES ocupacoes_quadra(id) ON DELETE RESTRICT)`,
    );
    const antes = await fotografia();

    const aplicado = await aplicar(r.plano);

    expect(aplicado.codigo).not.toBe(0);
    expect(await fotografia()).toEqual(antes);
  });

  it('(iv) aplicar sem --plano → sai ≠ 0 sem escrever', async () => {
    await cenarioDaFila();
    const antes = await fotografia();
    const semPlano = await rodar([
      'aplicar',
      '--ambiente',
      'teste',
      '--instancia',
      INSTANCIA,
    ]);
    expect(semPlano.codigo).not.toBe(0);
    expect(semPlano.saida.join('\n')).toMatch(/exige --plano/);
    expect(await fotografia()).toEqual(antes);
  });

  it('(v) dado novo com catálogo igual: a fila entra depois do contar → sai ≠ 0 sem escrever', async () => {
    const { s, futura } = await cenarioDaFila();
    const { r } = await contar();
    await servicoDaFila(db).entrarNaAula(E1, s.usuarioId, futura);
    const antes = await fotografia();

    const aplicado = await aplicar(r.plano);

    expect(aplicado.codigo).not.toBe(0);
    expect(aplicado.saida.join('\n')).toMatch(/não é a do --plano/);
    expect(await fotografia()).toEqual(antes);
  });

  it('(vi) a fila entra ENTRE a conferência global e a trava → a empresa não escreve', async () => {
    const { s, futura } = await cenarioDaFila();
    const { r } = await contar();
    let antes: Record<string, string> = {};

    const aplicado = await aplicar(r.plano, {
      depoisDaConferenciaGlobal: async () => {
        await servicoDaFila(db).entrarNaAula(E1, s.usuarioId, futura);
        antes = await fotografia();
      },
    });

    expect(aplicado.codigo).not.toBe(0);
    expect(daEmpresa(aplicado.r, E1).situacao).toBe('divergiu');
    expect(await fotografia()).toEqual(antes);
  });

  it('(vii) a fila tentada DEPOIS da trava das linhas espera, e o banco a recusa', async () => {
    const { s, legada, faltaId, futura } = await cenarioDaFila();
    const { r } = await contar();
    let tentativa: Promise<unknown> = Promise.resolve();
    let esperou = false;

    const aplicado = await aplicar(r.plano, {
      depoisDaTravaDasLinhas: async (empresa) => {
        if (empresa !== E1) return;
        tentativa = servicoDaFila(outra)
          .entrarNaAula(E1, s.usuarioId, futura)
          .then(
            () => 'entrou',
            (e: unknown) => e,
          );
        // O INSERT fica esperando a trava de chave da falta. Sem a trava das
        // linhas ele NÃO espera: registra e segue, para que o resto do caso
        // mostre o que acontece então (a fila entra).
        for (let i = 0; i < 100 && !esperou; i += 1) {
          const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND query ILIKE '%lista_de_espera%'`,
          );
          esperou = n > 0;
          if (!esperou) await new Promise((ok) => setTimeout(ok, 50));
        }
      },
    });

    expect(esperou).toBe(true);
    expect(aplicado.codigo).toBe(0);
    expect(daEmpresa(aplicado.r, E1).apagadas).toEqual([legada]);
    const recusa = await tentativa;
    expect(recusa).not.toBe('entrou');
    expect(String((recusa as Error).message)).toMatch(
      /fila_falta_fkey|Foreign key/i,
    );
    expect(await existe('faltas_avisadas', faltaId)).toBe(false);
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM lista_de_espera WHERE aluno_id = $1::uuid`,
      s.alunoId,
    );
    expect(n).toBe(0);
  });
});
