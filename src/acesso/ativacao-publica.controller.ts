import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { LimitePublico } from '../common/throttle/contagem-por-ip';
import { AcessoService } from './acesso.service';
import { AtivacaoPublicaResponseDto, AtivarContaDto } from './dto/ativacao.dto';

/**
 * SPEC-083/D7 — **as rotas do link de ativação, sem login.** Quem chama é quem
 * recebeu o e-mail, e ainda não tem senha.
 *
 * Sem `JwtAuthGuard`, como `public/invites`. As duas contam **por IP**
 * (`@LimitePublico()`), mesmo com Bearer: identidade não compra balde novo
 * numa rota que define senha.
 *
 * Os oito motivos de link morto respondem o mesmo `410 LINK_INVALIDO`, com o
 * mesmo corpo (AC-021): a página não vira oráculo de por que o link morreu.
 */
@ApiTags('ativacao')
@Controller('public/ativacao')
export class AtivacaoPublicaController {
  constructor(private readonly acesso: AcessoService) {}

  /** Não consome: a página pode recarregar à vontade (AC-020). */
  @Get(':token')
  @LimitePublico()
  @ApiOkResponse({ type: AtivacaoPublicaResponseDto })
  consultar(@Param('token') token: string) {
    return this.acesso.consultarPublico(token);
  }

  /**
   * `204` e nada mais: **sem sessão**. A página manda para o login (D11), e o
   * aceite do termo acontece no portão do primeiro acesso.
   */
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @LimitePublico()
  @ApiNoContentResponse()
  async ativar(@Body() dto: AtivarContaDto): Promise<void> {
    await this.acesso.ativar(dto.token, dto.senha);
  }
}
