import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LimitePublico } from '../common/throttle/contagem-por-ip';
import { PrismaService } from '../prisma/prisma.service';
import { LogoDaEmpresaService } from './logo-da-empresa.service';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly logos: LogoDaEmpresaService,
  ) {}

  @Get(':slug')
  @LimitePublico()
  async porSlug(@Param('slug') slug: string) {
    const empresa = await this.prisma.empresa.findUnique({
      where: { slug },
      select: {
        id: true,
        nome: true,
        // SPEC-018/TASK-006 — a vitrine pública é onde a logo mais importa:
        // é a única tela em que ela aparece para quem ainda NÃO é cliente.
        logoKey: true,
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

    // A resposta continua com dois campos, e `id` e `logoKey` NÃO saem
    // daqui: esta rota é pública e sem autenticação — quanto menos ela
    // contar sobre a empresa, melhor.
    return {
      nome: empresa.nome,
      logoUrl: this.logos.resolver(empresa).logoUrl,
    };
  }
}
