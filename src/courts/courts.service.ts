import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatDateOnly,
  formatTimeOnly,
  parseDateOnly,
  parseTimeOnly,
} from './date-time.util';
import type { CreateBookingDto } from './dto/create-booking.dto';
import type { CreateCourtDto } from './dto/create-court.dto';
import type { ListBookingsQueryDto } from './dto/list-bookings-query.dto';
import type { UpdateCourtDto } from './dto/update-court.dto';

// Janela de expediente fixa no MVP (06h-22h, slots de 1h) — não há campo
// de horário de funcionamento configurável em DATA_MODEL.md; assumido
// como simplificação razoável, registrado como gap em STATUS.md.
const EXPEDIENTE_INICIO_HORA = 6;
const EXPEDIENTE_FIM_HORA = 22;

interface ConflitoDetectado {
  ocupacaoId: string;
  origemTipo: string;
}

@Injectable()
export class CourtsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(companyId: string, page = 1, pageSize = 20) {
    const [data, total] = await Promise.all([
      this.prisma.quadra.findMany({
        where: { companyId },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.quadra.count({ where: { companyId } }),
    ]);

    return {
      data: data.map((quadra) => this.toQuadraResponse(quadra)),
      page,
      pageSize,
      total,
    };
  }

  async create(companyId: string, dto: CreateCourtDto) {
    const quadra = await this.prisma.quadra.create({
      data: {
        companyId,
        nome: dto.nome,
        esporte: dto.esporte,
        precoHora: dto.precoHora,
      },
    });
    return this.toQuadraResponse(quadra);
  }

  async findOne(companyId: string, id: string) {
    const quadra = await this.prisma.quadra.findFirst({
      where: { id, companyId },
    });
    if (!quadra) {
      throw new NotFoundException();
    }
    return this.toQuadraResponse(quadra);
  }

  async update(companyId: string, id: string, dto: UpdateCourtDto) {
    await this.assertQuadraDaEmpresa(companyId, id);

    const quadra = await this.prisma.quadra.update({
      where: { id },
      data: {
        nome: dto.nome,
        esporte: dto.esporte,
        precoHora: dto.precoHora,
        status: dto.status,
      },
    });
    return this.toQuadraResponse(quadra);
  }

  async availability(companyId: string, quadraId: string, data: string) {
    await this.assertQuadraDaEmpresa(companyId, quadraId);

    const dataDate = parseDateOnly(data);
    const ocupacoes = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        quadraId,
        data: dataDate,
        statusPagamento: { not: 'cancelado' },
      },
    });

    const slots: {
      slot: string;
      status: 'livre' | 'ocupado_turma' | 'ocupado_avulso';
    }[] = [];
    for (
      let hora = EXPEDIENTE_INICIO_HORA;
      hora < EXPEDIENTE_FIM_HORA;
      hora++
    ) {
      const slotInicio = `${String(hora).padStart(2, '0')}:00`;
      const slotFim = `${String(hora + 1).padStart(2, '0')}:00`;
      const slotInicioDate = parseTimeOnly(slotInicio);
      const slotFimDate = parseTimeOnly(slotFim);

      const conflito = ocupacoes.find(
        (ocupacao) =>
          ocupacao.horaInicio < slotFimDate &&
          ocupacao.horaFim > slotInicioDate,
      );

      slots.push({
        slot: `${slotInicio}-${slotFim}`,
        status: !conflito
          ? 'livre'
          : conflito.origemTipo === 'TURMA'
            ? 'ocupado_turma'
            : 'ocupado_avulso',
      });
    }

    return { quadraId, data, slots };
  }

  async createBooking(
    companyId: string,
    dto: CreateBookingDto,
    clientRequestId?: string,
  ) {
    await this.assertQuadraDaEmpresa(companyId, dto.quadraId);

    if (dto.horaFim <= dto.horaInicio) {
      throw new UnprocessableEntityException(
        'horaFim precisa ser depois de horaInicio',
      );
    }

    if (clientRequestId) {
      const existente = await this.prisma.ocupacaoQuadra.findFirst({
        where: { companyId, clientRequestId },
      });
      if (existente) {
        // AC-004: reenvio com o mesmo Idempotency-Key retorna a ocupação
        // já criada na 1ª chamada, não cria uma nova.
        return this.toOcupacaoResponse(existente);
      }
    }

    const dataDate = parseDateOnly(dto.data);
    const horaInicioDate = parseTimeOnly(dto.horaInicio);
    const horaFimDate = parseTimeOnly(dto.horaFim);

    const conflitoExistente = await this.findConflito(
      companyId,
      dto.quadraId,
      dataDate,
      horaInicioDate,
      horaFimDate,
    );
    if (conflitoExistente) {
      throw new ConflictException({
        message: 'Conflito de horário com outra ocupação (INV-001)',
        conflictWith: conflitoExistente,
      });
    }

    try {
      const ocupacao = await this.prisma.ocupacaoQuadra.create({
        data: {
          companyId,
          quadraId: dto.quadraId,
          data: dataDate,
          horaInicio: horaInicioDate,
          horaFim: horaFimDate,
          origemTipo: 'AVULSO',
          alunoId: dto.alunoId,
          clientRequestId,
        },
      });
      return this.toOcupacaoResponse(ocupacao);
    } catch (error) {
      // A constraint EXCLUDE (INV-001) e o índice único de idempotência
      // não têm código Prisma dedicado — qualquer falha de constraint
      // neste insert específico (depois dos pré-checks acima) só pode ser
      // uma dessas duas, ambas tratadas como corrida perdida. A violação de
      // EXCLUDE (23P01) chega como PrismaClientUnknownRequestError (não
      // PrismaClientKnownRequestError, que só cobre os P-códigos que o
      // Prisma reconhece), então as duas precisam ser pegas aqui.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError ||
        error instanceof Prisma.PrismaClientUnknownRequestError
      ) {
        if (clientRequestId) {
          const existente = await this.prisma.ocupacaoQuadra.findFirst({
            where: { companyId, clientRequestId },
          });
          if (existente) {
            return this.toOcupacaoResponse(existente);
          }
        }

        const conflito = await this.findConflito(
          companyId,
          dto.quadraId,
          dataDate,
          horaInicioDate,
          horaFimDate,
        );
        throw new ConflictException({
          message: 'Conflito de horário com outra ocupação (INV-001)',
          conflictWith: conflito ?? undefined,
        });
      }
      throw error;
    }
  }

  async listBookings(companyId: string, query: ListBookingsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.OcupacaoQuadraWhereInput = {
      companyId,
      ...(query.status ? { statusPagamento: query.status } : {}),
      ...(query.data ? { data: parseDateOnly(query.data) } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.ocupacaoQuadra.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ data: 'desc' }, { horaInicio: 'asc' }],
      }),
      this.prisma.ocupacaoQuadra.count({ where }),
    ]);

    return {
      data: data.map((ocupacao) => this.toOcupacaoResponse(ocupacao)),
      page,
      pageSize,
      total,
    };
  }

  async cancelBooking(companyId: string, id: string): Promise<void> {
    const ocupacao = await this.prisma.ocupacaoQuadra.findFirst({
      where: { id, companyId },
    });
    if (!ocupacao) {
      throw new NotFoundException();
    }

    // AC-003: cancelar libera o slot imediatamente — a constraint EXCLUDE
    // já ignora linhas com status_pagamento = 'cancelado' (WHERE da
    // migration), então essa escrita sozinha já resolve.
    await this.prisma.ocupacaoQuadra.update({
      where: { id },
      data: { statusPagamento: 'cancelado' },
    });
  }

  private async assertQuadraDaEmpresa(
    companyId: string,
    quadraId: string,
  ): Promise<void> {
    const quadra = await this.prisma.quadra.findFirst({
      where: { id: quadraId, companyId },
    });
    if (!quadra) {
      throw new NotFoundException();
    }
  }

  private async findConflito(
    companyId: string,
    quadraId: string,
    data: Date,
    horaInicio: Date,
    horaFim: Date,
  ): Promise<ConflitoDetectado | null> {
    const conflito = await this.prisma.ocupacaoQuadra.findFirst({
      where: {
        companyId,
        quadraId,
        data,
        statusPagamento: { not: 'cancelado' },
        horaInicio: { lt: horaFim },
        horaFim: { gt: horaInicio },
      },
    });
    return conflito ? this.toConflictWith(conflito) : null;
  }

  private toConflictWith(ocupacao: {
    id: string;
    origemTipo: string;
  }): ConflitoDetectado {
    return { ocupacaoId: ocupacao.id, origemTipo: ocupacao.origemTipo };
  }

  private toQuadraResponse(quadra: {
    id: string;
    companyId: string;
    nome: string;
    esporte: string;
    precoHora: Prisma.Decimal;
    status: string;
    createdAt: Date;
  }) {
    return {
      id: quadra.id,
      companyId: quadra.companyId,
      nome: quadra.nome,
      esporte: quadra.esporte,
      precoHora: quadra.precoHora.toNumber(),
      status: quadra.status,
      createdAt: quadra.createdAt,
    };
  }

  private toOcupacaoResponse(ocupacao: {
    id: string;
    companyId: string;
    quadraId: string;
    data: Date;
    horaInicio: Date;
    horaFim: Date;
    origemTipo: string;
    alunoId: string | null;
    statusPagamento: string;
  }) {
    return {
      id: ocupacao.id,
      companyId: ocupacao.companyId,
      quadraId: ocupacao.quadraId,
      data: formatDateOnly(ocupacao.data),
      horaInicio: formatTimeOnly(ocupacao.horaInicio),
      horaFim: formatTimeOnly(ocupacao.horaFim),
      origemTipo: ocupacao.origemTipo,
      alunoId: ocupacao.alunoId,
      statusPagamento: ocupacao.statusPagamento,
    };
  }
}
