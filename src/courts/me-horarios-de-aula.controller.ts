import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UuidCanonicoPipe } from '../common/pipes/uuid-canonico.pipe';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { HorariosDeAulaResponseDto } from './dto/horarios-de-aula-response.dto';
import { HorariosDeAulaParticularService } from './horarios-de-aula-particular.service';

/**
 * SPEC-047/REQ-005 — **quando dá para marcar com este professor.**
 *
 * ## O prefixo é `me/professores`, mas o controller mora em `courts`
 *
 * Fica ao lado de `MeProfessoresController` no caminho e longe dele na pasta,
 * e isso é deliberado: a resposta é feita de ocupação e horário de quadra.
 * `CourtsModule` já importa `PeopleModule`; o contrário seria circular, e
 * `forwardRef` para manter dois controllers na mesma pasta é conserto pior que
 * a doença.
 *
 * Dois controllers com o mesmo prefixo convivem sem colisão porque as rotas
 * são distintas (`GET /` lá, `GET /:id/horarios` aqui).
 *
 * ## `:id` passa pelo `UuidCanonicoPipe`, e este texto já disse o contrário
 *
 * A primeira versão argumentava que validar o formato criaria um oráculo —
 * `400` para o id malformado, `404` para o de outra empresa. **O gate
 * `uuid-canonico.gate.spec.ts` reprovou, e ele está certo.**
 *
 * O pipe não existe para validar: ele **normaliza**. `ParseUUIDPipe` devolve
 * `A000…001` com as maiúsculas intactas, e a coluna `uuid` do Postgres
 * responde sempre em minúsculas — toda comparação vira uma comparação entre
 * duas grafias do mesmo valor. Isso já custou `404` na própria turma do
 * gestor, "já existe" ao renomear para o próprio nome, e filtro devolvendo
 * lista vazia. E o `400` do malformado é o que **toda** rota de `:id` deste
 * projeto já responde: a exceção seria esta, não a regra.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/professores')
export class MeHorariosDeAulaController {
  constructor(private readonly horarios: HorariosDeAulaParticularService) {}

  @Get(':id/horarios')
  @ApiOkResponse({ type: HorariosDeAulaResponseDto })
  @Roles('aluno')
  listar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    return this.horarios.horariosDoProfessor(
      user.companyId as string,
      id,
      query.data,
    );
  }
}
