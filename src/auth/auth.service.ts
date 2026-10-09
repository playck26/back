import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { Prisma, UsuarioRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../people/students.service';
import { parseDurationToMs } from '../common/utils/parse-duration';
import { confereHashDoRefresh, hashDoRefresh } from './hash-do-refresh';
import {
  gerarSenhaTemporaria,
  senhaTemporariaExpiraEm,
} from '../common/utils/senha-temporaria';
import type {
  AccessTokenPayload,
  RefreshTokenPayload,
} from '../common/types/jwt-payload.type';
import {
  EscolhaDeEmpresaRespostaDto,
  LoginResponseDto,
  OpcaoDeEmpresaDto,
  RegistroDeAlunoResponseDto,
  UsuarioPublicoResponseDto,
} from './dto/auth-response.dto';
import type { LoginDto } from './dto/login.dto';
import type { EscolherEmpresaDto } from './dto/escolher-empresa.dto';
import { LogoDaEmpresaService } from '../companies/logo-da-empresa.service';
import {
  comTraducaoDaTravaDeEmail,
  conflitoDeContaDaEmpresa,
  travarEmailsParaCriarConta,
} from '../acesso/trava-de-email';
import { ehViolacaoDeEmail } from '../acesso/traduzir-violacao-de-unicidade';
import type { RegisterAlunoDto } from './dto/register-aluno.dto';
import type { TrocarSenhaDto } from './dto/trocar-senha.dto';

const BCRYPT_COST = 12;
// REQ-011: uma única mensagem para toda falha do cadastro público.
const CADASTRO_PUBLICO_RECUSADO =
  'Não foi possível concluir o cadastro com esses dados.';
const CREDENCIAIS_INVALIDAS = 'Credenciais inválidas';

/** SPEC-009 — a senha temporária venceu; a pessoa acertou a senha. */
const SENHA_TEMPORARIA_EXPIRADA = {
  statusCode: 401,
  code: 'SENHA_TEMPORARIA_EXPIRADA',
  message:
    'Senha temporária expirada. Peça ao administrador da sua empresa uma nova.',
};

/** SPEC-086 — o token de escolha venceu, foi adulterado, ou a senha mudou. */
const ESCOLHA_EXPIRADA = {
  statusCode: 401,
  code: 'ESCOLHA_EXPIRADA',
  message: 'A escolha de empresa expirou. Entre de novo.',
};

const MENSAGEM_ESCOLHA_DE_EMPRESA =
  'Este e-mail tem acesso a mais de uma empresa. Entre pelo app do aluno para escolher.';

/**
 * SPEC-086 — o token de escolha: assinado com o segredo do access token, mas
 * com um `typ` que a strategy de sessão recusa (INV-086b), e sem `sub`.
 * `impressao` é o sha256 do `senha_hash` no momento do login: troca, reset ou
 * ativação mudam o hash e matam o token (a técnica da SPEC-083, D6).
 */
export const TIPO_DO_TOKEN_DE_ESCOLHA = 'escolha-de-empresa';
const VALIDADE_DO_TOKEN_DE_ESCOLHA = '5m';

interface ConteudoDoTokenDeEscolha {
  typ: typeof TIPO_DO_TOKEN_DE_ESCOLHA;
  contas: { id: string; impressao: string }[];
}

interface ContaDaEscolha {
  id: string;
  companyId: string | null;
  role: UsuarioRole;
  senhaHash: string;
}

interface EmpresaDaEscolha {
  id: string;
  nome: string;
  status: string;
  logoKey: string | null;
  logoUrl: string | null;
}

function impressaoDaSenha(senhaHash: string): string {
  return createHash('sha256').update(senhaHash, 'utf8').digest('hex');
}

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/**
 * SPEC-021/TASK-005 — **era uma `interface` daqui, e virou apelido do DTO.**
 *
 * Enquanto fossem duas declarações da mesma forma, elas divergiriam no
 * primeiro ajuste e o contrato publicado passaria a mentir sem nada
 * reclamar — que é o defeito que esta spec veio desfazer, um nível acima.
 * Uma definição só, e é a que vai para o `openapi.json`.
 */
export type PublicUsuario = UsuarioPublicoResponseDto;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    // SPEC-009/REQ-007: MOD-001 não escreve em `alunos` — pede a MOD-003.
    private readonly students: StudentsService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    /** SPEC-086 — a logo de cada empresa da tela de escolha. */
    private readonly logos: LogoDaEmpresaService,
  ) {}

  /**
   * SPEC-086 — **o login quando o mesmo e-mail pode ter conta em mais de uma
   * empresa.**
   *
   * 1. Contas = todas as linhas do e-mail. Nenhuma: `401`, sem bcrypt.
   * 2. A senha é conferida em TODAS ao mesmo tempo (I7): as promessas nascem
   *    juntas, no `map`, antes de qualquer `await` — o tempo da senha errada
   *    não cresce com o número de contas enquanto houver CPU (LIM-086-01).
   * 3. Abertas = as que a senha abre. Nenhuma: `401`.
   * 4. Cada aberta cai numa categoria, na ordem de hoje: inativa (conta ou
   *    empresa) → vencida (senha temporária vencida) → válida.
   * 5. Toda vencida aberta tem os seus refresh revogados, POR `usuarioId`, em
   *    qualquer resultado — como o login de uma conta sempre fez.
   * 6. Uma válida e nenhuma vencida: a sessão, igual a hoje. Nenhuma válida:
   *    o `401` de hoje (o específico, se houver vencida). O resto: `409
   *    ESCOLHA_DE_EMPRESA`, com as válidas e as vencidas (bloqueadas, I6).
   *
   * Com uma conta só, as cinco saídas reproduzem exatamente o login de antes
   * — a régua é `spec-086-caracterizacao-login.db-spec.ts`.
   */
  async login(dto: LoginDto): Promise<LoginResponseDto> {
    const contas = await this.prisma.usuario.findMany({
      where: { email: dto.email },
      orderBy: { id: 'asc' },
    });
    if (contas.length === 0) {
      throw new UnauthorizedException(CREDENCIAIS_INVALIDAS);
    }

    const confere = contas.map((c) => bcrypt.compare(dto.senha, c.senhaHash));
    const resultados = await Promise.all(confere);
    const abertas = contas.filter((_, i) => resultados[i]);
    if (abertas.length === 0) {
      throw new UnauthorizedException(CREDENCIAIS_INVALIDAS);
    }

    const empresas = await this.empresasDe(abertas);
    // SPEC-013/INV-013 (DEF-001) — conta inativa não autentica, e a de
    // empresa inativa também. Somem em silêncio: dizer o motivo confirmaria
    // a existência da conta para quem está testando e-mails.
    const ativas = abertas.filter((c) => {
      if (c.status === 'inativo') return false;
      if (!c.companyId) return true;
      return empresas.get(c.companyId)?.status === 'ativa';
    });
    // SPEC-009: senha temporária vencida não autentica.
    const vencidas = ativas.filter((c) => this.senhaTemporariaVencida(c));
    const validas = ativas.filter((c) => !this.senhaTemporariaVencida(c));

    if (vencidas.length > 0) {
      await this.prisma.refreshToken.updateMany({
        where: {
          usuarioId: { in: vencidas.map((c) => c.id) },
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    }

    if (validas.length === 0) {
      if (vencidas.length > 0) {
        // Mensagem específica (e não a genérica de credencial) porque aqui a
        // pessoa **acertou** a senha: esconder o motivo faria ela tentar de
        // novo para sempre.
        throw new UnauthorizedException(SENHA_TEMPORARIA_EXPIRADA);
      }
      throw new UnauthorizedException(CREDENCIAIS_INVALIDAS);
    }

    if (validas.length === 1 && vencidas.length === 0) {
      const usuario = validas[0];
      const tokens = await this.issueTokens(this.prisma, usuario.id, {
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

    throw new ConflictException(
      await this.escolhaDeEmpresa(validas, vencidas, empresas),
    );
  }

  /**
   * SPEC-086 — troca a escolha da tela pela sessão da conta escolhida.
   *
   * A conta é lida com `FOR UPDATE`, e o refresh nasce **na mesma
   * transação**: troca de senha, reset e ativação escrevem a linha da conta,
   * então ou vêm antes (a impressão não bate → `ESCOLHA_EXPIRADA`) ou vêm
   * depois (e revogam o refresh que nasceu aqui). Nenhuma ordem deixa uma
   * sessão viva emitida sob a senha antiga (AC-021).
   */
  async escolherEmpresa(dto: EscolherEmpresaDto): Promise<LoginResponseDto> {
    const contas = this.lerTokenDeEscolha(dto.token);
    const daLista = contas.find((c) => c.id === dto.usuarioId);
    if (!daLista) {
      throw new UnauthorizedException(ESCOLHA_EXPIRADA);
    }

    const resultado = await this.prisma.$transaction(async (tx) => {
      const [conta] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM usuarios WHERE id = ${daLista.id}::uuid FOR UPDATE`;
      if (!conta) throw new UnauthorizedException(ESCOLHA_EXPIRADA);

      const usuario = await tx.usuario.findUniqueOrThrow({
        where: { id: daLista.id },
        include: { empresa: { select: { status: true } } },
      });
      if (impressaoDaSenha(usuario.senhaHash) !== daLista.impressao) {
        throw new UnauthorizedException(ESCOLHA_EXPIRADA);
      }
      if (
        usuario.status === 'inativo' ||
        (usuario.companyId !== null && usuario.empresa?.status !== 'ativa')
      ) {
        throw new UnauthorizedException(CREDENCIAIS_INVALIDAS);
      }
      if (this.senhaTemporariaVencida(usuario)) {
        await tx.refreshToken.updateMany({
          where: { usuarioId: usuario.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return { vencida: true as const };
      }

      const tokens = await this.issueTokens(tx, usuario.id, {
        sub: usuario.id,
        email: usuario.email,
        nome: usuario.nome,
        role: usuario.role,
        companyId: usuario.companyId,
      });
      return { vencida: false as const, usuario, tokens };
    });

    // A revogação da vencida tem de COMITAR antes do `401`: lançado dentro
    // da transação, ele a desfaria.
    if (resultado.vencida) {
      throw new UnauthorizedException(SENHA_TEMPORARIA_EXPIRADA);
    }
    return {
      accessToken: resultado.tokens.accessToken,
      refreshToken: resultado.tokens.refreshToken,
      usuario: this.toPublicUsuario(resultado.usuario),
    };
  }

  private async empresasDe(
    contas: readonly { companyId: string | null }[],
  ): Promise<Map<string, EmpresaDaEscolha>> {
    const ids = [
      ...new Set(contas.flatMap((c) => (c.companyId ? [c.companyId] : []))),
    ];
    if (ids.length === 0) return new Map();
    const linhas = await this.prisma.empresa.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        nome: true,
        status: true,
        logoKey: true,
        logoUrl: true,
      },
    });
    return new Map(linhas.map((e) => [e.id, e]));
  }

  private async escolhaDeEmpresa(
    validas: readonly ContaDaEscolha[],
    vencidas: readonly ContaDaEscolha[],
    empresas: ReadonlyMap<string, EmpresaDaEscolha>,
  ): Promise<EscolhaDeEmpresaRespostaDto> {
    const opcao = (
      c: ContaDaEscolha,
      situacao: OpcaoDeEmpresaDto['situacao'],
    ): OpcaoDeEmpresaDto => {
      const empresa = c.companyId ? empresas.get(c.companyId) : undefined;
      return {
        usuarioId: c.id,
        empresaNome: empresa?.nome ?? '',
        logoUrl: empresa ? this.logos.resolver(empresa).logoUrl : null,
        papel: c.role,
        situacao,
      };
    };
    const conteudo: ConteudoDoTokenDeEscolha = {
      typ: TIPO_DO_TOKEN_DE_ESCOLHA,
      contas: validas.map((c) => ({
        id: c.id,
        impressao: impressaoDaSenha(c.senhaHash),
      })),
    };
    const token = await this.jwt.signAsync(conteudo, {
      secret: this.segredoDaEscolha(),
      expiresIn: VALIDADE_DO_TOKEN_DE_ESCOLHA as unknown as number,
    });
    return {
      statusCode: 409,
      code: 'ESCOLHA_DE_EMPRESA',
      message: MENSAGEM_ESCOLHA_DE_EMPRESA,
      escolha: {
        token,
        empresas: [
          ...validas.map((c) => opcao(c, 'disponivel')),
          ...vencidas.map((c) => opcao(c, 'senha_expirada')),
        ],
      },
    };
  }

  /**
   * O segredo do token de escolha: **derivado** do do access token, e nunca
   * igual a ele.
   *
   * A validação da implementação achou o defeito que um segredo comum abre: o
   * `POST /auth/logout`, público, confere o Bearer só pela assinatura e revoga
   * os refresh de `payload.sub` — e o token de escolha, sem `sub`, virava um
   * `where` vazio que revogava as sessões de TODO MUNDO. Com o segredo
   * derivado, o token de escolha não verifica em nenhum lugar que confere
   * access token (a strategy, o logout, o limite de upload), e o defeito deixa
   * de existir como classe, não só neste caminho. A recusa por `typ` na
   * strategy e a exigência de `sub` no logout continuam, como segunda linha.
   */
  private segredoDaEscolha(): string {
    return `${this.config.getOrThrow<string>('JWT_ACCESS_SECRET')}:${TIPO_DO_TOKEN_DE_ESCOLHA}`;
  }

  /** Tudo o que não for um token de escolha válido é `ESCOLHA_EXPIRADA`. */
  private lerTokenDeEscolha(token: string): ConteudoDoTokenDeEscolha['contas'] {
    let conteudo: Partial<ConteudoDoTokenDeEscolha>;
    try {
      conteudo = this.jwt.verify<Partial<ConteudoDoTokenDeEscolha>>(token, {
        secret: this.segredoDaEscolha(),
      });
    } catch {
      throw new UnauthorizedException(ESCOLHA_EXPIRADA);
    }
    if (
      conteudo.typ !== TIPO_DO_TOKEN_DE_ESCOLHA ||
      !Array.isArray(conteudo.contas)
    ) {
      throw new UnauthorizedException(ESCOLHA_EXPIRADA);
    }
    return conteudo.contas;
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

    // SPEC-081/D1 — SHA-256 em tempo constante; bcrypt só para linha legada.
    // Hash que não confere recusa ANTES da claim: a linha não é revogada.
    const matches = await confereHashDoRefresh(
      refreshTokenRaw,
      stored.tokenHash,
    );
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

    // SPEC-013/INV-013 — sem isto, a inativacao so valeria ate o access
    // token expirar: a sessao se renovaria sozinha para sempre pelo refresh,
    // e o guard nunca veria uma conta inativa porque ela seguiria recebendo
    // tokens novos. O refresh ja foi consumido pela claim atomica acima, e
    // as demais sessoes caem junto — inativar encerra a sessao, nao a
    // suspende.
    if (usuario.status === 'inativo') {
      await this.prisma.refreshToken.updateMany({
        where: { usuarioId: usuario.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException();
    }

    // DEF-028 — a mesma checagem para a EMPRESA, e pela razao escrita logo
    // acima: sem ela a suspensao do clube so valeria ate o access token
    // expirar, porque a sessao se renovaria sozinha para sempre. Medido:
    // com a empresa `inativa`, duas renovacoes seguidas responderam `200`.
    //
    // **Derruba as sessoes junto**, como a inativacao de conta: suspender um
    // clube e um gesto comercial (inadimplencia), e meia suspensao e pior que
    // nenhuma, porque quem suspendeu acredita nela.
    if (usuario.companyId) {
      const empresa = await this.prisma.empresa.findUnique({
        where: { id: usuario.companyId },
        select: { status: true },
      });
      if (!empresa || empresa.status !== 'ativa') {
        await this.prisma.refreshToken.updateMany({
          where: { usuarioId: usuario.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        throw new UnauthorizedException();
      }
    }

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

    const tokens = await this.issueTokens(this.prisma, usuario.id, {
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
        const payload = await this.jwt.verifyAsync<
          AccessTokenPayload & { typ?: unknown }
        >(entrada.accessTokenRaw, {
          secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        });
        // SPEC-086 — só um access token de SESSÃO revoga: com `sub` de
        // verdade e sem `typ`. Um payload sem `sub` viraria
        // `usuarioId: undefined`, que o Prisma ignora — e o `updateMany`
        // revogaria o refresh de todos os usuários.
        if (
          typeof payload.sub !== 'string' ||
          payload.sub.length === 0 ||
          payload.typ !== undefined
        ) {
          return;
        }
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
  ): Promise<RegistroDeAlunoResponseDto> {
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

    if (!empresa || !empresaAceitaCadastro) {
      throw new UnprocessableEntityException(CADASTRO_PUBLICO_RECUSADO);
    }

    // SPEC-086 — esta conferência é só atalho (evita o bcrypt à toa). A
    // garantia é a de dentro da transação, sob a trava do e-mail.
    const existente = await this.prisma.usuario.findFirst({
      where: conflitoDeContaDaEmpresa(dto.email, empresa.id),
      select: { id: true },
    });
    if (existente) {
      throw new UnprocessableEntityException(CADASTRO_PUBLICO_RECUSADO);
    }

    const senhaHash = await bcrypt.hash(dto.senha, BCRYPT_COST);
    // Usuario (identidade) + Aluno (perfil de domínio, MOD-003) nascem
    // juntos — mesmo padrão de MOD-002 (empresa + admin numa transação):
    // é uma única operação de provisionamento de conta, não duas escritas
    // independentes disputando a tabela `alunos` ao longo do tempo.
    const usuario = await comTraducaoDaTravaDeEmail(() =>
      this.prisma.$transaction(async (tx) => {
        await travarEmailsParaCriarConta(tx, [dto.email]);
        const conflito = await tx.usuario.findFirst({
          where: conflitoDeContaDaEmpresa(dto.email, empresa.id),
          select: { id: true },
        });
        if (conflito) {
          throw new UnprocessableEntityException(CADASTRO_PUBLICO_RECUSADO);
        }

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
      }),
    ).catch((erro: unknown) => {
      // SPEC-086 — a segunda linha: a corrida que passou da trava (só por SQL
      // de fora dela) recebe a mesma resposta da pré-conferência. O `catch`
      // fica FORA da transação: quando ele roda, o rollback já aconteceu.
      if (ehViolacaoDeEmail(erro)) {
        throw new UnprocessableEntityException(CADASTRO_PUBLICO_RECUSADO);
      }
      throw erro;
    });

    return { usuario: this.toPublicUsuario(usuario) };
  }

  async me(usuarioId: string): Promise<UsuarioPublicoResponseDto> {
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: usuarioId },
    });
    return this.toPublicUsuario(usuario);
  }

  /**
   * SPEC-086 — recebe o cliente onde o refresh é gravado: o `escolher` passa
   * a transação, para o refresh nascer sob o `FOR UPDATE` da conta (S22).
   */
  private async issueTokens(
    db: Pick<Prisma.TransactionClient, 'refreshToken'>,
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
    const tokenHash = hashDoRefresh(refreshToken);

    await db.refreshToken.create({
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
  /**
   * SPEC-016/INV-031 — gera senha temporária para uma conta **qualquer**,
   * como método público de MOD-001.
   *
   * Existe porque `usuarios` e `refresh_tokens` são tabelas de MOD-001 e o
   * `TARGET_ARCHITECTURE.md` proíbe escrita nelas de fora. `students` e
   * `teachers` fazem isso hoje (dívida declarada em LIM-013 da SPEC-016);
   * esta seria a terceira ocorrência, e é onde ela para de crescer — daqui
   * em diante existe para onde migrar.
   *
   * **`contaInativa` é política nomeada, não booleano** (2ª validação
   * cruzada). Os três valores são os três comportamentos que já existem no
   * produto: o gestor **rejeita** (SPEC-016/AC-007b), o aluno **preserva**
   * (`students.service.ts`) e o professor **reativa**
   * (`teachers.service.ts`). Um `reativar: false` não distinguiria "recusa"
   * de "mantém como está".
   */
  async gerarSenhaTemporariaParaUsuario({
    usuarioId,
    contaInativa,
  }: {
    usuarioId: string;
    contaInativa: 'rejeitar' | 'preservar' | 'reativar';
  }): Promise<{ senhaTemporaria: string; expiraEm: Date }> {
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: usuarioId },
      select: { id: true, status: true },
    });

    if (usuario.status === 'inativo' && contaInativa === 'rejeitar') {
      throw new ConflictException({
        statusCode: 409,
        code: 'CONTA_INATIVA',
        message:
          'Esta conta está inativa. Reative-a antes de gerar uma senha nova.',
      });
    }

    const senha = gerarSenhaTemporaria();
    const senhaHash = await bcrypt.hash(senha, BCRYPT_COST);
    const expiraEm = senhaTemporariaExpiraEm();

    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuarioId },
        data: {
          senhaHash,
          senhaTemporaria: true,
          senhaTemporariaExpiraEm: expiraEm,
          ...(contaInativa === 'reativar' ? { status: 'ativo' as const } : {}),
        },
      });

      // INV-030 — sem isto a senha nova é decorativa: quem estivesse com
      // sessão aberta continuaria operando com a antiga. Foi o ACHADO-002
      // da SPEC-009, e vale igual aqui.
      await tx.refreshToken.updateMany({
        where: { usuarioId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    return { senhaTemporaria: senha, expiraEm };
  }

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
    return this.issueTokens(this.prisma, usuarioId, {
      sub: usuario.id,
      email: usuario.email,
      nome: usuario.nome,
      role: usuario.role,
      companyId: usuario.companyId,
    });
  }
}
