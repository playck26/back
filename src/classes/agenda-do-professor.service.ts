import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { formatTimeOnly, parseDateOnly } from '../courts/date-time.util';

/**
 * SPEC-026 — **o calendário do professor.**
 *
 * Último item da lista de entrega do Israel: *"Calendário → Turma → Alunos →
 * Presença"*. **Metade já estava no ar** — a cadeia Turma → Alunos →
 * Presença funciona desde a SPEC-014. O que faltava era a **entrada pelo
 * dia**: ele começava escolhendo a turma, e o pedido é que comece escolhendo
 * a data.
 *
 * **Serviço próprio, e não um parâmetro no `AgendaService` do gestor.**
 * Aquele é orientado a **quadra** e inclui reserva avulsa — coisas que não
 * são trabalho do professor. Acrescentar um `professorId?` opcional lá faria
 * uma função responder a duas perguntas diferentes, e o `?` acabaria
 * esquecido em alguma chamada. Duas funções separadas não têm esse modo de
 * falha.
 */

/**
 * O estado da chamada de uma aula, **resolvido no servidor**.
 *
 * A tela não interpreta `completude` nem conta presenças: se interpretasse,
 * viraria uma segunda cópia da regra da SPEC-014 — e é sempre a cópia que
 * fica velha.
 *
 * Os três valores foram conferidos no enum, não supostos. A spec chegou a
 * dizer `parcial`, que **não existe**.
 */
export type EstadoDaChamada = 'pendente' | 'feita' | 'legada';

function estadoDaChamada(
  chamada: { completude: string } | null | undefined,
): EstadoDaChamada {
  // Sem linha em `chamadas` é o caso mais comum e o mais importante: é o dia
  // em que o professor esqueceu de registrar, e é para isso que o calendário
  // existe.
  if (!chamada) return 'pendente';
  return chamada.completude === 'completa' ? 'feita' : 'legada';
}

@Injectable()
export class AgendaDoProfessorService {
  constructor(private readonly prisma: PrismaService) {}

  private async professorDoUsuario(companyId: string, usuarioId: string) {
    const professor = await this.prisma.professor.findFirst({
      where: { usuarioId, companyId },
      select: { id: true },
    });
    // `Forbidden` e não `NotFound`: quem chega aqui tem papel `professor` no
    // token mas não tem linha em `professores` — sessão inconsistente, não
    // recurso ausente.
    if (!professor) {
      throw new ForbiddenException();
    }
    return professor;
  }

  /**
   * REQ-001 — o mês, para pintar o calendário.
   *
   * **Por dia: quantas aulas e quantas com chamada pendente.** A segunda
   * contagem é a razão de a tela existir — um calendário que só diz "tem
   * aula terça" repete o que o professor já sabe de cabeça; o que ele não
   * sabe é em quais dias ficou faltando registrar presença.
   *
   * Duas consultas, independentemente do tamanho do mês: as ocupações dele
   * e as chamadas correspondentes. A contagem por dia acontece aqui porque
   * "pendente" é a **ausência** de linha em `chamadas` — um `groupBy` não
   * enxerga o que não existe.
   */
  async resumoDoMes(companyId: string, usuarioId: string, mes: string) {
    const professor = await this.professorDoUsuario(companyId, usuarioId);

    const [ano, mesNum] = mes.split('-').map(Number);
    const inicio = new Date(Date.UTC(ano, mesNum - 1, 1));
    const fim = new Date(Date.UTC(ano, mesNum, 0));

    const ocupacoes = await this.prisma.ocupacaoQuadra.findMany({
      where: this.filtroDasAulasDele(companyId, professor.id, {
        gte: inicio,
        lte: fim,
      }),
      select: {
        id: true,
        data: true,
        // `chamadas` é lista no Prisma, e o comentário do schema explica:
        // a relação é composta e o banco garante UMA por ocorrência, pela
        // PK. Aqui isso vira `[0]`.
        chamadas: { select: { completude: true } },
      },
    });

    const porDia = new Map<string, { aulas: number; pendentes: number }>();
    for (const o of ocupacoes) {
      const dia = o.data.toISOString().slice(0, 10);
      const atual = porDia.get(dia) ?? { aulas: 0, pendentes: 0 };
      atual.aulas += 1;
      if (estadoDaChamada(o.chamadas[0]) === 'pendente') {
        atual.pendentes += 1;
      }
      porDia.set(dia, atual);
    }

    return [...porDia.entries()]
      .map(([data, contagem]) => ({ data, ...contagem }))
      .sort((a, b) => a.data.localeCompare(b.data));
  }

  /**
   * REQ-002 — as aulas de um dia.
   *
   * O `ocupacaoId` que sai daqui é o **mesmo** que
   * `PUT /me/teacher/attendance/:ocupacaoId` aceita (INV-026b). Se os dois
   * divergirem, o caminho do pedido quebra no último passo — e quebraria em
   * silêncio, porque cada metade funcionaria sozinha.
   */
  async detalheDoDia(companyId: string, usuarioId: string, data: string) {
    const professor = await this.professorDoUsuario(companyId, usuarioId);
    const dataDate = parseDateOnly(data);

    const ocupacoes = await this.prisma.ocupacaoQuadra.findMany({
      where: this.filtroDasAulasDele(companyId, professor.id, dataDate),
      include: {
        quadra: { select: { nome: true } },
        origemTurma: { select: { id: true, nome: true } },
        chamadas: { select: { completude: true } },
      },
      orderBy: [{ horaInicio: 'asc' }],
    });

    return ocupacoes.map((o) => ({
      ocupacaoId: o.id,
      turmaId: o.origemTurmaId,
      turmaNome: o.origemTurma?.nome ?? null,
      quadraNome: o.quadra.nome,
      horaInicio: formatTimeOnly(o.horaInicio),
      horaFim: formatTimeOnly(o.horaFim),
      chamada: estadoDaChamada(o.chamadas[0]),
    }));
  }

  /**
   * **O filtro num lugar só** (INV-026a).
   *
   * As duas rotas precisam do mesmo escopo, e escopo repetido é escopo que
   * um dia diverge. Aqui estão as quatro condições, e cada uma tem motivo:
   *
   * - `companyId` e `professorId`: nem aula de outro professor, nem de outra
   *   empresa;
   * - `origemTipo: TURMA`: reserva avulsa não é aula dele;
   * - `cancelado` fora: aula cancelada não é compromisso, e é assim que a
   *   agenda do gestor já se comporta;
   * - `quadra ativa`: quadra desativada não é agenda de ninguém.
   */
  private filtroDasAulasDele(
    companyId: string,
    professorId: string,
    data: Date | { gte: Date; lte: Date },
  ): Prisma.OcupacaoQuadraWhereInput {
    return {
      companyId,
      data,
      origemTipo: 'TURMA' as const,
      statusPagamento: { not: 'cancelado' as const },
      quadra: { status: 'ativa' as const },
      origemTurma: { professorId, companyId },
    };
  }
}
