import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { MatriculaResponseDto } from './dto/matricula-response.dto';
import { MatriculasService } from './matriculas.service';

/**
 * SPEC-037/REQ-003 — o plano do aluno logado.
 *
 * **Devolve `null`, nunca `404`** (AC-011). Nao ter plano e um estado normal
 * -- a maioria dos alunos de hoje esta assim, porque a tabela nasceu vazia. Um
 * `404` faria a tela do Cliente tratar o normal como erro, que e exatamente o
 * defeito que a carteira levou para producao na SPEC-033.
 *
 * `403` para quem nao e aluno, como no `/me/cadastro`: professor e gestor nao
 * tem matricula, e devolver `null` para eles seria dizer "voce nao tem plano"
 * a quem nunca poderia ter.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/matricula')
export class MeMatriculaController {
  constructor(private readonly matriculas: MatriculasService) {}

  @Get()
  @ApiOkResponse({ type: MatriculaResponseDto, nullable: true })
  @Roles('aluno')
  minhaMatricula(@CurrentUser() user: AccessTokenPayload) {
    return this.matriculas.minhaMatricula(user.companyId as string, user.sub);
  }
}
