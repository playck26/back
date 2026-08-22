import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StudentsService } from '../people/students.service';
import { HorarioFuncionamentoService } from './horario-funcionamento.service';
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

interface ConflitoDetectado {
  ocupacaoId: string;
  origemTipo: string;
}

@Injectable()
export class CourtsService {
  constructor(
    private readonly prisma: PrismaService,
    // SPEC-009/INV-010: reserva ocupa horário real (INV-001) — cadastro
    // não aprovado não bloqueia a agenda da empresa.
    private readonly studentsService: StudentsService,
    // SPEC-010: única fonte de verdade sobre "estar aberto".
    private readonly horarios: HorarioFuncionamentoService,
  ) {}

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

    // SPEC-010/REQ-004: a grade vem do horário efetivo da quadra naquele
    // dia da semana, não mais de constante. Mesma função usada pela
    // validação de criação (AC-015) — é o que impede a tela oferecer um
    // horário que o servidor recusaria depois.
    const horario = await this.horarios.resolverParaData(
      companyId,
      quadraId,
      dataDate,
    );

    const slots = this.horarios.gerarSlots(horario).map((slot) => {
      // Conflito é **semiaberto** (REQ-010/AC-020): uma ocupação que
      // começa às 10:00 não ocupa o slot que termina às 10:00.
      const conflito = ocupacoes.find(
        (ocupacao) =>
          ocupacao.horaInicio < slot.fim && ocupacao.horaFim > slot.inicio,
      );

      return {
        slot: `${formatTimeOnly(slot.inicio)}-${formatTimeOnly(slot.fim)}`,
        status: !conflito
          ? ('livre' as const)
          : conflito.origemTipo === 'TURMA'
            ? ('ocupado_turma' as const)
            : ('ocupado_avulso' as const),
      };
    });

    // AC-008: `estado` distingue "fechado" de "aberto sem nada livre" — as
    // duas situações produzem lista vazia depois que a tela filtra os
    // slots ocupados, e sem isto o app do aluno mostraria a mesma grade
    // vazia sem explicação nos dois casos.
    return { quadraId, data, estado: horario.estado, slots };
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

    if (dto.alunoId) {
      await this.studentsService.exigirVinculoAprovado(companyId, dto.alunoId);
    }

    // SPEC-010/INV-011: nada é criado fora do expediente. Vem antes da
    // checagem de conflito de propósito — um horário fora do expediente é
    // inválido mesmo que a quadra esteja livre, e devolver "conflito"
    // nesse caso seria mentir sobre o motivo.
    const horarioDoDia = await this.horarios.resolverParaData(
      companyId,
      dto.quadraId,
      dataDate,
    );
    if (
      !this.horarios.dentroDoExpediente(
        horarioDoDia,
        horaInicioDate,
        horaFimDate,
      )
    ) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'FORA_DO_EXPEDIENTE',
        message: 'Horário fora do funcionamento da quadra.',
      });
    }

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
    // SPEC-010/INV-011 (AC-018): **todas** as ocorrências são validadas
    // antes de qualquer escrita. Hoje elas compartilham dia e hora, então
    // conferir só a primeira daria o mesmo resultado — mas este método é
    // público e reutilizável, e uma implementação que confere só a
    // primeira grava as demais fora do expediente sem ninguém notar.
    const foraDoExpediente: { data: Date; horaInicio: Date }[] = [];
    for (const ocorrencia of ocorrencias) {
      const horarioDoDia = await this.horarios.resolverParaData(
        companyId,
        quadraId,
        ocorrencia.data,
        tx,
      );
      if (
        !this.horarios.dentroDoExpediente(
          horarioDoDia,
          ocorrencia.horaInicio,
          ocorrencia.horaFim,
        )
      ) {
        foraDoExpediente.push({
          data: ocorrencia.data,
          horaInicio: ocorrencia.horaInicio,
        });
      }
    }
    if (foraDoExpediente.length > 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'FORA_DO_EXPEDIENTE',
        message:
          'A turma cai fora do horário de funcionamento da quadra em ao menos uma data.',
        ocorrencias: foraDoExpediente.map((o) => ({
          data: formatDateOnly(o.data),
          horaInicio: formatTimeOnly(o.horaInicio),
        })),
      });
    }

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

  // CON-006.3 (SPEC-006, MOD-006 via PaymentStatusController): único
  // caminho para mudar `status_pagamento` fora de criar/cancelar reserva
  // — `ocupacoes_quadra` continua propriedade exclusiva de MOD-005
  // (TARGET_ARCHITECTURE.md seção 5), MOD-006 nunca escreve na tabela
  // direto. AC-002: idempotente — marcar o mesmo status de novo não
  // dispara um update supérfluo nem erro.
  async updatePaymentStatus(
    companyId: string,
    id: string,
    status: 'pago' | 'cancelado',
  ) {
    const ocupacao = await this.prisma.ocupacaoQuadra.findFirst({
      where: { id, companyId },
    });
    if (!ocupacao) {
      throw new NotFoundException();
    }
    if (ocupacao.statusPagamento === status) {
      return this.toOcupacaoResponse(ocupacao);
    }

    const atualizada = await this.prisma.ocupacaoQuadra.update({
      where: { id },
      data: { statusPagamento: status },
    });
    return this.toOcupacaoResponse(atualizada);
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
