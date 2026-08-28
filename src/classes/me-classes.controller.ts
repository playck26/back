import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AulaDoAlunoResponseDto } from './dto/me-response.dto';
import {
  ErroDeMatriculaResponseDto,
  MatriculaDoAlunoResponseDto,
  TurmaDisponivelResponseDto,
} from './dto/matricula-do-aluno-response.dto';
import { MatriculaDoAlunoService } from './matricula-do-aluno.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { ClassesService } from './classes.service';

// CON-004.5 (SPEC-005) — exclusivo do aluno, separado do CRUD
// administrativo de turmas em ClassesController (company_admin).
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/classes')
export class MeClassesController {
  constructor(
    private readonly classesService: ClassesService,
    private readonly matricula: MatriculaDoAlunoService,
  ) {}

  @Get()
  @ApiOkResponse({ type: [AulaDoAlunoResponseDto] })
  @Roles('aluno')
  myUpcomingClasses(@CurrentUser() user: AccessTokenPayload) {
    return this.classesService.myUpcomingClasses(
      user.companyId as string,
      user.sub,
    );
  }

  /**
   * SPEC-023/REQ-001 — as turmas do clube com a ocupação à vista.
   *
   * Declarada **antes** de qualquer `:id` neste controller: rota literal
   * depois de rota com parâmetro é o clássico "disponiveis" virando um id
   * inválido.
   */
  @Get('disponiveis')
  @ApiOkResponse({ type: [TurmaDisponivelResponseDto] })
  @Roles('aluno')
  disponiveis(@CurrentUser() user: AccessTokenPayload) {
    return this.matricula.disponiveis(user.companyId as string, user.sub);
  }

  /** SPEC-023/REQ-002 — entrar. Idempotente: entrar duas vezes é o mesmo estado. */
  @Post(':id')
  @ApiOkResponse({ type: MatriculaDoAlunoResponseDto })
  @ApiForbiddenResponse({ type: ErroDeMatriculaResponseDto })
  @ApiConflictResponse({ type: ErroDeMatriculaResponseDto })
  @ApiNotFoundResponse({
    description:
      'Turma inexistente — ou de outra empresa. São 404 iguais de propósito (INV-023b): distinguir já entregaria informação sobre o outro clube.',
  })
  @HttpCode(200)
  @Roles('aluno')
  entrar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) turmaId: string,
  ) {
    return this.matricula.entrar(user.companyId as string, user.sub, turmaId);
  }

  /** SPEC-023/REQ-004 — sair, exceto quando a turma tem aula hoje. */
  @Delete(':id')
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErroDeMatriculaResponseDto })
  @ApiNotFoundResponse({
    description:
      'Turma inexistente, de outra empresa, ou o aluno não está nela. Sair de onde não se está é engano, e silenciar esconderia bug de tela.',
  })
  @HttpCode(204)
  @Roles('aluno')
  sair(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) turmaId: string,
  ) {
    return this.matricula.sair(user.companyId as string, user.sub, turmaId);
  }
}
