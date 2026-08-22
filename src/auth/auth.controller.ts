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
import { PermiteSenhaTemporaria } from '../common/decorators/permite-senha-temporaria.decorator';
import { parseDurationToMs } from '../common/utils/parse-duration';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { AuthService } from './auth.service';
import { InvitesService } from './invites.service';
import { LoginDto } from './dto/login.dto';
import { AceitarConviteDto } from './dto/aceitar-convite.dto';
import { RegisterAlunoDto } from './dto/register-aluno.dto';
import { TrocarSenhaDto } from './dto/trocar-senha.dto';

const REFRESH_COOKIE_NAME = 'refresh_token';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

// NFR-002: 10 tentativas / 15min por IP.
const LOGIN_THROTTLE = { default: { limit: 10, ttl: 900_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly invites: InvitesService,
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

  // SPEC-009/AC-020: sem `JwtAuthGuard`. Exigir access token válido para
  // deslogar prende quem está com o token expirado numa sessão que segue
  // viva no servidor. A identificação vem do cookie de refresh, com o
  // Bearer como alternativa quando ele existir.
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout({
      refreshTokenRaw: this.readRefreshCookie(req),
      accessTokenRaw: this.readBearer(req),
    });
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
  }

  // SPEC-009/REQ-004: única rota de escrita que uma conta em primeiro
  // acesso alcança (INV-008).
  @Post('trocar-senha')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @PermiteSenhaTemporaria()
  @ApiBearerAuth()
  async trocarSenha(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: TrocarSenhaDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.trocarSenha(user.sub, dto);
    this.setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  // SPEC-009/REQ-002: o aceite fica em `/auth` porque é criação de conta,
  // não gestão de convite — quem chama aqui é o aluno, não a empresa.
  @Post('aceitar-convite')
  @HttpCode(HttpStatus.CREATED)
  @Throttle(LOGIN_THROTTLE)
  aceitarConvite(@Body() dto: AceitarConviteDto) {
    return this.invites.aceitar(dto);
  }

  @Post('register-aluno')
  @Throttle(LOGIN_THROTTLE)
  registerAluno(@Body() dto: RegisterAlunoDto) {
    return this.authService.registerAluno(dto);
  }

  // Alcançável em primeiro acesso: é por aqui que o frontend descobre que
  // precisa mandar a pessoa trocar a senha (AC-008).
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @PermiteSenhaTemporaria()
  @ApiBearerAuth()
  me(@CurrentUser() user: AccessTokenPayload) {
    return this.authService.me(user.sub);
  }

  private readBearer(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return undefined;
    }
    return header.slice('Bearer '.length).trim() || undefined;
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
