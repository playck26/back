import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { CamposDoCadastroDto } from './dto/campos-do-cadastro.dto';
import { AlunoResponseDto } from './dto/people-response.dto';
import { StudentsService } from './students.service';

/**
 * SPEC-036/REQ-002 — **o aluno completa o proprio cadastro.**
 *
 * ## O "cadastro hibrido" do item 15 e literalmente este par de rotas
 *
 * O gestor comeca e o aluno termina, sobre os MESMOS sete campos. O convite ja
 * tinha provado o padrao (SPEC-009): o admin pre-preenche, a pessoa fecha.
 *
 * ## Duas rotas e nao uma, com o papel decidindo (D7)
 *
 * O gestor pode mudar `nivelId` e `status`; o aluno **nao pode**. Um DTO so,
 * com campos que ora valem ora nao, e como nasce escalada de privilegio —
 * basta alguem esquecer o `if`. Aqui o DTO do aluno **nao tem** os campos, e
 * nao ha `if` para esquecer.
 *
 * ## `403` e nao `{}` para quem nao e aluno (AC-008)
 *
 * Professor e gestor nao tem ficha de aluno. Devolver objeto vazio faria a
 * tela do Cliente renderizar uma barra de 0% para eles — e cobrar de um
 * professor que ele "complete o cadastro" de aluno que nao existe.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/cadastro')
export class MeCadastroController {
  constructor(private readonly studentsService: StudentsService) {}

  @Get()
  @ApiOkResponse({ type: AlunoResponseDto })
  @Roles('aluno')
  meuCadastro(@CurrentUser() user: AccessTokenPayload) {
    return this.studentsService.meuCadastro(user.companyId as string, user.sub);
  }

  @Patch()
  @ApiOkResponse({ type: AlunoResponseDto })
  @Roles('aluno')
  atualizarMeuCadastro(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CamposDoCadastroDto,
  ) {
    return this.studentsService.atualizarMeuCadastro(
      user.companyId as string,
      user.sub,
      dto,
    );
  }
}
