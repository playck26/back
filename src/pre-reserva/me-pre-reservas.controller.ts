import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UuidCanonicoPipe } from '../common/pipes/uuid-canonico.pipe';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import {
  PedirPreReservaDto,
  PreReservaResponseDto,
} from './dto/pre-reserva.dto';
import { PreReservaService } from './pre-reserva.service';

/**
 * SPEC-074/TASK-002 — **a pré-reserva, pelo próprio aluno.**
 *
 * O aluno toca num horário OCUPADO e pede para ser avisado quando ele vagar.
 * **O contrato só cresce**: três rotas novas sob `/me`, nenhuma existente muda.
 *
 * ## `@Roles('aluno')` em CADA método
 *
 * A lição da SPEC-031/D19, repetida pela fila de espera: *"o prefixo não é
 * mecanismo"* — o `RolesGuard` deixa passar qualquer role autenticada quando
 * não há decorator.
 *
 * ## O que esta rota NÃO faz
 *
 * Não avisa ninguém e não reserva nada. **Quem avisa é o varredor** (D3), e o
 * aviso não segura o horário: quem reservar primeiro fica com ele (LIM-074a).
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/pre-reservas')
export class MePreReservasController {
  constructor(private readonly preReservas: PreReservaService) {}

  /** REQ-001 — os pedidos vivos do aluno, por início do horário. */
  @Get()
  @ApiOkResponse({ type: PreReservaResponseDto, isArray: true })
  @Roles('aluno')
  meus(@CurrentUser() user: AccessTokenPayload) {
    return this.preReservas.meus(user.companyId as string, user.sub);
  }

  /** REQ-001 — pedir aviso de um horário ocupado (D2). */
  @Post()
  @ApiCreatedResponse({ type: PreReservaResponseDto })
  @ApiNotFoundResponse({ description: 'A quadra não existe nesta empresa.' })
  @ApiConflictResponse({
    description:
      'O horário está livre (`HORARIO_LIVRE`), já é do aluno ' +
      '(`HORARIO_JA_E_SEU`), ou o aviso já foi pedido (`PRE_RESERVA_DUPLICADA`).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Aluno inativo (`ALUNO_INATIVO`), quadra fora de operação ' +
      '(`QUADRA_INATIVA`), horário que já começou (`HORARIO_NO_PASSADO`), fora ' +
      'do expediente (`FORA_DO_EXPEDIENTE`) ou teto de avisos ativos ' +
      '(`LIMITE_DE_PRE_RESERVAS`).',
  })
  @Roles('aluno')
  pedir(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: PedirPreReservaDto,
  ) {
    return this.preReservas.pedir(user.companyId as string, user.sub, dto);
  }

  /** REQ-001 — cancelar um pedido vivo. */
  @Delete(':id')
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description:
      'O pedido não existe, é de outro aluno ou já terminou — os três no ' +
      'mesmo `404`, que não revela o pedido de ninguém.',
  })
  @HttpCode(204)
  @Roles('aluno')
  cancelar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.preReservas.cancelar(user.companyId as string, user.sub, id);
  }
}
