import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  LimiteDeLogin,
  LimitePublico,
} from '../common/throttle/contagem-por-ip';
import {
  EsqueciSenhaDto,
  RedefinicaoPublicaResponseDto,
  RedefinirSenhaDto,
} from './dto/redefinicao.dto';
import { RedefinicaoService } from './redefinicao.service';

/**
 * SPEC-090 — **as três rotas do "esqueci minha senha", sem login.** Moram no
 * `AcessoModule`, e não no `AuthModule`, inclusive a que fica em `/auth`: o
 * `AuthModule` importa o `PeopleModule`, que importa o `AcessoModule`, e o
 * `AuthModule` importar este fecharia um ciclo.
 *
 * Sem `JwtAuthGuard`, como as rotas do link de ativação. As três contam **por
 * IP**, mesmo com Bearer: identidade não compra balde novo numa rota que
 * dispara e-mail ou define senha. O balde é de cada rota (a chave do
 * `@nestjs/throttler` inclui classe e handler).
 */

/**
 * D1 — `POST /auth/esqueci-senha`. Classe própria porque o prefixo é outro
 * (`auth`), no mesmo arquivo porque é a mesma funcionalidade.
 */
@ApiTags('auth')
@Controller('auth')
export class EsqueciSenhaController {
  private readonly logger = new Logger('Redefinicao');

  constructor(private readonly redefinicao: RedefinicaoService) {}

  /**
   * **`202` vazio, e antes de olhar o banco** (D1, INV-090e): o serviço é
   * chamado **sem `await`**. Com conta, sem conta, conta inativa, empresa
   * inativa, super admin ou acima do teto, a resposta é a mesma e sai no mesmo
   * tempo — não depende de consulta, de bcrypt nem do envio (AC-003, AC-004).
   *
   * O `.catch` existe para a promessa solta não virar `unhandledRejection`, e
   * registra **só o evento**: nem o e-mail, nem o erro (cuja mensagem pode
   * carregar o SQL com o e-mail como parâmetro).
   */
  @Post('esqueci-senha')
  @HttpCode(HttpStatus.ACCEPTED)
  @LimiteDeLogin()
  @ApiAcceptedResponse()
  esqueciSenha(@Body() dto: EsqueciSenhaDto): void {
    // Sem `await` e sem `async`, de propósito (S1): o handler devolve antes de
    // o serviço tocar o banco.
    void this.redefinicao.solicitar(dto.email).catch(() => {
      this.logger.error({ evento: 'redefinicao_falhou' });
    });
  }
}

/** D4/D5 — as rotas do link que chegou por e-mail. */
@ApiTags('redefinicao')
@Controller('public/redefinicao')
export class RedefinicaoPublicaController {
  constructor(private readonly redefinicao: RedefinicaoService) {}

  /** Não consome: a página pode recarregar à vontade (D4). */
  @Get(':token')
  @LimitePublico()
  @ApiOkResponse({ type: RedefinicaoPublicaResponseDto })
  consultar(
    @Param('token') token: string,
  ): Promise<RedefinicaoPublicaResponseDto> {
    return this.redefinicao.consultar(token);
  }

  /**
   * `204` e nada mais: **sem sessão** (D5). A página manda para o login.
   */
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @LimitePublico()
  @ApiNoContentResponse()
  async redefinir(@Body() dto: RedefinirSenhaDto): Promise<void> {
    await this.redefinicao.redefinir(dto.token, dto.usuarioId, dto.senha);
  }
}
