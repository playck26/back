import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { parseDurationToMs } from '../common/utils/parse-duration';
import type {
  AccessTokenPayload,
  RefreshTokenPayload,
} from '../common/types/jwt-payload.type';
import type { LoginDto } from './dto/login.dto';
import type { RegisterAlunoDto } from './dto/register-aluno.dto';

const BCRYPT_COST = 12;
const CREDENCIAIS_INVALIDAS = 'Credenciais inválidas';

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface PublicUsuario {
  id: string;
  nome: string;
  email: string;
  role: AccessTokenPayload['role'];
  companyId: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto): Promise<{
    accessToken: string;
    refreshToken: string;
    usuario: PublicUsuario;
  }> {
    const usuario = await this.prisma.usuario.findUnique({
      where: { email: dto.email },
    });
    if (!usuario) {
      throw new UnauthorizedException(CREDENCIAIS_INVALIDAS);
    }

    const senhaValida = await bcrypt.compare(dto.senha, usuario.senhaHash);
    if (!senhaValida) {
      throw new UnauthorizedException(CREDENCIAIS_INVALIDAS);
    }

    if (usuario.companyId) {
      const empresa = await this.prisma.empresa.findUnique({
        where: { id: usuario.companyId },
      });
      if (!empresa || empresa.status !== 'ativa') {
        throw new UnauthorizedException(CREDENCIAIS_INVALIDAS);
      }
    }

    const tokens = await this.issueTokens(usuario.id, {
      sub: usuario.id,
      email: usuario.email,
      nome: usuario.nome,
      role: usuario.role,
      companyId: usuario.companyId,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      usuario: this.toPublicUsuario(usuario),
    };
  }

  async refresh(
    refreshTokenRaw: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = this.verifyRefreshToken(refreshTokenRaw);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { id: payload.jti },
    });
    if (!stored) {
      throw new UnauthorizedException();
    }

    const matches = await bcrypt.compare(refreshTokenRaw, stored.tokenHash);
    if (!matches) {
      throw new UnauthorizedException();
    }

    // Claim atômica: um único UPDATE com WHERE revokedAt: null é a forma
    // de tornar "ler revokedAt, decidir, escrever" atômico sem depender
    // de uma transação explícita — o Postgres serializa UPDATEs
    // concorrentes na mesma linha, então só uma requisição consegue
    // affected rows = 1; qualquer outra (perdeu a corrida ou é reuso de
    // token já rotacionado antes) recebe affected rows = 0. Corrige a
    // corrida encontrada na validação cruzada (2 requisições simultâneas
    // com o mesmo refresh token não podiam mais emitir 2 pares de token).
    const claim = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (claim.count === 0) {
      if (stored.expiresAt < new Date()) {
        // Expirado e nunca usado por ninguém — não é reuso, não revoga
        // as outras sessões do usuário.
        throw new UnauthorizedException();
      }
      // Perdeu a corrida (outra requisição concorrente já revogou) ou é
      // reuso de token já rotacionado antes: mesmo tratamento — sinal de
      // comprometimento, revoga toda a sessão do usuário (REQ-003).
      await this.prisma.refreshToken.updateMany({
        where: { usuarioId: stored.usuarioId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException();
    }

    if (stored.expiresAt < new Date()) {
      // Não deveria acontecer (a claim só teria sucesso se ninguém tivesse
      // revogado ainda), mas expiração é checada de novo por segurança.
      throw new UnauthorizedException();
    }

    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: stored.usuarioId },
    });
    const tokens = await this.issueTokens(usuario.id, {
      sub: usuario.id,
      email: usuario.email,
      nome: usuario.nome,
      role: usuario.role,
      companyId: usuario.companyId,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async logout(usuarioId: string, refreshTokenRaw?: string): Promise<void> {
    if (refreshTokenRaw) {
      try {
        const payload = this.verifyRefreshToken(refreshTokenRaw);
        await this.prisma.refreshToken.updateMany({
          where: { id: payload.jti, usuarioId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return;
      } catch {
        // token de refresh inválido/expirado — cai no fallback abaixo
      }
    }

    await this.prisma.refreshToken.updateMany({
      where: { usuarioId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async registerAluno(
    dto: RegisterAlunoDto,
  ): Promise<{ usuario: PublicUsuario }> {
    const empresa = await this.prisma.empresa.findUnique({
      where: { id: dto.companyId },
    });
    if (!empresa || empresa.status !== 'ativa') {
      throw new UnprocessableEntityException('Empresa inexistente ou inativa');
    }

    const existente = await this.prisma.usuario.findUnique({
      where: { email: dto.email },
    });
    if (existente) {
      throw new ConflictException('Email já cadastrado');
    }

    const senhaHash = await bcrypt.hash(dto.senha, BCRYPT_COST);
    // Usuario (identidade) + Aluno (perfil de domínio, MOD-003) nascem
    // juntos — mesmo padrão de MOD-002 (empresa + admin numa transação):
    // é uma única operação de provisionamento de conta, não duas escritas
    // independentes disputando a tabela `alunos` ao longo do tempo.
    const usuario = await this.prisma.$transaction(async (tx) => {
      const usuarioCriado = await tx.usuario.create({
        data: {
          email: dto.email,
          senhaHash,
          nome: dto.nome,
          telefone: dto.telefone,
          role: 'aluno',
          companyId: dto.companyId,
        },
      });

      await tx.aluno.create({
        data: {
          usuarioId: usuarioCriado.id,
          companyId: dto.companyId,
        },
      });

      return usuarioCriado;
    });

    return { usuario: this.toPublicUsuario(usuario) };
  }

  async me(usuarioId: string): Promise<PublicUsuario> {
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: usuarioId },
    });
    return this.toPublicUsuario(usuario);
  }

  private async issueTokens(
    usuarioId: string,
    payload: AccessTokenPayload,
  ): Promise<IssuedTokens> {
    const accessSecret = this.config.getOrThrow<string>('JWT_ACCESS_SECRET');
    const accessExpiresIn = this.config.get<string>(
      'JWT_ACCESS_EXPIRES_IN',
      '15m',
    );
    const refreshSecret = this.config.getOrThrow<string>('JWT_REFRESH_SECRET');
    const refreshExpiresIn = this.config.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '7d',
    );

    const accessToken = await this.jwt.signAsync(payload, {
      secret: accessSecret,
      expiresIn: accessExpiresIn as unknown as number,
    });

    const jti = randomUUID();
    const refreshTokenExpiresAt = new Date(
      Date.now() + parseDurationToMs(refreshExpiresIn),
    );
    const refreshPayload: RefreshTokenPayload = { sub: usuarioId, jti };
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: refreshSecret,
      expiresIn: refreshExpiresIn as unknown as number,
    });
    const tokenHash = await bcrypt.hash(refreshToken, BCRYPT_COST);

    await this.prisma.refreshToken.create({
      data: {
        id: jti,
        usuarioId,
        tokenHash,
        expiresAt: refreshTokenExpiresAt,
      },
    });

    return { accessToken, refreshToken, refreshTokenExpiresAt };
  }

  private verifyRefreshToken(refreshTokenRaw: string): RefreshTokenPayload {
    const refreshSecret = this.config.getOrThrow<string>('JWT_REFRESH_SECRET');
    try {
      return this.jwt.verify<RefreshTokenPayload>(refreshTokenRaw, {
        secret: refreshSecret,
      });
    } catch {
      throw new UnauthorizedException();
    }
  }

  private toPublicUsuario(usuario: {
    id: string;
    nome: string;
    email: string;
    role: AccessTokenPayload['role'];
    companyId: string | null;
  }): PublicUsuario {
    return {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      role: usuario.role,
      companyId: usuario.companyId,
    };
  }
}
