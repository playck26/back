import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  AcessoService,
  hashDeSegredoDescartado,
  type ConvitePreparado,
} from '../../acesso/acesso.service';
import {
  ALUNO_NOVO,
  aulasQueAMatriculaLotaria,
  diaEMes,
} from '../../classes/ocupacao-da-ocorrencia';
import {
  ehEsperaEstourada,
  ehServidorOcupado,
  MENSAGEM_ALTERACAO_EM_ANDAMENTO,
  MENSAGEM_OUTRA_PESSOA_NA_TURMA,
  MENSAGEM_SERVIDOR_OCUPADO,
} from '../../common/erros/erro-transitorio';
import {
  CTE_DO_PRAZO,
  DEPOIS_DO_PRAZO,
  RESTO_DO_PRAZO,
} from '../../common/lock/prazo-de-espera';
import {
  BCRYPT_COST,
  gerarSenhaTemporaria,
  senhaTemporariaExpiraEm,
} from '../../common/utils/senha-temporaria';
import { sqlstateDoErro } from '../../courts/recusas-de-estoque';
import {
  CONFIGURACAO_DOS_MODELOS,
  type ConfiguracaoDosModelos,
} from '../../email/email.config';
import { renderizarConviteDeAcesso } from '../../email/modelos/convite-de-acesso';
import {
  PROVEDOR_DE_EMAIL,
  type ProvedorDeEmail,
  type ResultadoDoEnvio,
} from '../../email/provedor-de-email';
import { PrismaService } from '../../prisma/prisma.service';
import {
  mensagemDeNivelIncompativel,
  podeEntrarPorNivel,
  primeiroNivel,
  travarNivelDaEmpresa,
  type LoteNovo,
  type NivelEfetivo,
} from '../nivel-efetivo';
import { linhasComNumero } from './csv';
import type {
  AlunoImportadoDto,
  ErroDeImportacaoDto,
  ImportacaoConcluidaDto,
  LinhaValidaDto,
  RelatorioDeImportacaoDto,
} from './dto/importacao-response.dto';

/**
 * As colunas aceitas — **cinco, em qualquer ordem** (SPEC-083/D1). **`nome` e
 * `email` são os únicos obrigatórios** (D9 da 038): importar 300 alunos com
 * nome e e-mail é um estado legítimo, e a faixa do app pede o resto.
 *
 * *Por que saíram nascimento e os dois de emergência:* o Israel pediu o modelo
 * só com o que foi alinhado (I5), e manter colunas que o modelo não traz
 * deixaria a importação aceitando uma planilha que ninguém mais distribui.
 * Uma planilha antiga cai em `COLUNA_DESCONHECIDA`, com as cinco na mensagem.
 */
const COLUNAS = ['nome', 'email', 'telefone', 'nivel', 'turma'] as const;

type Coluna = (typeof COLUNAS)[number];

/**
 * Aceita o cabeçalho como o gestor o escreveria: `E-mail`, `Celular` e `Nível`
 * são o que sai de uma planilha feita à mão (o normalizador tira caixa e
 * acento, então `nível` já chega como `nivel`).
 *
 * *Não é gentileza:* recusá-los transformaria o primeiro uso numa caça ao nome
 * exato da coluna.
 */
const APELIDOS: Record<string, Coluna> = {
  nome: 'nome',
  email: 'email',
  'e-mail': 'email',
  telefone: 'telefone',
  celular: 'telefone',
  nivel: 'nivel',
  turma: 'turma',
};

/** Sem acento, sem caixa, sem espaço nas pontas — para casar apelido. */
function normalizarCabecalho(bruto: string): string {
  return bruto.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * SPEC-083/D3 — **o nome de nível e o de turma, normalizados do mesmo jeito**
 * (a D3 manda a turma ser normalizada "como o do nível"): o do cabeçalho, e os
 * espaços de dentro colapsados num só. *"Terça  19h"*, digitado com dois
 * espaços, é a turma *"Terça 19h"* — o gestor não enxerga a diferença na
 * célula, e recusar por ela seria pedir que ele adivinhe (AC-007).
 */
function normalizarNome(bruto: string): string {
  return normalizarCabecalho(bruto).replace(/\s+/g, ' ');
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * O erro de e-mail que a corrida produz. **A D3 decide o `23505` da etapa de
 * `usuarios` por ele, e só por ele**: a conferência refeita que o acha prova
 * que outra transação criou a conta no meio, e o `422` diz ao gestor qual
 * linha corrigir. Uma constante, porque a mensagem e a decisão não podem
 * divergir.
 */
export const MENSAGEM_EMAIL_JA_EXISTE = 'Já existe uma conta com este e-mail.';

/** Até quantas turmas ativas a recusa de turma inexistente lista (D3). */
const TETO_DE_TURMAS_NA_MENSAGEM = 10;

/** D4 — o `timeout` da transação da importação. Ver a D3, passo 6. */
export const TIMEOUT_DA_IMPORTACAO_MS = 15_000;

/**
 * O nome da variável de transação onde a primeira instrução de ajuste guarda o
 * `statement_timeout` que a sessão tinha **antes** de a importação mexer nele.
 * É dela que a reposição antes do `COMMIT` lê o padrão da sessão (D3, passo
 * 4): `SET LOCAL … TO DEFAULT` devolveria o valor de configuração, e não o que
 * a sessão tinha.
 */
const TIMEOUT_DA_SESSAO = 'playck.statement_timeout_da_sessao';

/**
 * SPEC-083/D3, passo 4 — **a instrução que fixa o prazo de cada escrita.**
 *
 * O Postgres aplica o `lock_timeout` a cada espera **separadamente**: um
 * `INSERT` de usuários pode esperar por dois e-mails que outras transações
 * estão inserindo, e as duas esperas somariam quase 4 s (DOR-083-R2-01). O
 * `statement_timeout` limita a instrução **inteira**, com todas as esperas, ao
 * que sobra de `playck.prazo` — o mesmo `RESTO_DO_PRAZO` da SPEC-082, com piso
 * de 1 ms. Recalculado antes de cada escrita, a soma das escritas também não
 * passa do prazo.
 *
 * O `FROM` guarda, na primeira vez, o `statement_timeout` da sessão (o
 * `coalesce` mantém o que já foi guardado nas seguintes). Uma subconsulta no
 * `FROM` com função volátil não é achatada pelo planejador: roda antes da
 * lista do `SELECT`, que é o que põe a captura antes da troca.
 */
export const AJUSTE_DO_PRAZO = Prisma.sql`
  SELECT set_config('statement_timeout', ${RESTO_DO_PRAZO}, true) AS st,
         set_config('lock_timeout', ${RESTO_DO_PRAZO}, true) AS lt
    FROM (SELECT set_config('${Prisma.raw(TIMEOUT_DA_SESSAO)}',
                   coalesce(nullif(current_setting('${Prisma.raw(TIMEOUT_DA_SESSAO)}', true), ''),
                            current_setting('statement_timeout')),
                   true) AS guardado) g
   WHERE g.guardado IS NOT NULL`;

/**
 * SPEC-083/D3, passo 4 — **antes do `COMMIT`, o `statement_timeout` volta ao
 * da sessão.** Sem isto, o próprio `COMMIT` rodaria com o prazo curto que
 * sobrou da última escrita, e poderia ser cancelado — a importação inteira
 * desfeita por um relógio, depois de tudo ter dado certo (AC-051).
 */
export const REPOSICAO_DO_TIMEOUT = Prisma.sql`
  SELECT set_config('statement_timeout',
           coalesce(nullif(current_setting('${Prisma.raw(TIMEOUT_DA_SESSAO)}', true), ''),
                    current_setting('statement_timeout')),
           true) AS st`;

// ==========================================================================
// As etapas — a causa do erro vem da etapa, nunca do texto (D3, passo 5)
// ==========================================================================

/** As quatro tabelas que a importação escreve, na ordem em que escreve. */
export type EtapaDeEscrita =
  'usuarios' | 'alunos' | 'turma_alunos' | 'convites_de_acesso';

/**
 * Onde o erro nasceu. O serviço marca a etapa antes de cada instrução, como a
 * D4 da SPEC-082 — mas com etapas próprias: as da 082 são as da matrícula de
 * um aluno, e a importação tem as das quatro escritas, o ajuste do prazo e a
 * reposição, que a tradução e o 23505 precisam distinguir.
 */
export type EtapaDaImportacao =
  | 'travas'
  | 'referenciadas'
  | 'turmas'
  | 'ajuste'
  | EtapaDeEscrita
  | 'reposicao';

const ETAPA_DA_IMPORTACAO = Symbol.for('playck.spec083.etapaDaImportacao');

async function naEtapa<T>(
  etapa: EtapaDaImportacao,
  instrucao: Promise<T>,
): Promise<T> {
  try {
    return await instrucao;
  } catch (erro) {
    if (
      erro !== null &&
      typeof erro === 'object' &&
      !(ETAPA_DA_IMPORTACAO in erro)
    ) {
      Object.defineProperty(erro, ETAPA_DA_IMPORTACAO, {
        value: etapa,
        enumerable: false,
      });
    }
    throw erro;
  }
}

/** A etapa marcada no erro, ou `null` (erro de fora das instruções). */
export function etapaDaImportacao(erro: unknown): EtapaDaImportacao | null {
  if (
    erro !== null &&
    typeof erro === 'object' &&
    ETAPA_DA_IMPORTACAO in erro
  ) {
    return (erro as Record<symbol, EtapaDaImportacao>)[ETAPA_DA_IMPORTACAO];
  }
  return null;
}

const ETAPAS_COM_PRAZO_DE_INSTRUCAO: ReadonlySet<EtapaDaImportacao> = new Set([
  'ajuste',
  'usuarios',
  'alunos',
  'turma_alunos',
  'convites_de_acesso',
  'reposicao',
]);

/**
 * SPEC-083/D3, passo 5 — **a tradução da importação, na borda HTTP**, pela
 * etapa que o serviço marcou:
 *
 * - `55P03` na etapa das turmas ⇒ 409 `MATRICULA_EM_ANDAMENTO` + I4: alguém
 *   está matriculando numa turma do arquivo;
 * - `55P03` em outra etapa, ou `57014` (o `statement_timeout` da D3) no
 *   ajuste, numa escrita ou na reposição ⇒ 409 + I6. Escrita que não coube no
 *   que sobrou do prazo é tratada como disputa, mesmo sem disputa (LIM-083m);
 * - `P2028`/`P2024` ⇒ 503 `SERVIDOR_OCUPADO` + I5;
 * - qualquer outro erro sobe como veio.
 *
 * O `23505` não passa por aqui: quem o decide é o serviço, depois do rollback
 * (`importar`), porque a decisão precisa refazer a conferência.
 */
export function traduzirErroDaImportacao(erro: unknown): never {
  const etapa = etapaDaImportacao(erro);
  const sqlstate = sqlstateDoErro(erro);
  const esperaEstourada = ehEsperaEstourada(erro);
  const prazoDaInstrucao =
    sqlstate === '57014' &&
    etapa !== null &&
    ETAPAS_COM_PRAZO_DE_INSTRUCAO.has(etapa);
  if (esperaEstourada || prazoDaInstrucao) {
    throw new ConflictException(
      {
        statusCode: 409,
        code: 'MATRICULA_EM_ANDAMENTO',
        message:
          esperaEstourada && etapa === 'turmas'
            ? MENSAGEM_OUTRA_PESSOA_NA_TURMA
            : MENSAGEM_ALTERACAO_EM_ANDAMENTO,
      },
      { cause: erro },
    );
  }
  if (ehServidorOcupado(erro)) {
    throw new ServiceUnavailableException(
      {
        statusCode: 503,
        code: 'SERVIDOR_OCUPADO',
        message: MENSAGEM_SERVIDOR_OCUPADO,
      },
      { cause: erro },
    );
  }
  throw erro;
}

// ==========================================================================
// Ganchos — de teste; em produção não há nenhum
// ==========================================================================

export const GANCHOS_DA_IMPORTACAO = Symbol('GANCHOS_DA_IMPORTACAO');

/**
 * **Os pontos por onde as provas observam a importação**, e nenhum deles faz
 * nada em produção (nenhum módulo fornece o token; o padrão é `{}`).
 *
 * - `gerarId` — o gerador dos ids das linhas novas (AC-053 injeta um id de
 *   usuário que já existe, para a colisão de chave primária);
 * - `aoTravar` — chamado logo depois da instrução inicial, na sessão da
 *   importação, com o `playck.prazo` que ela fixou e o `pg_backend_pid()`
 *   (AC-045 e AC-050 medem pelo prazo da sessão: noutra conexão,
 *   `current_setting` devolve nulo). Só quando existe a consulta é feita;
 * - `aoMedirEscrita` — a duração de cada escrita, medida no Back, para o
 *   registro do LIM-083m (AC-014);
 * - `depoisDoRollback` — chamado depois do rollback e antes de decidir a
 *   resposta (AC-052: a conta concorrente nasce exatamente ali).
 */
export interface GanchosDaImportacao {
  gerarId?: (
    tabela: 'usuarios' | 'alunos' | 'convites_de_acesso',
    indice: number,
  ) => string;
  aoTravar?: (sessao: {
    prazo: string;
    pid: number;
    tx: Prisma.TransactionClient;
  }) => Promise<void> | void;
  aoMedirEscrita?: (etapa: EtapaDeEscrita, ms: number) => void;
  depoisDoRollback?: (erro: unknown) => Promise<void> | void;
}

// ==========================================================================
// A turma: as conferências da D3, itens 4 a 6 — as mesmas fora e sob a trava
// ==========================================================================

/** O que as conferências de turma leem, pelo cliente de quem chama. */
type LeitorDaTurma = Pick<
  Prisma.TransactionClient,
  'nivel' | 'turmaAluno' | 'faltaAvisada' | 'reposicaoDeAula' | 'ocupacaoQuadra'
>;

interface TurmaConferida {
  id: string;
  nome: string;
  capacidade: number;
  nivelId: string;
  alocados: number;
}

interface LinhaNaTurma {
  linha: number;
  turmaId: string;
  turmaNome: string;
  nivelId: string | null;
}

async function contarAlocados(
  db: Pick<Prisma.TransactionClient, 'turmaAluno'>,
  turmaIds: readonly string[],
): Promise<Map<string, number>> {
  if (turmaIds.length === 0) return new Map();
  const grupos = await db.turmaAluno.groupBy({
    by: ['turmaId'],
    where: { turmaId: { in: [...turmaIds] } },
    _count: { _all: true },
  });
  return new Map(grupos.map((g) => [g.turmaId, g._count._all]));
}

/**
 * D3, item 6 — **a primeira linha que lotaria uma aula futura**, por turma.
 *
 * É a conta da `aulaQueAMatriculaLotaria`, **a mesma função**, generalizada
 * para k alunos novos sem uma segunda cópia da regra: um aluno novo não é
 * matriculado, não tem falta nem reposição, então cada um soma exatamente 1 a
 * `ocupados` em toda aula. "k novos passam da capacidade C" é o mesmo que
 * "um novo passa de C − (k − 1)" — e a função já sabe responder isso, para
 * várias turmas numa ida.
 *
 * Lotar é monótono em k, então a primeira linha que lota sai de uma busca
 * binária: só roda quando o arquivo inteiro lotaria, e custa uma ida por
 * passo, com todas as turmas lotadas juntas.
 */
async function primeiraLinhaQueLotaAula(
  db: LeitorDaTurma,
  companyId: string,
  turmas: readonly { id: string; capacidade: number; k: number }[],
  agora: Date,
): Promise<Map<string, { posicao: number; data: Date }>> {
  const comCapacidade = (id: string, capacidade: number, k: number) => ({
    id,
    capacidade: capacidade - (k - 1),
  });
  const comTodos = await aulasQueAMatriculaLotaria(
    db,
    companyId,
    turmas.map((t) => comCapacidade(t.id, t.capacidade, t.k)),
    ALUNO_NOVO,
    agora,
  );
  const busca = new Map<
    string,
    { lo: number; hi: number; data: Date; capacidade: number }
  >();
  for (const t of turmas) {
    const aula = comTodos.get(t.id);
    if (aula) {
      busca.set(t.id, {
        lo: 1,
        hi: t.k,
        data: aula.data,
        capacidade: t.capacidade,
      });
    }
  }
  for (;;) {
    const abertas = [...busca].filter(([, b]) => b.lo < b.hi);
    if (abertas.length === 0) break;
    const meios = abertas.map(([id, b]) => ({
      id,
      b,
      meio: Math.floor((b.lo + b.hi) / 2),
    }));
    const lotadas = await aulasQueAMatriculaLotaria(
      db,
      companyId,
      meios.map((m) => comCapacidade(m.id, m.b.capacidade, m.meio)),
      ALUNO_NOVO,
      agora,
    );
    for (const m of meios) {
      const aula = lotadas.get(m.id);
      if (aula) {
        m.b.hi = m.meio;
        m.b.data = aula.data;
      } else {
        m.b.lo = m.meio + 1;
      }
    }
  }
  return new Map(
    [...busca].map(([id, b]) => [id, { posicao: b.hi, data: b.data }]),
  );
}

/**
 * SPEC-083/D3, itens 4 a 6 — **nível, capacidade e aula lotada**, pela ordem
 * do arquivo. Uma função só para as duas passadas: a conferência (sem trava,
 * pelo cliente de fora) e a importação (pelo `tx`, sob a trava do clube e o
 * `FOR UPDATE` das turmas). **A conferência é aviso; a garantia é esta mesma
 * conta refeita sob as travas.**
 *
 * - **nível**: `podeEntrarPorNivel(turma, efetivo)`, com o efetivo da linha
 *   ou, vazio, o primeiro nível da empresa — o que inclui a linha sem nível
 *   numa turma que não é do primeiro (I4). A recusa é o texto do gestor da
 *   SPEC-075;
 * - **capacidade**: os alocados mais as linhas que vão para a turma; o erro
 *   cai na primeira linha que passa;
 * - **aula lotada**: a primeira linha que deixaria uma aula futura acima da
 *   capacidade, contando as reposições.
 *
 * Turma ausente do mapa é turma que deixou de ser ativa (ou de existir) entre
 * a conferência e a trava.
 */
async function errosDeTurma(
  db: LeitorDaTurma,
  companyId: string,
  turmas: ReadonlyMap<string, TurmaConferida>,
  linhas: readonly LinhaNaTurma[],
  nomesDosNiveis: ReadonlyMap<string, string>,
  agora: Date,
): Promise<ErroDeImportacaoDto[]> {
  const erros: ErroDeImportacaoDto[] = [];
  const erro = (linha: number, mensagem: string) =>
    erros.push({ linha, coluna: 'turma', mensagem });

  const primeiro = linhas.some((l) => l.nivelId === null)
    ? await primeiroNivel(db, companyId)
    : null;

  /** Por turma, as linhas que passaram no nível, na ordem do arquivo. */
  const candidatas = new Map<string, number[]>();
  for (const l of linhas) {
    const turma = turmas.get(l.turmaId);
    if (!turma) {
      erro(
        l.linha,
        `A turma "${l.turmaNome}" deixou de estar ativa depois da conferência. Confira as turmas no Admin e envie de novo.`,
      );
      continue;
    }
    const efetivo: NivelEfetivo | null = l.nivelId
      ? {
          id: l.nivelId,
          nome: nomesDosNiveis.get(l.nivelId) ?? 'outro nível',
          doPrimeiro: false,
        }
      : primeiro
        ? { ...primeiro, doPrimeiro: true }
        : null;
    if (!podeEntrarPorNivel(turma.nivelId, efetivo)) {
      erro(
        l.linha,
        mensagemDeNivelIncompativel(
          'gestor',
          nomesDosNiveis.get(turma.nivelId) ?? 'outro nível',
          efetivo,
        ),
      );
      continue;
    }
    const daTurma = candidatas.get(turma.id) ?? [];
    daTurma.push(l.linha);
    candidatas.set(turma.id, daTurma);
  }

  const paraAula: { id: string; capacidade: number; k: number }[] = [];
  for (const [turmaId, numeros] of candidatas) {
    const turma = turmas.get(turmaId) as TurmaConferida;
    const livres = turma.capacidade - turma.alocados;
    if (numeros.length > livres) {
      erro(
        numeros[Math.max(livres, 0)],
        livres <= 0
          ? `A turma "${turma.nome}" já está cheia (capacidade ${turma.capacidade}).`
          : `A turma "${turma.nome}" tem ${livres} vaga(s) livre(s), e a planilha põe ${numeros.length} aluno(s) nela. Esta é a primeira linha que não cabe.`,
      );
      continue;
    }
    paraAula.push({
      id: turmaId,
      capacidade: turma.capacidade,
      k: numeros.length,
    });
  }

  if (paraAula.length > 0) {
    const lotadas = await primeiraLinhaQueLotaAula(
      db,
      companyId,
      paraAula,
      agora,
    );
    for (const [turmaId, { posicao, data }] of lotadas) {
      const turma = turmas.get(turmaId) as TurmaConferida;
      erro(
        (candidatas.get(turmaId) as number[])[posicao - 1],
        `A aula de ${diaEMes(data)} da turma "${turma.nome}" ficaria acima da capacidade, contando as reposições marcadas. Esta é a primeira linha da planilha que não cabe nesse dia.`,
      );
    }
  }
  return erros;
}

/** Erros pela ordem do arquivo; na mesma linha, a ordem em que nasceram. */
function emOrdemDeLinha(erros: ErroDeImportacaoDto[]): ErroDeImportacaoDto[] {
  return erros
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.linha - b.e.linha || a.i - b.i)
    .map(({ e }) => e);
}

// ==========================================================================
// O que atravessa da conferência para a escrita
// ==========================================================================

interface Conferencia {
  relatorio: RelatorioDeImportacaoDto;
  nomesDosNiveis: Map<string, string>;
}

/** Uma conferência refeita sob a trava falhou: vira `422` depois do rollback. */
class RecusaSobATrava extends Error {
  constructor(readonly erros: ErroDeImportacaoDto[]) {
    super('a conferência refeita sob as travas achou erro');
  }
}

/** Uma linha pronta para escrever, com os ids gerados antes da transação. */
interface LinhaParaEscrever {
  linha: LinhaValidaDto;
  usuarioId: string;
  alunoId: string;
  senhaHash: string;
  /** A senha `pck-` da linha não convidada; nula na convidada (D5). */
  senha: string | null;
  convite: (ConvitePreparado & { id: string }) | null;
}

/** Uma linha convidada, do commit até o envio. O token cru vive só aqui. */
interface ConviteDaLinha {
  linha: number;
  conviteId: string;
  token: string;
  para: string;
  nomeDaPessoa: string;
}

function planilhaComErros(relatorio: RelatorioDeImportacaoDto) {
  return new UnprocessableEntityException({
    statusCode: 422,
    code: 'PLANILHA_COM_ERROS',
    message: `A planilha tem ${relatorio.erros.length} problema(s). Nada foi importado — corrija e envie de novo.`,
    ...relatorio,
  });
}

/**
 * D5 — o campo `convidar`: números de linha da planilha separados por
 * vírgula. Ausente ou vazio é "ninguém". Qualquer coisa que não seja número
 * de linha é `CONVIDAR_LINHA_INVALIDA`, como o número que não é linha válida:
 * adivinhar o que o Admin quis mandaria convite a quem o gestor não marcou.
 */
function lerConvidar(bruto: unknown): number[] {
  // O multipart entrega um arranjo quando o campo vem repetido: o tipo do
  // parâmetro diz `string`, e quem decide é o que chegou.
  if (bruto !== undefined && typeof bruto !== 'string') {
    throw convidarLinhaInvalida([JSON.stringify(bruto)]);
  }
  const texto = (bruto ?? '').trim();
  if (texto === '') return [];
  const partes = texto.split(',').map((p) => p.trim());
  const invalidas = partes.filter((p) => !/^\d+$/.test(p));
  if (invalidas.length > 0) {
    throw convidarLinhaInvalida(invalidas);
  }
  return [...new Set(partes.map(Number))];
}

function convidarLinhaInvalida(linhas: readonly (string | number)[]) {
  return new BadRequestException({
    statusCode: 400,
    code: 'CONVIDAR_LINHA_INVALIDA',
    message: `O campo "convidar" cita o que não é linha de aluno válida desta planilha: ${linhas.slice(0, 10).join(', ')}. Nada foi importado.`,
    linhas: linhas.map(String),
  });
}

/**
 * SPEC-038 — **importar alunos por planilha.**
 *
 * ## Dois passos, e a razão é o custo do engano (D2/D3)
 *
 * `conferir=true` valida e **não escreve**; sem ele, valida e escreve — e
 * qualquer erro recusa o arquivo **inteiro**.
 *
 * *Importar as boas e listar as ruins foi considerado e recusado:* deixaria o
 * gestor sem saber quais das 300 entraram, e a segunda tentativa duplicaria o
 * que já passou. Com o passo de conferência, o custo do "tudo ou nada" é zero:
 * ele confere, corrige o arquivo, importa.
 *
 * ## O relatório é por LINHA, com o número da PLANILHA (D4)
 *
 * *"O e-mail da linha 47 já existe"* é acionável; *"há e-mails repetidos"* não
 * é. E o número conta o cabeçalho, porque é o que aparece no Excel.
 *
 * ## SPEC-083 — turma, convite por e-mail, e o tempo
 *
 * A importação passou a pôr o aluno na turma da planilha (D3), pelo protocolo
 * de travas e prazo da SPEC-082 (modo `lote-novo`); a escolher, linha por
 * linha, quem recebe convite por e-mail em vez de senha (D5); e a escrever em
 * lote, por SQL cru, com o bcrypt todo **antes** da transação (D4).
 */
/**
 * **Os `code` sao LITERAIS, e nao constantes exportadas.**
 *
 * Parece pior e nao e: o gate `Docs/contrato-spec-x-codigo.py` casa o campo
 * `code` seguido de uma string literal, e confronta com o que a spec PROMETE.
 * Atras de uma constante, o codigo existe e o gate nao o ve -- e ele reprova a
 * spec dizendo "ramo morto no frontend" sobre algo que funciona.
 *
 * Foi assim que esta spec reprovou na primeira execucao do gate. E a SEGUNDA
 * reprovacao foi do comentario que explicava a primeira: ele trazia o padrao
 * escrito por extenso, e o gate o leu como um codigo chamado `X`. Escrever a
 * regra sem escrever a forma dela e o conserto.
 */
@Injectable()
export class ImportacaoDeAlunosService {
  private readonly logger = new Logger('Importacao');

  constructor(
    private readonly prisma: PrismaService,
    // SPEC-083/D3 — as linhas de convite (token, hash, impressão, validade)
    // são PREPARADAS pela regra do `AcessoService` e gravadas aqui, no SQL
    // cru da importação. Uma regra de token só para a ficha e para o lote.
    private readonly acesso: AcessoService,
    @Inject(PROVEDOR_DE_EMAIL) private readonly provedor: ProvedorDeEmail,
    @Inject(CONFIGURACAO_DOS_MODELOS)
    private readonly modelos: ConfiguracaoDosModelos,
    @Optional()
    @Inject(GANCHOS_DA_IMPORTACAO)
    private readonly ganchos: GanchosDaImportacao = {},
  ) {}

  /**
   * Lê o cabeçalho e devolve o mapa `coluna -> índice`.
   *
   * **Coluna desconhecida é ERRO, não silêncio** (D8). Ignorá-la é como uma
   * planilha com `e-mail` mal escrito é importada com todos os e-mails
   * vazios — e o gestor só descobre quando ninguém consegue entrar.
   */
  private lerCabecalho(campos: string[]): Record<Coluna, number> {
    const mapa = {} as Record<Coluna, number>;
    const desconhecidas: string[] = [];

    campos.forEach((bruto, indice) => {
      const chave = normalizarCabecalho(bruto);
      if (chave === '') return;
      const coluna = APELIDOS[chave];
      if (!coluna) {
        desconhecidas.push(bruto.trim());
        return;
      }
      mapa[coluna] = indice;
    });

    if (desconhecidas.length > 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'COLUNA_DESCONHECIDA',
        message: `Coluna não reconhecida: ${desconhecidas.join(', ')}. As aceitas são: ${COLUNAS.join(', ')}.`,
        colunas: desconhecidas,
      });
    }
    if (mapa.nome === undefined || mapa.email === undefined) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PLANILHA_SEM_CABECALHO',
        message:
          'A primeira linha precisa ser o cabeçalho, com pelo menos as colunas `nome` e `email`.',
      });
    }
    return mapa;
  }

  /**
   * Valida tudo e devolve o relatório. **Não escreve nunca** — quem escreve é
   * o `importar`, e só depois de chamar isto e receber zero erros.
   */
  async conferir(
    companyId: string,
    conteudo: string,
  ): Promise<RelatorioDeImportacaoDto> {
    return (await this.conferirComContexto(companyId, conteudo)).relatorio;
  }

  private async conferirComContexto(
    companyId: string,
    conteudo: string,
  ): Promise<Conferencia> {
    const linhas = linhasComNumero(conteudo);
    if (linhas.length === 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PLANILHA_SEM_CABECALHO',
        message: 'O arquivo está vazio.',
      });
    }

    const mapa = this.lerCabecalho(linhas[0].campos);
    const dados = linhas.slice(1);
    if (dados.length === 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PLANILHA_VAZIA',
        message:
          'A planilha tem cabeçalho e nenhuma linha de aluno. Importar zero alunos com sucesso seria uma resposta verdadeira e inútil.',
      });
    }

    const valorDe = (campos: string[], c: Coluna): string =>
      mapa[c] === undefined ? '' : (campos[mapa[c]] ?? '').trim();

    const niveis = await this.prisma.nivel.findMany({
      where: { companyId },
      select: { id: true, nome: true },
    });
    const porNome = new Map(niveis.map((n) => [normalizarNome(n.nome), n]));
    const nomesDosNiveis = new Map(niveis.map((n) => [n.id, n.nome]));

    // SPEC-083/D3, item 1 — a turma é buscada pelo nome entre as ATIVAS da
    // empresa. Só se o arquivo citar alguma: planilha sem turma não paga a
    // consulta.
    const citaTurma = dados.some(
      ({ campos }) => valorDe(campos, 'turma') !== '',
    );
    const ativas = citaTurma
      ? await this.prisma.turma.findMany({
          where: { companyId, status: 'ativa' },
          select: { id: true, nome: true, capacidade: true, nivelId: true },
          orderBy: [{ nome: 'asc' }, { id: 'asc' }],
        })
      : [];
    const turmasPorNome = new Map<string, typeof ativas>();
    for (const t of ativas) {
      const chave = normalizarNome(t.nome);
      turmasPorNome.set(chave, [...(turmasPorNome.get(chave) ?? []), t]);
    }

    const erros: ErroDeImportacaoDto[] = [];
    /** e-mail -> a PRIMEIRA linha em que ele apareceu (AC-008). */
    const vistos = new Map<string, number>();
    const lidas: LinhaValidaDto[] = [];
    const naTurma: LinhaNaTurma[] = [];

    const emailsDoArquivo: string[] = [];
    for (const { campos } of dados) {
      const e = valorDe(campos, 'email').toLowerCase();
      if (e !== '') emailsDoArquivo.push(e);
    }
    /**
     * **Uma consulta para todos os e-mails, e não uma por linha.**
     *
     * Uma planilha de 300 alunos viraria 300 idas ao banco — o mesmo N+1 que
     * o DEF-013 baniu três vezes neste projeto, e que voltou pelo caminho de
     * escrita na terceira.
     */
    const jaExistem = new Set(
      (
        await this.prisma.usuario.findMany({
          where: { email: { in: emailsDoArquivo } },
          select: { email: true },
        })
      ).map((u) => u.email.toLowerCase()),
    );

    for (const { numero, campos } of dados) {
      const valor = (c: Coluna): string => valorDe(campos, c);
      const erro = (coluna: string, mensagem: string) =>
        erros.push({ linha: numero, coluna, mensagem });

      const nome = valor('nome');
      const email = valor('email').toLowerCase();

      if (nome === '') erro('nome', 'O nome é obrigatório.');
      if (email === '') {
        erro('email', 'O e-mail é obrigatório.');
      } else if (!EMAIL.test(email)) {
        erro('email', `"${email}" não parece um e-mail.`);
      } else if (vistos.has(email)) {
        // AC-008: o erro vai na SEGUNDA ocorrência e cita a primeira — sem a
        // linha de origem, o gestor procura a duplicata no arquivo inteiro.
        erro(
          'email',
          `Este e-mail já aparece na linha ${vistos.get(email) as number}.`,
        );
      } else if (jaExistem.has(email)) {
        erro('email', MENSAGEM_EMAIL_JA_EXISTE);
      } else {
        vistos.set(email, numero);
      }

      // SPEC-083/I4 e ADR-026 — **nível vazio fica NULO, e nunca o id do
      // primeiro nível.** O aluno sem nível já conta como o primeiro, pela
      // regra resolvida na leitura (`nivelEfetivoDoAluno`). Gravar o id aqui
      // congelaria a ordem de hoje: o gestor reordena os níveis, e este aluno
      // continuaria no antigo primeiro (S8).
      let nivelId: string | null = null;
      let nivelValido = true;
      const nivelBruto = valor('nivel');
      if (nivelBruto !== '') {
        const achado = porNome.get(normalizarNome(nivelBruto));
        if (!achado) {
          nivelValido = false;
          erro(
            'nivel',
            niveis.length === 0
              ? `O nível "${nivelBruto}" não existe — este clube ainda não tem níveis cadastrados.`
              : `O nível "${nivelBruto}" não existe. Os cadastrados são: ${niveis.map((n) => n.nome).join(', ')}.`,
          );
        } else {
          nivelId = achado.id;
        }
      }

      // SPEC-083/D3, itens 1 a 3 — a turma pelo nome, entre as ativas.
      let turma: { id: string; nome: string } | null = null;
      const turmaBruta = valor('turma');
      if (turmaBruta !== '') {
        const achadas = turmasPorNome.get(normalizarNome(turmaBruta)) ?? [];
        if (achadas.length === 0) {
          erro('turma', mensagemDeTurmaInexistente(turmaBruta, ativas));
        } else if (achadas.length > 1) {
          // Escolher uma das duas seria pôr o aluno numa turma que o gestor
          // talvez não quisesse. O conserto é dele, e é de um gesto só.
          erro(
            'turma',
            `Há ${achadas.length} turmas ativas chamadas "${turmaBruta}". Renomeie uma delas no Admin para a planilha dizer qual é.`,
          );
        } else {
          turma = { id: achadas[0].id, nome: achadas[0].nome };
          // A linha com nível inexistente já tem o erro dela, e o nível da
          // turma não tem contra o que ser conferido.
          if (nivelValido) {
            naTurma.push({
              linha: numero,
              turmaId: turma.id,
              turmaNome: turma.nome,
              nivelId,
            });
          }
        }
      }

      lidas.push({
        linha: numero,
        nome,
        email,
        telefone: valor('telefone') || null,
        nivelId,
        turmaId: turma?.id ?? null,
        turmaNome: turma?.nome ?? null,
      });
    }

    // D3, itens 4 a 6 — nível, capacidade e aula lotada, sem trava.
    if (naTurma.length > 0) {
      const ids = [...new Set(naTurma.map((l) => l.turmaId))];
      const alocados = await contarAlocados(this.prisma, ids);
      const turmas = new Map(
        ativas
          .filter((t) => ids.includes(t.id))
          .map((t) => [t.id, { ...t, alocados: alocados.get(t.id) ?? 0 }]),
      );
      erros.push(
        ...(await errosDeTurma(
          this.prisma,
          companyId,
          turmas,
          naTurma,
          nomesDosNiveis,
          new Date(),
        )),
      );
    }

    const comErro = new Set(erros.map((e) => e.linha));
    const validas = lidas.filter((l) => !comErro.has(l.linha));
    return {
      relatorio: {
        total: dados.length,
        validas: validas.length,
        erros: emOrdemDeLinha(erros),
        linhas: validas,
      },
      nomesDosNiveis,
    };
  }

  /**
   * SPEC-038/REQ-003 e SPEC-083 — a escrita, **tudo ou nada** (INV-117,
   * INV-083g).
   *
   * 1. a conferência, sem trava; qualquer erro é `422` e nada é escrito;
   * 2. o `convidar` (D5), conferido contra as linhas válidas;
   * 3. **todo bcrypt, antes da transação** (D4): as senhas `pck-` das linhas
   *    não convidadas, em paralelo, e um hash só de segredo descartado para
   *    todas as convidadas;
   * 4. a transação: travas, conferência de turma refeita sob elas, e as
   *    quatro escritas em lote, cada uma com o prazo fixado antes (D3);
   * 5. depois do `COMMIT`, o e-mail, e o resultado gravado (D8).
   *
   * **Depois do `COMMIT` nada lança.** A senha das linhas não convidadas só
   * existe nesta resposta: um `500` aqui deixaria contas criadas com senhas
   * que ninguém viu, e a segunda tentativa recusaria todos os e-mails.
   */
  async importar(
    companyId: string,
    conteudo: string,
    opcoes: { gestorId: string; convidar?: string },
  ): Promise<ImportacaoConcluidaDto> {
    const pedidas = lerConvidar(opcoes.convidar);

    const { relatorio, nomesDosNiveis } = await this.conferirComContexto(
      companyId,
      conteudo,
    );
    if (relatorio.erros.length > 0) {
      throw planilhaComErros(relatorio);
    }

    const validas = new Set(relatorio.linhas.map((l) => l.linha));
    const fora = pedidas.filter((n) => !validas.has(n));
    if (fora.length > 0) {
      throw convidarLinhaInvalida(fora);
    }
    const convidadas = new Set(pedidas);

    const linhas = await this.prepararLinhas(relatorio.linhas, convidadas);

    let nomeDoClube: string;
    try {
      nomeDoClube = await this.escreverNaTransacao(
        companyId,
        opcoes.gestorId,
        linhas,
        nomesDosNiveis,
      );
    } catch (erro) {
      await this.ganchos.depoisDoRollback?.(erro);
      return this.decidirFalha(companyId, conteudo, erro);
    }

    const resultados = await this.enviarConvites(
      linhas.flatMap((l) =>
        l.convite
          ? [
              {
                linha: l.linha.linha,
                conviteId: l.convite.id,
                token: l.convite.token,
                para: l.linha.email,
                nomeDaPessoa: l.linha.nome,
              },
            ]
          : [],
      ),
      nomeDoClube,
    );

    return {
      criados: linhas.map((l): AlunoImportadoDto => {
        const base = {
          linha: l.linha.linha,
          alunoId: l.alunoId,
          email: l.linha.email,
        };
        if (l.senha !== null) {
          return { ...base, senhaTemporaria: l.senha };
        }
        const r = resultados.get(l.linha.linha);
        return {
          ...base,
          convite:
            r && r.ok
              ? { email: 'enviado' }
              : {
                  email: 'falhou',
                  motivo: r && !r.ok ? r.motivo : 'indisponivel',
                },
        };
      }),
    };
  }

  /**
   * D4 — **o bcrypt todo, fora da transação.** As senhas `pck-` das linhas
   * não convidadas são calculadas em paralelo (o libuv tem 4 threads); as
   * convidadas recebem, todas, o hash de **um** segredo de 32 bytes que
   * ninguém conhece (`hashDeSegredoDescartado`) — um hash por arquivo, e não
   * por linha.
   *
   * Os ids das três tabelas também nascem aqui (`randomUUID`), e são eles que
   * encadeiam as escritas sem depender de `RETURNING` (D3, passo 4).
   */
  private async prepararLinhas(
    validas: readonly LinhaValidaDto[],
    convidadas: ReadonlySet<number>,
  ): Promise<LinhaParaEscrever[]> {
    const gerarId = (
      tabela: 'usuarios' | 'alunos' | 'convites_de_acesso',
      indice: number,
    ) => this.ganchos.gerarId?.(tabela, indice) ?? randomUUID();

    const [hashDoConvidado, senhas] = await Promise.all([
      convidadas.size > 0 ? hashDeSegredoDescartado() : Promise.resolve(null),
      Promise.all(
        validas.map(async (l) => {
          if (convidadas.has(l.linha)) return null;
          // **As MESMAS funções do cadastro individual**, e não uma cópia: a
          // validade e o custo do bcrypt são regra de segurança, e duas
          // implementações divergem no primeiro ajuste.
          const senha = gerarSenhaTemporaria();
          return { senha, hash: await bcrypt.hash(senha, BCRYPT_COST) };
        }),
      ),
    ]);

    return validas.map((linha, i) => {
      const daSenha = senhas[i];
      if (daSenha) {
        return {
          linha,
          usuarioId: gerarId('usuarios', i),
          alunoId: gerarId('alunos', i),
          senhaHash: daSenha.hash,
          senha: daSenha.senha,
          convite: null,
        };
      }
      const senhaHash = hashDoConvidado as string;
      return {
        linha,
        usuarioId: gerarId('usuarios', i),
        alunoId: gerarId('alunos', i),
        senhaHash,
        senha: null,
        // A impressão sai do hash que a linha vai gravar: é o `senha_hash`
        // desta conta no instante da emissão (INV-083c), e ninguém mais o
        // conhece até o `COMMIT`.
        convite: {
          ...this.acesso.prepararConvite({ senhaHash }),
          id: gerarId('convites_de_acesso', i),
        },
      };
    });
  }

  /**
   * SPEC-083/D3 — **a transação da importação**, pelo protocolo da SPEC-082.
   * Devolve o nome do clube, lido sob a trava, para o e-mail.
   *
   * A ordem das travas é a da spec, e é ela que evita ciclo com as matrículas:
   * 1. a trava do clube, **compartilhada**, com o prazo absoluto de 2 s
   *    (modo `lote-novo`, sem trava de aluno);
   * 2. as linhas referenciadas — a empresa, os níveis citados e o gestor —
   *    em `FOR KEY SHARE`, numa instrução, com o `lock_timeout` recalculado
   *    por linha;
   * 3. as turmas do arquivo, `FOR UPDATE` em ordem de `id`, também com o
   *    recálculo por linha;
   * 4. a conferência de turma refeita sob elas;
   * 5. as quatro escritas, cada uma depois do ajuste do prazo; e a reposição
   *    do `statement_timeout` antes do `COMMIT`.
   *
   * **O `timeout` é de 15 s** (D4): a espera por travas e as escritas ficam
   * presas aos 2 s do prazo; os 15 s cobrem as idas de rede, que nenhum dos
   * dois conta.
   */
  private async escreverNaTransacao(
    companyId: string,
    gestorId: string,
    linhas: readonly LinhaParaEscrever[],
    nomesDosNiveis: ReadonlyMap<string, string>,
  ): Promise<string> {
    const nivelIds = [
      ...new Set(
        linhas.flatMap((l) => (l.linha.nivelId ? [l.linha.nivelId] : [])),
      ),
    ];
    const naTurma = linhas.flatMap((l) =>
      l.linha.turmaId
        ? [
            {
              linha: l.linha.linha,
              turmaId: l.linha.turmaId,
              turmaNome: l.linha.turmaNome ?? '',
              nivelId: l.linha.nivelId,
            },
          ]
        : [],
    );
    // D3, passo 3 — em ordem de `id`. O texto do UUID em minúsculas ordena
    // como o `uuid` do Postgres (byte a byte), e é essa a ordem que duas
    // importações (e uma matrícula) precisam compartilhar para não fecharem
    // ciclo entre si.
    const turmaIds = [...new Set(naTurma.map((l) => l.turmaId))].sort();

    return this.prisma.$transaction(
      async (tx) => {
        const lote: LoteNovo = await naEtapa(
          'travas',
          travarNivelDaEmpresa(tx, companyId, 'lote-novo'),
        );

        if (this.ganchos.aoTravar) {
          const [sessao] = await tx.$queryRaw<
            { prazo: string; pid: number }[]
          >`SELECT current_setting('playck.prazo') AS prazo, pg_backend_pid() AS pid`;
          await this.ganchos.aoTravar({ ...sessao, tx });
        }

        const nomeDoClube = await this.travarReferenciadas(
          tx,
          companyId,
          gestorId,
          nivelIds,
          linhas,
        );

        if (turmaIds.length > 0) {
          const turmas = await this.travarTurmas(tx, companyId, turmaIds);
          const erros = await errosDeTurma(
            tx,
            companyId,
            turmas,
            naTurma,
            nomesDosNiveis,
            new Date(),
          );
          if (erros.length > 0) {
            throw new RecusaSobATrava(emOrdemDeLinha(erros));
          }
        }

        await this.escreverComPrazo(tx, 'usuarios', () =>
          this.inserirUsuarios(tx, companyId, linhas),
        );
        const criados = await this.escreverComPrazo(tx, 'alunos', () =>
          this.inserirAlunos(tx, companyId, linhas),
        );
        lote.registrarCriados(criados);

        const matriculas = linhas.filter((l) => l.linha.turmaId);
        if (matriculas.length > 0) {
          // AC-049 — sem a trava por aluno, só se matricula quem nasceu aqui.
          lote.exigirCriados(matriculas.map((l) => l.alunoId));
          await this.escreverComPrazo(tx, 'turma_alunos', () =>
            this.inserirMatriculas(tx, matriculas),
          );
        }

        const convidadas = linhas.filter((l) => l.convite);
        if (convidadas.length > 0) {
          await this.escreverComPrazo(tx, 'convites_de_acesso', () =>
            this.inserirConvites(tx, companyId, gestorId, convidadas),
          );
        }

        await naEtapa('reposicao', tx.$queryRaw(REPOSICAO_DO_TIMEOUT));
        return nomeDoClube;
      },
      { timeout: TIMEOUT_DA_IMPORTACAO_MS },
    );
  }

  /**
   * D3, passo 2 (D2b da SPEC-082) — **as linhas que as escritas vão
   * referenciar, travadas antes**: a empresa, os níveis citados e o gestor
   * (`criado_por_id` dos convites), em `FOR KEY SHARE`. Uma instrução, com o
   * `lock_timeout` recalculado num `LATERAL` que depende de cada linha — a
   * checagem de FK das escritas acha a linha já travada pela própria
   * transação, e não espera com um valor antigo.
   *
   * Um nível que sumiu entre a conferência e a trava (o catálogo de níveis
   * trava exclusiva, e espera esta; mas pode ter apagado antes dela) vira erro
   * nas linhas que o citam, e não um `23503` no meio do lote.
   */
  private async travarReferenciadas(
    tx: Prisma.TransactionClient,
    companyId: string,
    gestorId: string,
    nivelIds: readonly string[],
    linhas: readonly LinhaParaEscrever[],
  ): Promise<string> {
    const tabelas = ['empresa', ...nivelIds.map(() => 'nivel'), 'usuario'];
    const ids = [companyId, ...nivelIds, gestorId];
    const achadas = await naEtapa(
      'referenciadas',
      tx.$queryRaw<
        { tabela: string; achado: string | null; empresa_nome: string | null }[]
      >`
      SELECT ref.tabela, coalesce(e.id, n.id, u.id)::text AS achado,
             e.nome AS empresa_nome
        FROM unnest(${tabelas}::text[], ${ids}::uuid[])
               WITH ORDINALITY AS ref(tabela, id, ord)
        CROSS JOIN LATERAL (SELECT set_config('lock_timeout', ${RESTO_DO_PRAZO}, true) AS cfg
                             WHERE ref.id IS NOT NULL) r
        LEFT JOIN LATERAL (SELECT e2.id, e2.nome FROM empresas e2
                            WHERE ref.tabela = 'empresa' AND e2.id = ref.id
                              AND r.cfg IS NOT NULL
                            FOR KEY SHARE) e ON true
        LEFT JOIN LATERAL (SELECT n2.id FROM niveis n2
                            WHERE ref.tabela = 'nivel' AND n2.id = ref.id
                              AND n2.company_id = ${companyId}::uuid
                              AND r.cfg IS NOT NULL
                            FOR KEY SHARE) n ON true
        LEFT JOIN LATERAL (SELECT u2.id FROM usuarios u2
                            WHERE ref.tabela = 'usuario' AND u2.id = ref.id
                              AND u2.company_id = ${companyId}::uuid
                              AND r.cfg IS NOT NULL
                            FOR KEY SHARE) u ON true
       ORDER BY ref.ord`,
    );

    const empresa = achadas.find((a) => a.tabela === 'empresa');
    const gestor = achadas.find((a) => a.tabela === 'usuario');
    if (!empresa?.achado || !gestor?.achado) {
      // O token traz a empresa e o gestor; sumir um dos dois aqui é estado
      // impossível, e não uma recusa ao gestor.
      throw new Error(
        'importação: a empresa ou o gestor do token não existe mais',
      );
    }
    const presentes = new Set(
      achadas
        .filter((a) => a.tabela === 'nivel' && a.achado)
        .map((a) => a.achado),
    );
    const sumidos = nivelIds.filter((id) => !presentes.has(id));
    if (sumidos.length > 0) {
      throw new RecusaSobATrava(
        linhas
          .filter((l) => l.linha.nivelId && sumidos.includes(l.linha.nivelId))
          .map((l) => ({
            linha: l.linha.linha,
            coluna: 'nivel',
            mensagem:
              'O nível desta linha foi apagado depois da conferência. Confira os níveis no Admin e envie de novo.',
          })),
      );
    }
    return empresa.empresa_nome ?? '';
  }

  /**
   * D3, passo 3 — **as turmas do arquivo, `FOR UPDATE` em ordem de `id`**,
   * numa instrução, com o `lock_timeout` recalculado por linha (a forma "duas
   * linhas numa instrução" das pré-provas da SPEC-082): esperar a primeira
   * turma não dá à segunda o prazo inteiro de novo.
   *
   * Devolve as turmas ainda ativas, com os alocados contados sob a trava.
   */
  private async travarTurmas(
    tx: Prisma.TransactionClient,
    companyId: string,
    turmaIds: readonly string[],
  ): Promise<Map<string, TurmaConferida>> {
    const travadas = await naEtapa(
      'turmas',
      tx.$queryRaw<
        {
          id: string;
          nome: string;
          capacidade: number;
          nivel_id: string;
          status: string;
        }[]
      >`
      SELECT t.id::text AS id, t.nome, t.capacidade, t.nivel_id::text AS nivel_id,
             t.status::text AS status
        FROM unnest(${[...turmaIds]}::uuid[]) WITH ORDINALITY AS d(id, ord)
        CROSS JOIN LATERAL (SELECT set_config('lock_timeout', ${RESTO_DO_PRAZO}, true) AS cfg
                             WHERE d.id IS NOT NULL) r
        CROSS JOIN LATERAL (SELECT t2.id, t2.nome, t2.capacidade, t2.nivel_id, t2.status
                              FROM turmas t2
                             WHERE t2.id = d.id AND t2.company_id = ${companyId}::uuid
                               AND r.cfg IS NOT NULL
                             FOR UPDATE) t
       ORDER BY d.ord`,
    );
    const ativas = travadas.filter((t) => t.status === 'ativa');
    const alocados = await contarAlocados(
      tx,
      ativas.map((t) => t.id),
    );
    return new Map(
      ativas.map((t) => [
        t.id,
        {
          id: t.id,
          nome: t.nome,
          capacidade: t.capacidade,
          nivelId: t.nivel_id,
          alocados: alocados.get(t.id) ?? 0,
        },
      ]),
    );
  }

  /**
   * D3, passo 4 — **uma escrita, com o prazo fixado imediatamente antes.** O
   * ajuste e a escrita são duas instruções, e cada uma é marcada com a sua
   * etapa: o `57014` do ajuste, o da escrita e o da reposição são todos 409
   * com o texto I6, mas a prova (AC-051) registra qual foi.
   *
   * A escrita é um `thunk`, e não uma promessa: o Prisma só manda a instrução
   * quando a promessa é criada, e ela tem de sair depois do ajuste.
   */
  private async escreverComPrazo<T>(
    tx: Prisma.TransactionClient,
    etapa: EtapaDeEscrita,
    escrita: () => Promise<T>,
  ): Promise<T> {
    await naEtapa('ajuste', tx.$queryRaw(AJUSTE_DO_PRAZO));
    const inicio = performance.now();
    const resultado = await naEtapa(etapa, escrita());
    this.ganchos.aoMedirEscrita?.(etapa, performance.now() - inicio);
    return resultado;
  }

  /**
   * As escritas são SQL cru em lote — `INSERT … SELECT … FROM unnest(…)`, uma
   * instrução por tabela — e **não** a API de modelo: ela não carrega o `WITH`
   * que recalcula o `lock_timeout` com o marcador `playck.prazo`, que o gate da
   * SPEC-082 procura em toda escrita (DOR-083-R2-03).
   */
  private async inserirUsuarios(
    tx: Prisma.TransactionClient,
    companyId: string,
    linhas: readonly LinhaParaEscrever[],
  ): Promise<void> {
    // INV-008 força a troca no primeiro acesso — a mesma regra do cadastro
    // individual, e a razão de a senha poder sair na resposta uma única vez.
    // A conta convidada também nasce com `senha_temporaria`: o link exige
    // isso (D7), e a senha dela ninguém conhece (D4).
    //
    // As três datas de `usuarios` são TIMESTAMP(3) SEM fuso, e a API de modelo
    // — o cadastro individual, e esta importação antes da SPEC-083 — grava
    // nelas o instante em UTC (o `created_at` e o `@updatedAt` ela mesma
    // preenche). Um `timestamptz` atribuído à coluna seria convertido pelo
    // `TimeZone` da SESSÃO: em `America/Sao_Paulo` a senha temporária
    // valeria 3 h a menos que a do cadastro individual (AC-018 — "idêntica à
    // de hoje"). Daí o `AT TIME ZONE 'UTC'` explícito nas três, e o
    // `created_at` escrito aqui em vez de deixado ao `DEFAULT` do banco, que
    // tem o mesmo deslocamento.
    const expiraEm = senhaTemporariaExpiraEm();
    const gravados = await tx.$executeRaw`
      WITH ${CTE_DO_PRAZO}
      INSERT INTO usuarios (id, email, senha_hash, nome, telefone, role, company_id,
                            senha_temporaria, senha_temporaria_expira_em,
                            created_at, updated_at)
      SELECT d.id, d.email, d.senha_hash, d.nome, nullif(d.telefone, ''),
             'aluno'::usuario_role, ${companyId}::uuid, true,
             (${expiraEm}::timestamptz AT TIME ZONE 'UTC'),
             (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
        FROM unnest(${linhas.map((l) => l.usuarioId)}::uuid[],
                    ${linhas.map((l) => l.linha.email)}::text[],
                    ${linhas.map((l) => l.senhaHash)}::text[],
                    ${linhas.map((l) => l.linha.nome)}::text[],
                    ${linhas.map((l) => l.linha.telefone ?? '')}::text[])
               AS d(id, email, senha_hash, nome, telefone)
       WHERE ${DEPOIS_DO_PRAZO}`;
    exigirGravadas('usuarios', gravados, linhas.length);
  }

  /** Devolve os ids que o `INSERT` gravou — o que o `LoteNovo` cobra. */
  private async inserirAlunos(
    tx: Prisma.TransactionClient,
    companyId: string,
    linhas: readonly LinhaParaEscrever[],
  ): Promise<string[]> {
    // Foi o CLUBE que trouxe estas pessoas: elas não pedem para entrar, já
    // entraram. Mesmo raciocínio do convite (AC-014 da SPEC-009). E o nível
    // vazio vai NULO (S8, ver a conferência).
    //
    // `alunos.created_at` é TIMESTAMP(3) sem fuso, como as de `usuarios`, e é
    // a ordem da lista de alunos (`StudentsService`): deixado ao `DEFAULT`, o
    // importado nasceria, numa sessão fora de UTC, horas "mais velho" que o
    // cadastrado à mão no mesmo minuto. Daí o UTC explícito (ver
    // `inserirUsuarios`).
    const gravados = await tx.$queryRaw<{ id: string }[]>`
      WITH ${CTE_DO_PRAZO}
      INSERT INTO alunos (id, usuario_id, company_id, nivel_id, vinculo,
                          created_at)
      SELECT d.id, d.usuario_id, ${companyId}::uuid,
             nullif(d.nivel_id, '')::uuid, 'aprovado'::vinculo_aluno,
             (now() AT TIME ZONE 'UTC')
        FROM unnest(${linhas.map((l) => l.alunoId)}::uuid[],
                    ${linhas.map((l) => l.usuarioId)}::uuid[],
                    ${linhas.map((l) => l.linha.nivelId ?? '')}::text[])
               AS d(id, usuario_id, nivel_id)
       WHERE ${DEPOIS_DO_PRAZO}
      RETURNING id::text AS id`;
    exigirGravadas('alunos', gravados.length, linhas.length);
    return gravados.map((g) => g.id);
  }

  private async inserirMatriculas(
    tx: Prisma.TransactionClient,
    linhas: readonly LinhaParaEscrever[],
  ): Promise<void> {
    // A turma já é desta transação, pelo `FOR UPDATE`; o aluno nasceu nela.
    // Nenhuma das duas FKs espera. `turma_alunos.created_at` também é
    // TIMESTAMP sem fuso: o instante vai em UTC, como a API de modelo grava.
    const gravados = await tx.$executeRaw`
      WITH ${CTE_DO_PRAZO}
      INSERT INTO turma_alunos (id, turma_id, aluno_id, created_at)
      SELECT gen_random_uuid(), d.turma_id, d.aluno_id,
             (now() AT TIME ZONE 'UTC')
        FROM unnest(${linhas.map((l) => l.linha.turmaId as string)}::uuid[],
                    ${linhas.map((l) => l.alunoId)}::uuid[])
               AS d(turma_id, aluno_id)
       WHERE ${DEPOIS_DO_PRAZO}`;
    exigirGravadas('turma_alunos', gravados, linhas.length);
  }

  private async inserirConvites(
    tx: Prisma.TransactionClient,
    companyId: string,
    gestorId: string,
    linhas: readonly LinhaParaEscrever[],
  ): Promise<void> {
    const convites = linhas.map(
      (l) => l.convite as ConvitePreparado & { id: string },
    );
    // Só o sha256 do token vai ao banco (D6); o token cru fica na memória até
    // o envio, depois do `COMMIT` (INV-083f).
    const gravados = await tx.$executeRaw`
      WITH ${CTE_DO_PRAZO}
      INSERT INTO convites_de_acesso (id, company_id, usuario_id, criado_por_id,
                                      token_hash, impressao_credencial, expira_em)
      SELECT d.id, ${companyId}::uuid, d.usuario_id, ${gestorId}::uuid,
             d.token_hash, d.impressao, d.expira_em::timestamptz
        FROM unnest(${convites.map((c) => c.id)}::uuid[],
                    ${linhas.map((l) => l.usuarioId)}::uuid[],
                    ${convites.map((c) => c.tokenHash)}::text[],
                    ${convites.map((c) => c.impressaoCredencial)}::text[],
                    ${convites.map((c) => c.expiraEm.toISOString())}::text[])
               AS d(id, usuario_id, token_hash, impressao, expira_em)
       WHERE ${DEPOIS_DO_PRAZO}`;
    exigirGravadas('convites_de_acesso', gravados, linhas.length);
  }

  /**
   * SPEC-083/D3, passo 5 — **o que responder depois do rollback.**
   *
   * - conferência refeita sob a trava que achou erro ⇒ `422` com o relatório
   *   refeito agora (o estado que a trava viu já está confirmado); se ele
   *   voltar limpo, o que a trava viu;
   * - **`23505` na etapa de `usuarios`** ⇒ a conferência é refeita fora da
   *   transação, e só um **erro de e-mail** nela vira `422`: a corrida em que
   *   outra transação criou a conta. Sem ele (uma colisão de `id`, por
   *   exemplo), o erro original sobe como `500`, mesmo com erro de turma no
   *   relatório (AC-053);
   * - **`23505` em qualquer outra etapa** ⇒ `500`, sem refazer a conferência.
   *   Nessas tabelas nenhuma unicidade colide numa importação correta (ids
   *   novos, token aleatório): uma colisão ali é defeito, e não se mascara
   *   (AC-052);
   * - o resto sobe como veio, para a tradução da borda.
   *
   * **A causa é a etapa marcada, e nunca o texto do erro** — e a importação
   * não usa o tradutor da ficha (D9).
   */
  private async decidirFalha(
    companyId: string,
    conteudo: string,
    erro: unknown,
  ): Promise<never> {
    if (erro instanceof RecusaSobATrava) {
      const refeita = await this.conferir(companyId, conteudo);
      if (refeita.erros.length > 0) throw planilhaComErros(refeita);
      const linhas = refeita.linhas.filter(
        (l) => !erro.erros.some((e) => e.linha === l.linha),
      );
      throw planilhaComErros({
        ...refeita,
        erros: erro.erros,
        linhas,
        validas: linhas.length,
      });
    }
    if (
      sqlstateDoErro(erro) === '23505' &&
      etapaDaImportacao(erro) === 'usuarios'
    ) {
      const refeita = await this.conferir(companyId, conteudo);
      const deEmail = refeita.erros.some(
        (e) => e.coluna === 'email' && e.mensagem === MENSAGEM_EMAIL_JA_EXISTE,
      );
      if (deEmail) throw planilhaComErros(refeita);
    }
    throw erro;
  }

  /**
   * D8 — **o e-mail, depois do `COMMIT`, e o resultado gravado.** Um envio de
   * dentro da transação, que depois desfizesse, levaria um link para um
   * convite que não existe.
   *
   * Em lote: a porta parte em blocos de 100, com uma chave de idempotência por
   * bloco (AC-032). O modelo e o link são os da ficha
   * (`renderizarConviteDeAcesso`, `URL_CLIENTE` da configuração — nada daqui
   * recebe a requisição, INV-083e).
   *
   * **Nada aqui lança:** a porta não lança por contrato, e a gravação do
   * resultado que falhar deixa o convite sem resultado — a ficha mostra
   * `falhou` com `sem_confirmacao` (D9), e a resposta segue com as senhas.
   */
  private async enviarConvites(
    convites: readonly ConviteDaLinha[],
    nomeDoClube: string,
  ): Promise<Map<number, ResultadoDoEnvio>> {
    const porLinha = new Map<number, ResultadoDoEnvio>();
    if (convites.length === 0) return porLinha;

    let resultados: ResultadoDoEnvio[];
    try {
      resultados = await this.provedor.enviarLote(
        convites.map((c) =>
          renderizarConviteDeAcesso(this.modelos, {
            conviteId: c.conviteId,
            token: c.token,
            para: c.para,
            nomeDoClube,
            nomeDaPessoa: c.nomeDaPessoa,
          }),
        ),
      );
    } catch {
      // A porta não lança (D8); se lançar, é defeito do adaptador, e as
      // contas já existem. Vale como provedor fora do ar.
      resultados = convites.map(() => ({
        ok: false,
        motivo: 'indisponivel',
      }));
    }

    const agora = new Date();
    const grupos = new Map<string, string[]>();
    convites.forEach((c, i) => {
      const r = resultados[i] ?? { ok: false, motivo: 'indisponivel' };
      porLinha.set(c.linha, r);
      const chave = r.ok ? 'enviado' : r.motivo;
      grupos.set(chave, [...(grupos.get(chave) ?? []), c.conviteId]);
    });

    for (const [chave, ids] of grupos) {
      try {
        await this.prisma.conviteDeAcesso.updateMany({
          where: { id: { in: ids } },
          data:
            chave === 'enviado'
              ? { emailResultado: 'enviado', emailMotivo: null, emailEm: agora }
              : {
                  emailResultado: 'falhou',
                  emailMotivo: chave,
                  emailEm: agora,
                },
        });
      } catch {
        // Sem o resultado gravado, a ficha diz `sem_confirmacao` — que é a
        // verdade sobre o que o banco sabe.
        this.logger.warn({
          evento: 'resultado_do_convite_nao_gravado',
          quantidade: ids.length,
        });
      }
      if (chave !== 'enviado') {
        // Só ids e o motivo. Nunca destinatário, link ou token (INV-083f).
        this.logger.warn({
          evento: 'convite_de_acesso_nao_enviado',
          motivo: chave,
          conviteIds: ids,
        });
      }
    }
    return porLinha;
  }
}

/** A mensagem de turma não achada, com até 10 ativas (D3, item 2). */
function mensagemDeTurmaInexistente(
  bruta: string,
  ativas: readonly { nome: string }[],
): string {
  if (ativas.length === 0) {
    return `A turma "${bruta}" não existe — este clube não tem turma ativa.`;
  }
  const nomes = ativas.slice(0, TETO_DE_TURMAS_NA_MENSAGEM).map((t) => t.nome);
  const resto = ativas.length - nomes.length;
  return (
    `A turma "${bruta}" não existe entre as turmas ativas. As ativas são: ${nomes.join(', ')}` +
    (resto > 0 ? ` e mais ${resto}.` : '.')
  );
}

/**
 * Toda escrita grava exatamente as linhas que mandou. O `WHERE` do prazo é
 * sempre verdadeiro; uma contagem diferente é defeito, e desfaz tudo.
 */
function exigirGravadas(
  tabela: EtapaDeEscrita,
  gravadas: number,
  esperadas: number,
): void {
  if (gravadas !== esperadas) {
    throw new Error(
      `importação: ${tabela} gravou ${gravadas} de ${esperadas} linha(s)`,
    );
  }
}

export type TransacaoDeImportacao = Prisma.TransactionClient;
