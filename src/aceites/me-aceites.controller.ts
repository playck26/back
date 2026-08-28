import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AceitesService } from './aceites.service';
import {
  AceiteRegistradoResponseDto,
  AceitesPendentesResponseDto,
  ErroDeAceiteResponseDto,
  RegistrarAceiteDto,
} from './dto/aceites.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PermiteAceitePendente } from '../common/decorators/permite-aceite-pendente.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';

/**
 * SPEC-024 — as duas rotas que quem está bloqueado ainda alcança.
 *
 * **As duas são `@PermiteAceitePendente`, e sem isso a pessoa ficaria
 * presa**: barrada por não ter aceitado, e sem como ler o que precisa
 * aceitar. É o mesmo desenho de `/auth/trocar-senha` para a INV-008 — o
 * portão sempre deixa aberta a porta que resolve o próprio portão.
 *
 * Note que **não há `@Roles`**: o portão só se aplica a `aluno` e
 * `professor` (LIM-024b), mas ler o próprio estado de aceite é pergunta que
 * qualquer sessão pode fazer sobre si mesma.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/aceites')
export class MeAceitesController {
  constructor(private readonly aceites: AceitesService) {}

  @Get('pendentes')
  @PermiteAceitePendente()
  @ApiOkResponse({ type: AceitesPendentesResponseDto })
  pendentes(@CurrentUser() user: AccessTokenPayload) {
    return this.aceites.pendentes(user.sub);
  }

  @Post()
  @PermiteAceitePendente()
  @HttpCode(200)
  @ApiOkResponse({
    type: AceiteRegistradoResponseDto,
    description:
      'Aceite registrado. Idempotente: aceitar de novo não cria segunda linha.',
  })
  @ApiConflictResponse({ type: ErroDeAceiteResponseDto })
  aceitar(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: RegistrarAceiteDto,
  ) {
    return this.aceites.aceitar(user.sub, {
      termo: dto.termo,
      contrato: dto.contrato,
    });
  }
}
