import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../../prisma/prisma.service';
import { PERMITE_SENHA_TEMPORARIA } from '../decorators/permite-senha-temporaria.decorator';
import type { AccessTokenPayload } from '../types/jwt-payload.type';

/**
 * Autenticação por access token + a trava de INV-008 (SPEC-009).
 *
 * A verificação de senha temporária mora **aqui**, e não num guard global
 * separado, por dois motivos:
 *
 * 1. Cobertura por construção — os 13 controllers já usam este guard, e
 *    toda rota autenticada nova vai usá-lo. Um guard global registrado via
 *    `APP_GUARD` rodaria *antes* do `JwtAuthGuard` de rota, quando
 *    `request.user` ainda não existe, e um guard aplicado controller a
 *    controller depende de alguém lembrar — INV-008 vira furo na primeira
 *    distração.
 * 2. Ordem correta — só faz sentido perguntar "esta conta está com senha
 *    temporária?" depois de saber de que conta se trata.
 *
 * A fonte de verdade é o **banco**, lido a cada requisição autenticada, não
 * um claim do JWT. Custa um lookup por PK; em troca, revogar o estado é
 * imediato e não depende de expiração de token. Se algum dia isso pesar, a
 * mitigação é o claim — seguro aqui porque trocar a senha revoga todas as
 * sessões (AC-009) —, mas não se otimiza antes de existir o problema.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt-access') {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const autenticado = (await super.canActivate(context)) as boolean;
    if (!autenticado) {
      return false;
    }

    const permite = this.reflector.getAllAndOverride<boolean | undefined>(
      PERMITE_SENHA_TEMPORARIA,
      [context.getHandler(), context.getClass()],
    );
    if (permite) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AccessTokenPayload }>();
    const usuarioId = request.user?.sub;
    if (!usuarioId) {
      return true;
    }

    const usuario = await this.prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: { senhaTemporaria: true },
    });

    if (usuario?.senhaTemporaria) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'SENHA_TEMPORARIA',
        message:
          'Defina uma senha própria antes de continuar (POST /auth/trocar-senha).',
      });
    }

    return true;
  }
}
