import {
  Controller,
  Delete,
  Get,
  Param,
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
  ChamadaNaoHouveResponseDto,
  NaoHouveDesfeitoResponseDto,
  OcorrenciasDaTurmaPaginadasResponseDto,
} from './dto/me-response.dto';
import { UuidCanonicoPipe } from '../common/pipes/uuid-canonico.pipe';
import { OcorrenciasDaTurmaQueryDto } from './dto/ocorrencias-da-turma-query.dto';
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
    @Param('id', UuidCanonicoPipe) id: string,
    // SPEC-027: paginacao por cima da janela de dias. As duas coexistem de
    // proposito — `dias` limita QUANTO HISTORICO existe, `page` limita
    // quanto vem por vez. Trocar uma pela outra perderia a metade util.
    //
    // **DEF-034 — `dias` mora no DTO, e não pode voltar a ser `@Query('dias')`
    // solto.** Ao lado de um `@Query()` de objeto, a validação global
    // (`forbidNonWhitelisted`) confere o DTO contra a query INTEIRA e derruba
    // o que não for propriedade dele: a query que o app manda respondia
    // `400 property dias should not exist`, e a lista de aulas do professor
    // nunca funcionou em produção. Coberto por
    // `test/me-teacher-ocorrencias.e2e-spec.ts` — que é o primeiro teste desta
    // rota pela camada HTTP.
    @Query() query: OcorrenciasDaTurmaQueryDto,
  ) {
    return this.presencas.ocorrenciasDaTurma(
      user.companyId as string,
      user.sub,
      id,
      // Default de 30 e teto de 90: sem limite, o endpoint cresce junto com o
      // histórico e um dia devolve anos de aula (ressalva da validação).
      Math.min(Math.max(query.dias ?? 30, 1), 90),
      query.page,
      query.pageSize,
    );
  }

  @Get('attendance/:ocupacaoId')
  @ApiOkResponse({ type: ChamadaResponseDto })
  @Roles('professor')
  chamada(
    @CurrentUser() user: AccessTokenPayload,
    @Param('ocupacaoId', UuidCanonicoPipe) ocupacaoId: string,
  ) {
    return this.presencas.chamada(
      user.companyId as string,
      user.sub,
      ocupacaoId,
    );
  }

  // SPEC-076/D1 — o `PUT /me/teacher/attendance/:ocupacaoId` SAIU (decisões 1
  // e 9 do Israel): ninguém grava presença à mão. Quem fecha a chamada é o
  // worker, e quem avisou falta pelo app vira "Faltou" (D2). Chamada àquela
  // rota dá 404 do roteador.

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
    @Param('ocupacaoId', UuidCanonicoPipe) ocupacaoId: string,
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

  /**
   * SPEC-076/D3 — **desfazer "a aula não aconteceu"**, pelo mesmo portão de
   * registrar (mesma janela, decisão 5). Sempre `200` com o estado atual:
   * sem `nao_houve` gravado, nada muda.
   */
  @Delete('attendance/:ocupacaoId/nao-houve')
  @ApiOkResponse({ type: NaoHouveDesfeitoResponseDto })
  @Roles('professor')
  desfazerNaoHouve(
    @CurrentUser() user: AccessTokenPayload,
    @Param('ocupacaoId', UuidCanonicoPipe) ocupacaoId: string,
  ) {
    return this.presencas.desfazerNaoHouve(
      user.companyId as string,
      ocupacaoId,
      user.sub,
      true,
    );
  }
}
