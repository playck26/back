import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AccessTokenPayload } from '../../common/types/jwt-payload.type';

@Injectable()
export class JwtAccessStrategy extends PassportStrategy(
  Strategy,
  'jwt-access',
) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  /**
   * SPEC-086/INV-086b — **o token de escolha de empresa é assinado com o
   * mesmo segredo, e não é sessão.** Ele não tem `sub`, e o `JwtAuthGuard`
   * deixa passar um payload sem `sub`: a recusa tem de ser aqui. Qualquer
   * payload com `typ` é recusado.
   */
  validate(
    payload: AccessTokenPayload & { typ?: unknown },
  ): AccessTokenPayload {
    if (payload.typ !== undefined) {
      throw new UnauthorizedException();
    }
    return payload;
  }
}
