import { Controller, Get, NotFoundException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';

/**
 * DEF-003 — a empresa precisa saber o próprio `slug` para divulgar o link
 * de auto-cadastro (`/cadastro/<slug>`).
 *
 * O `slug` existe desde a SPEC-009 e **nenhuma rota o entregava ao gestor**:
 * `CompaniesController` é `SuperAdminGuard`, e `/auth/me` devolve o usuário,
 * não a empresa. O resultado é que o auto-cadastro funcionava e ninguém
 * conseguia divulgá-lo — nem o gestor sabia qual era o endereço.
 *
 * Fica em `me/company`, e não em `companies/:id`, pela mesma razão que
 * `me/teacher` existe: o escopo aqui é "a minha empresa", resolvido do
 * token, sem id na URL para alguém trocar.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/company')
export class MeCompanyController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('company_admin')
  async minhaEmpresa(@CurrentUser() user: AccessTokenPayload) {
    const empresa = await this.prisma.empresa.findUnique({
      where: { id: user.companyId as string },
      select: {
        nome: true,
        slug: true,
        logoUrl: true,
        status: true,
        permiteAutoCadastro: true,
      },
    });

    if (!empresa) {
      throw new NotFoundException();
    }

    return empresa;
  }
}
