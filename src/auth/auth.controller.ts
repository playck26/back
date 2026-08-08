import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { parseDurationToMs } from '../common/utils/parse-duration';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterAlunoDto } from './dto/register-aluno.dto';

const REFRESH_COOKIE_NAME = 'refresh_token';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

// NFR-002: 10 tentativas / 15min por IP.
const LOGIN_THROTTLE = { default: { limit: 10, ttl: 900_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(LOGIN_THROTTLE)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto);
    this.setRefreshCookie(res, result.refreshToken);
    return result;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshTokenRaw = this.readRefreshCookie(req);
    if (!refreshTokenRaw) {
      throw new UnauthorizedException();
    }
    const result = await this.authService.refresh(refreshTokenRaw);
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async logout(
    @CurrentUser() user: AccessTokenPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshTokenRaw = this.readRefreshCookie(req);
    await this.authService.logout(user.sub, refreshTokenRaw);
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
  }

  @Post('register-aluno')
  @Throttle(LOGIN_THROTTLE)
  registerAluno(@Body() dto: RegisterAlunoDto) {
    return this.authService.registerAluno(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  me(@CurrentUser() user: AccessTokenPayload) {
    return this.authService.me(user.sub);
  }

  private readRefreshCookie(req: Request): string | undefined {
    const cookies: Record<string, string> | undefined = (
      req as Request & { cookies?: Record<string, string> }
    ).cookies;
    const value: string | undefined = cookies?.[REFRESH_COOKIE_NAME];
    return value;
  }

  private setRefreshCookie(res: Response, refreshToken: string): void {
    const refreshExpiresIn = this.config.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '7d',
    );
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      // SECURITY_PRIVACY.md exige Strict. Só funciona em produção se
      // back e os 3 frontends estiverem sob o mesmo domínio raiz (ex.:
      // api.playck.com.br + admin.playck.com.br — "site" para fins de
      // SameSite é o eTLD+1, não o subdomínio) — ver OPERATIONS.md,
      // seção "Domínio E DNS" (gap em aberto). Em domínios totalmente
      // distintos (ex. *.netlify.app vs *.ondigitalocean.app), o
      // navegador nunca envia este cookie de volta, mesmo com
      // credentials: 'include' — refresh/logout quebram silenciosamente.
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: parseDurationToMs(refreshExpiresIn),
    });
  }
}
