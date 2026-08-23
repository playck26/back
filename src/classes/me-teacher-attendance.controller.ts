import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { SalvarChamadaDto } from './dto/salvar-chamada.dto';
import { PresencaService } from './presenca.service';

/**
 * SPEC-014 — a chamada, do lado do professor.
 *
 * `company_admin` **não** escreve aqui (LIM-002): nesta spec o gestor só
 * consulta. Contrato de escrita sem tela que o use é superfície morta, e
 * quem tomou a chamada é quem sabe corrigi-la.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/teacher')
export class MeTeacherAttendanceController {
  constructor(private readonly presencas: PresencaService) {}

  @Get('classes/:id/ocorrencias')
  @Roles('professor')
  ocorrencias(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    // Default de 30 e teto de 90: sem limite, o endpoint cresce junto com o
    // histórico e um dia devolve anos de aula (ressalva da validação).
    @Query('dias', new DefaultValuePipe(30), ParseIntPipe) dias: number,
  ) {
    return this.presencas.ocorrenciasDaTurma(
      user.companyId as string,
      user.sub,
      id,
      Math.min(Math.max(dias, 1), 90),
    );
  }

  @Get('attendance/:ocupacaoId')
  @Roles('professor')
  chamada(
    @CurrentUser() user: AccessTokenPayload,
    @Param('ocupacaoId', ParseUUIDPipe) ocupacaoId: string,
  ) {
    return this.presencas.chamada(
      user.companyId as string,
      user.sub,
      ocupacaoId,
    );
  }

  @Put('attendance/:ocupacaoId')
  @Roles('professor')
  salvar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('ocupacaoId', ParseUUIDPipe) ocupacaoId: string,
    @Body() dto: SalvarChamadaDto,
  ) {
    return this.presencas.salvarChamada(
      user.companyId as string,
      user.sub,
      ocupacaoId,
      dto.versao,
      dto.itens,
    );
  }
}
