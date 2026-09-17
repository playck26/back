import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';
import { PaginationQueryDto } from './pagination-query.dto';

/**
 * SPEC-009/REQ-008 — a fila de aprovação do admin é a listagem normal de
 * alunos filtrada por vínculo, não um endpoint próprio: é a mesma coleção,
 * com o mesmo escopo de empresa e a mesma paginação.
 */
export class ListStudentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['pendente', 'aprovado', 'recusado'] })
  @IsOptional()
  @IsEnum(['pendente', 'aprovado', 'recusado'])
  vinculo?: 'pendente' | 'aprovado' | 'recusado';

  /**
   * SPEC-049/REQ-001 — **busca por nome, porque `pageSize` para em 100.**
   *
   * O teto do `PaginationQueryDto` é `@Max(100)` e **fica** (D5): ele protege o
   * banco de um pedido que o derruba, e a resposta para "tenho mais de 100
   * alunos" é buscar, não pedir mil.
   *
   * Sem isto, o seletor de aluno do Admin simplesmente **terminava** no
   * centésimo — sem busca, sem aviso, e o gestor concluindo que a pessoa não
   * existe.
   */
  @ApiPropertyOptional({
    description:
      'Filtra por nome do aluno. Vários termos combinam com AND, em qualquer ordem. Não ignora acento (LIM-049a).',
    example: 'silva joao',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  busca?: string;

  /**
   * SPEC-057/TASK-004 (card 5350) — **filtrar alunos por nível.**
   *
   * `@UuidNoCorpo()` e não `@Matches`: a primeira versão aceitava o literal
   * `SEM_NIVEL` **dentro** deste campo, e o gate `uuid-no-corpo.gate.spec.ts`
   * a reprovou — com razão. Aquele gate foi endurecido em três rodadas de
   * validação cruzada justamente contra exceções, e o decorador não confere
   * só o formato: ele **normaliza a grafia**, que é o que impede um
   * `where nivel_id = 'ABC…'` não casar com o valor minúsculo que o Postgres
   * devolve.
   *
   * Quem pergunta "quem ficou sem nível" pergunta outra coisa, e tem campo
   * próprio (`semNivel`).
   */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @UuidNoCorpo()
  nivelId?: string;

  /**
   * **Quem não foi classificado** — a pergunta que o gestor precisa fazer
   * ANTES de ligar o filtro do aluno.
   *
   * `alunos.nivel_id` é anulável e o nulo é o estado normal: sem esta opção,
   * descobrir quem ficou de fora exigiria abrir aluno por aluno.
   *
   * Vence o `nivelId` quando os dois vêm: "sem nível" e "deste nível" são
   * mutuamente exclusivos, e recusar com `400` seria rigor sem ganho.
   */
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  // **NÃO `@Type(() => Boolean)`**: `Boolean('false')` é `true`. Mesmo molde
  // de `MinhasTurmasQueryDto.incluirInativas`.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  semNivel?: boolean;
}
