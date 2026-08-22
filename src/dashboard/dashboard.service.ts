import { Injectable } from '@nestjs/common';
import {
  EXPEDIENTE_FIM_HORA,
  EXPEDIENTE_INICIO_HORA,
} from '../courts/date-time.util';
import { PrismaService } from '../prisma/prisma.service';
import type { DashboardQueryDto } from './dto/dashboard-query.dto';

const HORAS_EXPEDIENTE_POR_DIA = EXPEDIENTE_FIM_HORA - EXPEDIENTE_INICIO_HORA;

interface Periodo {
  inicio: Date;
  fim: Date;
  dias: number;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  // MOD-007 (CON-007.1, REQ-006): agregação somente-leitura sobre tabelas
  // de MOD-003/004/005 — dashboard não tem tabela própria
  // (TARGET_ARCHITECTURE.md seção 5), então lê Prisma direto (ao contrário
  // do caminho de escrita de MOD-004→MOD-005, que passa por método
  // público — aqui não há escrita nenhuma).
  async summary(companyId: string, query: DashboardQueryDto) {
    const periodo = this.resolvePeriodo(query.periodo);

    const [alunosAtivos, turmasAtivas, quadrasAtivasCount, ocupacoesDoPeriodo] =
      await Promise.all([
        // SPEC-009/REQ-010: `status` sozinho passou a ser insuficiente —
        // com auto-cadastro público ligado, qualquer desconhecido que
        // preenchesse o formulário entraria no KPI de "alunos ativos" da
        // empresa. Conta só quem a empresa reconhece (INV-010).
        this.prisma.aluno.count({
          where: { companyId, status: 'ativo', vinculo: 'aprovado' },
        }),
        this.prisma.turma.findMany({
          where: { companyId, status: 'ativa' },
          select: { capacidade: true, _count: { select: { alunos: true } } },
        }),
        this.prisma.quadra.count({ where: { companyId, status: 'ativa' } }),
        this.prisma.ocupacaoQuadra.findMany({
          where: {
            companyId,
            statusPagamento: { not: 'cancelado' },
            data: { gte: periodo.inicio, lte: periodo.fim },
            quadra: { status: 'ativa' },
          },
          select: { horaInicio: true, horaFim: true },
        }),
      ]);

    return {
      alunosAtivos,
      ocupacaoTurmasPct: this.ocupacaoTurmasPct(turmasAtivas),
      ocupacaoQuadrasPct: this.ocupacaoQuadrasPct(
        ocupacoesDoPeriodo,
        quadrasAtivasCount,
        periodo.dias,
      ),
    };
  }

  // "Ocupação de turma": alunos alocados sobre capacidade total das
  // turmas ativas (o quanto as turmas existentes estão cheias) — não é
  // escopado por período, é um retrato do momento (alocação em
  // `turma_alunos` não tem data própria, DATA_MODEL.md).
  private ocupacaoTurmasPct(
    turmasAtivas: { capacidade: number; _count: { alunos: number } }[],
  ): number {
    const capacidadeTotal = turmasAtivas.reduce(
      (soma, turma) => soma + turma.capacidade,
      0,
    );
    if (capacidadeTotal === 0) {
      return 0;
    }
    const alocadosTotal = turmasAtivas.reduce(
      (soma, turma) => soma + turma._count.alunos,
      0,
    );
    return Math.round((alocadosTotal / capacidadeTotal) * 100);
  }

  // "Ocupação de quadra" (AC-002, ADR-009): horas ocupadas por qualquer
  // origem (TURMA ou AVULSO, somadas numa única porcentagem) sobre horas
  // disponíveis no período — quadras ativas × dias do período × horas de
  // expediente (mesma janela fixa 06h-22h da grade de disponibilidade).
  private ocupacaoQuadrasPct(
    ocupacoes: { horaInicio: Date; horaFim: Date }[],
    quadrasAtivasCount: number,
    diasNoPeriodo: number,
  ): number {
    const horasDisponiveis =
      quadrasAtivasCount * diasNoPeriodo * HORAS_EXPEDIENTE_POR_DIA;
    if (horasDisponiveis === 0) {
      return 0;
    }
    const horasOcupadas = ocupacoes.reduce(
      (soma, ocupacao) =>
        soma +
        (ocupacao.horaFim.getTime() - ocupacao.horaInicio.getTime()) /
          3_600_000,
      0,
    );
    return Math.round((horasOcupadas / horasDisponiveis) * 100);
  }

  private resolvePeriodo(periodo?: string): Periodo {
    const hoje = new Date();
    const periodoResolvido =
      periodo ??
      `${hoje.getUTCFullYear()}-${String(hoje.getUTCMonth() + 1).padStart(2, '0')}`;
    const [anoStr, mesStr] = periodoResolvido.split('-');
    const ano = Number(anoStr);
    const mes = Number(mesStr);

    const inicio = new Date(Date.UTC(ano, mes - 1, 1));
    const fim = new Date(Date.UTC(ano, mes, 0));
    return { inicio, fim, dias: fim.getUTCDate() };
  }
}
