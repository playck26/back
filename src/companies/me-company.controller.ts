import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { LogoDaEmpresaService } from './logo-da-empresa.service';
import { UpdateAutoCadastroDto } from './dto/update-auto-cadastro.dto';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly logos: LogoDaEmpresaService,
  ) {}

  @Get()
  // SPEC-018/TASK-006 — `aluno` e `professor` entraram aqui para o app
  // conseguir desenhar a marca do clube (antes só o gestor lia). O que a
  // rota devolve já era alcançável por eles de outro jeito: `slug` é o link
  // público de cadastro, e `nome` e `logoUrl` aparecem na vitrine pública.
  // "A minha empresa" é uma pergunta que todo mundo com empresa pode fazer.
  @Roles('company_admin', 'aluno', 'professor')
  async minhaEmpresa(@CurrentUser() user: AccessTokenPayload) {
    const empresa = await this.prisma.empresa.findUnique({
      where: { id: user.companyId as string },
      select: {
        id: true,
        nome: true,
        slug: true,
        // SPEC-018/TASK-006: as duas colunas saem do banco, e só uma sai na
        // resposta — `LogoDaEmpresaService.resolver` decide qual, com o
        // fallback da AC-013.
        logoKey: true,
        logoUrl: true,
        status: true,
        permiteAutoCadastro: true,
      },
    });

    if (!empresa) {
      throw new NotFoundException();
    }

    // `id` sai: o painel precisa dele para montar `PUT /companies/:id/logo`,
    // e ele já viaja no próprio token do gestor — não é informação nova.
    // **`logoKey` NÃO sai**: chave crua é coisa que nenhum cliente deve usar
    // para montar URL, porque isso contornaria a conferência do
    // `StorageService` (INV-037).
    return {
      id: empresa.id,
      nome: empresa.nome,
      slug: empresa.slug,
      status: empresa.status,
      permiteAutoCadastro: empresa.permiteAutoCadastro,
      logoUrl: this.logos.resolver(empresa).logoUrl,
    };
  }

  /**
   * DEF-004 — a SPEC-009/REQ-006 diz "a empresa decide se aceita
   * auto-cadastro", e os critérios de aceite dela descreviam **apenas** o
   * que acontece com o link desligado (AC-012). Nenhum deles dava à empresa
   * um jeito de desligar: `permite_auto_cadastro` era lida em
   * `public-companies.controller.ts` e em `auth.service.ts`, e escrita em
   * lugar nenhum. Passou por duas rodadas de validação cruzada assim.
   *
   * Não é falha de segurança — a trava que a ADR-013 usa para justificar o
   * default ligado é a fila de aprovação (INV-010), e ela existe e funciona.
   * É requisito não cumprido: o clube que for spamado não consegue fechar a
   * porta.
   */
  @Patch()
  @Roles('company_admin')
  async definirAutoCadastro(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: UpdateAutoCadastroDto,
  ) {
    // `updateMany` com o `company_id` do token, e não `update` por id: se a
    // empresa não for a do usuário, o resultado é zero linhas em vez de uma
    // escrita em tenant alheio.
    const { count } = await this.prisma.empresa.updateMany({
      where: { id: user.companyId as string },
      data: { permiteAutoCadastro: dto.permiteAutoCadastro },
    });

    if (count === 0) {
      throw new NotFoundException();
    }

    return this.minhaEmpresa(user);
  }
}
