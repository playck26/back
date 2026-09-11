import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { ProfessorParaAlunoResponseDto } from './dto/professor-para-aluno.dto';
import { ProfessoresParaAlunoService } from './professores-para-aluno.service';

/**
 * SPEC-047/REQ-002 — **quem dá aula particular, e por quanto.**
 *
 * ## Rota própria, e reusar `/teachers` seria vazamento
 *
 * `TeachersController` é `@UseGuards(JwtAuthGuard, CompanyAdminGuard)` — o
 * aluno hoje **não consegue nem listar professores**. Abrir aquela rota para
 * ele entregaria `telefone`, `email` e `usuarioId`, que são dados de ficha.
 *
 * *Reusar a rota do gestor "porque já existe" é como vazamento de dado
 * começa.* Esta devolve só o que ele precisa para escolher: nome, foto e
 * preço.
 *
 * ## Só quem tem preço aparece (D2)
 *
 * Professor sem preço próprio e sem padrão do clube **não é oferecido** — e a
 * tentativa direta é recusada com `422 AULA_SEM_PRECO`. A lista e a recusa
 * concordam de propósito: oferecer o que a criação vai negar é a forma mais
 * barata de perder a confiança de quem usa.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/professores')
export class MeProfessoresController {
  constructor(private readonly professores: ProfessoresParaAlunoService) {}

  @Get()
  @ApiOkResponse({ type: ProfessorParaAlunoResponseDto, isArray: true })
  @Roles('aluno')
  listar(@CurrentUser() user: AccessTokenPayload) {
    return this.professores.listarParaAluno(user.companyId as string);
  }
}
