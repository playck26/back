import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LimitePublico } from '../common/throttle/contagem-por-ip';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SPEC-009/REQ-001 — o que a página pública de auto-cadastro precisa saber
 * para se apresentar: o nome e o logo da empresa. Nada mais.
 *
 * AC-022/NFR-002: slug inexistente, empresa inativa e empresa com
 * auto-cadastro desligado devolvem o **mesmo** `404`. Distinguir os três
 * transformaria este endpoint num verificador de existência de tenant.
 */
@ApiTags('public')
@Controller('public/companies')
export class PublicCompaniesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':slug')
  @LimitePublico()
  async porSlug(@Param('slug') slug: string) {
    const empresa = await this.prisma.empresa.findUnique({
      where: { slug },
      select: {
        nome: true,
        logoUrl: true,
        status: true,
        permiteAutoCadastro: true,
      },
    });

    if (
      !empresa ||
      empresa.status !== 'ativa' ||
      !empresa.permiteAutoCadastro
    ) {
      throw new NotFoundException();
    }

    return { nome: empresa.nome, logoUrl: empresa.logoUrl };
  }
}
