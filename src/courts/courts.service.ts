import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  EXPEDIENTE_FIM_HORA,
  EXPEDIENTE_INICIO_HORA,
  formatDateOnly,
  formatTimeOnly,
  parseDateOnly,
  parseTimeOnly,
} from './date-time.util';
import type { CreateBookingDto } from './dto/create-booking.dto';
import type { CreateCourtDto } from './dto/create-court.dto';
import type { ListBookingsQueryDto } from './dto/list-bookings-query.dto';
import type { UpdateCourtDto } from './dto/update-court.dto';

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

  // `alunoIdScope` (SPEC-005): quando o chamador é `aluno`, o controller
  // resolve o próprio `aluno.id` e passa aqui para escopar a listagem só
  // às reservas do próprio aluno (REQ-005/AC-002) — `company_admin` chama
  // sem esse parâmetro e continua vendo tudo da empresa, como antes.
  async listBookings(
    companyId: string,
    query: ListBookingsQueryDto,
    alunoIdScope?: string,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.OcupacaoQuadraWhereInput = {
      companyId,
      ...(alunoIdScope ? { alunoId: alunoIdScope } : {}),
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

  // Método público chamado por MOD-004 (ClassesService) para registrar o
  // compromisso de horário recorrente de uma turma — nunca por escrita
  // direta em `ocupacoes_quadra` (DATA_MODEL.md, TARGET_ARCHITECTURE.md
  // seção 6: MOD-005 continua dono exclusivo da tabela, evita o ciclo
  // MOD-004↔MOD-005). Recebe o `tx` da transação aberta por quem chama
  // (ClassesService.create/update) para que turma + ocupações sejam
  // all-or-nothing na mesma transação (NFR-001). `createMany` insere as N
  // ocorrências numa única instrução SQL (NFR-002), não N chamadas.
  async registerClassOccupancy(
    tx: Prisma.TransactionClient,
    companyId: string,
    quadraId: string,
    turmaId: string,
    ocorrencias: { data: Date; horaInicio: Date; horaFim: Date }[],
  ): Promise<void> {
    const conflitos: ConflitoDetectado[] = [];
    for (const ocorrencia of ocorrencias) {
      const conflito = await tx.ocupacaoQuadra.findFirst({
        where: {
          companyId,
          quadraId,
          data: ocorrencia.data,
          statusPagamento: { not: 'cancelado' },
          horaInicio: { lt: ocorrencia.horaFim },
          horaFim: { gt: ocorrencia.horaInicio },
        },
      });
      if (conflito) {
        conflitos.push(this.toConflictWith(conflito));
      }
    }
    if (conflitos.length > 0) {
      throw new ConflictException({
        message:
          'Conflito de horário com ocupação existente na quadra (INV-001)',
        conflicts: conflitos,
      });
    }

    try {
      await tx.ocupacaoQuadra.createMany({
        data: ocorrencias.map((ocorrencia) => ({
          companyId,
          quadraId,
          data: ocorrencia.data,
          horaInicio: ocorrencia.horaInicio,
          horaFim: ocorrencia.horaFim,
          origemTipo: 'TURMA' as const,
          origemTurmaId: turmaId,
        })),
      });
    } catch (error) {
      // Mesma corrida perdida de createBooking (INV-001): a violação da
      // EXCLUDE constraint não tem P-código dedicado no Prisma.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError ||
        error instanceof Prisma.PrismaClientUnknownRequestError
      ) {
        throw new ConflictException({
          message:
            'Conflito de horário com ocupação existente na quadra (INV-001)',
        });
      }
      throw error;
    }
  }

  // Cancela (libera) as ocupações futuras ainda não canceladas geradas por
  // uma turma — usado por MOD-004 quando o admin edita o horário
  // recorrente (quadra/dia/hora), antes de gerar as novas ocorrências via
  // registerClassOccupancy, dentro da mesma transação.
  async cancelFutureClassOccupancies(
    tx: Prisma.TransactionClient,
    companyId: string,
    turmaId: string,
    aPartirDe: Date,
  ): Promise<void> {
    await tx.ocupacaoQuadra.updateMany({
      where: {
        companyId,
        origemTipo: 'TURMA',
        origemTurmaId: turmaId,
        statusPagamento: { not: 'cancelado' },
        data: { gte: aPartirDe },
      },
      data: { statusPagamento: 'cancelado' },
    });
  }

  // `alunoIdScope` (SPEC-005): quando o chamador é `aluno`, só pode
  // cancelar reserva onde `aluno_id` bate com o próprio — "dono da reserva
  // ou company_admin" (API_CONTRACTS.md CON-005.6).
  async cancelBooking(
    companyId: string,
    id: string,
    alunoIdScope?: string,
  ): Promise<void> {
    const ocupacao = await this.prisma.ocupacaoQuadra.findFirst({
      where: { id, companyId },
    });
    if (!ocupacao) {
      throw new NotFoundException();
    }
    if (alunoIdScope && ocupacao.alunoId !== alunoIdScope) {
      throw new ForbiddenException();
    }

    // AC-003: cancelar libera o slot imediatamente — a constraint EXCLUDE
    // já ignora linhas com status_pagamento = 'cancelado' (WHERE da
    // migration), então essa escrita sozinha já resolve.
    await this.prisma.ocupacaoQuadra.update({
      where: { id },
      data: { statusPagamento: 'cancelado' },
    });
  }

  // Resolve o registro de Aluno do usuário autenticado, escopado à empresa
  // (SPEC-005) — usado pelo controller para decidir o `alunoId` efetivo em
  // rotas que a role `aluno` compartilha com `company_admin`. 403 (não 404)
  // porque a ausência de vínculo aluno é uma falha de autorização do
  // chamador, não um recurso não encontrado.
  async findAlunoDoUsuario(companyId: string, usuarioId: string) {
    const aluno = await this.prisma.aluno.findFirst({
      where: { usuarioId, companyId },
    });
    if (!aluno) {
      throw new ForbiddenException();
    }
    return aluno;
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
