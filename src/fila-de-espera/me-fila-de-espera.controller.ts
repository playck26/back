import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UuidCanonicoPipe } from '../common/pipes/uuid-canonico.pipe';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import {
  EntrarNaFilaDeAulaDto,
  EntrarNaFilaDeTurmaDto,
  LinhaDaFilaResponseDto,
} from './dto/fila-de-espera.dto';
import { FilaDeEsperaService } from './fila-de-espera.service';

/**
 * SPEC-064/TASK-002 — a fila de espera, pelo próprio aluno (card 5331).
 *
 * ## Dois `POST` e não um com `tipo`
 *
 * As duas filas têm **direitos diferentes** (D1): a de turma é para qualquer
 * aluno ativo, a de aula é só para quem tem crédito. Um corpo com
 * `{ tipo, alvoId }` faria uma rota com dois conjuntos de erro e um `CHECK` de
 * exclusividade dentro do serviço — o mesmo `num_nonnulls = 1` que o banco já
 * garante, reescrito em TypeScript. Dois caminhos dizem no nome qual é qual.
 *
 * ## `@Roles('aluno')` em CADA método
 *
 * É a lição da SPEC-031/D19, e a `MeReposicoesController` a repete: *"o prefixo
 * não é mecanismo"* — o `RolesGuard` deixa passar qualquer role autenticada
 * quando não há decorator. Sem ele, o gestor entraria na fila em nome de si
 * mesmo e a LIM-064e viraria texto.
 *
 * ## O que esta rota NÃO faz
 *
 * Não chama ninguém e não reserva nada. **Quem chama é o varredor**
 * (TASK-003), e a fila é convite para tentar, não reserva de vaga (LIM-064a).
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/fila-de-espera')
export class MeFilaDeEsperaController {
  constructor(private readonly fila: FilaDeEsperaService) {}

  /**
   * REQ-001 — entrar na fila por uma **vaga de matrícula** numa turma.
   */
  @Post('turmas')
  @ApiCreatedResponse({ type: LinhaDaFilaResponseDto })
  @ApiConflictResponse({
    description: 'Já está nesta fila (`JA_NA_FILA`).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Turma fora de operação (`TURMA_INATIVA`) ou já matriculado nela ' +
      '(`JA_MATRICULADO_NA_TURMA`).',
  })
  @Roles('aluno')
  entrarNaTurma(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: EntrarNaFilaDeTurmaDto,
  ) {
    return this.fila.entrarNaTurma(
      user.companyId as string,
      user.sub,
      dto.turmaId,
    );
  }

  /**
   * REQ-001 + LIM-064e — entrar na fila por uma **vaga de reposição** numa
   * aula. Só para quem tem crédito: sem ele, o chamado seria convite que a
   * pessoa não pode cumprir.
   */
  @Post('aulas')
  @ApiCreatedResponse({ type: LinhaDaFilaResponseDto })
  @ApiConflictResponse({
    description:
      'Já está nesta fila (`JA_NA_FILA`), sem crédito de reposição ' +
      '(`SEM_CREDITO`), aula cancelada (`OCUPACAO_CANCELADA`) ou já passada ' +
      '(`PRAZO_DE_CANCELAMENTO`).',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Já matriculado na turma da aula (`JA_MATRICULADO_NA_TURMA`).',
  })
  @Roles('aluno')
  entrarNaAula(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: EntrarNaFilaDeAulaDto,
  ) {
    return this.fila.entrarNaAula(
      user.companyId as string,
      user.sub,
      dto.ocupacaoId,
    );
  }

  /**
   * REQ-001 — sair da fila, inclusive depois de chamado.
   *
   * Desistir da vez é legítimo, e **libera o alvo**: sem `chamado` vivo, o
   * próximo ciclo do varredor chama o seguinte.
   */
  @Delete(':id')
  @ApiNoContentResponse()
  @HttpCode(204)
  @Roles('aluno')
  sair(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.fila.sair(user.companyId as string, user.sub, id);
  }
}
