import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  candidataASemParticipantes,
  type OcorrenciaParaEstado,
} from '../classes/estado-da-chamada';
import {
  carregarConjuntos,
  type LeitorDeConjuntos,
} from '../classes/ocupacao-da-ocorrencia';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SPEC-057/TASK-001/D3-D4 — **o corte da presença automática, lido do banco.**
 *
 * O corte é `config_presenca_automatica.ativada_em`: o instante em que o
 * operador ligou o fechamento automático pela primeira vez neste ambiente. Ele
 * separa as aulas que continuam na regra legada (terminaram em ou antes dele)
 * das que o job fecha — e das que viram `sem_participantes`.
 *
 * **Só leitura, e sem modelo Prisma de propósito.** A credencial da aplicação
 * tem apenas `SELECT` nesta tabela (INV-146); um modelo Prisma convidaria a um
 * `update` que o banco recusaria com `42501` em produção e aceitaria no teste
 * como superusuário.
 *
 * Linha ausente é tratada como "nunca ativado" (corte nulo): o leitor não
 * inventa ativação, e o worker, que precisa distinguir os dois casos, lê a
 * linha inteira por conta própria.
 */
@Injectable()
export class CorteDaPresenca {
  constructor(private readonly prisma: PrismaService) {}

  async ler(
    db: Pick<Prisma.TransactionClient, '$queryRaw'> = this.prisma,
  ): Promise<Date | null> {
    const linhas = await db.$queryRaw<{ ativadaEm: Date | null }[]>`
      SELECT ativada_em AS "ativadaEm"
        FROM public.config_presenca_automatica
       WHERE id = 1
    `;
    return linhas[0]?.ativadaEm ?? null;
  }
}

/** Uma ocorrência que um consumidor quer resolver, com a turma dela. */
export type OcorrenciaComTurma = OcorrenciaParaEstado & {
  id: string;
  turmaId: string | null;
};

/**
 * SPEC-057/TASK-001/D4 — `|M ∪ V|` **só das candidatas**.
 *
 * Quem é candidata decide o resolvedor (`candidataASemParticipantes`), e não
 * o consumidor: é a mesma pergunta nos cinco lugares, e a cópia é sempre a
 * que envelhece. Sem corte, nenhuma é candidata e nenhuma consulta sai daqui —
 * o ambiente que nunca ativou paga zero.
 *
 * `M` são as matrículas atuais e `V` os visitantes com reposição naquela
 * ocorrência; falta avisada **não** tira ninguém de `M` (LIM-057m).
 */
export async function participantesDasCandidatas(
  db: LeitorDeConjuntos,
  companyId: string,
  corte: Date | null,
  ocorrencias: readonly OcorrenciaComTurma[],
  agora: Date = new Date(),
): Promise<Map<string, number>> {
  const candidatas = ocorrencias.filter(
    (o): o is OcorrenciaComTurma & { turmaId: string } =>
      o.turmaId !== null && candidataASemParticipantes({ ...o, corte }, agora),
  );
  const contagem = new Map<string, number>();
  if (candidatas.length === 0) return contagem;

  const conjuntos = await carregarConjuntos(
    db,
    companyId,
    candidatas.map((o) => ({ id: o.id, turmaId: o.turmaId })),
  );
  for (const o of candidatas) {
    const c = conjuntos.get(o.id);
    const todos = new Set([
      ...(c?.matriculados ?? []),
      ...(c?.visitantes ?? []),
    ]);
    contagem.set(o.id, todos.size);
  }
  return contagem;
}
