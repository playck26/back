import { randomUUID } from 'node:crypto';
import {
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../people/students.service';
import { parseDurationToMs } from '../common/utils/parse-duration';
import type {
  AccessTokenPayload,
  RefreshTokenPayload,
} from '../common/types/jwt-payload.type';
import type { LoginDto } from './dto/login.dto';
import type { RegisterAlunoDto } from './dto/register-aluno.dto';
import type { TrocarSenhaDto } from './dto/trocar-senha.dto';

const BCRYPT_COST = 12;
// REQ-011: uma única mensagem para toda falha do cadastro público.
const CADASTRO_PUBLICO_RECUSADO =
  'Não foi possível concluir o cadastro com esses dados.';
const CREDENCIAIS_INVALIDAS = 'Credenciais inválidas';

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface PublicUsuario {
  // SPEC-009/AC-008: o frontend precisa saber que a conta está em primeiro
  // acesso para redirecionar; a trava em si é do servidor (INV-008).
  senhaTemporaria?: boolean;
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
    // SPEC-009/REQ-007: MOD-001 não escreve em `alunos` — pede a MOD-003.
    private readonly students: StudentsService,
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

    // SPEC-009: senha temporária vencida não autentica. Mensagem específica
    // (e não a genérica de credencial) porque aqui a pessoa **acertou** a
    // senha: esconder o motivo faria ela tentar de novo para sempre, e não
    // há enumeração de conta a proteger — quem chegou aqui já provou posse
    // da credencial.
    if (this.senhaTemporariaVencida(usuario)) {
      await this.prisma.refreshToken.updateMany({
        where: { usuarioId: usuario.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'SENHA_TEMPORARIA_EXPIRADA',
        message:
          'Senha temporária expirada. Peça ao administrador da sua empresa uma nova.',
      });
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

    // SPEC-009/AC-019 — sem esta checagem, uma sessão aberta com senha
    // temporária se renovaria indefinidamente por refresh e a validade de
    // 7 dias seria decorativa: o vencimento só barraria login novo, nunca
    // quem já estava dentro. Ao vencer, derruba todas as sessões da conta —
    // a saída é o admin gerar outra senha temporária (ADR-013).
    if (this.senhaTemporariaVencida(usuario)) {
      await this.prisma.refreshToken.updateMany({
        where: { usuarioId: usuario.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'SENHA_TEMPORARIA_EXPIRADA',
        message:
          'Senha temporária expirada. Peça ao administrador da sua empresa uma nova.',
      });
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
    };
  }

  /**
   * SPEC-009/AC-020 — logout deixou de exigir access token válido.
   *
   * Antes, a rota era protegida por `JwtAuthGuard`: quem estivesse com o
   * access token expirado (15 min) não conseguia deslogar, e a sessão
   * continuava viva no servidor enquanto o cliente apenas "esquecia" o
   * token localmente. Agora a identificação vem do refresh token do cookie,
   * com o Bearer como caminho alternativo quando ele existir.
   *
   * Continua idempotente: sem credencial nenhuma, não há sessão a revogar e
   * a resposta é a mesma — logout não é lugar de dar pista sobre sessão
   * alheia.
   */
  async logout(entrada: {
    refreshTokenRaw?: string;
    accessTokenRaw?: string;
  }): Promise<void> {
    if (entrada.refreshTokenRaw) {
      try {
        const payload = this.verifyRefreshToken(entrada.refreshTokenRaw);
        await this.prisma.refreshToken.updateMany({
          where: { id: payload.jti, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return;
      } catch {
        // refresh inválido/expirado — tenta pelo Bearer abaixo
      }
    }

    if (entrada.accessTokenRaw) {
      try {
        const payload = await this.jwt.verifyAsync<AccessTokenPayload>(
          entrada.accessTokenRaw,
          { secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET') },
        );
        await this.prisma.refreshToken.updateMany({
          where: { usuarioId: payload.sub, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      } catch {
        // sem credencial válida: nada a revogar
      }
    }
  }

  async registerAluno(
    dto: RegisterAlunoDto,
  ): Promise<{ usuario: PublicUsuario }> {
    // SPEC-009/REQ-011 (AC-021) — os quatro modos de falha deste endpoint
    // público devolvem **a mesma** resposta: slug inexistente, empresa
    // inativa, auto-cadastro desligado e e-mail já cadastrado.
    //
    // Antes, este código distinguia `422 "Empresa inexistente ou inativa"`
    // de `409 "Email já cadastrado"`, o que fazia de um endpoint aberto um
    // verificador de existência de tenant e de conta: bastava um POST por
    // e-mail para descobrir quem tem cadastro na plataforma.
    const empresa = await this.prisma.empresa.findUnique({
      where: { slug: dto.empresaSlug },
    });
    const empresaAceitaCadastro =
      empresa?.status === 'ativa' && empresa.permiteAutoCadastro;

    const existente = await this.prisma.usuario.findUnique({
      where: { email: dto.email },
    });

    if (!empresa || !empresaAceitaCadastro || existente) {
      throw new UnprocessableEntityException(CADASTRO_PUBLICO_RECUSADO);
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
          companyId: empresa.id,
        },
      });

      // Auto-cadastro público (C1): a iniciativa é de quem chegou pelo
      // link, não da empresa — nasce `pendente` até um admin aprovar
      // (REQ-008/AC-014, INV-010).
      await this.students.criarPerfilDeAluno(tx, {
        usuarioId: usuarioCriado.id,
        companyId: empresa.id,
        vinculo: 'pendente',
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
    senhaTemporaria?: boolean;
  }): PublicUsuario {
    return {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      role: usuario.role,
      companyId: usuario.companyId,
      senhaTemporaria: usuario.senhaTemporaria ?? false,
    };
  }

  /**
   * SPEC-009/REQ-004 — senha temporária vencida não vira acesso permanente.
   * Chamado no login e no refresh: os dois são portas de entrada de sessão,
   * e deixar só o login checando permitiria que uma sessão aberta antes do
   * vencimento sobrevivesse indefinidamente por refresh (achado ACHADO-002
   * da 1ª validação cruzada).
   */
  private senhaTemporariaVencida(usuario: {
    senhaTemporaria: boolean;
    senhaTemporariaExpiraEm: Date | null;
  }): boolean {
    if (!usuario.senhaTemporaria) {
      return false;
    }
    return (
      usuario.senhaTemporariaExpiraEm !== null &&
      usuario.senhaTemporariaExpiraEm.getTime() < Date.now()
    );
  }

  /**
   * SPEC-009/REQ-004 (AC-009) — troca de senha do próprio usuário. Serve
   * tanto ao primeiro acesso (senha temporária) quanto à troca voluntária.
   */
  async trocarSenha(
    usuarioId: string,
    dto: TrocarSenhaDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: usuarioId },
    });

    const senhaConfere = await bcrypt.compare(
      dto.senhaAtual,
      usuario.senhaHash,
    );
    if (!senhaConfere) {
      throw new UnauthorizedException(CREDENCIAIS_INVALIDAS);
    }

    const novaSenhaHash = await bcrypt.hash(dto.novaSenha, BCRYPT_COST);

    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuarioId },
        data: {
          senhaHash: novaSenhaHash,
          senhaTemporaria: false,
          senhaTemporariaExpiraEm: null,
        },
      });

      // Mesma proteção do REQ-003 de SPEC-001: senha trocada invalida toda
      // sessão anterior. Vale principalmente para o primeiro acesso — a
      // senha temporária circulou por WhatsApp, então qualquer sessão
      // aberta com ela deixa de valer no momento da troca.
      await tx.refreshToken.updateMany({
        where: { usuarioId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    // Emite um par novo para quem trocou: revogar tudo sem devolver sessão
    // jogaria a pessoa para a tela de login logo depois de ela ter feito
    // exatamente o que o sistema exigiu.
    return this.issueTokens(usuarioId, {
      sub: usuario.id,
      email: usuario.email,
      nome: usuario.nome,
      role: usuario.role,
      companyId: usuario.companyId,
    });
  }
}
