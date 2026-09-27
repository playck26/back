import { Prisma, PrismaClient } from '@prisma/client';
import { FUSO_DO_CLUBE } from '../../courts/date-time.util';
import {
  CicloDeLinhas,
  type Catalogo,
  type ClienteDoFecho,
  type Fecho,
  SemChavePrimaria,
  TABELA_RAIZ,
  calcularFecho,
  camadasDeApagar,
  exprDaChave,
  ident,
  lerCatalogo,
  porTabela,
  sha256,
  textoDoCatalogo,
} from './fecho-de-linhas';
import { sqlstateDe } from './presenca-auto';

/**
 * SPEC-076/D8 e D9 — **a limpeza das aulas legadas e a correção das chamadas
 * automáticas do período**, num script de operador, fora das rotas.
 *
 *     pnpm limpeza-chamada -- contar  --ambiente <nome> --instancia <uuid>
 *     pnpm limpeza-chamada -- aplicar --ambiente <nome> --instancia <uuid> --plano <impressão>
 *
 * **O que faz, por empresa, numa transação só:** primeiro a D9 (presença
 * `presente` de quem avisou falta, em chamada ainda automática, vira
 * `ausente`), depois a D8 (cada aula legada sem cabeçalho some com o fecho de
 * linhas dela, sob um `SAVEPOINT` próprio).
 *
 * **`contar` executa e desfaz** (LIM-076i): o número é o do banco, e não uma
 * estimativa. Termina cada empresa em `ROLLBACK` e imprime a **impressão do
 * plano** — o `sha256` do que vai ser escrito.
 *
 * **`aplicar` só roda com a impressão que o Israel viu**, e a confere duas
 * vezes: antes de qualquer escrita (a global), e em cada empresa depois de
 * travar as turmas e as LINHAS do fecho (a parte daquela empresa). Divergiu,
 * para sem escrever aquela empresa (AC-033).
 *
 * **O que o banco protege, fica** (decisão 8): erro de gatilho só-acréscimo
 * ou de FK no fecho de uma aula volta ao savepoint e a aula fica inteira. O
 * script não mexe em gatilho, não troca de papel e não emite DDL (AC-025 v).
 *
 * **Credencial:** só `MIGRATION_DATABASE_URL` (a do owner). Ausente, sai com
 * 1 antes de conectar. Não imprime URL, host nem usuário.
 */

export const VARIAVEL_DA_CREDENCIAL = 'MIGRATION_DATABASE_URL';

/** Cada empresa é uma transação com estes limites (D8). */
export const LOCK_TIMEOUT = '5s';
export const STATEMENT_TIMEOUT = '120s';

/**
 * O erro de instrução do fecho que NÃO mantém a aula: a trava que não veio e
 * o tempo esgotado desfazem a empresa inteira (matriz de falha da spec).
 * Qualquer outro erro de um `DELETE` do fecho — `23514` de gatilho
 * só-acréscimo, `23001`/`23503` de FK, o `RAISE` de um gatilho que ninguém
 * previu — volta ao savepoint e a aula fica inteira (decisão 8, AC-025 ii).
 */
const SQLSTATES_DA_EMPRESA = new Set(['55P03', '40P01', '57014']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPRESSAO = /^[0-9a-f]{64}$/;

export type Modo = 'contar' | 'aplicar';

export interface AulaMantida {
  aula: string;
  tabela: string;
  sqlstate: string;
  mensagem: string;
}

export interface EfeitoForaDoAlvo {
  tabela: string;
  chave: string;
  aula: string;
  data: string;
}

export type Situacao =
  | 'contada'
  | 'gravada'
  | 'desistiu_trava'
  | 'desistiu_deadlock'
  | 'divergiu'
  | 'ciclo'
  | 'erro';

export interface RelatorioDaEmpresa {
  empresa: string;
  parte: string;
  situacao: Situacao;
  alvo: string[];
  apagadas: string[];
  mantidas: AulaMantida[];
  /** Pelo `RETURNING` de cada `DELETE`: linha apagada uma vez conta uma vez. */
  porTabela: Record<string, number>;
  foraDoAlvo: EfeitoForaDoAlvo[];
  /** `ocupacao_id:aluno_id` de cada presença que a D9 reescreveu. */
  d9: string[];
  ratificadasComAviso: { chamadas: number; presencas: number };
  erro?: string;
}

export interface ResultadoDaLimpeza {
  modo: Modo;
  plano: string;
  empresas: RelatorioDaEmpresa[];
}

/** O mínimo de cliente que o script usa — um `PrismaClient` serve. */
export type ClienteDaLimpeza = Pick<
  PrismaClient,
  '$queryRawUnsafe' | '$transaction' | '$disconnect'
>;

type Tx = Prisma.TransactionClient;

export interface AmbienteDaLimpeza {
  env: Record<string, string | undefined>;
  conectar: (url: string) => ClienteDaLimpeza;
  escrever: (linha: string) => void;
}

/**
 * SPEC-076/R12 — **os ganchos existem só para o db-spec.** Nenhum argumento
 * de linha de comando, variável de ambiente ou rota os liga; o ponto de
 * entrada de produção chama `executarCli`, que não os recebe.
 */
export interface GanchosDeTeste {
  depoisDaConferenciaGlobal?: () => Promise<void>;
  depoisDaTravaDasLinhas?: (empresa: string) => Promise<void>;
  resultado?: (r: ResultadoDaLimpeza) => void;
}

interface Pedido {
  modo: Modo;
  ambiente: string;
  instancia: string;
  plano?: string;
}

interface Config {
  ambiente: string | null;
  instancia: string;
  corte: Date | null;
}

/** Devolve o exit code; nunca lança. */
export function executarCli(
  argv: readonly string[],
  ambiente: AmbienteDaLimpeza,
): Promise<number> {
  return executarComGanchos(argv, ambiente, {});
}

/** O mesmo `executarCli`, com os ganchos do db-spec (R12). */
export async function executarComGanchos(
  argv: readonly string[],
  ambiente: AmbienteDaLimpeza,
  ganchos: GanchosDeTeste,
): Promise<number> {
  const { escrever, env } = ambiente;
  const pedido = lerPedido(argv, env, escrever);
  if (!pedido) return 1;

  const url = env[VARIAVEL_DA_CREDENCIAL];
  if (!url) {
    escrever(`erro: ${VARIAVEL_DA_CREDENCIAL} ausente; nada foi conectado.`);
    return 1;
  }

  let cliente: ClienteDaLimpeza | null = null;
  try {
    cliente = ambiente.conectar(url);
    const config = await lerConfig(cliente);
    if (!config) {
      escrever('erro: config_presenca_automatica sem linha; nada foi gravado.');
      return 1;
    }
    if (
      config.instancia !== pedido.instancia.toLowerCase() ||
      config.ambiente !== pedido.ambiente
    ) {
      escrever(
        'erro: --ambiente/--instancia não conferem com o banco; nada foi gravado.',
      );
      return 1;
    }
    if (!config.corte) {
      escrever(
        'erro: a presença automática nunca foi ativada (ativada_em nulo): sem corte, não há aula legada a decidir; nada foi gravado.',
      );
      return 1;
    }
    return await limpar(cliente, pedido, config.corte, escrever, ganchos);
  } catch (causa) {
    escrever(`erro: ${descrever(causa)}; a empresa corrente foi desfeita.`);
    return 1;
  } finally {
    if (cliente) await cliente.$disconnect().catch(() => undefined);
  }
}

function lerPedido(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  escrever: (linha: string) => void,
): Pedido | null {
  const args = argv.filter((a) => a !== '--');
  const modo = args[0];
  if (modo !== 'contar' && modo !== 'aplicar') {
    escrever(
      'uso: limpeza-chamada -- contar|aplicar --ambiente <nome> --instancia <uuid> [--plano <impressão>]',
    );
    return null;
  }
  const ambiente = valorDe(args, '--ambiente') ?? '';
  const instancia = valorDe(args, '--instancia') ?? '';
  if (!ambiente || !instancia) {
    escrever(
      'erro: --ambiente e --instancia são obrigatórios; nada foi conectado.',
    );
    return null;
  }
  if (!UUID.test(instancia)) {
    escrever('erro: --instancia não é um UUID; nada foi conectado.');
    return null;
  }
  if (env.APP_ENVIRONMENT !== ambiente) {
    escrever(
      'erro: --ambiente diverge de APP_ENVIRONMENT deste terminal; nada foi conectado.',
    );
    return null;
  }
  const plano = valorDe(args, '--plano');
  if (modo === 'aplicar' && (!plano || !IMPRESSAO.test(plano))) {
    escrever(
      'erro: aplicar exige --plano <impressão do contar>; nada foi conectado.',
    );
    return null;
  }
  return { modo, ambiente, instancia, plano };
}

async function lerConfig(cliente: ClienteDaLimpeza): Promise<Config | null> {
  const linhas = await cliente.$queryRawUnsafe<Config[]>(
    `SELECT ambiente, instancia_id::text AS instancia, ativada_em AS corte
       FROM public.config_presenca_automatica WHERE id = 1`,
  );
  return linhas[0] ?? null;
}

// ---------------------------------------------------------------------------
// O que é lido: alvo, D9 e a parte de cada empresa na impressão
// ---------------------------------------------------------------------------

/** Aula `TURMA`, não cancelada, sem cabeçalho, terminada em ou antes do corte. */
const ALVO = `
  FROM ocupacoes_quadra o
 WHERE o.origem_tipo = 'TURMA'
   AND o.status_pagamento <> 'cancelado'
   AND NOT EXISTS (SELECT 1 FROM chamadas c WHERE c.ocupacao_id = o.id)
   AND ((o.data + o.hora_fim) AT TIME ZONE '${FUSO_DO_CLUBE}') <= $1::timestamptz`;

/** A D9, como a spec a escreve — só chamada AINDA automática (decisão 12). */
const D9_ONDE = `
  FROM chamadas c
 WHERE c.ocupacao_id = p.ocupacao_id
   AND c.company_id = $1::uuid
   AND c.origem = 'automatica'
   AND p.status = 'presente'
   AND p.registrado_por IS NULL
   AND EXISTS (SELECT 1 FROM faltas_avisadas f
                WHERE f.ocupacao_id = p.ocupacao_id AND f.aluno_id = p.aluno_id)`;

async function empresasComTrabalho(
  db: ClienteDoFecho,
  corte: Date,
): Promise<string[]> {
  const linhas = await db.$queryRawUnsafe<{ empresa: string }[]>(
    `SELECT DISTINCT o.company_id::text AS empresa ${ALVO}
     UNION
     SELECT DISTINCT c.company_id::text
       FROM presencas p JOIN chamadas c ON c.ocupacao_id = p.ocupacao_id
      WHERE c.origem IN ('automatica', 'professor')
        AND c.origem_inicial = 'automatica'
        AND p.status = 'presente'
        AND EXISTS (SELECT 1 FROM faltas_avisadas f
                     WHERE f.ocupacao_id = p.ocupacao_id AND f.aluno_id = p.aluno_id)
     ORDER BY 1`,
    corte.toISOString(),
  );
  return linhas.map((l) => l.empresa);
}

async function alvoDaEmpresa(
  db: ClienteDoFecho,
  corte: Date,
  empresa: string,
): Promise<string[]> {
  const linhas = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT o.id::text AS id ${ALVO} AND o.company_id = $2::uuid ORDER BY o.id`,
    corte.toISOString(),
    empresa,
  );
  return linhas.map((l) => l.id);
}

async function presencasDaD9(
  db: ClienteDoFecho,
  empresa: string,
): Promise<string[]> {
  const linhas = await db.$queryRawUnsafe<{ par: string }[]>(
    `SELECT p.ocupacao_id::text || ':' || p.aluno_id::text AS par
       FROM presencas p
      WHERE EXISTS (SELECT 1 ${D9_ONDE})
      ORDER BY 1`,
    empresa,
  );
  return linhas.map((l) => l.par);
}

interface Leitura {
  alvo: string[];
  nos: string[];
  d9: string[];
  parte: string;
}

/**
 * A parte de uma empresa na impressão do plano: as raízes, **cada linha do
 * fecho** e cada presença que a D9 reescreveria, tudo ordenado — o que vai
 * ser escrito, e não só o schema (a N4 da 4ª rodada).
 */
async function lerEmpresa(
  db: ClienteDoFecho,
  catalogo: Catalogo,
  corte: Date,
  empresa: string,
): Promise<Leitura> {
  const alvo = await alvoDaEmpresa(db, corte, empresa);
  const fecho = await calcularFecho(db, catalogo, alvo);
  const nos = [...fecho.linhas.keys()].sort();
  const d9 = await presencasDaD9(db, empresa);
  const parte = sha256(
    ['raizes', ...alvo, 'fecho', ...nos, 'd9', ...d9].join('\n'),
  );
  return { alvo, nos, d9, parte };
}

function impressaoGlobal(
  partes: readonly { empresa: string; parte: string }[],
  catalogo: Catalogo,
  pedido: Pedido,
): string {
  return sha256(
    [
      'empresas',
      ...partes.map((p) => `${p.empresa}=${p.parte}`),
      'catalogo',
      textoDoCatalogo(catalogo),
      `ambiente=${pedido.ambiente}`,
      `instancia=${pedido.instancia.toLowerCase()}`,
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// O que é escrito: D9 e D8
// ---------------------------------------------------------------------------

async function aplicarD9(tx: Tx, empresa: string): Promise<string[]> {
  const linhas = await tx.$queryRawUnsafe<{ par: string }[]>(
    `UPDATE presencas p
        SET status = 'ausente', updated_at = timezone('UTC', clock_timestamp())
      ${D9_ONDE}
      RETURNING p.ocupacao_id::text || ':' || p.aluno_id::text AS par`,
    empresa,
  );
  return linhas.map((l) => l.par).sort();
}

async function ratificadasComAviso(
  tx: Tx,
  empresa: string,
): Promise<{ chamadas: number; presencas: number }> {
  const [linha] = await tx.$queryRawUnsafe<
    { chamadas: number; presencas: number }[]
  >(
    `SELECT count(DISTINCT p.ocupacao_id)::int AS chamadas, count(*)::int AS presencas
       FROM presencas p JOIN chamadas c ON c.ocupacao_id = p.ocupacao_id
      WHERE c.company_id = $1::uuid
        AND c.origem = 'professor' AND c.origem_inicial = 'automatica'
        AND p.status = 'presente'
        AND EXISTS (SELECT 1 FROM faltas_avisadas f
                     WHERE f.ocupacao_id = p.ocupacao_id AND f.aluno_id = p.aluno_id)`,
    empresa,
  );
  return linha;
}

class FalhaNaInstrucao extends Error {
  constructor(
    readonly tabela: string,
    readonly causa: unknown,
  ) {
    super(`falha ao apagar de ${tabela}`);
  }
}

/**
 * A D8 de UMA aula, sob um savepoint, com o fecho recalculado do estado
 * atual — o que outra aula desta execução já apagou não aparece de novo, e
 * por isso cada linha conta uma vez (caso j da AC-023).
 */
async function apagarAula(
  tx: Tx,
  catalogo: Catalogo,
  aula: string,
  relatorio: RelatorioDaEmpresa,
): Promise<void> {
  await tx.$executeRawUnsafe('SAVEPOINT limpeza_aula');
  try {
    const fecho = await calcularFecho(tx, catalogo, [aula]);
    const camadas = camadasDeApagar(fecho);
    const efeitos = await efeitosForaDoAlvo(tx, catalogo, fecho.linhas, aula);
    const contagem: Record<string, number> = {};
    for (const camada of camadas) {
      for (const [tabela, chaves] of porTabela(camada)) {
        const colunas = catalogo.chaves.get(tabela) as string[];
        let apagadas: { chave: string }[];
        try {
          apagadas = await tx.$queryRawUnsafe<{ chave: string }[]>(
            `DELETE FROM ${ident(tabela)} x
              WHERE ${exprDaChave('x', colunas)} = ANY($1::text[])
              RETURNING ${exprDaChave('x', colunas)} AS chave`,
            chaves,
          );
        } catch (causa) {
          throw new FalhaNaInstrucao(tabela, causa);
        }
        contagem[tabela] = (contagem[tabela] ?? 0) + apagadas.length;
      }
    }
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT limpeza_aula');
    relatorio.apagadas.push(aula);
    for (const [tabela, n] of Object.entries(contagem)) {
      relatorio.porTabela[tabela] = (relatorio.porTabela[tabela] ?? 0) + n;
    }
    relatorio.foraDoAlvo.push(...efeitos);
  } catch (causa) {
    const sqlstate =
      causa instanceof FalhaNaInstrucao ? sqlstateDe(causa.causa) : null;
    if (
      !(causa instanceof FalhaNaInstrucao) ||
      !sqlstate ||
      SQLSTATES_DA_EMPRESA.has(sqlstate)
    ) {
      // Ciclo, trava que não veio, timeout: não é "o banco protege esta
      // aula" — desfaz a empresa inteira, por quem chamou.
      throw causa;
    }
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT limpeza_aula');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT limpeza_aula');
    relatorio.mantidas.push({
      aula,
      tabela: causa.tabela,
      sqlstate,
      mensagem: mensagemDoBanco(causa.causa),
    });
  }
}

/**
 * Linhas do fecho que pertencem a OUTRA aula — a reposição marcada numa aula
 * futura, a fila de uma aula futura (LIM-076g). Listadas com a data.
 *
 * **Compara com a aula que está sendo apagada, e não com o alvo inteiro**
 * (achado A3 da validação independente da implementação). Comparar com o
 * alvo escondia a linha que aponta para uma aula do alvo que o banco acabou
 * MANTENDO — a reposição marcada numa legada protegida por
 * `eventos_de_ocupacao`. Quem descarta o efeito que cai numa aula também
 * apagada é `escreverEmpresa`, no fim, quando já se sabe quais foram.
 */
async function efeitosForaDoAlvo(
  tx: Tx,
  catalogo: Catalogo,
  linhas: Fecho['linhas'],
  aula: string,
): Promise<EfeitoForaDoAlvo[]> {
  const porTab = new Map<string, string[]>();
  for (const l of linhas.values()) {
    if (l.tabela === TABELA_RAIZ) continue;
    porTab.set(l.tabela, [...(porTab.get(l.tabela) ?? []), l.chave]);
  }
  const achados = new Map<string, EfeitoForaDoAlvo>();
  for (const [tabela, chaves] of [...porTab].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const colunas = catalogo.chaves.get(tabela) as string[];
    for (const fk of catalogo.fks) {
      if (fk.filha !== tabela || fk.pai !== TABELA_RAIZ) continue;
      const juncao = fk.colunasFilha
        .map((c, i) => `f.${ident(c)} = o.${ident(fk.colunasPai[i])}`)
        .join(' AND ');
      const fora = await tx.$queryRawUnsafe<
        { chave: string; aula: string; data: string }[]
      >(
        `SELECT ${exprDaChave('f', colunas)} AS chave, o.id::text AS aula, o.data::text AS data
           FROM ${ident(tabela)} f JOIN ${ident(TABELA_RAIZ)} o ON ${juncao}
          WHERE ${exprDaChave('f', colunas)} = ANY($1::text[])
            AND o.id::text <> $2`,
        chaves,
        aula,
      );
      for (const e of fora) {
        achados.set(`${tabela}:${e.chave}:${e.aula}`, { tabela, ...e });
      }
    }
  }
  return [...achados.values()];
}

// ---------------------------------------------------------------------------
// contar e aplicar
// ---------------------------------------------------------------------------

/** Sinal para terminar a transação do `contar` em ROLLBACK. */
class Desfazer extends Error {}

class Divergiu extends Error {}

const OPCOES_DA_TRANSACAO = { maxWait: 30_000, timeout: 60 * 60_000 };

async function limitar(tx: Tx): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
  await tx.$executeRawUnsafe(
    `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`,
  );
}

function relatorioVazio(empresa: string, parte: string): RelatorioDaEmpresa {
  return {
    empresa,
    parte,
    situacao: 'contada',
    alvo: [],
    apagadas: [],
    mantidas: [],
    porTabela: {},
    foraDoAlvo: [],
    d9: [],
    ratificadasComAviso: { chamadas: 0, presencas: 0 },
  };
}

/** D9 e depois D8, na transação da empresa. */
async function escreverEmpresa(
  tx: Tx,
  catalogo: Catalogo,
  alvo: readonly string[],
  relatorio: RelatorioDaEmpresa,
  escrever: (linha: string) => void,
): Promise<void> {
  relatorio.alvo = [...alvo];
  relatorio.ratificadasComAviso = await ratificadasComAviso(
    tx,
    relatorio.empresa,
  );
  relatorio.d9 = await aplicarD9(tx, relatorio.empresa);
  for (const aula of alvo) {
    escrever(`  empresa ${relatorio.empresa}, aula ${aula}`);
    await apagarAula(tx, catalogo, aula, relatorio);
  }
  // Só agora se sabe quais aulas o banco deixou apagar: o efeito que cai numa
  // delas não é "fora do alvo"; o que cai numa MANTIDA é, e fica listado.
  const apagadas = new Set(relatorio.apagadas);
  relatorio.foraDoAlvo = relatorio.foraDoAlvo.filter(
    (e) => !apagadas.has(e.aula),
  );
}

async function limpar(
  cliente: ClienteDaLimpeza,
  pedido: Pedido,
  corte: Date,
  escrever: (linha: string) => void,
  ganchos: GanchosDeTeste,
): Promise<number> {
  const catalogo = await lerCatalogo(cliente);
  const empresas = await empresasComTrabalho(cliente, corte);
  escrever(
    `limpeza-chamada ${pedido.modo.toUpperCase()} — ambiente ${pedido.ambiente}, corte ${corte.toISOString()}`,
  );

  const resultado: ResultadoDaLimpeza = {
    modo: pedido.modo,
    plano: '',
    empresas: [],
  };
  let codigo = 0;

  if (pedido.modo === 'contar') {
    for (const empresa of empresas) {
      let relatorio = relatorioVazio(empresa, '');
      try {
        await cliente.$transaction(async (tx) => {
          await limitar(tx);
          const leitura = await lerEmpresa(tx, catalogo, corte, empresa);
          relatorio = relatorioVazio(empresa, leitura.parte);
          await escreverEmpresa(
            tx,
            catalogo,
            leitura.alvo,
            relatorio,
            escrever,
          );
          throw new Desfazer();
        }, OPCOES_DA_TRANSACAO);
      } catch (causa) {
        if (!(causa instanceof Desfazer)) {
          relatorio.situacao = situacaoDoErro(causa);
          relatorio.erro = descrever(causa);
          codigo = 1;
        }
      }
      resultado.empresas.push(relatorio);
      imprimirEmpresa(escrever, relatorio);
      if (relatorio.situacao === 'ciclo') break;
    }
    resultado.plano = impressaoGlobal(resultado.empresas, catalogo, pedido);
    escrever(`impressão do plano: ${resultado.plano}`);
    escrever('CONTAR: nada foi gravado.');
    ganchos.resultado?.(resultado);
    return codigo;
  }

  // aplicar — conferência 1: a impressão inteira, antes de qualquer escrita.
  const partes: { empresa: string; parte: string }[] = [];
  for (const empresa of empresas) {
    await cliente.$transaction(async (tx) => {
      await limitar(tx);
      const leitura = await lerEmpresa(tx, catalogo, corte, empresa);
      partes.push({ empresa, parte: leitura.parte });
    }, OPCOES_DA_TRANSACAO);
  }
  resultado.plano = impressaoGlobal(partes, catalogo, pedido);
  if (resultado.plano !== pedido.plano) {
    escrever(
      `erro: a impressão de agora (${resultado.plano}) não é a do --plano; conte de novo. Nada foi gravado.`,
    );
    ganchos.resultado?.(resultado);
    return 1;
  }
  await ganchos.depoisDaConferenciaGlobal?.();

  for (const { empresa, parte } of partes) {
    const relatorio = relatorioVazio(empresa, parte);
    try {
      await cliente.$transaction(async (tx) => {
        await limitar(tx);
        await tx.$queryRawUnsafe(
          `SELECT id FROM turmas WHERE company_id = $1::uuid ORDER BY id FOR UPDATE`,
          empresa,
        );
        const lida = await lerEmpresa(tx, catalogo, corte, empresa);
        await travarLinhas(tx, catalogo, lida);
        // Conferência 2: com as linhas travadas, o que vai ser escrito é o
        // que o Israel viu — ou esta empresa não escreve.
        const conferida = await lerEmpresa(tx, catalogo, corte, empresa);
        if (conferida.parte !== parte) throw new Divergiu();
        await ganchos.depoisDaTravaDasLinhas?.(empresa);
        await escreverEmpresa(
          tx,
          catalogo,
          conferida.alvo,
          relatorio,
          escrever,
        );
      }, OPCOES_DA_TRANSACAO);
      relatorio.situacao = 'gravada';
    } catch (causa) {
      relatorio.situacao =
        causa instanceof Divergiu ? 'divergiu' : situacaoDoErro(causa);
      relatorio.erro = descrever(causa);
      relatorio.apagadas = [];
      relatorio.mantidas = [];
      relatorio.porTabela = {};
      relatorio.foraDoAlvo = [];
      relatorio.d9 = [];
      codigo = 1;
    }
    resultado.empresas.push(relatorio);
    imprimirEmpresa(escrever, relatorio);
    // Trava que não veio: a próxima empresa segue (AC-031). O resto para.
    if (
      relatorio.situacao !== 'gravada' &&
      relatorio.situacao !== 'desistiu_trava' &&
      relatorio.situacao !== 'desistiu_deadlock'
    ) {
      const gravadas = resultado.empresas
        .filter((e) => e.situacao === 'gravada')
        .map((e) => e.empresa);
      escrever(
        `APLICAR parou. Empresas já gravadas: ${gravadas.length ? gravadas.join(', ') : '(nenhuma)'}.`,
      );
      ganchos.resultado?.(resultado);
      return 1;
    }
  }
  escrever(
    codigo === 0
      ? 'APLICAR: concluído.'
      : 'APLICAR: incompleto — há empresa desfeita por trava; conte de novo.',
  );
  ganchos.resultado?.(resultado);
  return codigo;
}

/**
 * Trava cada linha do fecho e cada presença da D9, `FOR UPDATE`. A ordem é
 * total e a mesma em toda conferência (R13): as camadas do fecho (filhos
 * primeiro), dentro delas o nome da tabela, e as linhas pela chave primária.
 */
async function travarLinhas(
  tx: Tx,
  catalogo: Catalogo,
  leitura: Leitura,
): Promise<void> {
  const fecho = await calcularFecho(tx, catalogo, leitura.alvo);
  for (const camada of camadasDeApagar(fecho)) {
    for (const [tabela, chaves] of porTabela(camada)) {
      const colunas = catalogo.chaves.get(tabela) as string[];
      await tx.$queryRawUnsafe(
        `SELECT 1 FROM ${ident(tabela)} x
          WHERE ${exprDaChave('x', colunas)} = ANY($1::text[])
          ORDER BY ${colunas.map((c) => `x.${ident(c)}`).join(', ')}
          FOR UPDATE`,
        chaves,
      );
    }
  }
  if (leitura.d9.length > 0) {
    await tx.$queryRawUnsafe(
      `SELECT 1 FROM presencas p
        WHERE p.ocupacao_id::text || ':' || p.aluno_id::text = ANY($1::text[])
        ORDER BY p.id
        FOR UPDATE`,
      leitura.d9,
    );
  }
}

// ---------------------------------------------------------------------------
// relatório
// ---------------------------------------------------------------------------

function situacaoDoErro(causa: unknown): Situacao {
  if (causa instanceof CicloDeLinhas) return 'ciclo';
  const sqlstate = sqlstateDe(causa);
  // R13 — os dois são "a trava não veio", e o relatório os distingue.
  if (sqlstate === '55P03') return 'desistiu_trava';
  if (sqlstate === '40P01') return 'desistiu_deadlock';
  return 'erro';
}

function descrever(causa: unknown): string {
  if (causa instanceof CicloDeLinhas || causa instanceof SemChavePrimaria) {
    return causa.message;
  }
  if (causa instanceof Divergiu) {
    return 'a parte desta empresa mudou entre a conferência e a trava';
  }
  if (causa instanceof FalhaNaInstrucao) {
    return `${causa.tabela}: ${mensagemDoBanco(causa.causa)}`;
  }
  const sqlstate = sqlstateDe(causa);
  if (sqlstate === '55P03') return 'lock_timeout (55P03): a trava não veio';
  if (sqlstate === '40P01') return 'deadlock (40P01)';
  if (causa instanceof Prisma.PrismaClientInitializationError) {
    return 'a conexão falhou';
  }
  return sqlstate
    ? `SQLSTATE ${sqlstate}: ${mensagemDoBanco(causa)}`
    : 'falha inesperada';
}

/** A mensagem do Postgres, sem o invólucro do Prisma. Nunca a URL. */
function mensagemDoBanco(causa: unknown): string {
  const texto = causa instanceof Error ? causa.message : String(causa);
  const achado = /Message: `([\s\S]*?)`\s*$/.exec(texto);
  return (achado ? achado[1] : texto.split('\n').pop() || '').trim();
}

function imprimirEmpresa(
  escrever: (linha: string) => void,
  r: RelatorioDaEmpresa,
): void {
  escrever(`empresa ${r.empresa} — ${r.situacao}`);
  if (r.erro) escrever(`  motivo: ${r.erro}`);
  escrever(`  alvo: ${r.alvo.length} aula(s)`);
  escrever(`  apagadas: ${r.apagadas.length}`);
  for (const m of r.mantidas) {
    escrever(
      `  mantida: aula ${m.aula} — ${m.tabela} [${m.sqlstate}] ${m.mensagem}`,
    );
  }
  for (const [tabela, n] of Object.entries(r.porTabela).sort()) {
    escrever(`  linhas apagadas em ${tabela}: ${n}`);
  }
  for (const e of r.foraDoAlvo) {
    escrever(
      `  fora do alvo: ${e.tabela} ${e.chave} — aula ${e.aula} em ${e.data}`,
    );
  }
  escrever(`  D9: presenças reescritas para ausente: ${r.d9.length}`);
  escrever(
    `  D9: ratificadas com aviso e presente (ficam, decisão 12): ${r.ratificadasComAviso.chamadas} chamada(s), ${r.ratificadasComAviso.presencas} presença(s)`,
  );
  escrever(`  impressão da empresa: ${r.parte}`);
}

function valorDe(args: readonly string[], nome: string): string | undefined {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
}

/* istanbul ignore next -- ponto de entrada; a lógica é `executarCli`. */
if (require.main === module) {
  void executarCli(process.argv.slice(2), {
    env: process.env,
    conectar: (url) => new PrismaClient({ datasources: { db: { url } } }),
    escrever: (linha) => console.log(linha),
  }).then((codigo) => {
    process.exitCode = codigo;
  });
}
