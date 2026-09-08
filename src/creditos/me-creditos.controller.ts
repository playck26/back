import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { CreditosDoAlunoService } from './creditos-do-aluno.service';
import { ExtratoDoAlunoResponseDto } from './dto/creditos-response.dto';

/**
 * SPEC-033/TASK-006 — a carteira pela mão do ALUNO.
 *
 * Controller próprio, e não um método a mais no do admin, pela mesma razão de
 * `MeClassesController`: o que o aluno vê da própria carteira **não é um
 * recorte de permissão do que o admin vê** — é outra resposta. O `motivo` não
 * aparece aqui (AC-013), e esconder por projeção no mesmo serviço convidaria
 * a esquecer o `select` no dia em que alguém acrescentasse um campo.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/creditos')
export class MeCreditosController {
  constructor(private readonly creditos: CreditosDoAlunoService) {}

  @Get()
  @ApiOkResponse({ type: ExtratoDoAlunoResponseDto })
  @Roles('aluno')
  minhaCarteira(@CurrentUser() user: AccessTokenPayload) {
    return this.creditos.extratoDoAluno(user.companyId as string, user.sub);
  }
}
