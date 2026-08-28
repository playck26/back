import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../../prisma/prisma.service';
import { PERMITE_ACEITE_PENDENTE } from '../decorators/permite-aceite-pendente.decorator';
import { PERMITE_SENHA_TEMPORARIA } from '../decorators/permite-senha-temporaria.decorator';
import type { AccessTokenPayload } from '../types/jwt-payload.type';
import { TERMO_VERSAO_VIGENTE } from '../../aceites/termo-vigente';

/**
 * Autenticação por access token + as travas de INV-008 (SPEC-009, senha
 * temporária) e INV-013 (SPEC-013, conta inativa).
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
 * INV-013 entra aqui pelos mesmos dois motivos, e por um terceiro: ela roda
 * **antes** do atalho de `@PermiteSenhaTemporaria`. Aquela marcação libera
 * /auth/trocar-senha, /auth/me e logout — se a checagem de status viesse
 * depois dela, uma conta inativa trocaria a senha e voltaria a operar,
 * furando INV-013 exatamente pela porta que existe para quem ainda não pode
 * operar. É a diferença entre "ainda não pode" e "não pode mais".
 *
 * O custo disso é a consulta deixar de ser pulável na rota marcada. Uma
 * leitura por PK contra o furo de DEF-001 é troca barata.
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

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AccessTokenPayload }>();
    const usuarioId = request.user?.sub;
    if (!usuarioId) {
      return true;
    }

    // SPEC-024 — as colunas de aceite entram NESTE select, e a versao
    // vigente do contrato vem por join da empresa. O guard continua fazendo
    // **uma** leitura por requisicao: o portao do aceite nao pode custar uma
    // segunda ida ao banco em toda rota autenticada do sistema.
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: {
        senhaTemporaria: true,
        status: true,
        role: true,
        termoVersaoAceita: true,
        contratoVersaoAceita: true,
        empresa: { select: { contratoVersaoVigente: true } },
      },
    });

    // INV-013 (SPEC-013/DEF-001) — vale para toda rota autenticada, marcada
    // ou não. É o que torna a inativação imediata: o access token vivo (até
    // 15 min) para de valer agora, não quando expirar.
    if (usuario?.status === 'inativo') {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'CONTA_INATIVA',
        message: 'Esta conta está inativa. Procure o administrador.',
      });
    }

    const permite = this.reflector.getAllAndOverride<boolean | undefined>(
      PERMITE_SENHA_TEMPORARIA,
      [context.getHandler(), context.getClass()],
    );
    if (permite) {
      return true;
    }

    if (usuario?.senhaTemporaria) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'SENHA_TEMPORARIA',
        message:
          'Defina uma senha própria antes de continuar (POST /auth/trocar-senha).',
      });
    }

    // SPEC-024/INV-024b — o portao do aceite, DEPOIS do de senha temporaria.
    //
    // A ordem importa e nao e arbitraria: quem ainda nao definiu senha
    // propria precisa resolver isso primeiro. Empilhar as duas pendencias na
    // mesma tela seria pedir que a pessoa aceite um contrato antes de ter
    // uma conta de verdade.
    if (usuario && this.precisaAceitar(usuario)) {
      const permiteAceite = this.reflector.getAllAndOverride<
        boolean | undefined
      >(PERMITE_ACEITE_PENDENTE, [context.getHandler(), context.getClass()]);
      if (!permiteAceite) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'ACEITE_PENDENTE',
          message: 'Há termos pendentes de aceite (GET /me/aceites/pendentes).',
        });
      }
    }

    return true;
  }

  /**
   * **Gestor e super admin ficam de fora, e isso e decisao, nao esquecimento**
   * (SPEC-024, duvida 1 / LIM-024b).
   *
   * O bloqueio seria circular: o gestor de um clube que publicou contrato
   * precisaria aceitar o proprio contrato para entrar no Admin — e, se o
   * termo da plataforma mudasse, **ninguem conseguiria publicar contrato
   * ate aceitar**, inclusive quem precisa publicar. Um portao que tranca a
   * saida nao e portao, e armadilha.
   *
   * `super_admin` nao tem empresa, entao contrato nao se aplica a ele de
   * qualquer forma.
   */
  private precisaAceitar(usuario: {
    role: string;
    termoVersaoAceita: number | null;
    contratoVersaoAceita: number | null;
    empresa: { contratoVersaoVigente: number | null } | null;
  }): boolean {
    if (usuario.role !== 'aluno' && usuario.role !== 'professor') {
      return false;
    }

    if (usuario.termoVersaoAceita !== TERMO_VERSAO_VIGENTE) {
      return true;
    }

    const vigente = usuario.empresa?.contratoVersaoVigente ?? null;
    // REQ-005: clube que nao publicou contrato nao trava ninguem. E o estado
    // de toda empresa existente no dia da migration.
    if (vigente === null) {
      return false;
    }

    return usuario.contratoVersaoAceita !== vigente;
  }
}
