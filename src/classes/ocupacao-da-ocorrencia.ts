import type { Prisma } from '@prisma/client';

/**
 * SPEC-057/TASK-005/D17 — **a ocupação de uma ocorrência de turma, por
 * conjuntos.** Um lugar só, e três leitores: a agenda do gestor, as
 * oportunidades de reposição do aluno e a recusa do `POST` de reposição
 * (INV-145).
 *
 * ## Por que conjuntos, e não a conta de contagens da SPEC-046
 *
 * `matriculados − faltas + reposições` erra em dois casos que acontecem de
 * verdade, e o veredito v4 reproduziu os dois pelos serviços reais:
 *
 * - **o ex-matriculado com falta retida.** A falta avisada continua valendo
 *   para crédito e auditoria depois que ele sai da turma, e a conta antiga a
 *   subtrai de uma matrícula que já não existe — capacidade 2, zero
 *   matriculados e uma falta davam **três vagas**;
 * - **o matriculado que também é visitante** da mesma ocorrência (marcou
 *   reposição antes de ser alocado): a conta antiga o soma duas vezes.
 *
 * Com `M` = matriculados atuais, `F` = faltas avisadas da ocorrência e `V` =
 * visitantes com reposição ativa nela:
 *
 * - `faltasAvisadas = |M ∩ F|` — só quem ainda é da turma libera vaga;
 * - `reposicoesMarcadas = |V|` — o que o detalhe lista;
 * - `reposicoesNaOcupacao = |V menos (M menos F)|` — o visitante que ainda
 *   não estava contado como membro presente;
 * - `ocupados = |(M menos F) ∪ V|`;
 * - `vagasNaOcorrencia = max(0, capacidade − ocupados)`.
 *
 * **Isto não é a capacidade de MATRÍCULA**, que continua sendo `|M|` contra
 * `turmas.capacidade` em `allocateStudent`: vaga de reposição não vira vaga de
 * matrícula, e o diálogo da agenda mostra as duas coisas separadas.
 *
 * **Mecanismo: só aplicação.** Capacidade é contagem com subtração e não cabe
 * em `CHECK` nem em `EXCLUDE` (a mesma declaração da SPEC-046); quem serializa
 * a escrita é o lock da turma no `POST`.
 */
export interface ConjuntosDaOcorrencia {
  matriculados: ReadonlySet<string>;
  faltas: ReadonlySet<string>;
  visitantes: ReadonlySet<string>;
}

export interface OcupacaoDaOcorrencia {
  capacidade: number;
  matriculados: number;
  faltasAvisadas: number;
  reposicoesMarcadas: number;
  reposicoesNaOcupacao: number;
  ocupados: number;
  vagasNaOcorrencia: number;
  /** `ocupados >= capacidade`. O excedente continua visível em `ocupados`. */
  cheia: boolean;
}

export function calcularOcupacao(
  capacidade: number,
  { matriculados, faltas, visitantes }: ConjuntosDaOcorrencia,
): OcupacaoDaOcorrencia {
  let faltasAvisadas = 0;
  const presentes = new Set<string>();
  for (const aluno of matriculados) {
    if (faltas.has(aluno)) faltasAvisadas += 1;
    else presentes.add(aluno);
  }

  let reposicoesNaOcupacao = 0;
  for (const aluno of visitantes) {
    if (!presentes.has(aluno)) reposicoesNaOcupacao += 1;
  }

  const ocupados = presentes.size + reposicoesNaOcupacao;
  return {
    capacidade,
    matriculados: matriculados.size,
    faltasAvisadas,
    reposicoesMarcadas: visitantes.size,
    reposicoesNaOcupacao,
    ocupados,
    vagasNaOcorrencia: Math.max(0, capacidade - ocupados),
    cheia: ocupados >= capacidade,
  };
}

/** Basta o cliente do Prisma ou uma transação: só estas três tabelas são lidas. */
export type LeitorDeConjuntos = Pick<
  Prisma.TransactionClient,
  'turmaAluno' | 'faltaAvisada' | 'reposicaoDeAula'
>;

/**
 * Os três conjuntos de cada ocorrência, **em três consultas para a janela
 * inteira** (NFR-001) — nunca uma por item. Vinte ou duzentas ocorrências
 * custam o mesmo número de idas ao banco.
 *
 * `turma_alunos` não tem `company_id`: o escopo vem das `turmaId` de
 * ocorrências que o chamador já leu filtradas pela empresa. Faltas e
 * reposições têm, e o filtro vai junto por higiene.
 *
 * Só IDs saem daqui. Nome de aluno é carregado pelo detalhe, ao abrir o
 * diálogo, e não por item da semana.
 */
export async function carregarConjuntos(
  db: LeitorDeConjuntos,
  companyId: string,
  ocorrencias: readonly { id: string; turmaId: string }[],
): Promise<Map<string, ConjuntosDaOcorrencia>> {
  const resultado = new Map<string, ConjuntosDaOcorrencia>();
  if (ocorrencias.length === 0) return resultado;

  const ocupacaoIds = ocorrencias.map((o) => o.id);
  const turmaIds = [...new Set(ocorrencias.map((o) => o.turmaId))];

  const [matriculas, faltas, reposicoes] = await Promise.all([
    db.turmaAluno.findMany({
      where: { turmaId: { in: turmaIds } },
      select: { turmaId: true, alunoId: true },
    }),
    db.faltaAvisada.findMany({
      where: { companyId, ocupacaoId: { in: ocupacaoIds } },
      select: { ocupacaoId: true, alunoId: true },
    }),
    db.reposicaoDeAula.findMany({
      where: { companyId, ocupacaoId: { in: ocupacaoIds } },
      select: { ocupacaoId: true, alunoId: true },
    }),
  ]);

  const porTurma = agrupar(matriculas, (m) => m.turmaId);
  const faltasPorOcorrencia = agrupar(faltas, (f) => f.ocupacaoId);
  const visitasPorOcorrencia = agrupar(reposicoes, (r) => r.ocupacaoId);

  for (const o of ocorrencias) {
    resultado.set(o.id, {
      matriculados: porTurma.get(o.turmaId) ?? new Set(),
      faltas: faltasPorOcorrencia.get(o.id) ?? new Set(),
      visitantes: visitasPorOcorrencia.get(o.id) ?? new Set(),
    });
  }
  return resultado;
}

function agrupar<T extends { alunoId: string }>(
  linhas: readonly T[],
  chave: (linha: T) => string,
): Map<string, Set<string>> {
  const mapa = new Map<string, Set<string>>();
  for (const linha of linhas) {
    const k = chave(linha);
    const conjunto = mapa.get(k);
    if (conjunto) conjunto.add(linha.alunoId);
    else mapa.set(k, new Set([linha.alunoId]));
  }
  return mapa;
}
