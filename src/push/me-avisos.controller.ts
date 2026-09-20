import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { PaginationQueryDto } from '../people/dto/pagination-query.dto';
import { CaixaDeAvisosService } from './caixa-de-avisos.service';
import {
  CaixaDeAvisosResponseDto,
  MarcadasResponseDto,
  NaoLidosResponseDto,
} from './dto/caixa-de-avisos.dto';

/**
 * SPEC-065/TASK-001 — **a caixa de avisos pela mão de quem a recebe.**
 *
 * ## O escopo vem do TOKEN, nunca do pedido
 *
 * `companyId` e `destinatarioId` saem do `@CurrentUser()`, e **não há
 * parâmetro** que permita pedir a caixa de outra pessoa. É a INV-065a, e o
 * mecanismo é a ausência do parâmetro — não uma conferência que alguém possa
 * esquecer de escrever.
 *
 * **`@Roles` é obrigatório em cada método, e não decoração.** O próprio
 * projeto já registra isto em `me-classes.controller.ts`: *"o prefixo `/me/`
 * não autoriza nada"*.
 *
 * ## Os três papéis, e por que os três
 *
 * Aluno, professor e gestor recebem avisos **diferentes** (SPEC-063/D1), mas
 * a caixa é a mesma pergunta: *o que chegou para mim?*. Três controllers
 * seriam três cópias da mesma resposta, e a diferença entre eles moraria só no
 * decorador.
 *
 * O `super_admin` fica de fora (LIM-065a) — e isso é decisão do Israel, de
 * 2026-09-20, não impossibilidade: o schema recusa hoje, mas havia caminhos
 * para desenhar diferente. Hoje **nada no sistema gera aviso para ele**, e a
 * caixa dele seria uma tela esperando um emissor que não existe.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/avisos')
export class MeAvisosController {
  constructor(private readonly caixa: CaixaDeAvisosService) {}

  /**
   * **`403`, e não lista vazia.**
   *
   * Lista vazia diria "você não tem avisos", e isso é falso: o super_admin não
   * *pode* ter. Responder o que é verdade — *esta caixa não é sua* — é o que
   * impede alguém de passar uma tarde investigando por que os avisos "sumiram".
   */
  private empresaDo(user: AccessTokenPayload): string {
    if (!user.companyId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'SEM_CAIXA_DE_AVISOS',
        message:
          'A caixa de avisos é de quem pertence a um clube. ' +
          'O super administrador não recebe avisos (LIM-065a).',
      });
    }
    return user.companyId;
  }

  @Get()
  @ApiOkResponse({ type: CaixaDeAvisosResponseDto })
  @Roles('aluno', 'professor', 'company_admin')
  listar(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: PaginationQueryDto,
  ): Promise<CaixaDeAvisosResponseDto> {
    return this.caixa.listar(
      this.empresaDo(user),
      user.sub,
      query.page ?? 1,
      query.pageSize ?? 20,
    );
  }

  /**
   * O que o sino pede. Rota própria, e não `?pageSize=1` na listagem: o sino
   * quer **um inteiro**, e pedir uma página para ler o rodapé dela seria
   * trazer linha de banco para descartar.
   */
  @Get('nao-lidos')
  @ApiOkResponse({ type: NaoLidosResponseDto })
  @Roles('aluno', 'professor', 'company_admin')
  naoLidos(
    @CurrentUser() user: AccessTokenPayload,
  ): Promise<NaoLidosResponseDto> {
    return this.caixa.contarNaoLidos(this.empresaDo(user), user.sub);
  }

  /**
   * **`200`, e não `204`.** O corpo carrega `marcadas`, e a tela precisa dele:
   * é o que diz se havia algo a marcar. `204` obrigaria uma segunda chamada
   * para descobrir que agora é zero.
   */
  @Post('lidas')
  @HttpCode(200)
  @ApiOkResponse({ type: MarcadasResponseDto })
  @Roles('aluno', 'professor', 'company_admin')
  marcarLidas(
    @CurrentUser() user: AccessTokenPayload,
  ): Promise<MarcadasResponseDto> {
    return this.caixa.marcarTodasComoLidas(this.empresaDo(user), user.sub);
  }
}
