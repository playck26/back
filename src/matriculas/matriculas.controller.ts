import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UuidCanonicoPipe } from '../common/pipes/uuid-canonico.pipe';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { CriarMatriculaDto } from './dto/matricula.dto';
import { MatriculaResponseDto } from './dto/matricula-response.dto';
import { MatriculasService } from './matriculas.service';

/**
 * SPEC-037/REQ-002 — matricular, do lado do gestor.
 *
 * **Nao ha `PATCH` nem `DELETE`, e e a INV-112.** Valor e prazo sao imutaveis:
 * mudar o contratado depois apagaria o registro de com o que o aluno
 * concordou -- e e esse registro que da valor legal ao aceite. Renovar e uma
 * matricula NOVA (D4); duas seguidas contam a historia certa, uma linha
 * editada conta a ultima.
 */
@ApiTags('matriculas')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('students/:alunoId/matriculas')
export class MatriculasController {
  constructor(private readonly matriculas: MatriculasService) {}

  @Get()
  @ApiOkResponse({ type: MatriculaResponseDto, isArray: true })
  listar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('alunoId', UuidCanonicoPipe) alunoId: string,
  ) {
    return this.matriculas.listarDoAluno(user.companyId as string, alunoId);
  }

  @Post()
  @ApiOkResponse({ type: MatriculaResponseDto })
  criar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('alunoId', UuidCanonicoPipe) alunoId: string,
    @Body() dto: CriarMatriculaDto,
  ) {
    return this.matriculas.criar(
      user.companyId as string,
      alunoId,
      dto,
      user.sub,
    );
  }
}
