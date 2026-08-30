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
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import {
  ChamadaResponseDto,
  ChamadaSalvaResponseDto,
  ChamadaNaoHouveResponseDto,
  OcorrenciasDaTurmaPaginadasResponseDto,
} from './dto/me-response.dto';
import { SalvarChamadaDto } from './dto/salvar-chamada.dto';
import { PaginationQueryDto } from '../people/dto/pagination-query.dto';
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
  @ApiOkResponse({ type: OcorrenciasDaTurmaPaginadasResponseDto })
  @Roles('professor')
  ocorrencias(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    // Default de 30 e teto de 90: sem limite, o endpoint cresce junto com o
    // histórico e um dia devolve anos de aula (ressalva da validação).
    @Query('dias', new DefaultValuePipe(30), ParseIntPipe) dias: number,
    // SPEC-027: paginacao por cima da janela de dias. As duas coexistem de
    // proposito — `dias` limita QUANTO HISTORICO existe, `page` limita
    // quanto vem por vez. Trocar uma pela outra perderia a metade util.
    @Query() paginacao: PaginationQueryDto,
  ) {
    return this.presencas.ocorrenciasDaTurma(
      user.companyId as string,
      user.sub,
      id,
      Math.min(Math.max(dias, 1), 90),
      paginacao.page,
      paginacao.pageSize,
    );
  }

  @Get('attendance/:ocupacaoId')
  @ApiOkResponse({ type: ChamadaResponseDto })
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
  @ApiOkResponse({ type: ChamadaSalvaResponseDto })
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

  /**
   * SPEC-030 — **a aula não aconteceu.**
   *
   * Rota própria, e não um campo no `PUT` acima: o corpo daquele é a lista
   * de alunos, e "salvei com zero alunos" é exatamente o engano que a
   * SPEC-015 já tratou. Aqui não há corpo — a rota inteira é a afirmação.
   *
   * O gestor tem a dele em `classes.controller.ts`, sobre o mesmo serviço.
   * Este caminho fica `professor`-only porque `/me/teacher` significa "meu,
   * como professor", e um gestor chamando por aqui seria uma rota mentindo
   * sobre quem chama.
   */
  @Put('attendance/:ocupacaoId/nao-houve')
  @ApiOkResponse({ type: ChamadaNaoHouveResponseDto })
  @Roles('professor')
  naoHouve(
    @CurrentUser() user: AccessTokenPayload,
    @Param('ocupacaoId', ParseUUIDPipe) ocupacaoId: string,
  ) {
    return this.presencas.registrarNaoHouve(
      user.companyId as string,
      ocupacaoId,
      user.sub,
      // `true` = estreita para as turmas DELE. O `professorId` em si é
      // resolvido no serviço, a partir do banco — o JWT não o carrega
      // (INV-018).
      true,
    );
  }
}
