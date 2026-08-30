import { Injectable } from '@nestjs/common';
import {
  EXPEDIENTE_FIM_HORA,
  EXPEDIENTE_INICIO_HORA,
  mesCorrenteNoFusoDoClube,
} from '../courts/date-time.util';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardResumoResponseDto } from '../courts/dto/booking-response.dto';
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
  async summary(
    companyId: string,
    query: DashboardQueryDto,
  ): Promise<DashboardResumoResponseDto> {
    const periodo = this.resolvePeriodo(query.periodo);

    const [
      alunosAtivos,
      turmasAtivas,
      quadrasAtivas,
      ocupacoesDoPeriodo,
      horariosDaEmpresa,
    ] = await Promise.all([
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
      // SPEC-010/REQ-009: precisamos dos ids, não só da contagem — o
      // denominador passou a depender do horário de cada quadra.
      this.prisma.quadra.findMany({
        where: { companyId, status: 'ativa' },
        select: { id: true },
      }),
      this.prisma.ocupacaoQuadra.findMany({
        where: {
          companyId,
          statusPagamento: { not: 'cancelado' },
          data: { gte: periodo.inicio, lte: periodo.fim },
          quadra: { status: 'ativa' },
        },
        select: { horaInicio: true, horaFim: true },
      }),
      // SPEC-010/NFR-003: **uma** consulta traz todas as regras semanais
      // da empresa (padrão e overrides de quadra). O denominador é
      // somado em memória a partir daqui — consultar por quadra e por
      // dia seria N+1 numa rota agregadora.
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

    return {
      alunosAtivos,
      ocupacaoTurmasPct: this.ocupacaoTurmasPct(turmasAtivas),
      ocupacaoQuadrasPct: this.ocupacaoQuadrasPct(
        ocupacoesDoPeriodo,
        quadrasAtivas.map((q) => q.id),
        periodo,
        horariosDaEmpresa,
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

  /**
   * "Ocupação de quadra" (AC-002, ADR-009): horas ocupadas por qualquer
   * origem sobre horas **realmente disponíveis** no período.
   *
   * SPEC-010/REQ-009 — antes o denominador era
   * `quadras × dias × 16`, com o 16 vindo das constantes de expediente.
   * Isso fazia o KPI errar **para baixo justamente na empresa que abre
   * menos**: quem funciona 6 horas por dia aparecia com um terço da
   * ocupação real, e quem fecha no domingo era penalizado por um dia que
   * nunca existiu.
   *
   * NFR-003 — o denominador é somado **em memória**, a partir de duas
   * listas já carregadas (quadras ativas e as regras semanais da empresa).
   * Consultar o expediente por quadra e por dia seria um N+1 disfarçado:
   * 8 quadras num período de 90 dias viram 720 consultas para produzir um
   * número numa rota agregadora.
   */
  private ocupacaoQuadrasPct(
    ocupacoes: { horaInicio: Date; horaFim: Date }[],
    quadraIds: string[],
    periodo: Periodo,
    horarios: {
      quadraId: string | null;
      diaSemana: number;
      fechado: boolean;
      horaInicio: Date | null;
      horaFim: Date | null;
    }[],
  ): number {
    const horasDisponiveis = this.somarHorasDisponiveis(
      quadraIds,
      periodo,
      horarios,
    );
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

  /**
   * Soma as horas de funcionamento de cada quadra em cada dia do período,
   * aplicando a mesma herança de MOD-005 (horário da quadra vence o padrão
   * da empresa) sobre dados já em memória.
   */
  private somarHorasDisponiveis(
    quadraIds: string[],
    periodo: Periodo,
    horarios: {
      quadraId: string | null;
      diaSemana: number;
      fechado: boolean;
      horaInicio: Date | null;
      horaFim: Date | null;
    }[],
  ): number {
    const horasDe = (linha?: (typeof horarios)[number]): number => {
      if (!linha) {
        // Sem configuração: mesma rede de segurança de MOD-005 — mantém o
        // comportamento anterior à SPEC-010 em vez de zerar o denominador
        // e inflar o KPI para o infinito.
        return HORAS_EXPEDIENTE_POR_DIA;
      }
      if (linha.fechado || !linha.horaInicio || !linha.horaFim) {
        return 0;
      }
      return linha.horaFim.getUTCHours() - linha.horaInicio.getUTCHours();
    };

    let total = 0;
    for (
      let dia = new Date(periodo.inicio);
      dia <= periodo.fim;
      dia.setUTCDate(dia.getUTCDate() + 1)
    ) {
      const diaSemana = dia.getUTCDay();
      for (const quadraId of quadraIds) {
        const daQuadra = horarios.find(
          (h) => h.quadraId === quadraId && h.diaSemana === diaSemana,
        );
        const daEmpresa = horarios.find(
          (h) => h.quadraId === null && h.diaSemana === diaSemana,
        );
        total += horasDe(daQuadra ?? daEmpresa);
      }
    }
    return total;
  }

  private resolvePeriodo(periodo?: string): Periodo {
    // DEF-020: o mês assumido é o do fuso do clube. Em UTC, às 21h de 31 de
    // dezembro o dashboard abria em janeiro — vazio, sem nada explicando.
    const periodoResolvido = periodo ?? mesCorrenteNoFusoDoClube();
    const [anoStr, mesStr] = periodoResolvido.split('-');
    const ano = Number(anoStr);
    const mes = Number(mesStr);

    const inicio = new Date(Date.UTC(ano, mes - 1, 1));
    const fim = new Date(Date.UTC(ano, mes, 0));
    return { inicio, fim, dias: fim.getUTCDate() };
  }
}
