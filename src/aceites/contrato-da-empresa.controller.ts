import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AceitesService } from './aceites.service';
import {
  ContratoDaEmpresaResponseDto,
  PublicarContratoDto,
} from './dto/aceites.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';

/**
 * SPEC-024 — o contrato do clube, do lado do gestor.
 *
 * **O gestor não é travado pelo portão de aceite** (LIM-024b), e é aqui que
 * essa decisão deixa de ser teoria: se ele fosse, um termo novo da plataforma
 * o impediria de publicar o contrato — e o contrato é justamente o que
 * destrava os alunos. O portão trancaria a própria saída.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/company/contrato')
export class ContratoDaEmpresaController {
  constructor(private readonly aceites: AceitesService) {}

  @Get()
  @Roles('company_admin')
  @ApiOkResponse({ type: ContratoDaEmpresaResponseDto })
  vigente(@CurrentUser() user: AccessTokenPayload) {
    return this.aceites.contratoVigente(user.companyId as string);
  }

  /**
   * Quantas pessoas serão obrigadas a reaceitar se publicar agora.
   *
   * Existe como rota própria porque a tela precisa do número **antes** de o
   * gestor decidir. "Publicar" sem esse aviso parece salvar um rascunho — e
   * não é: interrompe todo mundo no próximo acesso.
   */
  @Get('alcance')
  @Roles('company_admin')
  @ApiOkResponse({
    schema: { type: 'object', properties: { pessoas: { type: 'number' } } },
  })
  async alcance(@CurrentUser() user: AccessTokenPayload) {
    return {
      pessoas: await this.aceites.quantosReaceitam(user.companyId as string),
    };
  }

  @Put()
  @Roles('company_admin')
  @ApiOkResponse({ type: ContratoDaEmpresaResponseDto })
  publicar(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: PublicarContratoDto,
  ) {
    return this.aceites.publicarContrato(user.companyId as string, dto.texto);
  }
}
