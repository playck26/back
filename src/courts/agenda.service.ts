import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatDateOnly,
  formatTimeOnly,
  parseDateOnly,
} from './date-time.util';
import {
  HorarioFuncionamentoService,
  type LinhaHorario,
} from './horario-funcionamento.service';

export interface DiaDaAgenda {
  data: string;
  total: number;
  pendentes: number;
  /** SPEC-012/AC-008: dia sem nada reservado **e** com tudo fechado. */
  fechado: boolean;
}

export interface ItemDoDia {
  id: string;
  quadraNome: string;
  horaInicio: string;
  horaFim: string;
  origemTipo: 'AVULSO' | 'TURMA';
  responsavel: string | null;
  statusPagamento: string;
}

/**
 * SPEC-012 (MOD-005) — agenda do gestor.
 *
 * Leitura agregada, sem tabela própria: mesmo papel de MOD-007
 * (`TARGET_ARCHITECTURE.md`, seção de ownership). **Não cria nenhum
 * endpoint de escrita** — cancelar e marcar pago já existem, com suas
 * regras de autorização e as transições corrigidas em SPEC-012:TASK-000.
 */
@Injectable()
export class AgendaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly horarios: HorarioFuncionamentoService,
  ) {}

  /**
   * Resumo do mês: por dia, quantas ocupações e quantas pendentes.
   *
   * NFR-001 — **três consultas, independentemente do tamanho do mês ou do
   * número de quadras**: a agregação por dia, as quadras ativas e as
   * regras semanais. A agregação acontece no banco (`groupBy`), não em
   * memória sobre a lista de ocupações.
   */
  async resumoDoMes(companyId: string, mes: string): Promise<DiaDaAgenda[]> {
    const [ano, mesNum] = mes.split('-').map(Number);
    const inicio = new Date(Date.UTC(ano, mesNum - 1, 1));
    const fim = new Date(Date.UTC(ano, mesNum, 0));

    const [grupos, quadrasAtivas, linhas] = await Promise.all([
      this.prisma.ocupacaoQuadra.groupBy({
        by: ['data', 'statusPagamento'],
        where: {
          companyId,
          data: { gte: inicio, lte: fim },
          // Cancelada não ocupa a quadra (a constraint EXCLUDE a ignora),
          // então não deve aparecer como compromisso na agenda.
          statusPagamento: { not: 'cancelado' },
          // Quadra inativa não é agenda de ninguém.
          quadra: { status: 'ativa' },
        },
        _count: { _all: true },
      }),
      this.prisma.quadra.findMany({
        where: { companyId, status: 'ativa' },
        select: { id: true },
      }),
      this.prisma.horarioFuncionamento.findMany({
        where: { companyId },
        select: {
          quadraId: true,
          diaSemana: true,
          fechado: true,
          horaInicio: true,
          horaFim: true,
        },
      }),
    ]);

    const porDia = new Map<string, { total: number; pendentes: number }>();
    for (const g of grupos) {
      const chave = formatDateOnly(g.data);
      const atual = porDia.get(chave) ?? { total: 0, pendentes: 0 };
      atual.total += g._count._all;
      if (g.statusPagamento === 'pendente_pagamento') {
        atual.pendentes += g._count._all;
      }
      porDia.set(chave, atual);
    }

    const dias: DiaDaAgenda[] = [];
    for (
      const dia = new Date(inicio);
      dia <= fim;
      dia.setUTCDate(dia.getUTCDate() + 1)
    ) {
      const chave = formatDateOnly(dia);
      const contagem = porDia.get(chave) ?? { total: 0, pendentes: 0 };
      dias.push({
        data: chave,
        total: contagem.total,
        pendentes: contagem.pendentes,
        fechado: this.tudoFechado(quadrasAtivas, linhas, dia.getUTCDay()),
      });
    }
    return dias;
  }

  /** Detalhe de um dia: o que aparece no pop-up (REQ-002). */
  async detalheDoDia(companyId: string, data: string): Promise<ItemDoDia[]> {
    const dataDate = parseDateOnly(data);

    // NFR-002: `include` explícito resolve os nomes de uma vez — sem N+1
    // para descobrir quem reservou.
    const ocupacoes = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        data: dataDate,
        statusPagamento: { not: 'cancelado' },
        quadra: { status: 'ativa' },
      },
      include: {
        quadra: { select: { nome: true } },
        aluno: { include: { usuario: { select: { nome: true } } } },
        origemTurma: { select: { nome: true } },
      },
      orderBy: [{ horaInicio: 'asc' }, { quadraId: 'asc' }],
    });

    return ocupacoes.map((o) => ({
      id: o.id,
      quadraNome: o.quadra.nome,
      horaInicio: formatTimeOnly(o.horaInicio),
      horaFim: formatTimeOnly(o.horaFim),
      origemTipo: o.origemTipo,
      // AC-004: ocupação de turma não tem `aluno_id` — quem responde por
      // ela é a turma. Mesma razão do AC-019 de SPEC-010.
      responsavel:
        o.origemTipo === 'TURMA'
          ? (o.origemTurma?.nome ?? null)
          : (o.aluno?.usuario.nome ?? null),
      statusPagamento: o.statusPagamento,
    }));
  }

  /**
   * AC-010 — resolvido **em memória**, sobre listas carregadas uma vez.
   *
   * Chamar `HorarioFuncionamentoService.resolver` por quadra e por dia
   * seriam até `31 × quadras` consultas (248 com 8 quadras) para dizer
   * quais dias do mês estão fechados. É o mesmo N+1 que a validação
   * cruzada da SPEC-010 baniu no KPI do dashboard, e que a validação da
   * SPEC-012 pegou tentando voltar por outra spec.
   */
  private tudoFechado(
    quadras: { id: string }[],
    linhas: LinhaHorario[],
    diaSemana: number,
  ): boolean {
    if (quadras.length === 0) {
      // Sem quadra ativa não há o que abrir — mas "fechado" aqui
      // descreveria mal a situação: a empresa não tem quadra, não está de
      // portas fechadas. A tela trata o caso vazio antes de chegar aqui.
      return false;
    }
    return quadras.every(
      (q) =>
        this.horarios.resolverDeLinhas(linhas, q.id, diaSemana).estado ===
        'fechado',
    );
  }
}
