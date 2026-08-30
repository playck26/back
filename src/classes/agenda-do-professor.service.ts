import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CompletudeChamada, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { formatTimeOnly, parseDateOnly } from '../courts/date-time.util';
import {
  resolverEstadoDaChamada,
  type EstadoDaChamada,
} from './estado-da-chamada';

export type { EstadoDaChamada };

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
 * SPEC-030 — **a regra saiu daqui.**
 *
 * Este arquivo tinha a sua própria `estadoDaChamada`, e ela era uma de
 * **quatro** respostas diferentes para a mesma pergunta no `Back`. A regra
 * agora mora em `estado-da-chamada.ts`, com a história inteira e o motivo de
 * o cabeçalho mandar sobre a contagem de presenças (INV-030b).
 *
 * O que este serviço mantém é o que é dele: **o calendário nunca vê
 * `cancelada`**, porque `filtroDasAulasDele` tira a aula cancelada antes da
 * consulta. O resolvedor sabe devolver esse estado; aqui ele não aparece.
 *
 * A lição da SPEC-027 continua valendo e agora está no resolvedor: são três
 * momentos, não dois, e `em_andamento` **não** é pendência — o ponto
 * vermelho significa "você esqueceu", não "está acontecendo agora".
 */
function estadoDaChamada(
  chamada: { completude: CompletudeChamada } | null | undefined,
  data: Date,
  horaInicio: Date,
  horaFim: Date,
  agora: Date = new Date(),
): EstadoDaChamada {
  return resolverEstadoDaChamada(
    {
      // Fixo, e é verdade **porque `filtroDasAulasDele` já tirou a
      // cancelada da consulta** — a query nem seleciona `statusPagamento`.
      // Se aquele filtro deixar de excluir cancelada, este `false` vira
      // mentira: os dois andam juntos, e é por isso que o filtro está a
      // poucas linhas daqui, num método só (INV-026a).
      cancelada: false,
      completude: chamada?.completude,
      data,
      horaInicio,
      horaFim,
    },
    agora,
  );
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
        // SPEC-027: o estado passou a depender da HORA, não só do dia — uma
        // aula das 18h ainda não aconteceu às 8h da manhã do mesmo dia.
        horaInicio: true,
        horaFim: true,
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
      // SPEC-027 — só conta como pendência a aula que JÁ TERMINOU sem
      // chamada. `futura` e `em_andamento` não são esquecimento, e pintar o
      // ponto vermelho nelas fazia o calendário cobrar o professor por uma
      // aula que ele ainda vai dar.
      if (
        estadoDaChamada(o.chamadas[0], o.data, o.horaInicio, o.horaFim) ===
        'pendente'
      ) {
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
      chamada: estadoDaChamada(o.chamadas[0], o.data, o.horaInicio, o.horaFim),
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
   *   agenda do gestor já se comporta.
   *
   * **`quadra: { status: 'ativa' }` saiu daqui — validação cruzada, achado 2.**
   *
   * Ele estava justificado como *"quadra desativada não é agenda de
   * ninguém"*, e isso **contradizia uma decisão que esta mesma spec já tinha
   * tomado**: na dúvida 3, turma inativa continua aparecendo, porque quem
   * deu a aula precisa poder registrar a presença. Desativar uma quadra em
   * setembro não desfaz a aula que aconteceu nela em agosto.
   *
   * O sintoma era exatamente o que o achado descreve: `GET .../attendance/:id`
   * aceitava a ocorrência e o calendário não a mostrava. O relatório leu isso
   * como "a chamada está frouxa". Era o contrário — **a agenda estava
   * escondendo aula do próprio professor**, e ele ficava sem caminho para
   * lançar uma chamada que o sistema aceitaria.
   *
   * O que **continua** assimétrico, de propósito: a chamada aceita ocorrência
   * cancelada no `GET` e a recusa no `PUT`, enquanto a agenda não a mostra.
   * Aula cancelada é o assunto da próxima spec (LIM-026a) e o lugar de
   * resolver isso é lá, não num remendo aqui.
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
      origemTurma: { professorId, companyId },
    };
  }
}
