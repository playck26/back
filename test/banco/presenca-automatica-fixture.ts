/**
 * SPEC-057/TASK-001 — fixture das provas de APLICAÇÃO da presença automática.
 *
 * Uma empresa, dois professores, três turmas e alunos criados sob demanda.
 * Tudo por SQL cru e pela sessão superusuário da suíte (`db`) — a fixture não
 * é o que está em julgamento. **Os serviços, sim, rodam pela conexão do login
 * runtime** (`runtime`): é assim que a prova mostra que nenhum caminho da
 * aplicação precisou de privilégio de owner.
 */
import { PrismaClient } from '@prisma/client';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import {
  CONEXAO_OPERADOR_DE_TESTE,
  CONEXAO_RUNTIME_DE_TESTE,
  urlDaConexaoDeTeste,
} from './config-de-presenca';

export const EMPRESA = '05720000-0000-4000-8000-000000000001';
export const QUADRA = '05720000-0000-4000-8000-000000000002';
export const UPROF = '05720000-0000-4000-8000-000000000011';
export const PROF = '05720000-0000-4000-8000-000000000012';
export const UPROF_VAZIA = '05720000-0000-4000-8000-000000000013';
export const PROF_VAZIA = '05720000-0000-4000-8000-000000000014';
export const UGESTOR = '05720000-0000-4000-8000-000000000015';
/** Ordem importa no teste de pausa: A < B pela chave do worker. */
export const TURMA_A = '05720000-0000-4000-8000-0000000000a1';
export const TURMA_B = '05720000-0000-4000-8000-0000000000b1';
export const TURMA_VAZIA = '05720000-0000-4000-8000-0000000000c1';
export const TURMA_ORIGEM = '05720000-0000-4000-8000-0000000000d1';

export const db = new PrismaClient();
export const runtime = new PrismaClient({
  datasources: { db: { url: urlDaConexaoDeTeste(CONEXAO_RUNTIME_DE_TESTE) } },
});
export const runtime2 = new PrismaClient({
  datasources: { db: { url: urlDaConexaoDeTeste(CONEXAO_RUNTIME_DE_TESTE) } },
});
export const operador = new PrismaClient({
  datasources: { db: { url: urlDaConexaoDeTeste(CONEXAO_OPERADOR_DE_TESTE) } },
});

export const q = (sql: string) => db.$executeRawUnsafe(sql);

/** `YYYY-MM-DD` a N dias de hoje, no fuso do clube. */
export function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export const diasAtras = (dias: number) =>
  new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

let seq = 0;
let hora = 6;
export function reiniciarSequencias(): void {
  seq = 0;
  hora = 6;
}
function proximo(prefixo: string): string {
  seq += 1;
  return `05720000-0000-4000-8000-${prefixo}${String(seq).padStart(11 - prefixo.length + 1, '0')}`;
}

export async function montarEmpresa(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-057 presenca','spec-057-pa-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Quadra',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'ativa')`,
  );
  for (const [u, p, nome] of [
    [UPROF, PROF, 'Prof'],
    [UPROF_VAZIA, PROF_VAZIA, 'Prof Vazia'],
  ]) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${u}','pa-${u}@teste.local','x','${nome}','professor','${EMPRESA}',now())`,
    );
    await q(
      `INSERT INTO professores (id,company_id,nome,usuario_id,created_at) VALUES ('${p}','${EMPRESA}','${nome}','${u}',now())`,
    );
  }
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${UGESTOR}','pa-gestor@teste.local','x','Gestor','company_admin','${EMPRESA}',now())`,
  );
  for (const [t, nome, prof] of [
    [TURMA_A, 'A', PROF],
    [TURMA_B, 'B', PROF],
    [TURMA_VAZIA, 'Vazia', PROF_VAZIA],
    [TURMA_ORIGEM, 'Origem', PROF],
  ]) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${t}','${EMPRESA}','${nome}','${QUADRA}','${prof}',20,'ativa')`,
    );
  }
}

export async function aluno(
  nome: string,
): Promise<{ alunoId: string; usuarioId: string }> {
  const usuarioId = proximo('1');
  const alunoId = proximo('2');
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','pa-${usuarioId}@teste.local','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  return { alunoId, usuarioId };
}

export const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${alunoId}',now())`,
  );

/** Aula de 50 minutos no dia `emDias(dias)`; a hora varia para não colidir na quadra. */
export async function aula(
  turmaId: string,
  dias: number,
  horas?: { inicio: string; fim: string },
): Promise<string> {
  const id = proximo('3');
  hora = hora >= 21 ? 6 : hora + 1;
  const inicio = horas?.inicio ?? `${String(hora).padStart(2, '0')}:00`;
  const fim = horas?.fim ?? `${String(hora).padStart(2, '0')}:50`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${emDias(dias)}','${inicio}','${fim}','TURMA','${turmaId}','pendente_pagamento',now())`,
  );
  return id;
}

/**
 * Um visitante na aula `ocupacaoId`: falta avisada numa aula da TURMA_ORIGEM
 * (onde ele é matriculado) e a reposição, sem passar pelo serviço — que recusa
 * aula passada, e as provas do job precisam de aula passada.
 */
export async function visita(
  alunoId: string,
  ocupacaoId: string,
): Promise<{ faltaId: string; reposicaoId: string }> {
  const perdida = await aula(TURMA_ORIGEM, -2);
  const faltaId = proximo('4');
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${faltaId}','${EMPRESA}','${perdida}','${alunoId}',now())`,
  );
  const reposicaoId = proximo('5');
  await q(
    `INSERT INTO reposicoes_de_aula (id,company_id,aluno_id,falta_id,ocupacao_id) VALUES ('${reposicaoId}','${EMPRESA}','${alunoId}','${faltaId}','${ocupacaoId}')`,
  );
  return { faltaId, reposicaoId };
}

type Status = 'presente' | 'ausente' | 'justificado';

/**
 * Um cabeçalho com linhas, escrito cru.
 *
 * - `automatica`: autor nulo, fechamento automático em `fechadaSql`;
 * - `professor`: autor = UPROF;
 * - `antigo`: INSERT **como o binário antigo escrevia** — sem as colunas novas,
 *   que caem no DEFAULT `legada_humana`.
 */
export async function chamadaCrua(
  ocupacaoId: string,
  tipo: 'automatica' | 'professor' | 'antigo',
  linhas: [string, Status][],
  opcoes: {
    completude?: 'completa' | 'desconhecida';
    fechadaSql?: string;
  } = {},
): Promise<void> {
  const completude = opcoes.completude ?? 'completa';
  const esperados = completude === 'completa' ? String(linhas.length) : 'NULL';
  if (tipo === 'antigo') {
    await q(
      `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados)
       VALUES ('${ocupacaoId}','TURMA','${EMPRESA}','${UPROF}',now(),'${completude}',${esperados})`,
    );
  } else {
    const autor = tipo === 'automatica' ? 'NULL' : `'${UPROF}'`;
    const origem = tipo === 'automatica' ? 'automatica' : 'professor';
    const fechada =
      tipo === 'automatica'
        ? (opcoes.fechadaSql ?? 'clock_timestamp()')
        : 'NULL';
    await q(
      `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados,origem,origem_inicial,fechada_automaticamente_em)
       VALUES ('${ocupacaoId}','TURMA','${EMPRESA}',${autor},now(),'${completude}',${esperados},'${origem}','${origem}',${fechada})`,
    );
  }
  for (const [alunoId, status] of linhas) {
    const autor = tipo === 'automatica' ? 'NULL' : `'${UPROF}'`;
    await q(
      `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}','${ocupacaoId}','TURMA','${alunoId}','${status}',${autor},now())`,
    );
  }
}

export interface CabecalhoLido {
  origem: string;
  origemInicial: string;
  registradaPor: string | null;
  completude: string;
  fechada: Date | null;
}

export async function cabecalhoDe(
  ocupacaoId: string,
): Promise<CabecalhoLido | null> {
  const [linha] = await db.$queryRawUnsafe<CabecalhoLido[]>(
    `SELECT origem, origem_inicial AS "origemInicial", registrada_por::text AS "registradaPor",
            completude::text AS completude, fechada_automaticamente_em AS fechada
       FROM chamadas WHERE ocupacao_id = $1::uuid`,
    ocupacaoId,
  );
  return linha ?? null;
}

export async function linhasDe(
  ocupacaoId: string,
): Promise<{ alunoId: string; status: string; autor: string | null }[]> {
  return db.$queryRawUnsafe(
    `SELECT aluno_id::text AS "alunoId", status::text AS status, registrado_por::text AS autor
       FROM presencas WHERE ocupacao_id = $1::uuid ORDER BY aluno_id`,
    ocupacaoId,
  );
}

/** Código de negócio (`response.code`) ou nome do erro — para `expect`. */
export async function codigoDe(promessa: Promise<unknown>): Promise<string> {
  try {
    await promessa;
    return 'ok';
  } catch (e) {
    const r = (e as { response?: { code?: string } }).response;
    return r?.code ?? (e as Error).constructor.name;
  }
}

/** Resposta inteira da exceção, para conferir campos além do código. */
export async function respostaDe(
  promessa: Promise<unknown>,
): Promise<Record<string, unknown> | 'ok'> {
  try {
    await promessa;
    return 'ok';
  } catch (e) {
    return (e as { response?: Record<string, unknown> }).response ?? {};
  }
}

/**
 * Segura `turmas FOR UPDATE` numa transação da sessão da suíte até `soltar()`.
 * Serve para deixar o worker, o `PUT` ou o `desmarcar` parados na raiz.
 */
export async function segurarTurma(
  turmaId: string,
): Promise<{ soltar: () => void; fim: Promise<void> }> {
  let soltar!: () => void;
  const solto = new Promise<void>((r) => (soltar = r));
  let travou!: () => void;
  const travada = new Promise<void>((r) => (travou = r));
  const fim = db.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM turmas WHERE id = '${turmaId}' FOR UPDATE`,
      );
      travou();
      await solto;
    },
    { timeout: 120_000 },
  );
  await travada;
  const trava = { soltar, fim: fim.catch(() => undefined) };
  travasAbertas.add(trava);
  return trava;
}

/**
 * Travas que um teste abriu. Uma asserção que falha entre `segurarTurma` e
 * `soltar()` deixaria a transação aberta, e o `afterEach` seguinte esperaria o
 * lock para sempre — foi o que a sabotagem do `desmarcar` mostrou. O
 * `afterEach` da suíte chama isto.
 */
const travasAbertas = new Set<{ soltar: () => void; fim: Promise<unknown> }>();
export async function soltarTodasAsTravas(): Promise<void> {
  for (const trava of travasAbertas) {
    trava.soltar();
    await trava.fim;
  }
  travasAbertas.clear();
}

/** Espera até alguma conexão de `login` estar parada esperando lock. */
export async function esperarBloqueio(login: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const [linha] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE usename = $1 AND wait_event_type = 'Lock'`,
      login,
    );
    if (Number(linha.n) > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`nenhuma conexão de ${login} ficou esperando lock`);
}

export async function desconectarTodos(): Promise<void> {
  await Promise.all([
    db.$disconnect(),
    runtime.$disconnect(),
    runtime2.$disconnect(),
    operador.$disconnect(),
  ]);
}
