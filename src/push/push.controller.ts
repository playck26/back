import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { LimitePublico } from '../common/throttle/contagem-por-ip';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import {
  AssinaturaPushDto,
  ChavePublicaResponseDto,
  DesassinarPushDto,
  TesteEnfileiradoResponseDto,
} from './dto/push.dto';
import { PushService } from './push.service';

/**
 * SPEC-062/D1b — **a rota da chave pública, e por que ela é pública.**
 *
 * Ela existe para o navegador assinar, e o navegador assina antes de haver
 * sessão em alguns caminhos. Exigir login aqui não protegeria nada: a chave
 * pública é pública por definição — o que ela não pode é ficar velha no bundle.
 *
 * `no-store` é consequência disso: guardar em cache anula a razão de ela vir
 * por rota. Depois de uma rotação, o aparelho assinaria com a chave antiga e o
 * erro só apareceria no envio, longe da causa.
 *
 * `LimitePublico()` é o mesmo teto por IP das outras rotas sem login. A regra
 * de `contagem-por-ip.ts` vale aqui inteira: onde o limite existe para conter
 * quem ainda não é ninguém, a chave é o IP.
 */
@ApiTags('push')
@Controller('push')
export class PushPublicoController {
  constructor(private readonly push: PushService) {}

  @Get('chave-publica')
  @LimitePublico()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: ChavePublicaResponseDto })
  @ApiServiceUnavailableResponse({
    description:
      '`PUSH_NAO_CONFIGURADO` — falta par VAPID. Falha fechada: o serviço diz que não funciona em vez de fingir.',
  })
  chavePublica(): ChavePublicaResponseDto {
    return this.push.chavePublica();
  }
}

/**
 * SPEC-062/D2, D2a-2, D6 — as rotas de quem tem conta.
 */
@ApiTags('push')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Post('assinatura')
  @HttpCode(204)
  @ApiNoContentResponse({
    description:
      'Registrada. **Sem corpo de propósito** (INV-062f): não há o que devolver, e devolver a assinatura seria repetir a credencial que acabou de chegar.',
  })
  @ApiConflictResponse({
    description:
      '`ENDPOINT_EM_USO` — o aparelho pertence a outra conta. A autenticação prova a conta, não o controle do aparelho.',
  })
  @ApiServiceUnavailableResponse({ description: '`PUSH_NAO_CONFIGURADO`.' })
  async assinar(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: AssinaturaPushDto,
  ): Promise<void> {
    await this.push.assinar(user.companyId as string, user.sub, dto);
  }

  /**
   * D2a-2 — **`204` sempre**, tenha apagado ou não. Resposta diferente por
   * existência transformaria a rota em oráculo de assinaturas alheias.
   */
  @Delete('assinatura')
  @HttpCode(204)
  @ApiNoContentResponse({
    description:
      'Removida, ou já não existia. A resposta é a mesma nos dois casos.',
  })
  async desassinar(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: DesassinarPushDto,
  ): Promise<void> {
    await this.push.desassinar(
      user.companyId as string,
      user.sub,
      dto.endpoint,
    );
  }

  /**
   * D6 — o aviso de teste. **É o que faz esta spec ser verificável sozinha**,
   * sem depender da SPEC-063 para provar que o cano funciona.
   *
   * O `@Throttle` é a camada barata, e está declarado pelo que é: o storage
   * padrão do pacote é um `Map` do processo, então ele vale **por instância e
   * por reinício**. O teto de verdade é a contagem na tabela (D6).
   */
  @Post('teste')
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @ApiCreatedResponse({ type: TesteEnfileiradoResponseDto })
  @ApiConflictResponse({
    description:
      '`TESTE_JA_ENFILEIRADO` (409, já há um a caminho) ou `TESTE_ACIMA_DO_TETO` (429, três na última hora).',
  })
  @ApiServiceUnavailableResponse({ description: '`PUSH_NAO_CONFIGURADO`.' })
  async teste(
    @CurrentUser() user: AccessTokenPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TesteEnfileiradoResponseDto> {
    try {
      return await this.push.enfileirarTeste(
        user.companyId as string,
        user.sub,
      );
    } catch (causa) {
      // D6 — `429` **com `Retry-After`**. O serviço calcula os segundos (ele é
      // quem conhece a janela); o cabeçalho é HTTP, e HTTP é aqui. Sem ele o
      // cliente só saberia tentar de novo por tentativa e erro.
      if (causa instanceof HttpException && causa.getStatus() === 429) {
        const corpo = causa.getResponse() as { retryAfter?: number };
        if (corpo?.retryAfter) {
          res.setHeader('Retry-After', String(corpo.retryAfter));
        }
      }
      throw causa;
    }
  }
}
