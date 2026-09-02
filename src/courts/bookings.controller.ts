import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Headers,
  Param,
  Post,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { UuidCanonicoPipe } from '../common/pipes/uuid-canonico.pipe';
import { CourtsService } from './courts.service';
import { AgendaService } from './agenda.service';
import { EventoDeOcupacaoResponseDto } from './dto/evento-de-ocupacao-response.dto';
import {
  OcupacaoPaginadaResponseDto,
  ReservasCriadasResponseDto,
} from './dto/booking-response.dto';
import { CreateBookingDto } from './dto/create-booking.dto';
import { ListBookingsQueryDto } from './dto/list-bookings-query.dto';

// CON-005.4/005.5/005.6 (SPEC-005): `company_admin` reserva/lista/cancela
// para qualquer aluno da empresa (comportamento original de SPEC-004);
// `aluno` só reserva/lista/cancela para si mesmo — o `alunoId` nunca vem
// do cliente quando quem chama é `aluno` (REQ-005), sempre resolvido a
// partir do token via `CourtsService.findAlunoDoUsuario`.
@ApiTags('bookings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly courtsService: CourtsService,
    private readonly agenda: AgendaService,
  ) {}

  @Post()
  @ApiCreatedResponse({ type: ReservasCriadasResponseDto })
  @Roles('company_admin', 'aluno')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CreateBookingDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const alunoId = await this.resolveAlunoId(user, dto.alunoId);
    return this.courtsService.createBooking(
      user.companyId as string,
      { ...dto, alunoId },
      user.sub,
      idempotencyKey,
    );
  }

  @Get()
  @ApiOkResponse({ type: OcupacaoPaginadaResponseDto })
  @Roles('company_admin', 'aluno')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: ListBookingsQueryDto,
  ) {
    const alunoIdScope =
      user.role === 'aluno'
        ? (
            await this.courtsService.findAlunoDoUsuario(
              user.companyId as string,
              user.sub,
            )
          ).id
        : undefined;
    return this.courtsService.listBookings(
      user.companyId as string,
      query,
      alunoIdScope,
    );
  }

  @Post(':id/cancel')
  @ApiNoContentResponse()
  @Roles('company_admin', 'aluno')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    const alunoIdScope =
      user.role === 'aluno'
        ? (
            await this.courtsService.findAlunoDoUsuario(
              user.companyId as string,
              user.sub,
            )
          ).id
        : undefined;
    return this.courtsService.cancelBooking(
      user.companyId as string,
      id,
      // SPEC-032/D6: a acao do ALUNO tambem vira evento. Registrar so o
      // gestor deixaria buraco onde a pergunta "quem cancelou isto?" e mais
      // provavel — quem le decide o papel pelo `role` do autor.
      user.sub,
      alunoIdScope,
    );
  }

  /**
   * SPEC-032/CON-016 — quem fez o quê nesta reserva, e quando.
   *
   * `company_admin` apenas: e histórico administrativo, não informação de
   * quem reservou. O aluno vê a própria reserva, não quem a operou.
   */
  @Get(':id/eventos')
  @Roles('company_admin')
  @ApiOkResponse({ type: [EventoDeOcupacaoResponseDto] })
  eventos(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.agenda.eventosDaOcupacao(user.companyId as string, id);
  }

  private async resolveAlunoId(
    user: AccessTokenPayload,
    alunoIdDoCorpo: string | undefined,
  ): Promise<string> {
    if (user.role === 'aluno') {
      const aluno = await this.courtsService.findAlunoDoUsuario(
        user.companyId as string,
        user.sub,
      );
      return aluno.id;
    }
    if (!alunoIdDoCorpo) {
      throw new UnprocessableEntityException(
        'alunoId é obrigatório para company_admin reservar em nome de um aluno',
      );
    }
    return alunoIdDoCorpo;
  }
}
